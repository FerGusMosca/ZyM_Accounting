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
import re
import ssl
import subprocess
import tempfile
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

# Invoice type 11 = Factura C
INVOICE_TYPE_C     = 11
# Concept 2 = Services
CONCEPT_SERVICES   = 2
# Currency PES = Argentine Pesos
CURRENCY_ARS       = "PES"

# Directory where tokens are persisted between process restarts
_TOKEN_CACHE_DIR = Path(__file__).parent / ".token_cache"


# ══════════════════════════════════════════════════════════════════════════════
# General helpers
# ══════════════════════════════════════════════════════════════════════════════

def _clean_cuit(cuit: str) -> str:
    """Strip dashes and whitespace from a CUIT string."""
    return cuit.replace("-", "").strip()


def _soap_call(host: str, path: str, soap_action: str, body: str) -> str:
    """Execute a SOAP/HTTPS POST and return the full XML response."""
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

    # AFIP staging uses a self-signed cert — skip SSL verification
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE

    logger.debug("SOAP → https://%s%s  action=%s", host, path, soap_action)
    conn = http.client.HTTPSConnection(host, context=ctx, timeout=30)
    try:
        conn.request("POST", path, body=payload, headers={
            "Content-Type":   "text/xml; charset=utf-8",
            "SOAPAction":     f'"{soap_action}"',
            "Content-Length": str(len(payload)),
        })
        resp = conn.getresponse()
        xml  = resp.read().decode("utf-8", errors="replace")
        logger.debug("SOAP ← HTTP %s", resp.status)
        # HTTP 500 may carry a useful faultstring — don't raise here
        if resp.status not in (200, 500):
            raise ConnectionError(f"HTTP {resp.status} from {host}")
        return xml
    finally:
        conn.close()


def _xml_find(root: ET.Element, local_tag: str) -> Optional[str]:
    """Find a tag anywhere in the tree, ignoring namespaces."""
    for el in root.iter():
        tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
        if tag == local_tag:
            return (el.text or "").strip() or None
    return None


def _xml_raise_fault(root: ET.Element) -> None:
    """Raise if the XML contains a SOAP Fault or a global AFIP error."""
    fault = _xml_find(root, "faultstring")
    if fault:
        raise RuntimeError(f"SOAP Fault: {fault}")
    err_code = _xml_find(root, "ErrCode")
    err_msg  = _xml_find(root, "ErrMsg")
    if err_code and err_code != "0":
        raise RuntimeError(f"AFIP Error {err_code}: {err_msg}")


# ══════════════════════════════════════════════════════════════════════════════
# Disk-based token cache
# ══════════════════════════════════════════════════════════════════════════════

def _token_cache_path(cuit: str, homo: bool) -> Path:
    env = "homo" if homo else "prod"
    _TOKEN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    return _TOKEN_CACHE_DIR / f"token_{cuit}_{env}.json"


def _load_token_from_disk(cuit: str, homo: bool) -> Optional[dict]:
    """
    Load a previously saved token from disk.
    Returns None if missing, corrupt, or expired (with a 5-minute safety margin).
    """
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
        logger.info("WSAA: cached token has expired — will request a new one.")
        path.unlink(missing_ok=True)
        return None
    except Exception as exc:
        logger.warning("WSAA: could not read token from disk: %s", exc)
        path.unlink(missing_ok=True)
        return None


def _save_token_to_disk(cuit: str, homo: bool, token_data: dict) -> None:
    """Persist token data to disk as JSON."""
    path = _token_cache_path(cuit, homo)
    try:
        path.write_text(
            json.dumps(token_data, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        logger.debug("WSAA: token saved to %s", path)
    except Exception as exc:
        logger.warning("WSAA: could not save token to disk: %s", exc)


def _delete_token_from_disk(cuit: str, homo: bool) -> None:
    """Remove a cached token file."""
    _token_cache_path(cuit, homo).unlink(missing_ok=True)


# ══════════════════════════════════════════════════════════════════════════════
# WSAA — Authentication
# ══════════════════════════════════════════════════════════════════════════════

def _build_tra() -> str:
    """Build a TRA (Ticket de Requerimiento de Acceso) XML string."""
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
    """Sign the TRA with the private key → base64-encoded CMS/PKCS7."""
    with tempfile.TemporaryDirectory() as tmp:
        tra_file = os.path.join(tmp, "tra.xml")
        cms_file = os.path.join(tmp, "tra.cms")
        with open(tra_file, "w", encoding="utf-8") as f:
            f.write(tra_xml)
        result = subprocess.run(
            [
                "openssl", "cms", "-sign",
                "-in",      tra_file,
                "-signer",  cert_path,
                "-inkey",   key_path,
                "-nodetach",
                "-outform", "DER",
                "-out",     cms_file,
            ],
            capture_output=True,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"openssl cms sign failed (exit {result.returncode}):\n"
                f"{result.stderr.decode(errors='replace')}"
            )
        with open(cms_file, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")


def wsaa_get_token(cert_path: str, key_path: str, homo: bool = True) -> dict:
    """
    Authenticate against WSAA and return a fresh token dict:
      {"token": str, "sign": str, "expiration": str}

    This function always calls WSAA — use ARCAClient._get_token() for
    cached access.
    """
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
    root = ET.fromstring(raw)
    _xml_raise_fault(root)

    # WSAA returns the inner XML HTML-escaped inside <loginCmsReturn>
    # It must be unescape-parsed as a second XML document to extract token/sign
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

    # Fallback: search directly in the outer tree (some envs may not escape)
    if not token:
        token      = _xml_find(root, "token")
        sign       = _xml_find(root, "sign")
        expiration = _xml_find(root, "expirationTime")

    if not token or not sign:
        raise RuntimeError(f"WSAA: token/sign not found in response:\n{raw[:600]}")

    logger.info("WSAA: ✅ token obtained, expires %s", expiration)
    return {"token": token, "sign": sign, "expiration": expiration}


# ══════════════════════════════════════════════════════════════════════════════
# WSFE — Electronic invoicing
# ══════════════════════════════════════════════════════════════════════════════

_WSFE_NS  = "http://ar.gov.afip.dif.FEV1/"
_WSFE_ACT = "http://ar.gov.afip.dif.FEV1/"


def _wsfe_auth(token: str, sign: str, cuit: str) -> str:
    c = _clean_cuit(cuit)
    return f'<Auth><Token>{token}</Token><Sign>{sign}</Sign><Cuit>{c}</Cuit></Auth>'


def wsfe_get_last_invoice_number(
    token: str,
    sign: str,
    cuit: str,
    punto_venta: int,
    homo: bool = True,
) -> int:
    """
    Query the last authorized invoice number for a given sales point.
    Returns 0 if no invoices have been issued yet.
    """
    host, path = _WSFE["homo" if homo else "prod"]
    auth = _wsfe_auth(token, sign, cuit)
    body = (
        f'<FECompUltimoAutorizado xmlns="{_WSFE_NS}">'
        f'{auth}'
        f'<PtoVta>{punto_venta}</PtoVta>'
        f'<CbteTipo>{INVOICE_TYPE_C}</CbteTipo>'
        f'</FECompUltimoAutorizado>'
    )
    raw  = _soap_call(host, path, f"{_WSFE_ACT}FECompUltimoAutorizado", body)
    root = ET.fromstring(raw)
    _xml_raise_fault(root)
    nro    = _xml_find(root, "CbteNro")
    result = int(nro) if nro and nro.isdigit() else 0
    logger.info("WSFE: last invoice at PV %s = %s", punto_venta, result)
    return result


def wsfe_request_cae(
    token: str,
    sign: str,
    cuit: str,
    punto_venta: int,
    invoice_number: int,
    invoice_date: str,      # "YYYYMMDD"
    total_amount: float,
    client_cuit: str,
    homo: bool = True,
) -> dict:
    """
    Request a CAE (Código de Autorización Electrónica) for a type-C invoice.

    Args:
        cuit:           CUIT of the certificate owner (issuer)
        punto_venta:    sales point number, e.g. 2
        invoice_number: sequential number (last + 1)
        invoice_date:   "20260228"
        total_amount:   e.g. 404315.0
        client_cuit:    recipient CUIT

    Returns:
        {"cae", "cae_vto", "invoice_number", "resultado", "obs", "raw_xml"}
    """
    host, path   = _WSFE["homo" if homo else "prod"]
    auth         = _wsfe_auth(token, sign, cuit)
    client_cuit_clean = _clean_cuit(client_cuit)
    amount_str   = f"{total_amount:.2f}"

    body = f"""
<FECAESolicitar xmlns="{_WSFE_NS}">
  {auth}
  <FeCAEReq>
    <FeCabReq>
      <CantReg>1</CantReg>
      <PtoVta>{punto_venta}</PtoVta>
      <CbteTipo>{INVOICE_TYPE_C}</CbteTipo>
    </FeCabReq>
    <FeDetReq>
      <FECAEDetRequest>
        <Concepto>{CONCEPT_SERVICES}</Concepto>
        <DocTipo>80</DocTipo>
        <DocNro>{client_cuit_clean}</DocNro>
        <CbteDesde>{invoice_number}</CbteDesde>
        <CbteHasta>{invoice_number}</CbteHasta>
        <CbteFch>{invoice_date}</CbteFch>
        <ImpTotal>{amount_str}</ImpTotal>
        <ImpTotConc>0.00</ImpTotConc>
        <ImpNeto>{amount_str}</ImpNeto>
        <ImpOpEx>0.00</ImpOpEx>
        <ImpIVA>0.00</ImpIVA>
        <ImpTrib>0.00</ImpTrib>
        <FchServDesde>{invoice_date}</FchServDesde>
        <FchServHasta>{invoice_date}</FchServHasta>
        <FchVtoPago>{invoice_date}</FchVtoPago>
        <MonId>{CURRENCY_ARS}</MonId>
        <MonCotiz>1</MonCotiz>
        <CondicionIVAReceptorId>5</CondicionIVAReceptorId>
      </FECAEDetRequest>
    </FeDetReq>
  </FeCAEReq>
</FECAESolicitar>
"""
    logger.info(
        "WSFE: requesting CAE PV=%s NRO=%s amount=%s client=%s",
        punto_venta, invoice_number, amount_str, client_cuit_clean,
    )
    raw  = _soap_call(host, path, f"{_WSFE_ACT}FECAESolicitar", body)
    root = ET.fromstring(raw)
    logger.debug("WSFE FECAESolicitar response:\n%s", raw[:1200])

    _xml_raise_fault(root)

    resultado   = _xml_find(root, "Resultado")
    cae         = _xml_find(root, "CAE")
    cae_vto     = _xml_find(root, "CAEFchVto")

    # Collect non-fatal observations
    obs_list: list[str] = []
    for obs_el in root.iter():
        tag = obs_el.tag.split("}")[-1] if "}" in obs_el.tag else obs_el.tag
        if tag == "Obs":
            code = _xml_find(obs_el, "Code")
            msg  = _xml_find(obs_el, "Msg")
            if msg:
                obs_list.append(f"[{code}] {msg}")

    if resultado == "R":
        err_lines = ["WSFE: CAE rejected."]
        err_msgs  = []
        obs_msgs  = []
        for el in root.iter():
            tag = el.tag.split("}")[-1] if "}" in el.tag else el.tag
            if tag == "Err":
                code = _xml_find(el, "Code")
                msg  = _xml_find(el, "Msg")
                if msg:
                    err_msgs.append(f"  ❌ [{code}] {msg}")
            elif tag == "Obs":
                code = _xml_find(el, "Code")
                msg  = _xml_find(el, "Msg")
                if msg:
                    obs_msgs.append(f"  ⚠️  [{code}] {msg}")
        if err_msgs:
            err_lines.append("Errors:")
            err_lines.extend(err_msgs)
        if obs_msgs:
            err_lines.append("Observations:")
            err_lines.extend(obs_msgs)
        if not err_msgs and not obs_msgs:
            err_lines.append(raw)
        raise RuntimeError("\n".join(err_lines))

    if not cae:
        raise RuntimeError(f"WSFE: CAE not returned.\nResponse:\n{raw[:800]}")

    # Format "YYYYMMDD" → "DD/MM/YYYY"
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

    Token management uses a two-layer cache:
      1. In-memory (dict on the instance)  → avoids redundant calls within
                                             the same process lifetime
      2. On-disk   (.token_cache/*.json)   → survives process restarts;
                                             tokens are valid for 12h so
                                             restarting the service should
                                             never trigger a new WSAA call

    If AFIP responds with "TA valido" (token still active but not in cache),
    the stale cache file is removed and a clear error message is raised.
    This edge case only occurs when the process was killed before the token
    expired and no disk cache existed at that time.

    Usage:
        client  = ARCAClient.from_config(settings)
        result  = client.issue_invoice(row)
    """

    def __init__(
        self,
        cert_path: str,
        key_path: str,
        cuit: str,
        homo: bool = True,
    ):
        self.cert_path    = cert_path
        self.key_path     = key_path
        self.cuit         = _clean_cuit(cuit)
        self.homo         = homo
        self._mem_cache: Optional[dict] = None

    @classmethod
    def from_config(cls, settings) -> "ARCAClient":
        """
        Instantiate from a settings object.
        Expected attributes:
          arca_cert_path  → path to .crt file
          arca_key_path   → path to .key file
          arca_cuit       → CUIT of the certificate owner
          arca_homo       → "true" / "false"  (default: "true")
        """
        homo = str(getattr(settings, "arca_homo", "true")).lower() != "false"
        return cls(
            cert_path = getattr(settings, "arca_cert_path", ""),
            key_path  = getattr(settings, "arca_key_path",  ""),
            cuit      = getattr(settings, "arca_cuit",      ""),
            homo      = homo,
        )

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _is_valid(self, token_data: dict) -> bool:
        """Return True if the token has more than 5 minutes of validity left."""
        try:
            exp = datetime.fromisoformat(token_data["expiration"])
            if exp.tzinfo is None:
                exp = exp.replace(tzinfo=timezone.utc)
            return datetime.now(timezone.utc) < exp - timedelta(minutes=5)
        except Exception:
            return False

    def _get_token(self) -> dict:
        """
        Return a valid token+sign dict.
        Resolution order: memory → disk → WSAA (new request).
        """
        # 1. Memory cache
        if self._mem_cache and self._is_valid(self._mem_cache):
            return self._mem_cache

        # 2. Disk cache
        disk = _load_token_from_disk(self.cuit, self.homo)
        if disk and self._is_valid(disk):
            self._mem_cache = disk
            return self._mem_cache

        # 3. Request a new token from WSAA
        logger.info("WSAA: requesting new token from AFIP...")
        try:
            token_data = wsaa_get_token(self.cert_path, self.key_path, self.homo)
        except RuntimeError as exc:
            if "TA valido" in str(exc):
                # AFIP reports an active token, but we don't have it locally.
                # This happens when the process restarted before the token expired
                # and no disk cache was written. Clean up and surface a clear error.
                _delete_token_from_disk(self.cuit, self.homo)
                self._mem_cache = None
                raise RuntimeError(
                    "AFIP reports an active token that is not available in local cache "
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
        return wsfe_get_last_invoice_number(
            t["token"], t["sign"],
            self.cuit,
            punto_venta,
            self.homo,
        )

    def issue_invoice(self, row: dict) -> dict:
        """
        Issue an invoice in AFIP from an xlsx row dict.

        Expected keys in row:
          comp_nro       → "C00002-00000144"  (sales point extracted from this)
          fecha_emision  → "16/02/2026"
          amount         → 137520.5
          cuit_cliente   → "33-54445107-9"

        Returns:
          {"cae", "cae_vto", "invoice_number", "obs", "raw_xml"}
        """
        # Extract sales point from comp_nro: "C00002-00000144" → 2
        m  = re.match(r"[Cc](\d+)-", row.get("comp_nro", ""))
        pv = int(m.group(1)) if m else 2

        # Convert date "16/02/2026" → "20260216"
        fecha_str = row.get("fecha_emision", "")
        if "/" in fecha_str:
            d, mo, y = fecha_str.split("/")
            invoice_date = f"{y}{mo}{d}"
        else:
            invoice_date = datetime.now().strftime("%Y%m%d")

        last_number    = self.get_last_invoice_number(pv)
        invoice_number = last_number + 1

        t = self._get_token()
        return wsfe_request_cae(
            token          = t["token"],
            sign           = t["sign"],
            cuit           = self.cuit,
            punto_venta    = pv,
            invoice_number = invoice_number,
            invoice_date   = invoice_date,
            total_amount   = float(row.get("amount", 0)),
            client_cuit    = row.get("cuit_cliente", ""),
            homo           = self.homo,
        )

    # Keep Spanish alias so the controller doesn't need updating
    def emitir_factura(self, row: dict) -> dict:
        """Alias for issue_invoice() — kept for backwards compatibility."""
        result = self.issue_invoice(row)
        # Map new key name back to the old one expected by the controller
        result.setdefault("cbte_nro", result.get("invoice_number"))
        return result