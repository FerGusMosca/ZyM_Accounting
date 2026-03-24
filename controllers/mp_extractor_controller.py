# mp_extractor_controller.py
"""
Mercado Pago PDF Extractor Controller
--------------------------------------
Parsea el resumen de cuenta PDF de Mercado Pago y devuelve las
transacciones estructuradas para ser importadas al generador de facturas.

Clasificación:
  "recibida"    → Transferencia recibida  → preseleccionada ✅
  "enviada"     → Transferencia enviada   → no seleccionada
  "rendimiento" → Rendimientos            → no seleccionada
  "otro"        → cualquier otra cosa     → no seleccionada

El CUIT del cliente NO está en el PDF — queda vacío para completar a mano.

Routes:
    POST /mp_extractor/parse_pdf  → PDF → JSON de transacciones
"""

import io
import logging
import re

from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

# ── Regex ──────────────────────────────────────────────────────────────────────

# A "data line" contains: DATE [optional inline desc] OP_ID $ VALUE $ SALDO
_DATA_LINE = re.compile(
    r'^(\d{2}-\d{2}-\d{4})\s+(.*?)(\d{12,15})\s+(\$\s*-?[\d\.]+,\d{2})\s+\$\s*[\d\.]+,\d{2}\s*$'
)

# Lines to skip entirely (headers, footers, summary rows)
_SKIP_LINE = re.compile(
    r'^(RESUMEN DE CUENTA|CVU:|Periodo:|Entradas:|Salidas:|Saldo |DETALLE DE|'
    r'ID de la|Fecha Desc|operaci|\d/\d$|Fecha de gen|Mercado Libre|de consulta|www\.)',
    re.IGNORECASE
)

# Prefix lines that belong to the NEXT transaction, not the current one
_TRANS_PREFIX = re.compile(r'^Transferencia\s+', re.IGNORECASE)


# ── Helpers ────────────────────────────────────────────────────────────────────

def _parse_amount(raw: str) -> float:
    clean = raw.replace("$", "").replace(" ", "").replace(".", "").replace(",", ".")
    try:
        return float(clean)
    except ValueError:
        return 0.0


def _normalize_date(raw: str) -> str:
    return raw.replace("-", "/")


def _classify(desc: str) -> str:
    d = desc.lower()
    if "transferencia recibida" in d:
        return "recibida"
    if "transferencia enviada" in d:
        return "enviada"
    if "rendimiento" in d:
        return "rendimiento"
    return "otro"


def _extract_counterpart(desc: str) -> str:
    """
    'Transferencia recibida CONS ARMENIA 2448' → 'CONS ARMENIA 2448'
    'Transferencia enviada Lucas Daniel Cardenas' → 'Lucas Daniel Cardenas'
    'Rendimientos' → 'Rendimientos'
    """
    for prefix in ("Transferencia recibida ", "Transferencia enviada "):
        idx = desc.find(prefix)
        if idx >= 0:
            return desc[idx + len(prefix):].strip()
    return desc.strip()


# ── Main parser ────────────────────────────────────────────────────────────────

def _parse_mp_pdf(pdf_bytes: bytes) -> dict:
    try:
        import pdfplumber
    except ImportError:
        raise RuntimeError("pdfplumber no instalado. Ejecutar: pip install pdfplumber")

    # ── Extract raw lines from all pages ──────────────────────────────────────
    raw_lines = []
    titular = ""
    cuit_titular = ""
    periodo = ""

    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            raw_lines.extend((page.extract_text() or "").splitlines())

    # ── Parse header ──────────────────────────────────────────────────────────
    for line in raw_lines[:15]:
        line = line.strip()
        if not line or line in ("RESUMEN DE CUENTA",):
            continue
        m = re.search(r"CUIT[/\s]+CUIL[:\s]+(\d+)", line, re.IGNORECASE)
        if m:
            cuit_titular = m.group(1)
            continue
        m = re.search(r"Periodo[:\s]+(.+)", line, re.IGNORECASE)
        if m:
            periodo = m.group(1).strip()
            continue
        if (not titular
                and not line.startswith("CVU")
                and not line.startswith("Periodo")
                and not line.startswith("Entradas")
                and not line.startswith("Salidas")):
            titular = line

    # ── Filter and parse transactions ─────────────────────────────────────────
    lines = [l.strip() for l in raw_lines
             if l.strip() and not _SKIP_LINE.match(l.strip())]

    transactions = []
    seen_ids = set()
    pending = []   # non-data lines accumulated as prefix for next data line

    i = 0
    while i < len(lines):
        line = lines[i]
        m = _DATA_LINE.match(line)

        if m:
            fecha       = m.group(1)
            inline_desc = m.group(2).strip()
            op_id       = m.group(3)
            valor       = m.group(4)

            if op_id in seen_ids:
                pending = []
                i += 1
                continue
            seen_ids.add(op_id)

            # Description = pending prefix + inline + optional suffix
            desc_parts = list(pending)
            if inline_desc:
                desc_parts.append(inline_desc)

            # Suffix: next line if it's NOT a "Transferencia..." prefix
            # (that would belong to the next transaction)
            if i + 1 < len(lines):
                nxt = lines[i + 1]
                if (not _DATA_LINE.match(nxt)
                        and not _SKIP_LINE.match(nxt)
                        and not _TRANS_PREFIX.match(nxt)):
                    desc_parts.append(nxt)
                    i += 1  # consume suffix

            pending = []

            full_desc   = " ".join(desc_parts).strip()
            amount      = _parse_amount(valor)
            tipo        = _classify(full_desc)
            counterpart = _extract_counterpart(full_desc)

            transactions.append({
                "fecha":                 _normalize_date(fecha),
                "descripcion":           full_desc,
                "contraparte":           counterpart,
                "op_id":                 op_id,
                "amount":                amount,
                "tipo":                  tipo,
                "preselected":           tipo == "recibida",
                # ── Campos para la grilla de facturas ──
                "fecha_emision":         _normalize_date(fecha),
                "cuit_cliente":          "",           # vacío — usuario lo completa
                "razon_social_cliente":  counterpart,
                "domicilio_cliente":     "",
                "nombre_contacto":       "",
                "descripcion_servicio":  f"Transferencia Mercado Pago — {counterpart}",
                "comp_nro":              "",           # se asignará al agregar a la grilla
                "cae_number":            "",
                "vencimiento":           "",
            })
        else:
            pending.append(line)

        i += 1

    return {
        "titular":      titular,
        "cuit_titular": cuit_titular,
        "periodo":      periodo,
        "total":        len(transactions),
        "transactions": transactions,
    }


# ── Controller ─────────────────────────────────────────────────────────────────

class MpExtractorController:
    """FastAPI controller — mounted at /mp_extractor"""

    def __init__(self):
        self.router = APIRouter(prefix="/mp_extractor")

        @self.router.post("/parse_pdf")
        async def parse_pdf(file: UploadFile = File(...)):
            if not file.filename.lower().endswith(".pdf"):
                return JSONResponse(
                    {"status": "error", "message": "Solo se admiten archivos PDF"},
                    status_code=400,
                )
            try:
                result = _parse_mp_pdf(await file.read())
                return JSONResponse({"status": "ok", **result})
            except Exception as exc:
                logger.exception("Error parsing MP PDF")
                return JSONResponse({"status": "error", "message": str(exc)}, status_code=500)