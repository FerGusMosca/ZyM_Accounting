# reconciliation_controller.py
"""
Conciliación de Cobranzas — Controller
---------------------------------------
Tanda 2 / Funcionalidades #3 y #4 (spec Nati):
  - Subir N PDFs de facturas emitidas       → extracción vía LLM → JSON
  - Subir N PDFs de comprobantes de pago    → extracción vía LLM → JSON
  - Conciliar                               → motor determinístico (sin LLM)
      * Match ALTA:  CUIT cliente + importe exacto
      * Match MEDIA: importe exacto + fecha pago >= fecha factura (ventana)
      * Sin match:   factura pendiente / pago sin imputar
  - Cuenta corriente por cliente (saldos, como pidió Nati) + detalle imputado

Tanda 3 (pedidos del 29/08/2026):
  1. Aviso de factura duplicada al subir: se calcula la huella del PDF y se
     consulta la base ANTES de llamar al LLM. Si ya está, se devuelve lo que
     hay guardado y la pantalla pregunta si se sigue igual.
  2. Contraste de "Facturado" y "Cobrado" → resuelto en reconciliation.css.
  3. Grupos de clientes con nombre libre y editable, para ver el saldo total
     de una administración, un holding o lo que haga falta.
  4. Un mismo CUIT sale siempre con el mismo nombre, en pantalla y en el CSV.

La base es opcional: si DATABASE_URL no está en el .env, la pantalla sigue
funcionando como antes, con el estado en el navegador. Lo único que se pierde
es la memoria entre sesiones (duplicados y grupos).

Routes:
    GET  /reconciliation/                → página
    POST /reconciliation/parse_invoices → PDFs facturas  → JSON list
    POST /reconciliation/parse_payments → PDFs pagos     → JSON list
    POST /reconciliation/reconcile      → {invoices, payments} → resultado
    GET  /reconciliation/db_status      → hay base o no
    GET  /reconciliation/groups         → grupos + mapa CUIT → grupo
    POST /reconciliation/groups         → crear o renombrar grupo
    POST /reconciliation/groups/delete  → borrar grupo
    POST /reconciliation/assign_group   → asignar un CUIT a un grupo
    POST /reconciliation/save           → guardar facturas, pagos y cruces
"""

import hashlib
import io
import json
import logging
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Request, UploadFile, File
from fastapi.responses import HTMLResponse, JSONResponse

from common.config.settings import get_settings
from common.util.templates import templates
from common.util.loader.prompt_loader import PromptLoader
from data_access_layer.reconciliation_manager import ReconciliationManager

logger = logging.getLogger(__name__)

_PROMPTS_PATH = "prompts"
_DATE_WINDOW_DAYS = 60          # ventana para match por importe+fecha
_MAX_PDF_PAGES = 4              # páginas a leer por PDF (facturas ARCA: 1-3 copias)


def _get_manager() -> ReconciliationManager:
    """La DAL se arma con lo que haya en el .env. Sin DATABASE_URL queda apagada."""
    return ReconciliationManager(get_settings().database_url)


# ── LLM ────────────────────────────────────────────────────────────────────────

def _get_llm():
    """Lazy init del LLM vía factory (mismo mecanismo que TheCloseInmob)."""
    import os
    settings = get_settings()
    if not settings.openai_api_key:
        return None
    os.environ["OPENAI_API_KEY"] = settings.openai_api_key
    from common.util.builder.llm_factory import LLMFactory
    return LLMFactory.from_class_path(
        class_path=settings.llm_class,
        model_name=settings.llm_model,
        temperature=settings.llm_temperature,
    )


def _pdf_to_text(pdf_bytes: bytes) -> str:
    """
    Extrae el texto conservando la disposición visual.

    layout=True mantiene la posición horizontal de cada palabra, asi que las
    columnas de una tabla no se mezclan entre si y un nombre partido en dos
    lineas sigue siendo legible como una unidad. Sin esto el modelo recibe el
    PDF aplanado y tiene que adivinar que va con que.
    """
    import pdfplumber
    chunks = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages[:_MAX_PDF_PAGES]:
            try:
                txt = page.extract_text(layout=True) or ""
            except TypeError:
                # pdfplumber viejo: sin soporte de layout
                txt = page.extract_text() or ""
            if not txt.strip():
                txt = page.extract_text() or ""
            if txt.strip():
                chunks.append(_squeeze(txt))
    return "\n".join(chunks)


def _squeeze(text: str) -> str:
    """
    layout=True alinea con espacios y multiplica el tamano del texto por 4.
    Se recortan las corridas largas de espacios y las lineas vacias: la
    separacion entre columnas se mantiene y el costo en tokens vuelve a ser
    casi el del texto plano.
    """
    out = []
    for line in text.split("\n"):
        line = line.rstrip()
        if not line.strip():
            continue
        out.append(re.sub(r" {7,}", "      ", line))
    return "\n".join(out)


_NULLISH = {"null", "none", "n/a", "na", "-", "--", "sin datos", "no figura", ""}


def _clean_nulls(obj):
    """
    El modelo a veces escribe el texto "null" en lugar del null de JSON.
    Convierte esos strings en None para que los fallback del front funcionen.
    """
    if isinstance(obj, dict):
        return {k: _clean_nulls(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean_nulls(v) for v in obj]
    if isinstance(obj, str) and obj.strip().lower() in _NULLISH:
        return None
    return obj


def _parse_llm_json(raw: str) -> dict:
    """Limpia fences de markdown y parsea JSON con tolerancia."""
    clean = raw.strip()
    clean = re.sub(r"^```(?:json)?\s*", "", clean)
    clean = re.sub(r"\s*```$", "", clean)
    # Si el modelo agregó texto, quedarse con el primer bloque {...}
    m = re.search(r"\{.*\}", clean, re.DOTALL)
    if m:
        clean = m.group(0)
    return _clean_nulls(json.loads(clean))


def _extract_document(pdf_bytes: bytes, prompt_name: str) -> dict:
    llm = _get_llm()
    if llm is None:
        raise RuntimeError(
            "OPENAI_API_KEY no configurada en .env — no se puede extraer el PDF")
    text = _pdf_to_text(pdf_bytes)
    if not text.strip():
        raise RuntimeError("El PDF no tiene texto extraíble (¿es una imagen escaneada?)")
    prompt_tpl = PromptLoader(_PROMPTS_PATH, prompt_name).get_prompt(prompt_name)
    prompt = prompt_tpl.replace("{document_text}", text[:12000])
    raw = llm.invoke(prompt)
    return _parse_llm_json(raw)


# ── Huella del archivo ─────────────────────────────────────────────────────────

def _file_hash(pdf_bytes: bytes) -> str:
    """
    Huella del PDF. Dos archivos con el mismo contenido dan la misma huella,
    aunque el nombre sea distinto; y si cambia un solo byte, la huella cambia.
    Es lo que permite darse cuenta de que la factura ya se subio.
    """
    return hashlib.sha256(pdf_bytes).hexdigest()


# ── Motor de conciliación (determinístico, sin LLM) ────────────────────────────

def _norm_cuit(cuit) -> str:
    return re.sub(r"\D", "", str(cuit or ""))


def _parse_date(s: str) -> Optional[datetime]:
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(str(s or "").strip(), fmt)
        except (ValueError, TypeError):
            continue
    return None


def _iso_date(s) -> Optional[str]:
    """Pasa la fecha a AAAA-MM-DD para guardarla en la base."""
    dt = _parse_date(s)
    return dt.strftime("%Y-%m-%d") if dt else None


def _round2(x) -> float:
    try:
        return round(float(x), 2)
    except (TypeError, ValueError):
        return 0.0


def _emisor_cuits(invoices: list[dict]) -> set[str]:
    """
    CUIT de quien emite las facturas del paso 1.

    Premisa del modulo: en el paso 1 se cargan facturas propias y en el paso 2
    cobros recibidos. Entonces el emisor NUNCA puede ser el pagador de un cobro.
    No se consulta el .env: los documentos cargados son la fuente de verdad.
    """
    cuits = {_norm_cuit(i.get("cuit_emisor")) for i in invoices}
    cuits.discard("")
    return cuits


def _flip(pay: dict) -> dict:
    """Da vuelta pagador y cobrador de un comprobante mal extraido."""
    pay = dict(pay)
    pay["originante"], pay["destinatario"] = (
        pay.get("destinatario"), pay.get("originante"))
    pay["cuit_originante"], pay["cuit_destinatario"] = (
        pay.get("cuit_destinatario"), pay.get("cuit_originante"))
    pay["_corregido"] = "pagador/cobrador invertidos por el extractor"
    return pay


def canonical_names(invoices: list[dict], from_db: dict | None = None) -> dict:
    """
    Un nombre por CUIT.

    El extractor lee el nombre del cliente tal como figura en cada factura, y
    dos facturas del mismo cliente pueden traerlo escrito distinto. Eso hacia
    que el mismo consorcio apareciera dos veces en el Excel.

    Criterio, en este orden:
      1. Si el cliente ya esta en la base, manda el nombre guardado ahi.
      2. Si no, gana el nombre que aparece en mas facturas.
      3. Si empatan, gana el mas largo, que suele ser el completo y no el
         abreviado.
    """
    from_db = from_db or {}
    por_cuit = defaultdict(list)
    for inv in invoices:
        cuit = _norm_cuit(inv.get("cuit_cliente"))
        nombre = (inv.get("razon_social_cliente") or "").strip()
        if cuit and nombre:
            por_cuit[cuit].append(nombre)

    elegido = {}
    for cuit, nombres in por_cuit.items():
        if from_db.get(cuit):
            elegido[cuit] = from_db[cuit]
            continue
        conteo = Counter(nombres)
        top = max(conteo.values())
        candidatos = [n for n, c in conteo.items() if c == top]
        elegido[cuit] = max(candidatos, key=len)
    return elegido


def reconcile(invoices: list[dict], payments: list[dict],
              nombres_db: dict | None = None,
              grupos: dict | None = None) -> dict:
    """
    Pasada 1: CUIT cliente == CUIT originante  +  importe exacto      → 'alta'
    Pasada 2: importe exacto + pago posterior a factura (ventana)     → 'media'
    Resto:    facturas pendientes / pagos sin imputar.
    Cuenta corriente por cliente: facturado, cobrado (imputado + a cuenta), saldo.

    nombres_db: mapa CUIT → nombre guardado en la base.
    grupos:     mapa CUIT → {group_id, group_name}.
    """
    grupos = grupos or {}
    nombres = canonical_names(invoices, nombres_db)

    invs = []
    for i, inv in enumerate(invoices):
        cuit = _norm_cuit(inv.get("cuit_cliente"))
        invs.append({
            "idx": i,
            "cuit": cuit,
            "cliente": nombres.get(cuit) or inv.get("razon_social_cliente") or "(sin nombre)",
            "comp": f"{inv.get('punto_venta', '')}-{inv.get('comp_nro', '')}",
            "fecha": inv.get("fecha_emision"),
            "fecha_dt": _parse_date(inv.get("fecha_emision")),
            "importe": _round2(inv.get("importe_total")),
            "descripcion": inv.get("descripcion") or "",
            "archivo": inv.get("_archivo") or "",
            "matched": False,
        })
    # Si el pagador de un cobro es el propio emisor, el extractor lo dio vuelta.
    emisores = _emisor_cuits(invoices)
    payments = [
        _flip(p) if _norm_cuit(p.get("cuit_originante")) in emisores else p
        for p in payments
    ]

    pays = []
    for j, pay in enumerate(payments):
        pays.append({
            "idx": j,
            "cuit": _norm_cuit(pay.get("cuit_originante")),
            "originante": pay.get("originante") or "(sin nombre)",
            "banco": pay.get("banco") or pay.get("banco_destino") or "-",
            "fecha": pay.get("fecha"),
            "fecha_dt": _parse_date(pay.get("fecha")),
            "importe": _round2(pay.get("importe")),
            "referencia": pay.get("referencia") or pay.get("concepto") or "",
            "archivo": pay.get("_archivo") or "",
            "corregido": pay.get("_corregido"),
            "matched": False,
        })

    matches = []

    # Pasada 1 — CUIT + importe exacto
    for p in pays:
        if p["matched"]:
            continue
        for inv in invs:
            if inv["matched"] or not inv["cuit"] or not p["cuit"]:
                continue
            if inv["cuit"] == p["cuit"] and inv["importe"] == p["importe"]:
                inv["matched"] = p["matched"] = True
                matches.append(_match(inv, p, "alta", "CUIT + importe exacto"))
                break

    # Pasada 2 — importe exacto + fecha compatible
    for p in pays:
        if p["matched"]:
            continue
        candidates = [
            inv for inv in invs
            if not inv["matched"] and inv["importe"] == p["importe"]
            and _date_ok(inv["fecha_dt"], p["fecha_dt"])
        ]
        if len(candidates) == 1:
            inv = candidates[0]
            inv["matched"] = p["matched"] = True
            matches.append(_match(inv, p, "media",
                                  "Importe exacto + fecha compatible (CUIT del pagador ≠ CUIT del cliente)"))
        elif len(candidates) > 1:
            # Ambiguo: elegir la factura más antigua, marcar para revisión
            inv = sorted(candidates, key=lambda x: x["fecha_dt"] or datetime.max)[0]
            inv["matched"] = p["matched"] = True
            matches.append(_match(inv, p, "revisar",
                                  f"Importe coincide con {len(candidates)} facturas — se imputó la más antigua"))

    pendientes = [_inv_out(i) for i in invs if not i["matched"]]

    # Cuenta corriente por cliente (clave: CUIT del cliente)
    cc = {}
    for inv in invs:
        key = inv["cuit"] or f"SIN_CUIT::{inv['cliente']}"
        c = cc.setdefault(key, {"cuit": inv["cuit"], "cliente": inv["cliente"],
                                "facturado": 0.0, "cobrado": 0.0,
                                "n_facturas": 0, "n_pagos": 0})
        c["facturado"] = _round2(c["facturado"] + inv["importe"])
        c["n_facturas"] += 1
    for m in matches:
        key = m["factura"]["cuit"] or f"SIN_CUIT::{m['factura']['cliente']}"
        if key in cc:
            cc[key]["cobrado"] = _round2(cc[key]["cobrado"] + m["pago"]["importe"])
            cc[key]["n_pagos"] += 1
    # Pagos sin imputar cuyo CUIT coincide con un cliente → "a cuenta" (saldos, como pidió Nati)
    for p in pays:
        if p["matched"] or not p["cuit"] or p["cuit"] not in cc:
            continue
        cc[p["cuit"]]["cobrado"] = _round2(cc[p["cuit"]]["cobrado"] + p["importe"])
        cc[p["cuit"]]["n_pagos"] += 1
        p["a_cuenta"] = True
    for c in cc.values():
        c["saldo"] = _round2(c["facturado"] - c["cobrado"])
        g = grupos.get(c["cuit"]) or {}
        c["group_id"] = g.get("group_id")
        c["grupo"] = g.get("group_name") or "Sin grupo"

    sin_imputar = [_pay_out(p) for p in pays if not p["matched"]]  # refleja flag a_cuenta

    cuentas = sorted(cc.values(), key=lambda c: -c["saldo"])

    return {
        "matches": matches,
        "facturas_pendientes": pendientes,
        "pagos_sin_imputar": sin_imputar,
        "cuentas_corrientes": cuentas,
        "grupos_resumen": _group_totals(cuentas),
        "resumen": {
            "n_facturas": len(invs),
            "n_pagos": len(pays),
            "n_matches": len(matches),
            "total_facturado": _round2(sum(i["importe"] for i in invs)),
            "total_cobrado": _round2(sum(p["importe"] for p in pays if p["matched"] or p.get("a_cuenta"))),
            "total_pendiente": _round2(sum(i["importe"] for i in invs if not i["matched"])),
        },
    }


def _group_totals(cuentas: list[dict]) -> list[dict]:
    """
    Suma por grupo. Es la vista que pidio Nati: cuanto debe en total cada
    administracion, con los consorcios adentro.
    """
    tot = {}
    for c in cuentas:
        nombre = c.get("grupo") or "Sin grupo"
        g = tot.setdefault(nombre, {"grupo": nombre, "group_id": c.get("group_id"),
                                    "facturado": 0.0, "cobrado": 0.0,
                                    "saldo": 0.0, "n_clientes": 0})
        g["facturado"] = _round2(g["facturado"] + c["facturado"])
        g["cobrado"] = _round2(g["cobrado"] + c["cobrado"])
        g["saldo"] = _round2(g["saldo"] + c["saldo"])
        g["n_clientes"] += 1
    # "Sin grupo" siempre al final, el resto por saldo
    return sorted(tot.values(),
                  key=lambda g: (g["grupo"] == "Sin grupo", -g["saldo"]))


def _date_ok(inv_dt, pay_dt) -> bool:
    if inv_dt is None or pay_dt is None:
        return True  # sin fechas no descartamos
    delta = (pay_dt - inv_dt).days
    return 0 <= delta <= _DATE_WINDOW_DAYS


def _match(inv, p, confianza, motivo) -> dict:
    return {"confianza": confianza, "motivo": motivo,
            "factura": _inv_out(inv), "pago": _pay_out(p)}


def _inv_out(inv) -> dict:
    return {k: inv[k] for k in
            ("cuit", "cliente", "comp", "fecha", "importe", "descripcion", "archivo")}


def _pay_out(p) -> dict:
    out = {k: p[k] for k in
           ("cuit", "originante", "banco", "fecha", "importe", "referencia", "archivo")}
    out["corregido"] = p.get("corregido")
    out["a_cuenta"] = p.get("a_cuenta", False)
    return out


# ── Controller ─────────────────────────────────────────────────────────────────

class ReconciliationController:

    def __init__(self):
        self.router = APIRouter(prefix="/reconciliation")

        @self.router.get("/", response_class=HTMLResponse)
        async def page(request: Request):
            return templates.TemplateResponse(
                "reconciliation.html", {"request": request})

        @self.router.post("/parse_invoices")
        async def parse_invoices(files: list[UploadFile] = File(...)):
            return await self._parse_many(files, "invoice_extraction")

        @self.router.post("/parse_payments")
        async def parse_payments(files: list[UploadFile] = File(...)):
            return await self._parse_many(files, "payment_extraction")

        @self.router.post("/reconcile")
        async def do_reconcile(request: Request):
            body = await request.json()
            invoices = body.get("invoices") or []
            payments = body.get("payments") or []
            try:
                mgr = _get_manager()
                nombres_db, grupos = {}, {}
                if mgr.is_enabled():
                    try:
                        nombres_db = mgr.get_canonical_names()
                        grupos = mgr.get_cuit_group_map()
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudo leer clientes y grupos de la base")
                result = reconcile(invoices, payments, nombres_db, grupos)
                return JSONResponse({"status": "ok", **result})
            except Exception as e:  # noqa: BLE001
                logger.exception("Error en conciliación")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        # ── Base de datos ──────────────────────────────────────────────────

        @self.router.get("/db_status")
        async def db_status():
            """La pantalla lo usa para saber si mostrar Guardar y Grupos."""
            return JSONResponse({"status": "ok", "enabled": _get_manager().ping()})

        @self.router.get("/groups")
        async def get_groups():
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db", "grupos": [], "asignaciones": {}})
            try:
                return JSONResponse({
                    "status": "ok",
                    "grupos": mgr.get_groups(),
                    "asignaciones": mgr.get_cuit_group_map(),
                })
            except Exception as e:  # noqa: BLE001
                logger.exception("Error leyendo grupos")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/groups")
        async def save_group(request: Request):
            body = await request.json()
            nombre = (body.get("nombre") or "").strip()
            if not nombre:
                return JSONResponse({"status": "error",
                                     "message": "El grupo necesita un nombre"},
                                    status_code=400)
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse(
                    {"status": "no_db",
                     "message": "Sin DATABASE_URL no se pueden guardar grupos"},
                    status_code=400)
            try:
                group_id = mgr.upsert_group(body.get("group_id"), nombre)
                return JSONResponse({"status": "ok", "group_id": group_id,
                                     "nombre": nombre})
            except Exception as e:  # noqa: BLE001
                logger.exception("Error guardando grupo")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/groups/delete")
        async def delete_group(request: Request):
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                mgr.delete_group(int(body.get("group_id")))
                return JSONResponse({"status": "ok"})
            except Exception as e:  # noqa: BLE001
                logger.exception("Error borrando grupo")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/assign_group")
        async def assign_group(request: Request):
            body = await request.json()
            cuit = _norm_cuit(body.get("cuit"))
            nombre = body.get("cliente") or cuit
            group_id = body.get("group_id")
            if not cuit:
                return JSONResponse({"status": "error",
                                     "message": "El cliente no tiene CUIT"},
                                    status_code=400)
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                mgr.assign_cuit_to_group(cuit, nombre, group_id)
                return JSONResponse({"status": "ok"})
            except Exception as e:  # noqa: BLE001
                logger.exception("Error asignando grupo")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/save")
        async def save(request: Request):
            """
            Guarda en la base lo que hay en pantalla: facturas, cobros y los
            cruces. Las facturas cubiertas quedan como pagadas, y por eso la
            proxima vez que se suba ese PDF el sistema avisa.
            """
            body = await request.json()
            invoices = body.get("invoices") or []
            payments = body.get("payments") or []
            result = body.get("result") or {}

            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db",
                                     "message": "Sin DATABASE_URL no se puede guardar"},
                                    status_code=400)
            try:
                nombres = canonical_names(invoices, mgr.get_canonical_names())

                # Facturas: la clave para volver a encontrarlas es la huella
                inv_ids = {}
                for inv in invoices:
                    cuit = _norm_cuit(inv.get("cuit_cliente"))
                    comp = f"{inv.get('punto_venta', '')}-{inv.get('comp_nro', '')}"
                    inv_id = mgr.persist_invoice({
                        "cuit_cliente": cuit,
                        "razon_social_cliente": nombres.get(cuit)
                                                or inv.get("razon_social_cliente"),
                        "cuit_emisor": _norm_cuit(inv.get("cuit_emisor")),
                        "comprobante": comp,
                        "fecha_emision_iso": _iso_date(inv.get("fecha_emision")),
                        "importe_total": _round2(inv.get("importe_total")),
                        "descripcion": inv.get("descripcion"),
                        "archivo": inv.get("_archivo"),
                        "file_hash": inv.get("_hash"),
                        "raw": inv,
                    })
                    inv_ids[comp] = inv_id

                # Cobros: la clave es la huella del comprobante
                pay_ids = {}
                for pay in payments:
                    pay_id = mgr.persist_payment({
                        "cuit_originante": _norm_cuit(pay.get("cuit_originante")),
                        "originante": pay.get("originante"),
                        "fecha_iso": _iso_date(pay.get("fecha")),
                        "importe": _round2(pay.get("importe")),
                        "banco": pay.get("banco") or pay.get("banco_destino"),
                        "referencia": pay.get("referencia") or pay.get("concepto"),
                        "archivo": pay.get("_archivo"),
                        "file_hash": pay.get("_hash"),
                        "raw": pay,
                    })
                    pay_ids[pay.get("_archivo")] = pay_id

                # Cruces
                n_matches = 0
                for m in result.get("matches") or []:
                    comp = m["factura"]["comp"]
                    archivo_pago = m["pago"].get("archivo")
                    if comp in inv_ids and archivo_pago in pay_ids:
                        mgr.persist_match(inv_ids[comp], pay_ids[archivo_pago],
                                          _round2(m["pago"]["importe"]),
                                          m["confianza"], "zym")
                        n_matches += 1

                return JSONResponse({
                    "status": "ok",
                    "n_facturas": len(inv_ids),
                    "n_pagos": len(pay_ids),
                    "n_matches": n_matches,
                })
            except Exception as e:  # noqa: BLE001
                logger.exception("Error guardando en la base")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

    @staticmethod
    async def _parse_many(files: list[UploadFile], prompt_name: str):
        """
        Por cada PDF:
          1. Se calcula la huella y se consulta la base ANTES de llamar al LLM.
          2. Si ya estaba, se devuelve lo guardado con el aviso de duplicado y
             no se gasta una llamada al modelo.
          3. Si no estaba, se extrae como siempre.
        La pantalla es la que decide si lo carga igual o lo descarta.
        """
        settings = get_settings()
        if not settings.openai_api_key:
            return JSONResponse({
                "status": "not_configured",
                "message": "OPENAI_API_KEY no configurada en .env"})

        mgr = _get_manager()
        es_factura = prompt_name == "invoice_extraction"
        results, errors = [], []

        for f in files:
            try:
                raw_bytes = await f.read()
                huella = _file_hash(raw_bytes)

                previo = None
                if mgr.is_enabled():
                    try:
                        previo = (mgr.find_invoice_by_hash(huella) if es_factura
                                  else mgr.find_payment_by_hash(huella))
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudo consultar duplicados en la base")

                if previo:
                    aviso = ("Esta factura ya está registrada"
                             if es_factura else "Este comprobante ya está registrado")
                    if es_factura and previo.get("_estado") == "paid":
                        aviso = "Esta factura ya está registrada como PAGADA"
                    data = dict(previo)
                    data["_archivo"] = f.filename
                    data["_hash"] = huella
                    data["_duplicado"] = True
                    data["_aviso"] = aviso
                    results.append(data)
                    continue

                data = _extract_document(raw_bytes, prompt_name)
                data["_archivo"] = f.filename
                data["_hash"] = huella
                data["_duplicado"] = False
                results.append(data)
            except Exception as e:  # noqa: BLE001
                logger.exception("Error extrayendo %s", f.filename)
                errors.append({"archivo": f.filename, "error": str(e)})

        return JSONResponse({"status": "ok", "documents": results, "errors": errors})
