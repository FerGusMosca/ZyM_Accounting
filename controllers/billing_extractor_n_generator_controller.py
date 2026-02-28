# billing_extractor_n_generator_controller.py
"""
Controlador para Extracción y Generación de Facturas
- Parsea xlsx de entrada
- Renderiza facturas desde static/templates/invoice_template.html
- Embebe logo desde static/img/logo_factura.png en base64
- Genera PDFs vía wkhtmltopdf con fallback HTML
- Lee datos del emisor desde settings (.env)

Nuevo layout de columnas del xlsx (v2, sin fila de encabezado):
  0: fecha_emision
  1: cuit_cliente
  2: razon_social_cliente   ← NUEVA col (era nombre antes)
  3: domicilio_cliente      ← NUEVA col
  4: nombre_contacto        ← antes era col 2
  5: descripcion            ← antes era col 4
  6: importe                ← antes era col 5
  7: comp_nro               ← antes era col 6
  8: cae_number             ← antes era col 7
  9: vencimiento            ← antes era col 8
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


# ── Rutas ──────────────────────────────────────────────────────────────────────
def _root() -> Path:
    return Path(RootLocator.get_root())

def _template_path() -> Path:
    return _root() / "static" / "templates" / "invoice_template.html"

def _logo_path() -> Path:
    return _root() / "static" / "img" / "logo_factura.png"

def _modelo_xlsx_path() -> Path:
    return _root() / "static" / "downloads" / "modelo_facturacion.xlsx"


# ── Carga de logo ──────────────────────────────────────────────────────────────
def _load_logo_tag() -> str:
    """Retorna un <img> con el logo embebido en base64, o '' si no existe."""
    path = _logo_path()
    if not path.exists():
        logger.warning(f"Logo no encontrado en {path} — omitiendo")
        return ""
    try:
        with open(path, "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        ext  = path.suffix.lstrip(".").lower()
        mime = "image/png" if ext == "png" else f"image/{ext}"
        return f'<img class="inv-logo" src="data:{mime};base64,{data}" alt="Logo Empresa">'
    except Exception as e:
        logger.warning(f"No se pudo cargar el logo: {e}")
        return ""


# ── Carga de template ──────────────────────────────────────────────────────────
def _load_template() -> str:
    path = _template_path()
    if not path.exists():
        raise FileNotFoundError(
            f"Template de factura no encontrado en: {path}\n"
            "Colocá invoice_template.html en static/templates/"
        )
    return path.read_text(encoding="utf-8")


# ── Helpers ────────────────────────────────────────────────────────────────────
def _fmt_ar(val: float) -> str:
    """Formatea número al estilo argentino: 1.234.567,89"""
    return f"{val:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

def _extract_pv_comp(comp_nro: str) -> tuple[str, str]:
    m = re.match(r"[Cc](\d{5})-(\d{8})", comp_nro)
    return (m.group(1), m.group(2)) if m else ("00002", "00000000")

def _extract_dni(cuit: str) -> str:
    m = re.match(r"\d{2}-(\d{7,8})-\d", cuit)
    return m.group(1) if m else ""

def _is_skippable(row: dict) -> tuple[bool, str]:
    """
    Retorna (bool, motivo) indicando si la fila debe omitirse.
    Ahora devuelve el motivo para mensajes más descriptivos al usuario.
    """
    comp = str(row.get("comp_nro", "")).strip().upper()
    if not comp:
        return True, "Comp. Nro vacío"
    if comp.startswith("EMITIR"):
        return True, f"Pendiente de emisión: {row.get('comp_nro', '')}"
    if not row.get("amount") or row.get("amount", 0) == 0:
        return True, "Importe cero o vacío"
    if not row.get("razon_social_cliente"):
        return True, "Sin razón social del cliente"
    return False, ""

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


# ── Constructor de HTML de factura ─────────────────────────────────────────────
def _build_invoice_html(row: dict, emisor: dict, copy_label: str = "ORIGINAL") -> str:
    """
    Carga invoice_template.html y sustituye todos los tokens {{TOKEN}}.
    El logo se embebe en base64 para funcionar correctamente en browser y wkhtmltopdf.

    Nuevo token:
      {{CLIENTE_RAZON_SOCIAL}} → col 2 del xlsx (razón social del cliente)
      {{CLIENTE_CUIT}}         → col 1 del xlsx
      {{CLIENTE_DOMICILIO}}    → col 3 del xlsx (nueva columna)
      {{DNI_ROW}}              → fila con DNI si aplica
    """
    template   = _load_template()
    logo_tag   = _load_logo_tag()
    pv, comp   = _extract_pv_comp(row["comp_nro"])
    dni        = _extract_dni(row["cuit_cliente"])
    amount_str = _fmt_ar(row["amount"])
    fecha      = row["fecha_emision"]
    vto        = row.get("vencimiento") or fecha

    dni_row = (
        f'<div class="inv-receptor-field">'
        f'<span class="inv-label-small">DNI</span>'
        f'<span class="inv-receptor-value">{dni}</span>'
        f'</div>'
        if dni else ""
    )

    cae_row = (
        f'<div class="inv-footer-row"><strong>CAE N°:</strong> {row["cae_number"]}</div>'
        if row.get("cae_number") else ""
    )

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
        "{{CLIENTE_RAZON_SOCIAL}}":  row["razon_social_cliente"],   # col 2
        "{{CLIENTE_CUIT}}":          row["cuit_cliente"],            # col 1
        "{{CLIENTE_DOMICILIO}}":     row["domicilio_cliente"],       # col 3
        "{{DNI_ROW}}":               dni_row,
        "{{DESCRIPCION}}":           row["descripcion"],
        "{{IMPORTE}}":               amount_str,
        "{{CAE_ROW}}":               cae_row,
    }

    html = template
    for token, value in tokens.items():
        html = html.replace(token, str(value))
    return html


# ── PDF vía wkhtmltopdf ────────────────────────────────────────────────────────
def _html_to_pdf_bytes(html_content: str) -> Optional[bytes]:
    """
    Convierte HTML → PDF usando wkhtmltopdf.
    El logo ya está embebido en base64, no requiere acceso a archivos externos.
    Retorna None si wkhtmltopdf no está disponible.
    """
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            html_path = os.path.join(tmpdir, "factura.html")
            pdf_path  = os.path.join(tmpdir, "factura.pdf")

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

            stderr = result.stderr.decode("utf-8", errors="replace")
            logger.error(f"wkhtmltopdf no produjo salida. stderr: {stderr}")
            return None

    except FileNotFoundError:
        logger.warning("wkhtmltopdf no encontrado en PATH")
        return None
    except subprocess.TimeoutExpired:
        logger.error("wkhtmltopdf expiró después de 30s")
        return None
    except Exception as e:
        logger.exception(f"Error al generar PDF: {e}")
        return None


# ── Parser de XLSX ─────────────────────────────────────────────────────────────
def _parse_xlsx(file_bytes: bytes) -> list[dict]:
    """
    Nuevo layout de columnas (sin fila de encabezado):
      0: fecha_emision
      1: cuit_cliente
      2: razon_social_cliente   ← NUEVO (antes nombre_cliente)
      3: domicilio_cliente      ← NUEVO
      4: nombre_contacto        ← antes en col 2
      5: descripcion
      6: importe
      7: comp_nro
      8: cae_number
      9: vencimiento
    """
    df = pd.read_excel(io.BytesIO(file_bytes), header=None, dtype=str)
    rows = []

    for i, row in df.iterrows():
        fecha = str(row.iloc[0]).strip() if pd.notna(row.iloc[0]) else ""
        if not fecha or fecha.lower() in ("nan", "none", ""):
            continue

        try:
            amount = float(str(row.iloc[6]).replace(",", "."))
        except (ValueError, TypeError):
            amount = 0.0

        # CAE: col 8
        cae_raw   = str(row.iloc[8]).strip() if len(row) > 8 and pd.notna(row.iloc[8]) else ""
        cae_clean = re.sub(r"\.0+$", "", cae_raw).strip()
        if cae_clean.lower() in ("nan", "none", ""):
            cae_clean = ""

        # Vencimiento: col 9
        venc_raw   = str(row.iloc[9]).strip() if len(row) > 9 and pd.notna(row.iloc[9]) else ""
        venc_clean = re.sub(r"VENCIMIENTO\s*", "", venc_raw, flags=re.IGNORECASE).strip()
        if venc_clean.lower() in ("nan", "none"):
            venc_clean = ""

        rows.append({
            "idx":                   i,
            "fecha_emision":         _fmt_date(fecha),
            "cuit_cliente":          str(row.iloc[1]).strip() if pd.notna(row.iloc[1]) else "",
            "razon_social_cliente":  str(row.iloc[2]).strip() if pd.notna(row.iloc[2]) else "",
            "domicilio_cliente":     str(row.iloc[3]).strip() if len(row) > 3 and pd.notna(row.iloc[3]) else "",
            "nombre_contacto":       str(row.iloc[4]).strip() if len(row) > 4 and pd.notna(row.iloc[4]) else "",
            "descripcion":           str(row.iloc[5]).strip() if len(row) > 5 and pd.notna(row.iloc[5]) else "",
            "amount":                amount,
            "comp_nro":              str(row.iloc[7]).strip() if len(row) > 7 and pd.notna(row.iloc[7]) else "",
            "cae_number":            cae_clean,
            "vencimiento":           venc_clean,
        })

    return rows


# ── Controlador ────────────────────────────────────────────────────────────────
class BillingExtractorNGeneratorController:
    """
    Controlador FastAPI — registrado en prefijo /billing_extractor_n_generator

    Rutas:
        GET  /                    → Página HTML
        POST /parse_xlsx          → Excel → JSON de filas
        POST /generate_pdf        → { row, emisor } → PDF binario
        POST /generate_all        → Excel + emisor → ZIP de PDFs
        GET  /download_modelo     → Descarga Excel modelo
        GET  /emisor_settings     → Datos del emisor desde .env (para pre-cargar en UI)
    """

    def __init__(self):
        self.router = APIRouter(prefix="/billing_extractor_n_generator")

        templates_path = os.path.join(RootLocator.get_root(), "templates")
        self.templates = Jinja2Templates(directory=templates_path)

        # Importar settings una sola vez
        try:
            from common.config.settings import get_settings
            self._settings = get_settings()
        except Exception:
            self._settings = None

        @self.router.get("/", response_class=HTMLResponse)
        async def page(request: Request):
            return self.templates.TemplateResponse(
                "billing_extractor_n_generator.html",
                {"request": request}
            )

        @self.router.get("/emisor_settings")
        async def emisor_settings():
            """
            Devuelve los datos del emisor configurados en .env.
            El frontend los usa para pre-completar (y bloquear) los campos.
            """
            try:
                s = self._settings
                if s is None:
                    raise ValueError("Settings no disponibles")

                # Mapeo de condición IVA desde código → label legible
                cond_iva_map = {
                    "RESP_MONOTR":   "Responsable Monotributo",
                    "RESP_INSCR":    "Responsable Inscripto",
                }
                cond_iva_code  = getattr(s, "emisor_cond_iva", "RESP_MONOTR")
                cond_iva_label = cond_iva_map.get(cond_iva_code.upper(), "Responsable Monotributo")

                return JSONResponse({
                    "status":      "ok",
                    "razon_social": getattr(s, "emisor_razon_social", ""),
                    "cuit":         getattr(s, "emisor_cuit", ""),
                    "domicilio":    getattr(s, "emisor_domicilio", ""),
                    "ib":           getattr(s, "emisor_ib", ""),
                    "inicio_act":   getattr(s, "emisor_inicio_act", ""),
                    "cond_iva":     cond_iva_label,
                    "cond_iva_code": cond_iva_code,
                })
            except Exception as e:
                logger.exception("Error al leer settings del emisor")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

        @self.router.get("/download_modelo")
        async def download_modelo():
            """Descarga el Excel modelo para carga de datos."""
            path = _modelo_xlsx_path()
            if not path.exists():
                return JSONResponse(
                    {"status": "error", "message": "Archivo modelo no encontrado en static/downloads/"},
                    status_code=404
                )
            with open(path, "rb") as f:
                content = f.read()
            return StreamingResponse(
                io.BytesIO(content),
                media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                headers={"Content-Disposition": 'attachment; filename="modelo_facturacion.xlsx"'},
            )

        @self.router.post("/parse_xlsx")
        async def parse_xlsx(file: UploadFile = File(...)):
            try:
                file_bytes = await file.read()
                rows = _parse_xlsx(file_bytes)

                valid   = []
                skipped = []
                for r in rows:
                    skip, motivo = _is_skippable(r)
                    if skip:
                        skipped.append({"comp_nro": r.get("comp_nro", ""), "motivo": motivo})
                    else:
                        valid.append(r)

                return JSONResponse({
                    "status":  "ok",
                    "total":   len(rows),
                    "valid":   len(valid),
                    "skipped": len(skipped),
                    "skipped_detail": skipped,
                    "rows":    rows,
                })
            except Exception as e:
                logger.exception("Error al parsear xlsx")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=400)

        @self.router.post("/generate_pdf")
        async def generate_pdf(request: Request):
            """
            Espera JSON: { row: {...}, emisor: {...}, copy_label?: "ORIGINAL" }
            Retorna: PDF (application/pdf) o HTML de fallback si no hay backend PDF.
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
                    logger.warning("wkhtmltopdf no disponible — retornando HTML para impresión")
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
                logger.exception("Error al generar PDF")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

        @self.router.post("/generate_all")
        async def generate_all(
            file:        UploadFile = File(...),
            emisor_json: str        = Form(...),
        ):
            """Batch: Excel + JSON del emisor → ZIP de PDFs (o HTML de fallback)."""
            import zipfile
            try:
                emisor     = json.loads(emisor_json)
                file_bytes = await file.read()
                rows       = _parse_xlsx(file_bytes)
                valid_rows = [r for r in rows if not _is_skippable(r)[0]]

                if not valid_rows:
                    skipped_detail = [
                        {"comp_nro": r.get("comp_nro", f"fila {r['idx']}"), "motivo": _is_skippable(r)[1]}
                        for r in rows
                    ]
                    return JSONResponse(
                        {
                            "status":  "error",
                            "message": "No hay filas válidas para generar.",
                            "detalle": skipped_detail,
                        },
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
                logger.exception("Error en generate_all")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)