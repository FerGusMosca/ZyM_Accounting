# service_client/ARCA_client.py
"""
ARCA / AFIP Electronic Invoicing Client
========================================
Implements the two services required to issue type-C invoices:

  WSAA  → Authentication  → returns Token + Sign  (valid 12h)
  WSFE  → Invoicing       → returns CAE + CAE expiration date

Staging endpoints (homologación):
  WSAA:  https://wsaahomo.afip.gov.ar/ws/services/LoginCms
  WSFE:  https://wswhomo.afip.gov.ar/wsfev1/service.asmx

Production endpoints:
  WSAA:  https://wsaa.afip.gov.ar/ws/services/LoginCms
  WSFE:  https://servicios1.afip.gov.ar/wsfev1/service.asmx

Dependencies: stdlib only (ssl, http.client, xml.etree, json) +
              openssl in PATH to sign the TRA (pre-installed on Linux)

CUIT notes:
  - The CUIT used in AFIP calls belongs to the CERTIFICATE owner
    (the entity that holds the private key and authenticated with ARCA).
  - The commercial issuer (business name on the invoice) may differ
    → configured via EMISOR_CUIT in .env and passed as a parameter.
"""

import base64
import html
import http.client
import json
import logging
import os
import random
import re
import socket
import ssl
import subprocess
import tempfile
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# ── Endpoints ──────────────────────────────────────────────────────────────────
_WSAA = {
    "homo": ("wsaahomo.afip.gov.ar", "/ws/services/LoginCms"),
    "prod": ("wsaa.afip.gov.ar",     "/ws/services/LoginCms"),
}
_WSFE = {
    "homo": ("wswhomo.afip.gov.ar",    "/wsfev1/service.asmx"),
    "prod": ("servicios1.afip.gov.ar", "/wsfev1/service.asmx"),
}

INVOICE_TYPE_C   = 11   # Factura C
CONCEPT_SERVICES = 2    # Servicios
CURRENCY_ARS     = "PES"

_TOKEN_CACHE_DIR = Path(__file__).parent / ".token_cache"

# ── Retry tuning for transient WSAA/WSFE failures ─────────────────────────────
_WSAA_RETRY_ATTEMPTS = 3
_WSAA_RETRY_BACKOFF  = 1.2   # seconds; doubled each attempt (1.2s, 2.4s, 4.8s)
_SOAP_TIMEOUT_SEC    = 30


# ══════════════════════════════════════════════════════════════════════════════
# Exception taxonomy  — blindaje: los callers pueden discriminar por tipo
# ══════════════════════════════════════════════════════════════════════════════

class ArcaError(RuntimeError):
    """Base class for ARCA / AFIP-related errors."""


class ArcaUnavailableError(ArcaError):
    """
    Transient failure on AFIP side or network. Retryable.

    Includes:
      - Network errors (socket.timeout, ConnectionError, ssl.SSLError, OSError)
      - HTTP 5xx from AFIP
      - Well-known transient SOAP faults (EJBException, NumberFormatException,
        "Zero length BigInteger", database-connection errors on AFIP's side)
    """


class ArcaAuthError(ArcaError):
    """
    Authentication / credential problem. Not automatically retryable.

    Includes:
      - openssl cms sign failures (bad cert/key)
      - WSAA faults about invalid CMS, expired cert, revoked cert
      - "TA ya valido" edge case (active token not in local cache)
    """


class ArcaConfigError(ArcaError):
    """Missing or invalid local configuration (cert path, CUIT, etc.)."""


# Regex/substring hints used to classify SOAP faults coming back from AFIP.
# These are *best-effort* — WSAA doesn't have a formal error catalog, so we
# pattern-match known text.
_TRANSIENT_FAULT_HINTS = (
    "zero length biginteger",
    "ejbexception",
    "numberformatexception",
    "nullpointerexception",
    "service unavailable",
    "connection refused",
    "read timed out",
    "could not connect",
    "database",
    "datasource",
    "ora-",                 # Oracle errors (AFIP backend is Oracle)
    "socket",
    "timeout",
    "internal server error",
    "temporarily unavailable",
)

_AUTH_FAULT_HINTS = (
    "cms.bad",
    "cms.sign",
    "certificado",
    "certificate",
    "cert is not yet valid",
    "cert has expired",
    "revoked",
    "ta valido",            # previously-issued token still active
    "alias",                # signer alias not found in AFIP keystore
    "autenticar",           # "error al autenticar"
    "computador no autorizado",
    "no autorizado",
)


def _classify_fault(message: str) -> ArcaError:
    """Return the most specific ArcaError subclass for a given fault text."""
    lower = (message or "").lower()
    for hint in _AUTH_FAULT_HINTS:
        if hint in lower:
            return ArcaAuthError(message)
    for hint in _TRANSIENT_FAULT_HINTS:
        if hint in lower:
            return ArcaUnavailableError(message)
    # Unknown fault — treat as generic; callers that want to be lenient can
    # catch ArcaError.
    return ArcaError(message)


# ══════════════════════════════════════════════════════════════════════════════
# General helpers
# ══════════════════════════════════════════════════════════════════════════════

def _clean_cuit(cuit: str) -> str:
    return cuit.replace("-", "").strip()


def _fmt_date_afip(yyyymmdd: Optional[str]) -> str:
    """Convert AFIP 'YYYYMMDD' → 'DD/MM/YYYY'. Returns '' if invalid."""
    if not yyyymmdd or len(yyyymmdd) != 8:
        return yyyymmdd or ""
    return f"{yyyymmdd[6:8]}/{yyyymmdd[4:6]}/{yyyymmdd[0:4]}"


def _soap_call(host: str, path: str, soap_action: str, body: str) -> str:
    envelope = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<soapenv:Envelope '
        'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" '
        'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        '<soapenv:Header/>'
        f'<soapenv:Body>{body}</soapenv:Body>'
        '</soapenv:Envelope>'
    )
    payload = envelope.encode("utf-8")
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE
    logger.debug("SOAP → https://%s%s  action=%s", host, path, soap_action)

    conn = None
    try:
        conn = http.client.HTTPSConnection(host, context=ctx, timeout=_SOAP_TIMEOUT_SEC)
        conn.request("POST", path, body=payload, headers={
            "Content-Type":   "text/xml; charset=utf-8",
            "SOAPAction":     f'"{soap_action}"',
            "Content-Length": str(len(payload)),
        })
        resp = conn.getresponse()
        xml  = resp.read().decode("utf-8", errors="replace")
        logger.debug("SOAP ← HTTP %s  (len=%d)", resp.status, len(xml))

        # AFIP returns 200 on success and 500 on SOAP Faults — both carry body we must parse.
        # Any other status is treated as infrastructure problem.
        if resp.status not in (200, 500):
            if 500 <= resp.status < 600:
                raise ArcaUnavailableError(
                    f"AFIP returned HTTP {resp.status} from {host} (service unavailable)"
                )
            raise ArcaError(f"Unexpected HTTP {resp.status} from {host}")
        return xml

    except (socket.timeout, TimeoutError) as exc:
        raise ArcaUnavailableError(
            f"Timeout ({_SOAP_TIMEOUT_SEC}s) connecting to AFIP host {host}"
        ) from exc
    except ssl.SSLError as exc:
        raise ArcaUnavailableError(f"TLS error contacting {host}: {exc}") from exc
    except (ConnectionError, http.client.HTTPException, OSError) as exc:
        # OSError covers DNS failures ("Name or service not known"), refused
        # connections, "Network is unreachable", etc.
        raise ArcaUnavailableError(f"Network error contacting {host}: {exc}") from exc
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _xml_find(root: ET.Element, local_tag: str) -> Optional[str]:
    for el in root.iter():
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if tag == local_tag:
            return (el.text or "").strip() or None
    return None


def _xml_raise_fault(root: ET.Element) -> None:
    fault = _xml_find(root, "faultstring")
    if fault:
        raise _classify_fault(f"SOAP Fault: {fault}")
    err_code = _xml_find(root, "ErrCode")
    err_msg  = _xml_find(root, "ErrMsg")
    if err_code and err_code != "0":
        raise _classify_fault(f"AFIP Error {err_code}: {err_msg}")


# ══════════════════════════════════════════════════════════════════════════════
# Disk-based token cache
# ══════════════════════════════════════════════════════════════════════════════

def _token_cache_path(cuit: str, homo: bool) -> Path:
    env = "homo" if homo else "prod"
    _TOKEN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _TOKEN_CACHE_DIR / f"token_{cuit}_{env}.json"


def _load_token_from_disk(cuit: str, homo: bool) -> Optional[dict]:
    path = _token_cache_path(cuit, homo)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        exp  = datetime.fromisoformat(data["expiration"])
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) < exp - timedelta(minutes=5):
            logger.info("WSAA: valid token found on disk, expires %s", data["expiration"])
            return data
        logger.info("WSAA: cached token expired — requesting new one.")
        path.unlink(missing_ok=True)
        return None
    except Exception as exc:
        logger.warning("WSAA: could not read token from disk: %s", exc)
        path.unlink(missing_ok=True)
        return None


def _save_token_to_disk(cuit: str, homo: bool, token_data: dict) -> None:
    path = _token_cache_path(cuit, homo)
    try:
        path.write_text(json.dumps(token_data, ensure_ascii=False, indent=2), encoding="utf-8")
        logger.debug("WSAA: token saved to %s", path)
    except Exception as exc:
        logger.warning("WSAA: could not save token to disk: %s", exc)


def _delete_token_from_disk(cuit: str, homo: bool) -> None:
    _token_cache_path(cuit, homo).unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# WSAA — Authentication
# ══════════════════════════════════════════════════════════════════════════════

def _build_tra() -> str:
    now      = datetime.now(timezone.utc)
    gen_time = (now - timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    exp_time = (now + timedelta(hours=10)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    uid      = str(int(now.timestamp()))
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<loginTicketRequest version="1.0">'
        '<header>'
        f'<uniqueId>{uid}</uniqueId>'
        f'<generationTime>{gen_time}</generationTime>'
        f'<expirationTime>{exp_time}</expirationTime>'
        '</header>'
        '<service>wsfe</service>'
        '</loginTicketRequest>'
    )


def _sign_tra(tra_xml: str, cert_path: str, key_path: str) -> str:
    if not os.path.exists(cert_path):
        raise ArcaConfigError(f"Certificate file not found: {cert_path}")
    if not os.path.exists(key_path):
        raise ArcaConfigError(f"Private key file not found: {key_path}")

    with tempfile.TemporaryDirectory() as tmp:
        tra_file = os.path.join(tmp, "tra.xml")
        cms_file = os.path.join(tmp, "tra.cms")
        with open(tra_file, "w", encoding="utf-8") as f:
            f.write(tra_xml)
        try:
            result = subprocess.run(
                ["openssl", "cms", "-sign", "-in", tra_file, "-signer", cert_path,
                 "-inkey", key_path, "-nodetach", "-outform", "DER", "-out", cms_file],
                capture_output=True,
                timeout=30,
            )
        except FileNotFoundError as exc:
            raise ArcaConfigError(
                "openssl binary not found in PATH — cannot sign WSAA TRA"
            ) from exc
        except subprocess.TimeoutExpired as exc:
            raise ArcaUnavailableError("openssl cms sign timed out") from exc

        if result.returncode != 0:
            stderr = result.stderr.decode(errors="replace")
            raise ArcaAuthError(
                f"openssl cms sign failed (exit {result.returncode}): {stderr.strip()}"
            )
        with open(cms_file, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")


def _wsaa_get_token_once(cert_path: str, key_path: str, homo: bool) -> dict:
    """Single WSAA attempt — raises typed ArcaError on failure."""
    host, path = _WSAA["homo" if homo else "prod"]
    tra   = _build_tra()
    cms64 = _sign_tra(tra, cert_path, key_path)
    logger.info("WSAA: authenticating on %s → %s", "HOMO" if homo else "PROD", host)
    body = (
        '<loginCms xmlns="http://wsaa.view.sua.dvadac.desein.afip.gov">'
        f'<in0>{cms64}</in0>'
        '</loginCms>'
    )
    raw  = _soap_call(host, path, soap_action="", body=body)
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as exc:
        # Malformed XML from AFIP is almost always a gateway-level transient.
        raise ArcaUnavailableError(
            f"WSAA: malformed XML response from {host}: {exc}"
        ) from exc
    _xml_raise_fault(root)

    token = sign = expiration = None
    login_return = _xml_find(root, "loginCmsReturn")
    if login_return:
        try:
            inner_root = ET.fromstring(html.unescape(login_return))
            token      = _xml_find(inner_root, "token")
            sign       = _xml_find(inner_root, "sign")
            expiration = _xml_find(inner_root, "expirationTime")
        except ET.ParseError as exc:
            logger.warning("WSAA: ParseError in loginCmsReturn: %s", exc)

    if not token:
        token      = _xml_find(root, "token")
        sign       = _xml_find(root, "sign")
        expiration = _xml_find(root, "expirationTime")

    if not token or not sign:
        raise ArcaUnavailableError(
            f"WSAA: token/sign not found in response:\n{raw[:600]}"
        )

    logger.info("WSAA: ✅ token obtained, expires %s", expiration)
    return {"token": token, "sign": sign, "expiration": expiration}


def wsaa_get_token(cert_path: str, key_path: str, homo: bool = True) -> dict:
    """
    WSAA login with retry/backoff on transient failures.

    Retries `ArcaUnavailableError` up to _WSAA_RETRY_ATTEMPTS times with
    exponential backoff + jitter. Auth/config errors are raised immediately
    (no point in retrying a bad certificate).
    """
    last_exc: Optional[ArcaError] = None
    for attempt in range(1, _WSAA_RETRY_ATTEMPTS + 1):
        try:
            return _wsaa_get_token_once(cert_path, key_path, homo)
        except (ArcaAuthError, ArcaConfigError):
            # Don't retry — the problem won't resolve by trying again.
            raise
        except ArcaUnavailableError as exc:
            last_exc = exc
            if attempt == _WSAA_RETRY_ATTEMPTS:
                break
            delay = _WSAA_RETRY_BACKOFF * (2 ** (attempt - 1))
            delay += random.uniform(0, 0.3)  # jitter
            logger.warning(
                "WSAA: attempt %d/%d failed (%s) — retrying in %.1fs",
                attempt, _WSAA_RETRY_ATTEMPTS, exc, delay,
            )
            time.sleep(delay)
        except ArcaError as exc:
            # Unknown ArcaError — retry once to be safe, then give up.
            last_exc = exc
            if attempt >= 2:
                break
            time.sleep(_WSAA_RETRY_BACKOFF)

    # Exhausted retries
    assert last_exc is not None
    raise last_exc


# ══════════════════════════════════════════════════════════════════════════════
# WSFE — Electronic invoicing
# ══════════════════════════════════════════════════════════════════════════════

_WSFE_NS  = "http://ar.gov.afip.dif.FEV1/"
_WSFE_ACT = "http://ar.gov.afip.dif.FEV1/"


def _wsfe_auth(token: str, sign: str, cuit: str) -> str:
    c = _clean_cuit(cuit)
    return f'<Auth><Token>{token}</Token><Sign>{sign}</Sign><Cuit>{c}</Cuit></Auth>'


def wsfe_get_last_invoice_number(
    token: str, sign: str, cuit: str, punto_venta: int, homo: bool = True,
) -> int:
    """Query the last authorized invoice number for a given sales point."""
    host, path = _WSFE["homo" if homo else "prod"]
    auth = _wsfe_auth(token, sign, cuit)
    body = (
        f'<FECompUltimoAutorizado xmlns="{_WSFE_NS}">'
        f'{auth}<PtoVta>{punto_venta}</PtoVta><CbteTipo>{INVOICE_TYPE_C}</CbteTipo>'
        f'</FECompUltimoAutorizado>'
    )
    raw  = _soap_call(host, path, f"{_WSFE_ACT}FECompUltimoAutorizado", body)
    root = ET.fromstring(raw)
    _xml_raise_fault(root)
    nro    = _xml_find(root, "CbteNro")
    result = int(nro) if nro and nro.isdigit() else 0
    logger.info("WSFE: last invoice at PV %s = %s", punto_venta, result)
    return result


def wsfe_query_invoice(
    token: str, sign: str, cuit: str,
    punto_venta: int, invoice_number: int,
    homo: bool = True,
) -> dict:
    """
    Fetch a single already-issued invoice via FECompConsultar.

    Note: AFIP does not store the client's business name or service description
    in WSFE — those fields will be empty strings in the result.
    """
    host, path = _WSFE["homo" if homo else "prod"]
    auth = _wsfe_auth(token, sign, cuit)
    body = f"""
<FECompConsultar xmlns="{_WSFE_NS}">
  {auth}
  <FeCompConsReq>
    <CbteTipo>{INVOICE_TYPE_C}</CbteTipo>
    <PtoVta>{punto_venta}</PtoVta>
    <CbteNro>{invoice_number}</CbteNro>
  </FeCompConsReq>
</FECompConsultar>
"""
    raw  = _soap_call(host, path, f"{_WSFE_ACT}FECompConsultar", body)
    logger.info("WSFE: PV=%s NRO=%s — homo: Resultado=A pero sin CAE (esperado)", punto_venta, invoice_number)

    root = ET.fromstring(raw)
    _xml_raise_fault(root)

    doc_nro   = _xml_find(root, "DocNro") or ""
    imp_total = _xml_find(root, "ImpTotal")
    cae       = _xml_find(root, "CAE") or ""
    fecha_raw = _xml_find(root, "CbteFch")
    cae_vto   = _xml_find(root, "CAEFchVto")
    resultado = _xml_find(root, "Resultado") or ""

    # Format CUIT with dashes: 20298654491 → 20-29865449-1
    cuit_fmt = doc_nro
    if doc_nro and len(doc_nro) == 11:
        cuit_fmt = f"{doc_nro[0:2]}-{doc_nro[2:10]}-{doc_nro[10]}"

    homo_no_cae = homo and resultado == "A" and not cae
    if homo_no_cae:
        logger.info("WSFE: PV=%s NRO=%s — homo: Resultado=A pero sin CAE (esperado)", ...)

    return {
        "comp_nro":             f"C{punto_venta:05d}-{invoice_number:08d}",
        "homo_no_cae": homo_no_cae,
        "punto_venta":          punto_venta,
        "invoice_number":       invoice_number,
        "fecha_emision":        _fmt_date_afip(fecha_raw),
        "cuit_cliente":         cuit_fmt,
        "razon_social_cliente": "",   # not stored by AFIP
        "domicilio_cliente":    "",
        "nombre_contacto":      "",
        "descripcion":          "",   # not stored by AFIP
        "amount":               float(imp_total) if imp_total else 0.0,
        "cae_number":           cae,
        "vencimiento":          _fmt_date_afip(cae_vto),
        "resultado":            resultado,
    }


def wsfe_query_invoices_range(
    token: str, sign: str, cuit: str,
    punto_venta: int, from_number: int, to_number: int,
    homo: bool = True,
) -> list[dict]:
    """
    Fetch a range of invoices for one sales point.
    Silently skips numbers that return errors (gaps are normal).
    """
    invoices = []
    for n in range(from_number, to_number + 1):
        try:
            inv = wsfe_query_invoice(token, sign, cuit, punto_venta, n, homo)
            invoices.append(inv)
        except Exception as exc:
            logger.debug("WSFE: skip PV=%s NRO=%s — %s", punto_venta, n, exc)
    return invoices


def wsfe_request_cae(
    token: str, sign: str, cuit: str,
    punto_venta: int, invoice_number: int,
    invoice_date: str, total_amount: float, client_cuit: str,
    homo: bool = True,
    consumidor_final: bool = False,
) -> dict:
    """Request a CAE for a type-C invoice. consumidor_final=True → DocTipo=99, DocNro=0"""
    host, path = _WSFE["homo" if homo else "prod"]
    auth       = _wsfe_auth(token, sign, cuit)
    amount_str = f"{total_amount:.2f}"

    if consumidor_final or not client_cuit or not client_cuit.strip():
        doc_tipo     = 99
        doc_nro      = 0
        client_label = "CONSUMIDOR FINAL"
    else:
        doc_tipo     = 80
        doc_nro      = _clean_cuit(client_cuit)
        client_label = doc_nro

    body = f"""
<FECAESolicitar xmlns="{_WSFE_NS}">
  {auth}
  <FeCAEReq>
    <FeCabReq>
      <CantReg>1</CantReg><PtoVta>{punto_venta}</PtoVta><CbteTipo>{INVOICE_TYPE_C}</CbteTipo>
    </FeCabReq>
    <FeDetReq>
      <FECAEDetRequest>
        <Concepto>{CONCEPT_SERVICES}</Concepto>
        <DocTipo>{doc_tipo}</DocTipo><DocNro>{doc_nro}</DocNro>
        <CbteDesde>{invoice_number}</CbteDesde><CbteHasta>{invoice_number}</CbteHasta>
        <CbteFch>{invoice_date}</CbteFch>
        <ImpTotal>{amount_str}</ImpTotal><ImpTotConc>0.00</ImpTotConc>
        <ImpNeto>{amount_str}</ImpNeto><ImpOpEx>0.00</ImpOpEx>
        <ImpIVA>0.00</ImpIVA><ImpTrib>0.00</ImpTrib>
        <FchServDesde>{invoice_date}</FchServDesde>
        <FchServHasta>{invoice_date}</FchServHasta>
        <FchVtoPago>{invoice_date}</FchVtoPago>
        <MonId>{CURRENCY_ARS}</MonId><MonCotiz>1</MonCotiz>
        <CondicionIVAReceptorId>5</CondicionIVAReceptorId>
      </FECAEDetRequest>
    </FeDetReq>
  </FeCAEReq>
</FECAESolicitar>
"""
    logger.info("WSFE: requesting CAE PV=%s NRO=%s amount=%s client=%s",
                punto_venta, invoice_number, amount_str, client_label)
    raw  = _soap_call(host, path, f"{_WSFE_ACT}FECAESolicitar", body)
    root = ET.fromstring(raw)
    logger.debug("WSFE FECAESolicitar response:\n%s", raw[:1200])
    _xml_raise_fault(root)

    resultado = _xml_find(root, "Resultado")
    cae       = _xml_find(root, "CAE")
    cae_vto   = _xml_find(root, "CAEFchVto")

    obs_list: list[str] = []
    for obs_el in root.iter():
        tag = obs_el.tag.split("}")[-1] if "}" in obs_el.tag else obs_el.tag
        if tag == "Obs":
            code = _xml_find(obs_el, "Code")
            msg  = _xml_find(obs_el, "Msg")
            if msg:
                obs_list.append(f"[{code}] {msg}")

    if resultado == "R":
        err_lines, err_msgs, obs_msgs = ["WSFE: CAE rejected."], [], []
        for el in root.iter():
            tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
            if tag == "Err":
                code = _xml_find(el, "Code"); msg = _xml_find(el, "Msg")
                if msg: err_msgs.append(f"  ❌ [{code}] {msg}")
            elif tag == "Obs":
                code = _xml_find(el, "Code"); msg = _xml_find(el, "Msg")
                if msg: obs_msgs.append(f"  ⚠️  [{code}] {msg}")
        if err_msgs: err_lines += ["Errors:"] + err_msgs
        if obs_msgs: err_lines += ["Observations:"] + obs_msgs
        if not err_msgs and not obs_msgs: err_lines.append(raw)
        raise RuntimeError("\n".join(err_lines))

    if not cae:
        raise RuntimeError(f"WSFE: CAE not returned.\nResponse:\n{raw[:800]}")

    cae_vto_fmt = cae_vto
    if cae_vto and len(cae_vto) == 8:
        cae_vto_fmt = f"{cae_vto[6:8]}/{cae_vto[4:6]}/{cae_vto[0:4]}"

    logger.info("WSFE: ✅ CAE=%s  Expires=%s  Obs=%s", cae, cae_vto_fmt, obs_list)
    return {
        "cae":            cae,
        "cae_vto":        cae_vto_fmt,
        "invoice_number": invoice_number,
        "resultado":      resultado,
        "obs":            obs_list,
        "raw_xml":        raw,
    }


# ══════════════════════════════════════════════════════════════════════════════
# ARCAClient — high-level facade
# ══════════════════════════════════════════════════════════════════════════════

class ARCAClient:
    """
    High-level facade used by the controller.

    Token management — two-layer cache:
      1. In-memory  → avoids redundant calls within the same process lifetime
      2. On-disk    → survives process restarts (tokens live 12h)

    Usage:
        client   = ARCAClient.from_config(settings)
        result   = client.issue_invoice(row)
        history  = client.get_invoices(from_date="2026-01-01", to_date="2026-02-28")
    """

    def __init__(self, cert_path: str, key_path: str, cuit: str, homo: bool = True):
        self.cert_path = cert_path
        self.key_path  = key_path
        self.cuit      = _clean_cuit(cuit)
        self.homo      = homo
        self._mem_cache: Optional[dict] = None

    @classmethod
    def from_config(cls, settings) -> "ARCAClient":
        homo = str(getattr(settings, "arca_homo", "true")).lower() != "false"
        return cls(
            cert_path = getattr(settings, "arca_cert_path", ""),
            key_path  = getattr(settings, "arca_key_path",  ""),
            cuit      = getattr(settings, "arca_cuit",      ""),
            homo      = homo,
        )

    def _is_valid(self, token_data: dict) -> bool:
        try:
            exp = datetime.fromisoformat(token_data["expiration"])
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            return datetime.now(timezone.utc) < exp - timedelta(minutes=5)
        except Exception:
            return False

    def _get_token(self) -> dict:
        if self._mem_cache and self._is_valid(self._mem_cache):
            return self._mem_cache
        disk = _load_token_from_disk(self.cuit, self.homo)
        if disk and self._is_valid(disk):
            self._mem_cache = disk
            return self._mem_cache
        logger.info("WSAA: requesting new token from AFIP...")
        try:
            token_data = wsaa_get_token(self.cert_path, self.key_path, self.homo)
        except ArcaAuthError as exc:
            # "TA ya valido" is a special case — wipe local cache and re-raise
            # with a more actionable message. It is *not* retryable but it will
            # resolve itself in ~12h.
            if "ta valido" in str(exc).lower():
                _delete_token_from_disk(self.cuit, self.homo)
                self._mem_cache = None
                raise ArcaAuthError(
                    "ARCA reports an active token that is not available in local cache "
                    "(the process likely restarted before the previous token expired). "
                    "This resolves automatically when the token expires (~12h after last "
                    "authentication). If you need to operate now, wait a few minutes and retry."
                ) from exc
            raise
        _save_token_to_disk(self.cuit, self.homo, token_data)
        self._mem_cache = token_data
        return self._mem_cache

    # ── Public API ────────────────────────────────────────────────────────────

    def get_last_invoice_number(self, punto_venta: int) -> int:
        t = self._get_token()
        return wsfe_get_last_invoice_number(t["token"], t["sign"], self.cuit, punto_venta, self.homo)

    def get_recent_invoices(self, limit: int = 10, sales_points: Optional[list[int]] = None) -> list[dict]:
        """
        Fetch the last `limit` invoices across all sales points by number,
        without any date filtering. Used for the dashboard widget.
        """
        pvs = sales_points or [1, 2]
        t = self._get_token()
        candidates: list[dict] = []

        for pv in pvs:
            try:
                last = wsfe_get_last_invoice_number(t["token"], t["sign"], self.cuit, pv, self.homo)
                if last == 0:
                    continue
                # Solo fetchear los últimos `limit` de cada PV
                from_n = max(1, last - limit + 1)
                invs = wsfe_query_invoices_range(
                    t["token"], t["sign"], self.cuit, pv, from_n, last, self.homo
                )
                candidates.extend(invs)
            except Exception as exc:
                logger.warning("WSFE: get_recent_invoices PV=%s error: %s", pv, exc)

        candidates.sort(
            key=lambda x: (x.get("fecha_emision", ""), x.get("invoice_number", 0)),
            reverse=True,
        )
        return candidates[:limit]

    def get_invoices(
        self,
        from_date: Optional[str] = None,        # "YYYY-MM-DD", defaults to 30 days ago
        to_date: Optional[str]   = None,        # "YYYY-MM-DD", defaults to today
        sales_points: Optional[list[int]] = None,  # defaults to [1, 2]
    ) -> list[dict]:
        """
        Fetch all issued invoices from AFIP within a date range.

        Strategy:
          1. For each sales point, get the last invoice number.
          2. Fetch every invoice from 1 → last via FECompConsultar.
          3. Filter client-side by date (AFIP's FECompConsultar has no date param).

        The AFIP response will NOT contain razon_social_cliente or descripcion
        (WSFE does not persist those fields). The controller can optionally
        enrich the response by cross-referencing the xlsx data.

        Returns list sorted by date descending.
        """
        today     = datetime.now().date()
        date_to   = datetime.fromisoformat(to_date).date()   if to_date   else today
        date_from = datetime.fromisoformat(from_date).date() if from_date else today - timedelta(days=30)
        pvs       = sales_points or [1, 2]
        t         = self._get_token()

        all_invoices: list[dict] = []

        for pv in pvs:
            try:
                last = wsfe_get_last_invoice_number(t["token"], t["sign"], self.cuit, pv, self.homo)
                if last == 0:
                    logger.info("WSFE: PV=%s has no invoices yet", pv)
                    continue
                logger.info("WSFE: fetching PV=%s invoices 1..%s", pv, last)
                invoices = wsfe_query_invoices_range(
                    t["token"], t["sign"], self.cuit, pv, 1, last, self.homo
                )
                for inv in invoices:
                    fecha_str = inv.get("fecha_emision", "")
                    try:
                        d, m, y  = fecha_str.split("/")
                        inv_date = datetime(int(y), int(m), int(d)).date()
                        if date_from <= inv_date <= date_to:
                            all_invoices.append(inv)
                    except Exception:
                        all_invoices.append(inv)   # include if date is unparseable
            except Exception as exc:
                logger.warning("WSFE: error fetching invoices for PV=%s: %s", pv, exc)

        all_invoices.sort(
            key=lambda x: (x.get("fecha_emision", ""), x.get("invoice_number", 0)),
            reverse=True,
        )
        logger.info("WSFE: get_invoices → %s records (PVs=%s, %s→%s)",
                    len(all_invoices), pvs, date_from, date_to)
        return all_invoices

    def issue_invoice(self, row: dict) -> dict:
        """Issue an invoice in AFIP from a row dict.
        Always uses today's date — AFIP rejects past dates.
        consumidor_final when cuit_cliente is empty.
        """
        m  = re.match(r"[Cc](\d+)-", row.get("comp_nro", ""))
        pv = int(m.group(1)) if m else 2

        # Always use today — AFIP rejects past/future dates in most cases
        invoice_date = datetime.now().strftime("%Y%m%d")

        last_number    = self.get_last_invoice_number(pv)
        invoice_number = last_number + 1
        t = self._get_token()
        cuit_cliente     = (row.get("cuit_cliente") or "").strip()
        consumidor_final = row.get("consumidor_final", False) or not cuit_cliente
        return wsfe_request_cae(
            token=t["token"], sign=t["sign"], cuit=self.cuit,
            punto_venta=pv, invoice_number=invoice_number,
            invoice_date=invoice_date, total_amount=float(row.get("amount", 0)),
            client_cuit=cuit_cliente, homo=self.homo,
            consumidor_final=consumidor_final,
        )

    def emitir_factura(self, row: dict) -> dict:
        """Alias for issue_invoice() — kept for backwards compatibility."""
        result = self.issue_invoice(row)
        result.setdefault("cbte_nro", result.get("invoice_number"))
        return result