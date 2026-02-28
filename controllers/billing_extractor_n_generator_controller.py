# billing_extractor_n_generator_controller.py
"""
Billing Extraction and Generation Controller
- Parses input xlsx
- Renders invoices from static/templates/invoice_template.html
- Embeds logo from static/img/logo_factura.png as base64
- Generates PDFs via wkhtmltopdf with HTML fallback
- Reads issuer data from settings (.env)

xlsx column layout (v2, no header row):
  0: fecha_emision        → invoice date
  1: cuit_cliente         → client CUIT
  2: razon_social_cliente → client business name
  3: domicilio_cliente    → client address
  4: nombre_contacto      → contact name
  5: descripcion          → service description
  6: importe              → amount
  7: comp_nro             → invoice number (e.g. C00002-00000144)
  8: cae_number           → CAE (filled after AFIP registration)
  9: vencimiento          → CAE expiration date
"""

import base64
import io
import json
import logging
import os
import re
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse, StreamingResponse
from fastapi.templating import Jinja2Templates

from common.util.std_in_out.root_locator import RootLocator

logger = logging.getLogger(__name__)


# ── ARCA client factory ────────────────────────────────────────────────────────

def _get_arca_client():
    """
    Return (ARCAClient, None) if fully configured,
    or (None, "error message") if something is missing.
    """
    try:
        from common.config.settings import get_settings
        from service_client.ARCA_client import ARCAClient

        s    = get_settings()
        cuit = getattr(s, "arca_cuit",      None)
        cert = getattr(s, "arca_cert_path", None)
        key  = getattr(s, "arca_key_path",  None)

        if not cuit or not cert or not key:
            return None, "ARCA not configured in .env (missing ARCA_CUIT, ARCA_CERT_PATH or ARCA_KEY_PATH)"

        root     = Path(RootLocator.get_root())
        cert_abs = str(root / cert)
        key_abs  = str(root / key)

        if not Path(cert_abs).exists():
            return None, f"Certificate not found: {cert_abs}"
        if not Path(key_abs).exists():
            return None, f"Private key not found: {key_abs}"

        homo   = str(getattr(s, "arca_homo", "true")).lower() != "false"
        client = ARCAClient(cert_path=cert_abs, key_path=key_abs, cuit=cuit, homo=homo)
        return client, None

    except Exception as exc:
        return None, str(exc)


# ── Path helpers ───────────────────────────────────────────────────────────────

def _root() -> Path:
    return Path(RootLocator.get_root())

def _template_path() -> Path:
    return _root() / "static" / "templates" / "invoice_template.html"

def _logo_path() -> Path:
    return _root() / "static" / "img" / "logo_factura.png"

def _modelo_xlsx_path() -> Path:
    return _root() / "static" / "downloads" / "modelo_facturacion.xlsx"


# ── Logo loader ────────────────────────────────────────────────────────────────

def _load_logo_tag() -> str:
    """Return an <img> tag with the logo embedded as base64, or '' if missing."""
    path = _logo_path()
    if not path.exists():
        logger.warning("Logo not found at %s — skipping", path)
        return ""
    try:
        data = base64.b64encode(path.read_bytes()).decode("ascii")
        ext  = path.suffix.lstrip(".").lower()
        mime = "image/png" if ext == "png" else f"image/{ext}"
        return f'<img class="inv-logo" src="data:{mime};base64,{data}" alt="Company Logo">'
    except Exception as exc:
        logger.warning("Could not load logo: %s", exc)
        return ""


# ── Template loader ────────────────────────────────────────────────────────────

def _load_template() -> str:
    path = _template_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Invoice template not found at: {path}\n"
            "Place invoice_template.html in static/templates/"
        )
    return path.read_text(encoding="utf-8")


# ── Formatting helpers ─────────────────────────────────────────────────────────

def _fmt_ar(val: float) -> str:
    """Format a number using Argentine locale: 1.234.567,89"""
    return f"{val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


def _extract_pv_comp(comp_nro: str) -> tuple[str, str]:
    """Extract (sales_point, invoice_seq) from 'C00002-00000144'."""
    m = re.match(r"[Cc](\d{5})-(\d{8})", comp_nro)
    return (m.group(1), m.group(2)) if m else ("00002", "00000000")


def _extract_dni(cuit: str) -> str:
    """Extract the DNI portion from a CUIT string."""
    m = re.match(r"\d{2}-(\d{7,8})-\d", cuit)
    return m.group(1) if m else ""


def _is_skippable(row: dict) -> tuple[bool, str]:
    """
    Return (should_skip, reason).
    Rows missing required data or marked as pending are skipped.
    """
    comp = str(row.get("comp_nro", "")).strip().upper()
    if not comp:
        return True, "Empty comp_nro"
    if comp.startswith("EMITIR"):
        return True, f"Pending emission: {row.get('comp_nro', '')}"
    if not row.get("amount") or row.get("amount", 0) == 0:
        return True, "Zero or missing amount"
    if not row.get("razon_social_cliente"):
        return True, "Missing client business name"
    return False, ""


def _fmt_date(val) -> str:
    """Normalize various date representations to DD/MM/YYYY."""
    import datetime
    if val is None:
        return ""
    if isinstance(val, (datetime.date, datetime.datetime)):
        return val.strftime("%d/%m/%Y")
    s = str(val).strip()
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", s)
    if m:
        return f"{m.group(3)}/{m.group(2)}/{m.group(1)}"
    return s.split(" ")[0]


# ── Invoice HTML builder ───────────────────────────────────────────────────────

def _build_invoice_html(row: dict, emisor: dict, copy_label: str = "ORIGINAL") -> str:
    """
    Load invoice_template.html and substitute all {{TOKEN}} placeholders.
    The logo is embedded as base64 so it works in both browsers and wkhtmltopdf.
    """
    template   = _load_template()
    logo_tag   = _load_logo_tag()
    pv, comp   = _extract_pv_comp(row["comp_nro"])
    dni        = _extract_dni(row["cuit_cliente"])
    amount_str = _fmt_ar(row["amount"])
    fecha      = row["fecha_emision"]
    vto        = row.get("vencimiento") or fecha

    dni_row = (
        f'<span class="f-label">DNI</span>'
        f'<span class="f-value">{dni}</span>'
        if dni else ""
    )

    cae_row = row["cae_number"] if row.get("cae_number") else "Sin CAE registrado"

    tokens = {
        "{{COPY_LABEL}}":            copy_label,
        "{{LOGO_TAG}}":              logo_tag,
        "{{EMISOR_RAZON_SOCIAL}}":   emisor["razon_social"],
        "{{EMISOR_DOMICILIO}}":      emisor["domicilio"],
        "{{EMISOR_COND_IVA}}":       emisor["cond_iva"],
        "{{EMISOR_CUIT}}":           emisor["cuit"],
        "{{EMISOR_IB}}":             emisor["ib"],
        "{{EMISOR_INICIO_ACT}}":     emisor["inicio_act"],
        "{{PUNTO_VENTA}}":           pv,
        "{{COMP_NRO}}":              comp,
        "{{FECHA_EMISION}}":         fecha,
        "{{VENCIMIENTO}}":           vto,
        "{{CLIENTE_RAZON_SOCIAL}}":  row["razon_social_cliente"],
        "{{CLIENTE_CUIT}}":          row["cuit_cliente"],
        "{{CLIENTE_DOMICILIO}}":     row["domicilio_cliente"],
        "{{DNI_ROW}}":               dni_row,
        "{{DESCRIPCION}}":           row["descripcion"],
        "{{IMPORTE}}":               amount_str,
        "{{CAE_ROW}}":               cae_row,
    }

    result = template
    for token, value in tokens.items():
        result = result.replace(token, str(value))
    return result


# ── PDF generation ─────────────────────────────────────────────────────────────

def _html_to_pdf_bytes(html_content: str) -> Optional[bytes]:
    """
    Convert HTML → PDF using wkhtmltopdf.
    The logo is already embedded as base64, so no external file access is needed.
    Returns None if wkhtmltopdf is not available.
    """
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            html_path = os.path.join(tmpdir, "invoice.html")
            pdf_path  = os.path.join(tmpdir, "invoice.pdf")

            with open(html_path, "w", encoding="utf-8") as f:
                f.write(html_content)

            cmd = [
                "wkhtmltopdf",
                "--quiet",
                "--page-size",     "A4",
                "--encoding",      "UTF-8",
                "--margin-top",    "0",
                "--margin-bottom", "0",
                "--margin-left",   "0",
                "--margin-right",  "0",
                "--enable-local-file-access",
                html_path,
                pdf_path,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=30)

            if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 500:
                with open(pdf_path, "rb") as f:
                    return f.read()

            logger.error(
                "wkhtmltopdf produced no output. stderr: %s",
                result.stderr.decode("utf-8", errors="replace"),
            )
            return None

    except FileNotFoundError:
        logger.warning("wkhtmltopdf not found in PATH")
        return None
    except subprocess.TimeoutExpired:
        logger.error("wkhtmltopdf timed out after 30s")
        return None
    except Exception as exc:
        logger.exception("Error generating PDF: %s", exc)
        return None


# ── xlsx parser ────────────────────────────────────────────────────────────────

def _parse_xlsx(file_bytes: bytes) -> list[dict]:
    """
    Parse the input xlsx file into a list of row dicts.
    See module docstring for column layout.
    """
    df   = pd.read_excel(io.BytesIO(file_bytes), header=None, dtype=str)
    rows = []

    for i, row in df.iterrows():
        fecha = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        if not fecha or fecha.lower() in ("nan", "none", ""):
            continue

        try:
            amount = float(str(row.iloc[6]).replace(",", "."))
        except (ValueError, TypeError):
            amount = 0.0

        def _col(idx: int) -> str:
            return str(row.iloc[idx]).strip() if len(row) > idx and pd.notna(row.iloc[idx]) else ""

        # CAE: strip trailing ".0" artifacts from float-parsed strings
        cae_clean = re.sub(r"\.0+$", "", _col(8)).strip()
        if cae_clean.lower() in ("nan", "none", ""):
            cae_clean = ""

        venc_clean = re.sub(r"VENCIMIENTO\s*", "", _col(9), flags=re.IGNORECASE).strip()
        if venc_clean.lower() in ("nan", "none"):
            venc_clean = ""

        rows.append({
            "idx":                   i,
            "fecha_emision":         _fmt_date(fecha),
            "cuit_cliente":          _col(1),
            "razon_social_cliente":  _col(2),
            "domicilio_cliente":     _col(3),
            "nombre_contacto":       _col(4),
            "descripcion":           _col(5),
            "amount":                amount,
            "comp_nro":              _col(7),
            "cae_number":            cae_clean,
            "vencimiento":           venc_clean,
        })

    return rows


# ══════════════════════════════════════════════════════════════════════════════
# Controller
# ══════════════════════════════════════════════════════════════════════════════

class BillingExtractorNGeneratorController:
    """
    FastAPI controller — mounted at /billing_extractor_n_generator

    Routes:
        GET  /                → HTML page
        POST /parse_xlsx      → Excel → JSON rows
        POST /generate_pdf    → { row, emisor } → PDF binary
        POST /generate_all    → Excel + emisor → ZIP of PDFs
        GET  /download_modelo → Download sample Excel template
        GET  /emisor_settings → Issuer data from .env (for UI pre-fill)
        POST /registrar_arca  → Register one invoice in AFIP and return CAE
    """

    def __init__(self):
        self.router = APIRouter(prefix="/billing_extractor_n_generator")

        templates_path = os.path.join(RootLocator.get_root(), "templates")
        self.templates = Jinja2Templates(directory=templates_path)

        try:
            from common.config.settings import get_settings
            self._settings = get_settings()
        except Exception:
            self._settings = None

        # ── Route definitions ──────────────────────────────────────────────────

        @self.router.get("/", response_class=HTMLResponse)
        async def page(request: Request):
            return self.templates.TemplateResponse(
                "billing_extractor_n_generator.html",
                {"request": request},
            )

        @self.router.get("/emisor_settings")
        async def emisor_settings():
            """Return issuer data from .env for UI pre-population."""
            try:
                s = self._settings
                if s is None:
                    raise ValueError("Settings not available")

                cond_iva_map = {
                    "RESP_MONOTR": "Responsable Monotributo",
                    "RESP_INSCR":  "Responsable Inscripto",
                }
                cond_iva_code  = getattr(s, "emisor_cond_iva", "RESP_MONOTR")
                cond_iva_label = cond_iva_map.get(cond_iva_code.upper(), "Responsable Monotributo")

                return JSONResponse({
                    "status":        "ok",
                    "razon_social":  getattr(s, "emisor_razon_social", ""),
                    "cuit":          getattr(s, "emisor_cuit",         ""),
                    "domicilio":     getattr(s, "emisor_domicilio",    ""),
                    "ib":            getattr(s, "emisor_ib",           ""),
                    "inicio_act":    getattr(s, "emisor_inicio_act",   ""),
                    "cond_iva":      cond_iva_label,
                    "cond_iva_code": cond_iva_code,
                })
            except Exception as exc:
                logger.exception("Error reading issuer settings")
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)

        @self.router.get("/download_modelo")
        async def download_modelo():
            """Download the sample xlsx template."""
            path = _modelo_xlsx_path()
            if not path.exists():
                return JSONResponse(
                    {"status": "error", "message": "Template file not found in static/downloads/"},
                    status_code=404,
                )
            return StreamingResponse(
                io.BytesIO(path.read_bytes()),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": 'attachment; filename="modelo_facturacion.xlsx"'},
            )

        @self.router.post("/parse_xlsx")
        async def parse_xlsx(file: UploadFile = File(...)):
            try:
                rows    = _parse_xlsx(await file.read())
                valid   = []
                skipped = []
                for r in rows:
                    skip, reason = _is_skippable(r)
                    if skip:
                        skipped.append({"comp_nro": r.get("comp_nro", ""), "motivo": reason})
                    else:
                        valid.append(r)

                return JSONResponse({
                    "status":         "ok",
                    "total":          len(rows),
                    "valid":          len(valid),
                    "skipped":        len(skipped),
                    "skipped_detail": skipped,
                    "rows":           rows,
                })
            except Exception as exc:
                logger.exception("Error parsing xlsx")
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=400)

        @self.router.post("/generate_pdf")
        async def generate_pdf(request: Request):
            """
            Expects JSON: { row: {...}, emisor: {...}, copy_label?: "ORIGINAL" }
            Returns: PDF binary or HTML fallback if wkhtmltopdf is unavailable.
            """
            try:
                body       = await request.json()
                row        = body.get("row", {})
                emisor     = body.get("emisor", {})
                copy_label = body.get("copy_label", "ORIGINAL")

                invoice_html = _build_invoice_html(row, emisor, copy_label)
                safe_name    = re.sub(r"[^a-zA-Z0-9_\-]", "_", row.get("comp_nro", "invoice"))
                pdf_bytes    = _html_to_pdf_bytes(invoice_html)

                if pdf_bytes:
                    return StreamingResponse(
                        io.BytesIO(pdf_bytes),
                        media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="factura_{safe_name}.pdf"'},
                    )

                logger.warning("wkhtmltopdf unavailable — returning HTML for printing")
                return StreamingResponse(
                    io.BytesIO(invoice_html.encode("utf-8")),
                    media_type="text/html",
                    headers={
                        "Content-Disposition": f'inline; filename="{safe_name}.html"',
                        "X-Pdf-Backend": "none",
                    },
                )

            except FileNotFoundError as exc:
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)
            except Exception as exc:
                logger.exception("Error generating PDF")
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)

        @self.router.post("/generate_all")
        async def generate_all(
            file:        UploadFile = File(...),
            emisor_json: str        = Form(...),
        ):
            """Batch: Excel + issuer JSON → ZIP of PDFs (or HTML fallback files)."""
            import zipfile
            try:
                emisor     = json.loads(emisor_json)
                rows       = _parse_xlsx(await file.read())
                valid_rows = [r for r in rows if not _is_skippable(r)[0]]

                if not valid_rows:
                    skipped_detail = [
                        {
                            "comp_nro": r.get("comp_nro", f"row {r['idx']}"),
                            "motivo":   _is_skippable(r)[1],
                        }
                        for r in rows
                    ]
                    return JSONResponse(
                        {"status": "error", "message": "No valid rows to generate.", "detalle": skipped_detail},
                        status_code=400,
                    )

                zip_buffer = io.BytesIO()
                with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                    for row in valid_rows:
                        invoice_html = _build_invoice_html(row, emisor)
                        safe_name    = re.sub(r"[^a-zA-Z0-9_\-]", "_", row["comp_nro"])
                        pdf_bytes    = _html_to_pdf_bytes(invoice_html)
                        if pdf_bytes:
                            zf.writestr(f"factura_{safe_name}.pdf", pdf_bytes)
                        else:
                            zf.writestr(f"factura_{safe_name}.html", invoice_html.encode("utf-8"))

                zip_buffer.seek(0)
                return StreamingResponse(
                    zip_buffer,
                    media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="facturas.zip"'},
                )

            except FileNotFoundError as exc:
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)
            except Exception as exc:
                logger.exception("Error in generate_all")
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)

        @self.router.post("/registrar_arca")
        async def registrar_arca(request: Request):
            """
            Register a single invoice in ARCA/AFIP and return the full debug log.

            Request JSON: { row: {...} }
            Response: {
                status:   "ok" | "error" | "not_configured",
                log:      [...],   ← lines for the debug console
                cae:      str,
                cae_vto:  str,
                cbte_nro: int
            }
            """
            log_lines: list[str] = []

            def log(msg: str) -> None:
                log_lines.append(msg)
                logger.info("[ARCA] %s", msg)

            try:
                body = await request.json()
                row  = body.get("row", {})

                log("── Iniciando registro en ARCA ──────────────────")

                client, err = _get_arca_client()
                if err:
                    log(f"❌ Error de configuración: {err}")
                    return JSONResponse({"status": "not_configured", "log": log_lines, "error": err})

                log(f"🌐 Ambiente: {'HOMOLOGACIÓN' if client.homo else 'PRODUCCIÓN'}")
                log(f"🔑 CUIT autenticante: {client.cuit}")
                log(f"📄 Certificado: {Path(client.cert_path).name}")

                # Step 1: WSAA token
                log("")
                log("── WSAA: obteniendo token ──────────────────────")
                try:
                    token_data = client._get_token()
                    log(f"✅ Token OK  |  expira: {token_data.get('expiration', '?')}")
                except Exception as exc:
                    log(f"❌ WSAA falló: {exc}")
                    return JSONResponse({"status": "error", "log": log_lines, "error": str(exc)})

                # Step 2: last invoice number
                m  = re.match(r"[Cc](\d+)-", row.get("comp_nro", ""))
                pv = int(m.group(1)) if m else 2
                log("")
                log(f"── WSFE: consultando último comprobante PV={pv} ─")
                try:
                    ultimo   = client.get_last_invoice_number(pv)
                    cbte_nro = ultimo + 1
                    log(f"✅ Último emitido: {ultimo}  →  nuevo será: {cbte_nro}")
                except Exception as exc:
                    log(f"❌ FECompUltimoAutorizado falló: {exc}")
                    return JSONResponse({"status": "error", "log": log_lines, "error": str(exc)})

                # Step 3: request CAE
                log("")
                log("── WSFE: solicitando CAE ───────────────────────")
                log(f"   Fecha:   {row.get('fecha_emision', '?')}")
                log(f"   Importe: {row.get('amount', '?')}")
                log(f"   CUIT cliente: {row.get('cuit_cliente', '?')}")
                try:
                    result = client.issue_invoice(row)
                    log(f"✅ CAE obtenido: {result['cae']}")
                    log(f"   Vto CAE:  {result['cae_vto']}")
                    log(f"   Cbte Nro: {result['invoice_number']}")
                    if result.get("obs"):
                        log("")
                        log("⚠️  Observaciones AFIP:")
                        for obs in result["obs"]:
                            log(f"   {obs}")
                    log("")
                    log("── XML respuesta completa ──────────────────────")
                    raw = result.get("raw_xml", "")
                    for chunk in [raw[i:i+120] for i in range(0, min(len(raw), 1200), 120)]:
                        log(chunk)
                    if len(raw) > 1200:
                        log(f"   ... ({len(raw)} chars total, showing first 1200)")

                    return JSONResponse({
                        "status":   "ok",
                        "log":      log_lines,
                        "cae":      result["cae"],
                        "cae_vto":  result["cae_vto"],
                        "cbte_nro": result["invoice_number"],
                    })

                except Exception as exc:
                    log(f"❌ FECAESolicitar falló: {exc}")
                    return JSONResponse({"status": "error", "log": log_lines, "error": str(exc)})

            except Exception as exc:
                log_lines.append(f"❌ Error inesperado: {exc}")
                logger.exception("Unexpected error in registrar_arca")
                return JSONResponse({"status": "error", "log": log_lines, "error": str(exc)}, status_code=500)