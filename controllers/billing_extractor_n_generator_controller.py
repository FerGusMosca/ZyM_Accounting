# billing_extractor_n_generator_controller.py
"""
Controller for Billing Extractor & Generator
- Parses input xlsx
- Renders invoices from static/templates/invoice_template.html
- Embeds logo from static/img/logo_factura.png as base64 (works in both web + PDF)
- Generates PDFs via wkhtmltopdf (subprocess) with fallback to print-dialog HTML
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


# ── Paths ──────────────────────────────────────────────────────────────────────
def _root() -> Path:
    return Path(RootLocator.get_root())

def _template_path() -> Path:
    return _root() / "static" / "templates" / "invoice_template.html"

def _logo_path() -> Path:
    return _root() / "static" / "img" / "logo_factura.png"


# ── Logo loader ────────────────────────────────────────────────────────────────
def _load_logo_tag() -> str:
    """Return an <img> tag with logo embedded as base64, or '' if not found."""
    path = _logo_path()
    if not path.exists():
        logger.warning(f"Logo not found at {path} — skipping")
        return ""
    try:
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        ext  = path.suffix.lstrip(".").lower()
        mime = "image/png" if ext == "png" else f"image/{ext}"
        return f'<img class="inv-logo" src="data:{mime};base64,{data}" alt="Logo">'
    except Exception as e:
        logger.warning(f"Could not load logo: {e}")
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


# ── Helpers ────────────────────────────────────────────────────────────────────
def _fmt_ar(val: float) -> str:
    return f"{val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

def _extract_pv_comp(comp_nro: str) -> tuple[str, str]:
    m = re.match(r"[Cc](\d{5})-(\d{8})", comp_nro)
    return (m.group(1), m.group(2)) if m else ("00002", "00000000")

def _extract_dni(cuit: str) -> str:
    m = re.match(r"\d{2}-(\d{7,8})-\d", cuit)
    return m.group(1) if m else ""

def _is_skippable(row: dict) -> bool:
    comp = row.get("comp_nro", "").upper()
    return comp.startswith("EMITIR") or comp == "" or not row.get("amount")

def _fmt_date(val) -> str:
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
    Logo is embedded as base64 — renders correctly in both browser and wkhtmltopdf.
    """
    template   = _load_template()
    logo_tag   = _load_logo_tag()
    pv, comp   = _extract_pv_comp(row["comp_nro"])
    dni        = _extract_dni(row["cuit_cliente"])
    amount_str = _fmt_ar(row["amount"])
    fecha      = row["fecha_emision"]
    vto        = row["vencimiento"] or fecha

    dni_row = (
        f'<div class="inv-field"><span class="inv-label">DNI:</span> {dni}</div>'
        if dni else ""
    )
    cae_row = (
        f'<div class="cae-line"><strong>CAE N°:</strong> {row["cae_number"]}</div>'
        if row.get("cae_number") else ""
    )

    tokens = {
        "{{COPY_LABEL}}":          copy_label,
        "{{LOGO_TAG}}":            logo_tag,
        "{{EMISOR_RAZON_SOCIAL}}": emisor["razon_social"],
        "{{EMISOR_DOMICILIO}}":    emisor["domicilio"],
        "{{EMISOR_COND_IVA}}":     emisor["cond_iva"],
        "{{EMISOR_CUIT}}":         emisor["cuit"],
        "{{EMISOR_IB}}":           emisor["ib"],
        "{{EMISOR_INICIO_ACT}}":   emisor["inicio_act"],
        "{{PUNTO_VENTA}}":         pv,
        "{{COMP_NRO}}":            comp,
        "{{FECHA_EMISION}}":       fecha,
        "{{VENCIMIENTO}}":         vto,
        "{{CLIENTE_NOMBRE}}":      row["nombre_cliente"],
        "{{CLIENTE_DOMICILIO}}":   row["domicilio_cliente"],
        "{{DNI_ROW}}":             dni_row,
        "{{DESCRIPCION}}":         row["descripcion"],
        "{{IMPORTE}}":             amount_str,
        "{{CAE_ROW}}":             cae_row,
    }

    html = template
    for token, value in tokens.items():
        html = html.replace(token, value)
    return html


# ── PDF via wkhtmltopdf ────────────────────────────────────────────────────────
def _html_to_pdf_bytes(html_content: str) -> Optional[bytes]:
    """
    Convert HTML → PDF using wkhtmltopdf.
    Logo is already base64-embedded so no external file access issues.
    Returns None if wkhtmltopdf is unavailable or fails.
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
                "--margin-top",    "10",
                "--margin-bottom", "12",
                "--margin-left",   "14",
                "--margin-right",  "14",
                "--enable-local-file-access",
                html_path,
                pdf_path,
            ]

            result = subprocess.run(cmd, capture_output=True, timeout=30)

            # wkhtmltopdf exits 1 on non-fatal warnings but still produces a valid PDF
            if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 500:
                with open(pdf_path, "rb") as f:
                    return f.read()

            stderr = result.stderr.decode("utf-8", errors="replace")
            logger.error(f"wkhtmltopdf produced no output. stderr: {stderr}")
            return None

    except FileNotFoundError:
        logger.warning("wkhtmltopdf not found in PATH")
        return None
    except subprocess.TimeoutExpired:
        logger.error("wkhtmltopdf timed out after 30s")
        return None
    except Exception as e:
        logger.exception(f"PDF generation error: {e}")
        return None


# ── XLSX parser ────────────────────────────────────────────────────────────────
def _parse_xlsx(file_bytes: bytes) -> list[dict]:
    """
    Column layout (no header row):
    0: fecha_emision | 1: cuit_cliente | 2: domicilio_cliente | 3: nombre_cliente
    4: descripcion   | 5: importe      | 6: comp_nro          | 7: cae_number
    8: vencimiento
    """
    df = pd.read_excel(io.BytesIO(file_bytes), header=None, dtype=str)
    rows = []

    for i, row in df.iterrows():
        fecha = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        if not fecha or fecha.lower() in ("nan", "none", ""):
            continue

        try:
            amount = float(str(row.iloc[5]).replace(",", "."))
        except (ValueError, TypeError):
            amount = 0.0

        cae_raw   = str(row.iloc[7]).strip() if pd.notna(row.iloc[7]) else ""
        cae_clean = re.sub(r"\.0+$", "", cae_raw).strip()
        if cae_clean.lower() in ("nan", "none", ""):
            cae_clean = ""

        venc_raw   = str(row.iloc[8]).strip() if pd.notna(row.iloc[8]) else ""
        venc_clean = re.sub(r"VENCIMIENTO\s*", "", venc_raw, flags=re.IGNORECASE).strip()
        if venc_clean.lower() in ("nan", "none"):
            venc_clean = ""

        rows.append({
            "idx":               i,
            "fecha_emision":     _fmt_date(fecha),
            "cuit_cliente":      str(row.iloc[1]).strip() if pd.notna(row.iloc[1]) else "",
            "domicilio_cliente": str(row.iloc[2]).strip() if pd.notna(row.iloc[2]) else "",
            "nombre_cliente":    str(row.iloc[3]).strip() if pd.notna(row.iloc[3]) else "",
            "descripcion":       str(row.iloc[4]).strip() if pd.notna(row.iloc[4]) else "",
            "amount":            amount,
            "comp_nro":          str(row.iloc[6]).strip() if pd.notna(row.iloc[6]) else "",
            "cae_number":        cae_clean,
            "vencimiento":       venc_clean,
        })

    return rows


# ── Controller ─────────────────────────────────────────────────────────────────
class BillingExtractorNGeneratorController:
    """
    FastAPI controller — registers at prefix /billing_extractor_n_generator

    Routes:
        GET  /             → HTML page
        POST /parse_xlsx   → Excel → JSON rows
        POST /generate_pdf → { row, emisor } → PDF binary
        POST /generate_all → Excel + emisor → ZIP of PDFs
    """

    def __init__(self):
        self.router = APIRouter(prefix="/billing_extractor_n_generator")

        templates_path = os.path.join(RootLocator.get_root(), "templates")
        self.templates = Jinja2Templates(directory=templates_path)

        @self.router.get("/", response_class=HTMLResponse)
        async def page(request: Request):
            return self.templates.TemplateResponse(
                "billing_extractor_n_generator.html",
                {"request": request}
            )

        @self.router.post("/parse_xlsx")
        async def parse_xlsx(file: UploadFile = File(...)):
            try:
                file_bytes = await file.read()
                rows    = _parse_xlsx(file_bytes)
                valid   = [r for r in rows if not _is_skippable(r)]
                skipped = [r for r in rows if _is_skippable(r)]
                return JSONResponse({
                    "status":  "ok",
                    "total":   len(rows),
                    "valid":   len(valid),
                    "skipped": len(skipped),
                    "rows":    rows,
                })
            except Exception as e:
                logger.exception("Error parsing xlsx")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=400)

        @self.router.post("/generate_pdf")
        async def generate_pdf(request: Request):
            """
            Expects JSON body: { row: {...}, emisor: {...}, copy_label?: "ORIGINAL" }
            Returns: PDF (application/pdf) or HTML fallback if no PDF backend.
            """
            try:
                body       = await request.json()
                row        = body.get("row", {})
                emisor     = body.get("emisor", {})
                copy_label = body.get("copy_label", "ORIGINAL")

                html      = _build_invoice_html(row, emisor, copy_label)
                safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", row.get("comp_nro", "factura"))
                filename  = f"factura_{safe_name}.pdf"

                pdf_bytes = _html_to_pdf_bytes(html)

                if pdf_bytes:
                    return StreamingResponse(
                        io.BytesIO(pdf_bytes),
                        media_type="application/pdf",
                        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
                    )
                else:
                    logger.warning("wkhtmltopdf unavailable — returning HTML for browser print")
                    return StreamingResponse(
                        io.BytesIO(html.encode("utf-8")),
                        media_type="text/html",
                        headers={
                            "Content-Disposition": f'inline; filename="{safe_name}.html"',
                            "X-Pdf-Backend": "none",
                        },
                    )

            except FileNotFoundError as e:
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)
            except Exception as e:
                logger.exception("Error generating PDF")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

        @self.router.post("/generate_all")
        async def generate_all(
            file:        UploadFile = File(...),
            emisor_json: str        = Form(...),
        ):
            """
            Batch: Excel file + emisor JSON → ZIP archive of PDFs (or HTML fallbacks).
            """
            import zipfile
            try:
                emisor     = json.loads(emisor_json)
                file_bytes = await file.read()
                rows       = _parse_xlsx(file_bytes)
                valid_rows = [r for r in rows if not _is_skippable(r)]

                if not valid_rows:
                    return JSONResponse(
                        {"status": "error", "message": "No hay filas válidas para generar."},
                        status_code=400,
                    )

                zip_buffer = io.BytesIO()
                with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zf:
                    for row in valid_rows:
                        html      = _build_invoice_html(row, emisor)
                        pdf_bytes = _html_to_pdf_bytes(html)
                        safe_name = re.sub(r"[^a-zA-Z0-9_\-]", "_", row["comp_nro"])
                        if pdf_bytes:
                            zf.writestr(f"factura_{safe_name}.pdf", pdf_bytes)
                        else:
                            zf.writestr(f"factura_{safe_name}.html", html.encode("utf-8"))

                zip_buffer.seek(0)
                return StreamingResponse(
                    zip_buffer,
                    media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="facturas.zip"'},
                )

            except FileNotFoundError as e:
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)
            except Exception as e:
                logger.exception("Error in generate_all")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)