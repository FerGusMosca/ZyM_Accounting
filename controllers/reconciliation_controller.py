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

Tanda 4 (pedidos del 20/09/2026):
  1. Cruce manual: un cobro contra varias facturas, elegidas en pantalla.
  2. Si el cobro sobra, lo que sobra queda como un cobro aparte (remanente),
     que se puede volver a cruzar.
  3. Lo ya conciliado y guardado se recupera: al conciliar, los cruces
     guardados de lo que esta en pantalla vuelven tal cual, sin recalcular.

Tanda 5 (pedidos del 20/09/2026):
  1. Desarmar cruces de a uno o el grupo entero (factura/s con pago/s).
     Lo ya guardado se saca de a uno, como dice la regla.
  2. Facturas y cobros se guardan solos al pasar de un paso al otro; el
     boton "Guardar en base" guarda los cruces.
  Ademas: un documento sin marca de identidad ya no corta el guardado.

Tanda 3 (pedidos del 29/08/2026):
  1. Aviso de factura duplicada al subir: se calcula la huella del PDF y se
     consulta la base ANTES de llamar al LLM. Si ya está, se devuelve lo que
     hay guardado y la pantalla pregunta si se sigue igual.
  2. Contraste de "Facturado" y "Cobrado" → resuelto en reconciliation.css.
  3. Grupos de clientes con nombre libre y editable, para ver el saldo total
     de una administración, un holding o lo que haga falta.
  4. Un mismo CUIT sale siempre con el mismo nombre, en pantalla y en el CSV.

Tanda 7 (pedidos del 04/10/2026):
  1. NADA se guarda en el navegador ni en memoria del servidor: todo sale de
     la base. Facturas y cobros se guardan al pasar de un paso al otro y la
     pantalla los vuelve a leer de la base (sync_docs). Si alguien los borro
     desde Registros, la pantalla se entera y los saca.
  2. Registros: todo paginado, leido de la base en cada pedido.
  3. Borrar una factura o un cobro con cruces saca tambien los cruces y lo
     avisa (la pantalla pide confirmacion antes).

La base es obligatoria para guardar: si DATABASE_URL no está en el .env, la
pantalla solo calcula en el momento, sin guardar nada.

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
    POST /reconciliation/sync_docs      → guarda facturas y pagos y los relee de la base (al pasar de paso)
    POST /reconciliation/save           → guardar facturas, pagos y cruces
    GET  /reconciliation/registros      → pantalla de registros guardados
    GET  /reconciliation/registros/page → una pagina de facturas, cobros, cruces o clientes
    GET  /reconciliation/registros/invoice_matches → cruces de una factura
    GET  /reconciliation/registros/payment_matches → cruces de un cobro
    GET  /reconciliation/registros/file/{huella} → abre el archivo original
    POST /reconciliation/registros/payment_manual → alta de cobro a mano
    POST /reconciliation/registros/payment_delete → baja de cobro (saca sus cruces y avisa cuantos)
    POST /reconciliation/registros/invoice_delete → baja de factura (saca sus cruces y avisa cuantos)
    GET  /reconciliation/registros/clients       → clientes
    POST /reconciliation/registros/client_name   → cambia el nombre del cliente
    POST /reconciliation/registros/match_delete  → saca UN cruce
    POST /reconciliation/registros/payment_file  → sube el comprobante de un cobro
    POST /reconciliation/load_from_db            → trae lo guardado por fecha
"""

import base64
import hashlib
import io
import json
import logging
import re
from collections import Counter, defaultdict
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Request, UploadFile, File, Form
from fastapi.responses import HTMLResponse, JSONResponse, Response

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


# Formatos de imagen aceptados como comprobante.
_IMAGE_MIMES = {
    "jpg":  "image/jpeg",
    "jpeg": "image/jpeg",
    "png":  "image/png",
    "webp": "image/webp",
    "heic": "image/heic",
}


def _mime_de(nombre: str, content_type: str | None) -> str:
    """
    Tipo del archivo. Se mira primero la terminacion del nombre, que es mas
    confiable que lo que manda el navegador.
    """
    ext = (nombre or "").rsplit(".", 1)[-1].lower()
    if ext in _IMAGE_MIMES:
        return _IMAGE_MIMES[ext]
    if ext == "pdf":
        return "application/pdf"
    return content_type or "application/octet-stream"


def _es_imagen(mime: str) -> bool:
    return (mime or "").startswith("image/")


def _extract_from_image(img_bytes: bytes, mime: str, prompt_name: str) -> dict:
    """
    Comprobante sacado con el celular o captura de pantalla: no hay texto para
    leer, asi que la imagen se le manda al modelo tal cual y el lee lo que ve.
    """
    llm = _get_llm()
    if llm is None:
        raise RuntimeError(
            "OPENAI_API_KEY no configurada en .env — no se puede leer la imagen")
    if not hasattr(llm, "invoke_messages"):
        raise RuntimeError("El modelo configurado no acepta imagenes")

    from langchain_core.messages import HumanMessage

    prompt_tpl = PromptLoader(_PROMPTS_PATH, prompt_name).get_prompt(prompt_name)
    prompt = prompt_tpl.replace(
        "{document_text}",
        "(el comprobante va adjunto como imagen; leelo de la imagen)")

    b64 = base64.b64encode(img_bytes).decode("ascii")
    mensaje = HumanMessage(content=[
        {"type": "text", "text": prompt},
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
    ])
    return _parse_llm_json(llm.invoke_messages([mensaje]))


def _extract_document(raw_bytes: bytes, prompt_name: str,
                      mime: str = "application/pdf") -> dict:
    if _es_imagen(mime):
        return _extract_from_image(raw_bytes, mime, prompt_name)

    llm = _get_llm()
    if llm is None:
        raise RuntimeError(
            "OPENAI_API_KEY no configurada en .env — no se puede extraer el PDF")
    text = _pdf_to_text(raw_bytes)
    if not text.strip():
        raise RuntimeError(
            "El PDF no tiene texto: es una foto adentro de un PDF. "
            "Subí la foto directamente (jpg o png) y se lee igual.")
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


def _completar_marcas(invoices: list[dict], payments: list[dict]) -> None:
    """
    Toda factura y todo cobro tiene que llegar con su marca de identidad,
    porque la base no guarda nada sin ella.

    Una factura que viene de una sesion vieja o importada puede no traerla
    (caso de la factura 00001-00000621). En vez de que la base corte todo el
    guardado, la marca se arma con los propios datos del documento: emisor +
    numero para la factura, y los datos del cobro para el pago. Siempre da la
    misma marca para el mismo documento, asi no se duplica.
    """
    for inv in invoices:
        if (inv.get("_hash") or "").strip():
            continue
        base = "|".join([
            "sin_archivo", "factura",
            _norm_cuit(inv.get("cuit_emisor")),
            f"{inv.get('punto_venta', '')}-{inv.get('comp_nro', '')}",
            str(_round2(inv.get("importe_total"))),
        ])
        inv["_hash"] = hashlib.sha256(base.encode("utf-8")).hexdigest()
    for pay in payments:
        if (pay.get("_hash") or "").strip():
            continue
        base = "|".join([
            "sin_archivo", "pago",
            _norm_cuit(pay.get("cuit_originante")),
            str(pay.get("fecha") or ""),
            str(_round2(pay.get("importe"))),
            str(pay.get("banco") or "").strip().lower(),
            str(pay.get("referencia") or "").strip().lower(),
        ])
        pay["_hash"] = hashlib.sha256(base.encode("utf-8")).hexdigest()


def _faltantes_en_base(mgr: ReconciliationManager, invoices: list[dict],
                       payments: list[dict]) -> tuple[list[int], list[int]]:
    """
    Facturas y cobros que la pantalla da por guardados (traen id de la base)
    pero que ya no estan: alguien los borro desde Registros.
    Devuelve (ids de facturas que faltan, ids de cobros que faltan).
    """
    ids_inv = {int(d["_id_bd"]) for d in invoices if d.get("_id_bd")}
    ids_pay = {int(d["_id_bd"]) for d in payments if d.get("_id_bd")}
    hay_inv = mgr.get_invoices_by_ids(list(ids_inv))
    hay_pay = mgr.get_payments_by_ids(list(ids_pay))
    return (sorted(ids_inv - set(hay_inv)), sorted(ids_pay - set(hay_pay)))


def _notas_por_clave(mgr: ReconciliationManager, invoices: list[dict]) -> dict:
    """
    {clave del documento: importe} con los cruces nota de credito <-> factura
    guardados: la factura suma lo que le descuentan; la nota, lo ya aplicado
    en negativo.
    """
    clave_de = {}
    for i, inv in enumerate(invoices):
        if inv.get("_id_bd"):
            clave_de[int(inv["_id_bd"])] = _inv_key(inv, i)
    notas = defaultdict(float)
    for a in mgr.list_nc_applications(list(clave_de)):
        if a["invoice_id"] in clave_de:
            notas[clave_de[a["invoice_id"]]] += a["monto"]
        if a["nc_id"] in clave_de:
            notas[clave_de[a["nc_id"]]] -= a["monto"]
    return dict(notas)


def _persist_docs(mgr: ReconciliationManager, invoices: list[dict],
                  payments: list[dict]) -> tuple[dict, dict]:
    """
    Guarda facturas y cobros. No toca cruces. Si ya estaban guardados, la
    base devuelve el que ya estaba: no duplica y no borra nada.
    Devuelve (marca de factura -> id, marca de cobro -> id).
    """
    _completar_marcas(invoices, payments)
    nombres = canonical_names(invoices, mgr.get_canonical_names())

    inv_ids = {}
    for i, inv in enumerate(invoices):
        cuit = _norm_cuit(inv.get("cuit_cliente"))
        comp = _comprobante(inv)
        inv_ids[_inv_key(inv, i)] = mgr.persist_invoice({
            "cuit_cliente": cuit,
            "razon_social_cliente": nombres.get(cuit)
                                    or inv.get("razon_social_cliente"),
            "cuit_emisor": _norm_cuit(inv.get("cuit_emisor")),
            "comprobante": comp,
            "fecha_emision_iso": _iso_date(inv.get("fecha_emision")),
            "importe_total": _con_signo(inv),
            "descripcion": inv.get("descripcion"),
            "archivo": inv.get("_archivo"),
            "file_hash": inv.get("_hash"),
            "tipo_comprobante": _tipo_comprobante(inv),
            "comp_ajustado": inv.get("comp_ajustado"),
            "raw": inv,
        })

    pay_ids = {}
    for j, pay in enumerate(payments):
        pay_ids[_pay_key(pay, j)] = mgr.persist_payment({
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
    return inv_ids, pay_ids


# ── Motor de conciliación (determinístico, sin LLM) ────────────────────────────

def _norm_cuit(cuit) -> str:
    return re.sub(r"\D", "", str(cuit or ""))


def _parte_comp(v) -> str:
    """
    Un pedazo del numero de comprobante, limpio.

    Cuando el documento que se subio no es una factura (un estado de cuenta,
    por ejemplo), el extractor no encuentra ni punto de venta ni numero y
    devuelve vacio. Armar el texto de cualquier manera dejaba el comprobante
    escrito como "None-None", que despues quedaba guardado asi y volvia a la
    pantalla como si fuera una factura de verdad.
    """
    t = str(v if v is not None else "").strip()
    return "" if t.lower() in ("", "none", "null", "nan") else t


_TIPOS_NOTA = ("NOTA_CREDITO", "NOTA_DEBITO")


def _tipo_comprobante(inv: dict) -> str:
    """
    FACTURA, NOTA_CREDITO o NOTA_DEBITO.

    Se normaliza lo que haya devuelto el extractor: puede venir con acentos,
    en minusculas o separado con espacios o guiones.
    """
    t = str(inv.get("tipo_comprobante") or "").strip().upper()
    t = (t.replace("Á", "A").replace("É", "E").replace("Í", "I")
          .replace("Ó", "O").replace("Ú", "U"))
    t = t.replace("-", " ").replace("_", " ")
    t = " ".join(t.split())
    if "CREDITO" in t:
        return "NOTA_CREDITO"
    if "DEBITO" in t:
        return "NOTA_DEBITO"
    return "FACTURA"


def _es_nota(inv: dict) -> bool:
    """La nota de credito o de debito no es algo que haya que cobrar."""
    return _tipo_comprobante(inv) in _TIPOS_NOTA


def _con_signo(inv: dict) -> float:
    """
    El importe tal como tiene que entrar en las cuentas.

    El papel de la nota de credito viene con el importe en positivo, pero lo
    que hace es restar de la deuda: se le da vuelta el signo una sola vez,
    aca. La nota de debito suma, igual que una factura.
    """
    importe = _round2(inv.get("importe_total"))
    if _tipo_comprobante(inv) == "NOTA_CREDITO":
        return _round2(-abs(importe))
    return _round2(abs(importe))


def _comprobante(inv: dict) -> str:
    """Numero de comprobante de la factura, o vacio si no lo tiene."""
    pv  = _parte_comp(inv.get("punto_venta"))
    nro = _parte_comp(inv.get("comp_nro"))
    if not pv and not nro:
        return ""
    return f"{pv}-{nro}"


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


_CENT = 0.005   # por debajo de medio centavo se considera cero


def _inv_key(inv: dict, i: int) -> str:
    """Con que se identifica una factura en pantalla: la huella del archivo."""
    return (inv.get("_hash") or "").strip() or f"inv:{i}"


def _pay_key(pay: dict, j: int) -> str:
    """Con que se identifica un cobro en pantalla: la huella del archivo."""
    return (pay.get("_hash") or "").strip() or f"pay:{j}"


def _saldo(inv: dict) -> float:
    """
    Lo que le falta cobrar a la factura: su importe, menos lo que cubren las
    notas de credito cruzadas con ella, menos lo cobrado. En una nota de
    credito da negativo: lo que todavia le queda por aplicar.
    """
    return _round2(inv["importe"] - inv.get("nc", 0.0) - inv["pagado"])


def _libre(pay: dict) -> float:
    """Lo que le queda al cobro sin imputar (el remanente)."""
    return _round2(pay["importe"] - pay["aplicado"])


def _aplicar(inv: dict | None, pay: dict | None, monto: float) -> None:
    if inv is not None:
        inv["pagado"] = _round2(inv["pagado"] + monto)
    if pay is not None:
        pay["aplicado"] = _round2(pay["aplicado"] + monto)


def reconcile(invoices: list[dict], payments: list[dict],
              nombres_db: dict | None = None,
              grupos: dict | None = None,
              manuales: list[dict] | None = None,
              guardados: list[dict] | None = None,
              descartados: list[dict] | None = None,
              notas: dict | None = None,
              solo_guardados: bool = False) -> dict:
    """
    Paso 0: cruces YA GUARDADOS en la base               → 'guardado'
    Paso 1: cruces MANUALES hechos en pantalla            → 'manual'
            Un cobro contra varias facturas. Si el cobro sobra, lo que sobra
            queda como remanente, disponible para otro cruce.
    Paso 2: CUIT cliente == CUIT originante + importe exacto → 'alta'
    Paso 3: importe exacto + pago posterior a factura     → 'media'
    Resto:  facturas con saldo / cobros con plata libre.

    Los importes de los pasos 2 y 3 se comparan contra lo que le QUEDA a
    cada uno, no contra el total: asi un remanente puede cruzar solo con
    otra factura del mismo importe.

    nombres_db: mapa CUIT → nombre guardado en la base.
    grupos:     mapa CUIT → {group_id, group_name}.
    manuales:   [{pago: key, facturas: [key, ...]}]
    guardados:  cruces que devuelve get_saved_matches.
    descartados: [{factura: key, pago: key}] cruces automaticos que se
                 desarmaron en pantalla: el motor no los vuelve a armar.
    """
    grupos = grupos or {}
    nombres = canonical_names(invoices, nombres_db)

    invs = []
    for i, inv in enumerate(invoices):
        cuit = _norm_cuit(inv.get("cuit_cliente"))
        invs.append({
            "idx": i,
            "key": _inv_key(inv, i),
            "cuit": cuit,
            "cliente": nombres.get(cuit) or inv.get("razon_social_cliente") or "(sin nombre)",
            "comp": f"{inv.get('punto_venta', '')}-{inv.get('comp_nro', '')}",
            "fecha": inv.get("fecha_emision"),
            "fecha_dt": _parse_date(inv.get("fecha_emision")),
            "importe": _con_signo(inv),
            "tipo": _tipo_comprobante(inv),
            "ajusta": inv.get("comp_ajustado") or "",
            "descripcion": inv.get("descripcion") or "",
            "archivo": inv.get("_archivo") or "",
            "pagado": 0.0,
            # notas de credito cruzadas: en la factura, lo que le descuentan;
            # en la nota, lo ya aplicado con signo negativo.
            "nc": _round2((notas or {}).get(_inv_key(inv, i), 0.0)),
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
            "key": _pay_key(pay, j),
            "cuit": _norm_cuit(pay.get("cuit_originante")),
            "originante": pay.get("originante") or "(sin nombre)",
            "banco": pay.get("banco") or pay.get("banco_destino") or "-",
            "fecha": pay.get("fecha"),
            "fecha_dt": _parse_date(pay.get("fecha")),
            "importe": _round2(pay.get("importe")),
            "referencia": pay.get("referencia") or pay.get("concepto") or "",
            "archivo": pay.get("_archivo") or "",
            "corregido": pay.get("_corregido"),
            "aplicado": 0.0,
        })

    no_cruzar = {(d.get("factura"), d.get("pago")) for d in (descartados or [])}
    inv_by_key = {inv["key"]: inv for inv in invs}
    pay_by_key = {p["key"]: p for p in pays}
    matches = []

    # Paso 0 — lo que ya estaba conciliado y guardado. No se recalcula.
    for g in guardados or []:
        inv = inv_by_key.get(g.get("inv_hash"))
        pay = pay_by_key.get(g.get("pay_hash"))
        if inv is None and pay is None:
            continue
        monto = _round2(g.get("monto"))
        _aplicar(inv, pay, monto)
        matches.append({
            "confianza": g.get("confianza") or "alta",
            "motivo": "Ya estaba conciliado y guardado",
            "monto": monto,
            "guardado": True,
            "match_id": g.get("match_id"),
            "factura": _inv_out(inv) if inv else _inv_guardada(g, nombres),
            "pago": _pay_out(pay) if pay else _pay_guardado(g),
        })

    # Paso 1 — cruces manuales: un cobro contra una o varias facturas.
    for grupo in manuales or []:
        pay = pay_by_key.get(grupo.get("pago"))
        if pay is None:
            continue
        for key in grupo.get("facturas") or []:
            inv = inv_by_key.get(key)
            if inv is None:
                continue
            saldo, libre = _saldo(inv), _libre(pay)
            monto = _round2(min(saldo, libre))
            if monto <= _CENT:
                continue
            _aplicar(inv, pay, monto)
            motivo = "Cruce manual"
            if monto < saldo - _CENT:
                motivo += " — cubre una parte de la factura"
            matches.append(_match(inv, pay, "manual", motivo, monto))

    # solo_guardados: se muestra lo que ya estaba guardado (y lo hecho a mano)
    # sin buscar cruces nuevos. Lo nuevo se busca con el boton "Conciliar".
    pays_auto = [] if solo_guardados else pays

    # Paso 2 — CUIT + importe exacto
    for p in pays_auto:
        if _libre(p) <= _CENT or not p["cuit"]:
            continue
        for inv in invs:
            if not inv["cuit"] or _saldo(inv) <= _CENT:
                continue
            if (inv["key"], p["key"]) in no_cruzar:
                continue
            if inv["cuit"] == p["cuit"] and _saldo(inv) == _libre(p):
                monto = _libre(p)
                _aplicar(inv, p, monto)
                matches.append(_match(inv, p, "alta", "CUIT + importe exacto", monto))
                break

    # Paso 3 — importe exacto + fecha compatible
    for p in pays_auto:
        libre = _libre(p)
        if libre <= _CENT:
            continue
        candidates = [
            inv for inv in invs
            if _saldo(inv) > _CENT and _saldo(inv) == libre
            and (inv["key"], p["key"]) not in no_cruzar
            and _date_ok(inv["fecha_dt"], p["fecha_dt"])
        ]
        if len(candidates) == 1:
            inv = candidates[0]
            _aplicar(inv, p, libre)
            matches.append(_match(inv, p, "media",
                                  "Importe exacto + fecha compatible (CUIT del pagador ≠ CUIT del cliente)",
                                  libre))
        elif len(candidates) > 1:
            # Ambiguo: elegir la factura más antigua, marcar para revisión
            inv = sorted(candidates, key=lambda x: x["fecha_dt"] or datetime.max)[0]
            _aplicar(inv, p, libre)
            matches.append(_match(inv, p, "revisar",
                                  f"Importe coincide con {len(candidates)} facturas — se imputó la más antigua",
                                  libre))

    pendientes = []
    for inv in invs:
        es_nc = inv["tipo"] == "NOTA_CREDITO"
        if _saldo(inv) > _CENT or (es_nc and _saldo(inv) < -_CENT):
            out = _inv_out(inv)
            out["saldo"] = _saldo(inv)
            out["pagado"] = inv["pagado"]
            pendientes.append(out)

    # Cuenta corriente por cliente (clave: CUIT del cliente)
    cc = {}
    pagos_de = defaultdict(set)
    for inv in invs:
        key = inv["cuit"] or f"SIN_CUIT::{inv['cliente']}"
        c = cc.setdefault(key, {"cuit": inv["cuit"], "cliente": inv["cliente"],
                                "facturado": 0.0, "cobrado": 0.0,
                                "n_facturas": 0, "n_pagos": 0})
        c["facturado"] = _round2(c["facturado"] + inv["importe"])
        c["n_facturas"] += 1
    total_imputado = 0.0
    for m in matches:
        if m["factura"].get("fuera_de_pantalla"):
            continue
        key = m["factura"]["cuit"] or f"SIN_CUIT::{m['factura']['cliente']}"
        if key in cc:
            cc[key]["cobrado"] = _round2(cc[key]["cobrado"] + m["monto"])
            pagos_de[key].add(m["pago"]["key"])
            total_imputado = _round2(total_imputado + m["monto"])
    # Plata libre de un cobro cuyo CUIT coincide con un cliente → "a cuenta"
    total_a_cuenta = 0.0
    for p in pays:
        libre = _libre(p)
        if libre <= _CENT or not p["cuit"] or p["cuit"] not in cc:
            continue
        cc[p["cuit"]]["cobrado"] = _round2(cc[p["cuit"]]["cobrado"] + libre)
        pagos_de[p["cuit"]].add(p["key"])
        total_a_cuenta = _round2(total_a_cuenta + libre)
        p["a_cuenta"] = True
    for key, c in cc.items():
        c["n_pagos"] = len(pagos_de[key])
        c["saldo"] = _round2(c["facturado"] - c["cobrado"])
        g = grupos.get(c["cuit"]) or {}
        c["group_id"] = g.get("group_id")
        c["grupo"] = g.get("group_name") or "Sin grupo"

    sin_imputar = []
    for p in pays:
        libre = _libre(p)
        if libre <= _CENT:
            continue
        out = _pay_out(p)
        out["libre"] = libre
        # Si ya se uso una parte, lo que queda es el cobro "clonado" por el
        # remanente: se muestra como una linea aparte y se puede cruzar.
        out["remanente"] = p["aplicado"] > _CENT
        sin_imputar.append(out)

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
            "total_cobrado": _round2(total_imputado + total_a_cuenta),
            "total_pendiente": _round2(sum(_saldo(i) for i in invs if _saldo(i) > _CENT)),
        },
    }


def _inv_guardada(g: dict, nombres: dict) -> dict:
    """Factura de un cruce guardado que no esta en la pantalla."""
    cuit = _norm_cuit(g.get("cuit"))
    return {"key": g.get("inv_hash"), "cuit": cuit,
            "cliente": nombres.get(cuit) or g.get("cliente") or "(sin nombre)",
            "comp": g.get("comprobante") or "", "fecha": g.get("fecha_factura"),
            "importe": _round2(g.get("importe_factura")),
            "descripcion": g.get("descripcion") or "", "archivo": "",
            "fuera_de_pantalla": True}


def _pay_guardado(g: dict) -> dict:
    """Cobro de un cruce guardado que no esta en la pantalla."""
    return {"key": g.get("pay_hash"), "cuit": _norm_cuit(g.get("cuit_pagador")),
            "originante": g.get("originante") or "(sin nombre)",
            "banco": g.get("banco") or "-", "fecha": g.get("fecha_pago"),
            "importe": _round2(g.get("importe_pago")),
            "referencia": g.get("referencia") or "", "archivo": "",
            "corregido": None, "a_cuenta": False, "fuera_de_pantalla": True}


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


def _match(inv, p, confianza, motivo, monto) -> dict:
    return {"confianza": confianza, "motivo": motivo, "monto": _round2(monto),
            "guardado": False, "match_id": None,
            "factura": _inv_out(inv), "pago": _pay_out(p)}


def _inv_out(inv) -> dict:
    out = {k: inv[k] for k in
           ("key", "cuit", "cliente", "comp", "fecha", "importe", "descripcion",
            "archivo", "tipo", "ajusta")}
    # Importe "actualizado" por las notas de credito cruzadas con la factura.
    out["nc_aplicado"] = abs(inv.get("nc", 0.0))
    out["importe_neto"] = _round2(inv["importe"] - inv.get("nc", 0.0))
    return out


def _pay_out(p) -> dict:
    out = {k: p[k] for k in
           ("key", "cuit", "originante", "banco", "fecha", "importe", "referencia", "archivo")}
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

        @self.router.get("/registros", response_class=HTMLResponse)
        async def registros_page(request: Request):
            return templates.TemplateResponse(
                "records.html", {"request": request})

        @self.router.get("/registros/page")
        async def registros_page_data(tab: str = "facturas", page: int = 1,
                                      size: int = 25, q: str = "",
                                      orden: str = "fecha", dir: str = "desc"):
            """
            Una pagina de facturas, cobros, cruces o clientes, leida de la base
            en este mismo momento. Tambien devuelve cuantos hay en cada solapa.
            """
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db",
                                     "message": "Sin DATABASE_URL no hay registros"},
                                    status_code=400)
            lectores = {
                "facturas": (mgr.page_invoices, "facturas"),
                "cobros":   (mgr.page_payments, "cobros"),
                "cruces":   (mgr.page_matches,  "cruces"),
                "clientes": (mgr.page_clients,  "clientes"),
            }
            if tab not in lectores:
                return JSONResponse({"status": "error",
                                     "message": "Solapa desconocida"},
                                    status_code=400)
            try:
                size = min(max(int(size), 1), 100)
                totales = mgr.count_records(q)
                total = totales[lectores[tab][1]]
                paginas = max(1, -(-total // size))
                page = min(max(int(page), 1), paginas)   # si la ultima se vacio, retrocede
                if tab == "clientes":
                    items = mgr.page_clients(q, size, (page - 1) * size)
                else:
                    items = lectores[tab][0](q, size, (page - 1) * size,
                                             orden, dir == "asc")
                return JSONResponse({
                    "status":  "ok",
                    "tab":     tab,
                    "page":    page,
                    "size":    size,
                    "pages":   paginas,
                    "total":   total,
                    "totales": totales,
                    "items":   items,
                    "orden":   orden,
                    "dir":     dir,
                })
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo traer la pagina de registros")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.get("/registros/invoice_matches")
        async def registros_invoice_matches(invoice_id: int):
            """Los cruces guardados de UNA factura, leidos de la base ahora."""
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                return JSONResponse({"status": "ok",
                                     "cruces": mgr.list_matches_of(invoice_id=invoice_id),
                                     "n_notas": mgr.count_nc_applications(invoice_id)})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudieron traer los cruces de la factura")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.get("/registros/payment_matches")
        async def registros_payment_matches(payment_id: int):
            """Los cruces guardados de UN cobro, leidos de la base ahora."""
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                return JSONResponse({"status": "ok",
                                     "cruces": mgr.list_matches_of(payment_id=payment_id)})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudieron traer los cruces del cobro")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.get("/registros/file/{file_hash}")
        async def registros_file(file_hash: str):
            """Abre el archivo original tal como se subio."""
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                doc = mgr.get_uploaded_file(file_hash)
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo traer el archivo")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)
            if not doc:
                return JSONResponse({"status": "not_found",
                                     "message": "El archivo no quedo guardado"},
                                    status_code=404)
            nombre = (doc["nombre"] or "documento.pdf").replace('"', "")
            return Response(
                content=doc["contenido"],
                media_type=doc["tipo"],
                headers={"Content-Disposition": f'inline; filename="{nombre}"'})

        @self.router.post("/registros/payment_manual")
        async def registros_payment_manual(request: Request):
            """Alta de un cobro cargado a mano, sin comprobante."""
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                importe = _round2(body.get("importe"))
                if not importe:
                    return JSONResponse({"status": "error",
                                         "message": "Falta el importe"},
                                        status_code=400)
                pay_id = mgr.persist_manual_payment({
                    "cuit_originante": _norm_cuit(body.get("cuit")),
                    "originante":      body.get("originante"),
                    "fecha_iso":       _iso_date(body.get("fecha")),
                    "importe":         importe,
                    "banco":           body.get("banco") or "Carga manual",
                    "referencia":      body.get("referencia"),
                })
                return JSONResponse({"status": "ok", "payment_id": pay_id})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo cargar el cobro a mano")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/registros/payment_delete")
        async def registros_payment_delete(request: Request):
            """
            Baja de un cobro. Si tenia cruces se sacan con el, las facturas que
            cubria vuelven a quedar pendientes, y se devuelve cuantos eran para
            poder avisarlo en pantalla.
            """
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                n_cruces = mgr.delete_payment(int(body.get("payment_id")))
                return JSONResponse({"status": "ok", "n_cruces": n_cruces})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo borrar el cobro")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/registros/invoice_delete")
        async def registros_invoice_delete(request: Request):
            """
            Baja de una factura guardada. Si tenia cruces se sacan con ella (los
            cobros quedan en la base, libres para cruzarse de nuevo) y se
            devuelve cuantos eran para poder avisarlo en pantalla.
            """
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                invoice_id = int(body.get("invoice_id"))
            except (TypeError, ValueError):
                return JSONResponse({"status": "error",
                                     "message": "Falta la factura"},
                                    status_code=400)
            try:
                n_cruces = mgr.delete_invoice(invoice_id)
                return JSONResponse({"status": "ok", "n_cruces": n_cruces})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo borrar la factura")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.get("/registros/clients")
        async def registros_clients(q: str = ""):
            """Clientes que coinciden con lo escrito (hasta 20), para sugerir."""
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                return JSONResponse({"status": "ok",
                                     "clientes": mgr.page_clients(q, 20, 0)})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudieron traer los clientes")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/registros/client_name")
        async def registros_client_name(request: Request):
            """Cambia el nombre con el que se muestra el cliente."""
            body = await request.json()
            nombre = (body.get("nombre") or "").strip()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            if not nombre:
                return JSONResponse({"status": "error",
                                     "message": "Falta el nombre"},
                                    status_code=400)
            try:
                mgr.set_client_name(int(body.get("client_id")), nombre)
                return JSONResponse({"status": "ok"})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo cambiar el nombre del cliente")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/registros/match_delete")
        async def registros_match_delete(request: Request):
            """Saca UN cruce, el que se eligio en pantalla."""
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                mgr.delete_match(int(body.get("match_id")))
                return JSONResponse({"status": "ok"})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo sacar el cruce")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/registros/payment_file")
        async def registros_payment_file(payment_id: int = Form(...),
                                         file: UploadFile = File(...)):
            """Sube el comprobante de un cobro que se habia cargado a mano."""
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                raw_bytes = await file.read()
                if not raw_bytes:
                    return JSONResponse({"status": "error",
                                         "message": "El archivo llego vacio"},
                                        status_code=400)
                huella = _file_hash(raw_bytes)
                mime = _mime_de(file.filename, file.content_type)
                mgr.save_uploaded_file(huella, file.filename, mime, raw_bytes)
                mgr.set_payment_file(payment_id, huella, file.filename)
                return JSONResponse({"status": "ok", "huella": huella})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo guardar el comprobante del cobro")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

        @self.router.post("/load_from_db")
        async def load_from_db(request: Request):
            """
            Trae a la pantalla las facturas y los cobros YA GUARDADOS en un
            rango de fechas, para poder cruzarlos con lo que se sube ahora.
            No modifica nada: solo lee.
            """
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db",
                                     "message": "Sin base no hay nada guardado"},
                                    status_code=400)
            try:
                desde = _iso_date(body.get("desde")) or body.get("desde") or None
                hasta = _iso_date(body.get("hasta")) or body.get("hasta") or None
                return JSONResponse({
                    "status":   "ok",
                    "invoices": mgr.get_invoices_between(desde, hasta),
                    "payments": mgr.get_payments_between(desde, hasta),
                })
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo traer lo guardado")
                return JSONResponse({"status": "error", "message": str(e)},
                                    status_code=500)

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
            manuales = body.get("manuales") or []
            descartados = body.get("descartados") or []
            sacar = {int(x) for x in (body.get("sacar") or [])}
            _completar_marcas(invoices, payments)
            try:
                mgr = _get_manager()
                nombres_db, grupos, guardados = {}, {}, []
                if mgr.is_enabled():
                    try:
                        nombres_db = mgr.get_canonical_names()
                        grupos = mgr.get_cuit_group_map()
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudo leer clientes y grupos de la base")
                    # Lo que ya estaba conciliado se recupera tal cual,
                    # en vez de volver a calcularlo.
                    try:
                        guardados = mgr.get_saved_matches(
                            [_inv_key(x, i) for i, x in enumerate(invoices)],
                            [_pay_key(x, j) for j, x in enumerate(payments)])
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudieron leer los cruces guardados")
                    # Los guardados que se desarmaron en pantalla no cuentan
                    # (en la base se sacan recien al guardar).
                    guardados = [g for g in guardados
                                 if g.get("match_id") not in sacar]
                notas = {}
                if mgr.is_enabled():
                    try:
                        notas = _notas_por_clave(mgr, invoices)
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudieron leer los cruces de notas de credito")
                result = reconcile(invoices, payments, nombres_db, grupos,
                                   manuales, guardados, descartados, notas,
                                   solo_guardados=bool(body.get("solo_guardados")))
                result["solo_guardados"] = bool(body.get("solo_guardados"))
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

        # ── Cruces nota de credito <-> factura (se guardan aparte) ─────────

        @self.router.post("/nc/list")
        async def nc_list(request: Request):
            """Cruces de notas de credito donde participa alguno de estos ids."""
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                return JSONResponse({"status": "ok",
                                     "cruces": mgr.list_nc_applications(body.get("ids") or [])})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudieron leer los cruces de notas de credito")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

        @self.router.post("/nc/save")
        async def nc_save(request: Request):
            """
            Guarda solo los cruces nota de credito <-> factura de esta solapa.
            Cada uno pasa por las reglas de la base; si alguno no las cumple se
            avisa cual y por que, y los demas se guardan igual.
            """
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            guardados, errores = 0, []
            for c in body.get("cruces") or []:
                try:
                    mgr.save_nc_application(int(c["nc_id"]), int(c["invoice_id"]),
                                            float(c["monto"]))
                    guardados += 1
                except Exception as e:  # noqa: BLE001
                    msg = str(e).split("\n")[0].split("CONTEXT")[0].strip()
                    errores.append({"nc_id": c.get("nc_id"),
                                    "invoice_id": c.get("invoice_id"), "error": msg})
            return JSONResponse({"status": "ok", "guardados": guardados, "errores": errores})

        @self.router.post("/nc/delete")
        async def nc_delete(request: Request):
            """Deshace un cruce nota de credito <-> factura guardado."""
            body = await request.json()
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                mgr.delete_nc_application(int(body.get("id")))
                return JSONResponse({"status": "ok"})
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudo deshacer el cruce de la nota de credito")
                return JSONResponse({"status": "error", "message": str(e)}, status_code=500)

        @self.router.post("/sync_docs")
        async def sync_docs(request: Request):
            """
            Se llama al pasar de un paso al otro. Hace dos cosas:

              1. Guarda en la base las facturas y los cobros nuevos (los que
                 todavia no tienen id de la base).
              2. Vuelve a leer de la base TODO lo que hay en pantalla. Lo que
                 vuelve es lo que dice la base; lo que alguien borro desde
                 Registros vuelve como null y la pantalla lo saca.

            La respuesta trae una entrada por cada documento recibido y en el
            mismo orden. Los cruces no se tocan: esos solo con "Guardar en base".
            """
            body = await request.json()
            invoices = body.get("invoices") or []
            payments = body.get("payments") or []
            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db"}, status_code=400)
            try:
                nuevas_inv = [i for i, d in enumerate(invoices) if not d.get("_id_bd")]
                nuevos_pay = [j for j, d in enumerate(payments) if not d.get("_id_bd")]

                ids_inv, ids_pay = {}, {}
                if nuevas_inv or nuevos_pay:
                    inv_ids, pay_ids = _persist_docs(
                        mgr, [invoices[i] for i in nuevas_inv],
                        [payments[j] for j in nuevos_pay])
                    for pos, i in enumerate(nuevas_inv):
                        ids_inv[i] = inv_ids[_inv_key(invoices[i], pos)]
                    for pos, j in enumerate(nuevos_pay):
                        ids_pay[j] = pay_ids[_pay_key(payments[j], pos)]

                for i, d in enumerate(invoices):
                    if i not in ids_inv:
                        ids_inv[i] = int(d["_id_bd"])
                for j, d in enumerate(payments):
                    if j not in ids_pay:
                        ids_pay[j] = int(d["_id_bd"])

                en_base_inv = mgr.get_invoices_by_ids(list(ids_inv.values()))
                en_base_pay = mgr.get_payments_by_ids(list(ids_pay.values()))

                return JSONResponse({
                    "status":   "ok",
                    "facturas": [en_base_inv.get(ids_inv[i]) for i in range(len(invoices))],
                    "pagos":    [en_base_pay.get(ids_pay[j]) for j in range(len(payments))],
                    "n_nuevas": len(nuevas_inv),
                    "n_nuevos": len(nuevos_pay),
                })
            except Exception as e:  # noqa: BLE001
                logger.exception("No se pudieron guardar facturas y cobros")
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
            solo_manuales = bool(body.get("solo_manuales"))

            mgr = _get_manager()
            if not mgr.is_enabled():
                return JSONResponse({"status": "no_db",
                                     "message": "Sin DATABASE_URL no se puede guardar"},
                                    status_code=400)
            try:
                # Si la pantalla trae algo que alguien borro desde Registros, no
                # se guarda nada: guardar lo volveria a crear sin que nadie lo
                # pida. La pantalla lo saca y se vuelve a intentar.
                faltan_inv, faltan_pay = _faltantes_en_base(mgr, invoices, payments)
                if faltan_inv or faltan_pay:
                    return JSONResponse({
                        "status": "desactualizado",
                        "faltan_facturas": faltan_inv,
                        "faltan_pagos": faltan_pay,
                        "message": ("Hay documentos de esta pantalla que ya no estan "
                                    "en la base (se borraron desde Registros). "
                                    "No se guardo nada."),
                    }, status_code=409)

                # Cruces guardados que se desarmaron en pantalla, uno por uno,
                # cada uno elegido a mano con su ✕. Es lo unico que se saca.
                sacar = [int(x) for x in (body.get("sacar") or [])]
                for match_id in sacar:
                    mgr.delete_match(match_id)

                # Facturas y cobros (si ya se guardaron al pasar de paso, la
                # base devuelve los mismos, sin duplicar)
                inv_ids, pay_ids = _persist_docs(mgr, invoices, payments)

                # Cruces
                # REGLA: guardar no borra nada por su cuenta. Solo saca los
                # cruces que la persona desarmo a mano, de a uno, con su ✕ en
                # pantalla (lista "sacar", arriba). Un cruce que ya estaba se
                # pisa solo si vuelve a salir el MISMO par factura-cobro.
                # Se guarda lo imputado en cada cruce (monto), que puede ser
                # una parte del cobro cuando un cobro paga varias facturas.
                # Si el mismo par factura-cobro ya tenia un cruce guardado y se
                # le suma uno nuevo, se guarda el total, para no perder lo que
                # ya estaba imputado.
                por_par, nuevos = {}, {}
                for m in result.get("matches") or []:
                    par = (m["factura"].get("key"), m["pago"].get("key"))
                    monto = _round2(m.get("monto") or m["pago"]["importe"])
                    por_par[par] = _round2(por_par.get(par, 0.0) + monto)
                    # solo_manuales: al saltar de solapa se guarda lo que la persona
                    # hizo a mano; lo que solo propone el sistema espera al boton.
                    if not m.get("guardado") and (
                            not solo_manuales or m["confianza"] == "manual"):
                        nuevos[par] = m["confianza"]

                n_matches = 0
                for (k_inv, k_pay), confianza in nuevos.items():
                    if k_inv in inv_ids and k_pay in pay_ids:
                        mgr.persist_match(inv_ids[k_inv], pay_ids[k_pay],
                                          por_par[(k_inv, k_pay)], confianza,
                                          "manual" if confianza == "manual" else "zym")
                        n_matches += 1

                return JSONResponse({
                    "status": "ok",
                    "n_facturas": len(inv_ids),
                    "n_pagos": len(pay_ids),
                    "n_matches": n_matches,
                    "n_sacados": len(sacar),
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
                mime = _mime_de(f.filename, f.content_type)

                # El archivo se guarda apenas se sube, para poder abrirlo
                # despues desde la pantalla de Registros.
                if mgr.is_enabled():
                    try:
                        mgr.save_uploaded_file(huella, f.filename,
                                               mime, raw_bytes)
                    except Exception:  # noqa: BLE001
                        logger.exception("No se pudo guardar el archivo subido")

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

                data = _extract_document(raw_bytes, prompt_name, mime)
                data["_archivo"] = f.filename
                data["_hash"] = huella
                data["_duplicado"] = False

                # La misma factura puede venir en otro archivo: el archivo es
                # distinto, pero el numero de comprobante es el mismo. Sin esto
                # la factura quedaba cargada dos veces, una como pendiente y
                # otra como cancelada.
                if es_factura and mgr.is_enabled():
                    numero = _comprobante(data)
                    tipo = _tipo_comprobante(data)
                    como_se_llama = ("La nota de crédito" if tipo == "NOTA_CREDITO"
                                     else "La nota de débito" if tipo == "NOTA_DEBITO"
                                     else "La factura")
                    try:
                        mismo_numero = (mgr.find_invoice_by_number(
                            data.get("cuit_emisor") or "", numero, tipo)
                            if numero else None)
                    except Exception:  # noqa: BLE001
                        logger.exception(
                            "No se pudo consultar el numero de comprobante")
                        mismo_numero = None

                    if mismo_numero:
                        aviso = (f"{como_se_llama} {numero} ya está registrada "
                                 f"(el archivo es otro)")
                        if mismo_numero.get("_estado") == "paid":
                            aviso = (f"{como_se_llama} {numero} ya está registrada "
                                     f"como PAGADA (el archivo es otro)")
                        data["_id_bd"] = mismo_numero.get("_id_bd")
                        data["_client_id"] = mismo_numero.get("_client_id")
                        data["_estado"] = mismo_numero.get("_estado")
                        data["_duplicado"] = True
                        data["_aviso"] = aviso

                results.append(data)
            except Exception as e:  # noqa: BLE001
                logger.exception("Error extrayendo %s", f.filename)
                errors.append({"archivo": f.filename, "error": str(e)})

        return JSONResponse({"status": "ok", "documents": results, "errors": errors})
