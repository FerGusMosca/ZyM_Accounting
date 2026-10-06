# data_access_layer/reconciliation_manager.py
"""
Conciliacion de Cobranzas — Data Access Layer
----------------------------------------------
Habla con la base zym a traves de las stored functions definidas en
sql/03_sps.sql. Mismo patron que property_manager.py de TheCloseInmob:
la clase recibe el DATABASE_URL, abre una conexion por operacion y
mapea filas a diccionarios.

Si DATABASE_URL no esta configurado, is_enabled() devuelve False y el
modulo sigue funcionando como antes, con el estado en el navegador.
"""

import logging

logger = logging.getLogger(__name__)


# ── Column indexes devueltos por find_invoice_by_hash / by_number ─────────────
_INV_ID_IDX             = 0
_INV_CLIENT_ID_IDX      = 1
_INV_CLIENT_NAME_IDX    = 2
_INV_CLIENT_CUIT_IDX    = 3
_INV_ISSUER_CUIT_IDX    = 4
_INV_NUMBER_IDX         = 5
_INV_ISSUE_DATE_IDX     = 6
_INV_AMOUNT_IDX         = 7
_INV_STATUS_IDX         = 8
_INV_DESCRIPTION_IDX    = 9
_INV_FILE_NAME_IDX      = 10
_INV_DOC_TYPE_IDX       = 11
_INV_ADJUSTS_IDX        = 12

# ── Column indexes devueltos por get_client_account ──────────────────────────
_CC_CLIENT_ID_IDX       = 0
_CC_CUIT_IDX            = 1
_CC_NAME_IDX            = 2
_CC_GROUP_ID_IDX        = 3
_CC_GROUP_NAME_IDX      = 4
_CC_N_INVOICES_IDX      = 5
_CC_INVOICED_IDX        = 6
_CC_N_PAYMENTS_IDX      = 7
_CC_COLLECTED_IDX       = 8
_CC_BALANCE_IDX         = 9


def _split_comprobante(comprobante: str) -> tuple[str, str]:
    """
    "00002-00000183" -> ("00002", "00000183").

    La factura guardada tiene que volver con la misma forma que la que sale del
    extractor, porque la pantalla y el motor de conciliacion arman el numero de
    comprobante juntando punto de venta y numero.
    """
    partes = str(comprobante or "").split("-", 1)
    if len(partes) == 2:
        return partes[0], partes[1]
    return "", str(comprobante or "")


def _row_to_invoice(row) -> dict:
    """
    Mapea una fila de factura al MISMO formato que devuelve el extractor.
    Asi, si la persona decide cargarla igual, el resto del modulo no nota la
    diferencia entre una factura recien leida y una que ya estaba guardada.
    """
    punto_venta, comp_nro = _split_comprobante(row[_INV_NUMBER_IDX])
    return {
        "_id_bd":               row[_INV_ID_IDX],
        "_client_id":           row[_INV_CLIENT_ID_IDX],
        "_estado":              row[_INV_STATUS_IDX],
        "razon_social_cliente": row[_INV_CLIENT_NAME_IDX],
        "cuit_cliente":         row[_INV_CLIENT_CUIT_IDX],
        "cuit_emisor":          row[_INV_ISSUER_CUIT_IDX],
        "punto_venta":          punto_venta,
        "comp_nro":             comp_nro,
        "fecha_emision":        row[_INV_ISSUE_DATE_IDX].strftime("%d/%m/%Y")
                                if row[_INV_ISSUE_DATE_IDX] else None,
        "importe_total":        float(row[_INV_AMOUNT_IDX]) if row[_INV_AMOUNT_IDX] else 0.0,
        "descripcion":          row[_INV_DESCRIPTION_IDX],
        "tipo_comprobante":     row[_INV_DOC_TYPE_IDX] or "FACTURA",
        "comp_ajustado":        row[_INV_ADJUSTS_IDX],
    }



# ── Mapeo de filas (las comparten Conciliacion y Registros) ───────────────────

def _escape_like(texto: str | None) -> str:
    """El texto buscado, sin que % ni _ valgan como comodines."""
    t = (texto or "").strip()
    return t.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _fila_a_factura_pantalla(r) -> dict:
    """Fila de get_invoices_between / get_invoices_by_ids -> factura de pantalla."""
    punto_venta, comp_nro = _split_comprobante(r[5])
    return {
        "_id_bd":               r[0],
        "_client_id":           r[1],
        "_estado":              r[8],
        "razon_social_cliente": r[2],
        "cuit_cliente":         r[3],
        "cuit_emisor":          r[4],
        "punto_venta":          punto_venta,
        "comp_nro":             comp_nro,
        "fecha_emision":        r[6].strftime("%d/%m/%Y") if r[6] else None,
        "importe_total":        float(r[7] or 0),
        "descripcion":          r[9],
        "_archivo":             r[10],
        "_hash":                (r[11] or "").strip(),
        "tipo_comprobante":     r[12] or "FACTURA",
        "comp_ajustado":        r[13],
        "_de_la_base":          True,
    }


def _fila_a_pago_pantalla(r) -> dict:
    """Fila de get_payments_between / get_payments_by_ids -> cobro de pantalla."""
    return {
        "_id_bd":          r[0],
        "cuit_originante": r[1],
        "originante":      r[2],
        "fecha":           r[3].strftime("%d/%m/%Y") if r[3] else None,
        "importe":         float(r[4] or 0),
        "banco":           r[5],
        "referencia":      r[6],
        "_archivo":        r[7],
        "_hash":           (r[8] or "").strip(),
        "_de_la_base":     True,
    }


def _fila_a_factura_registro(r) -> dict:
    return {
        "id":          r[0],
        "cliente":     r[1],
        "cuit":        r[2],
        "comprobante": r[3],
        "fecha":       r[4].strftime("%d/%m/%Y") if r[4] else None,
        "importe":     float(r[5] or 0),
        "imputado":    float(r[6] or 0),
        "estado":      r[7],
        "descripcion": r[8],
        "archivo":     r[9],
        "huella":      (r[10] or "").strip(),
        "tiene_archivo": bool(r[11]),
        "tipo":        r[13] or "FACTURA",
        "ajusta":      r[14],
    }


def _fila_a_pago_registro(r) -> dict:
    return {
        "id":         r[0],
        "originante": r[1],
        "cuit":       r[2],
        "fecha":      r[3].strftime("%d/%m/%Y") if r[3] else None,
        "importe":    float(r[4] or 0),
        "imputado":   float(r[5] or 0),
        "banco":      r[6],
        "referencia": r[7],
        "archivo":    r[8],
        "huella":     (r[9] or "").strip(),
        "tiene_archivo": bool(r[10]),
    }


def _fila_a_cruce_registro(r) -> dict:
    return {
        "id":              r[0],
        "invoice_id":      r[1],
        "comprobante":     r[2],
        "cliente":         r[3],
        "fecha_factura":   r[4].strftime("%d/%m/%Y") if r[4] else None,
        "importe_factura": float(r[5] or 0),
        "payment_id":      r[6],
        "fecha_pago":      r[7].strftime("%d/%m/%Y") if r[7] else None,
        "banco":           r[8],
        "originante":      r[9],
        "importe":         float(r[10] or 0),
        "confianza":       r[11],
    }


def _fila_a_cliente_registro(r) -> dict:
    return {
        "id":         r[0],
        "cuit":       r[1],
        "nombre":     r[2],
        "grupo":      r[3],
        "n_facturas": r[4],
        "facturado":  float(r[5] or 0),
    }


# Consulta usada para los duplicados. Trae todo lo que la pantalla necesita
# para poder seguir trabajando con la factura sin volver a leer el PDF.
_INVOICE_SELECT = """
    SELECT i.id, i.client_id, c.name, c.cuit, i.issuer_cuit,
           i.invoice_number, i.issue_date, i.amount, i.status,
           i.description, i.file_name, i.doc_type, i.adjusts_number
    FROM invoices i
    JOIN clients  c ON c.id = i.client_id
"""


class ReconciliationManager:

    def __init__(self, database_url: str | None):
        self.database_url = database_url

    # ── Conexion ─────────────────────────────────────────────────────────────

    def is_enabled(self) -> bool:
        """False cuando no hay DATABASE_URL: la pantalla funciona sin base."""
        return bool(self.database_url)

    def _connect(self):
        import psycopg2
        return psycopg2.connect(self.database_url)

    def ping(self) -> bool:
        """Prueba la conexion. La pantalla la usa para saber si mostrar Guardar."""
        if not self.is_enabled():
            return False
        try:
            with self._connect() as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT 1")
                    cur.fetchone()
            return True
        except Exception:  # noqa: BLE001
            logger.exception("No se pudo conectar a la base")
            return False

    # ── Duplicados ───────────────────────────────────────────────────────────

    def find_invoice_by_hash(self, file_hash: str) -> dict | None:
        """La factura ya cargada que corresponde a ese PDF, o None."""
        if not self.is_enabled():
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(_INVOICE_SELECT + " WHERE i.file_hash = %s", (file_hash,))
                row = cur.fetchone()
                return _row_to_invoice(row) if row else None

    def find_invoice_by_number(self, issuer_cuit: str, invoice_number: str,
                               doc_type: str = "FACTURA") -> dict | None:
        """
        El mismo comprobante aunque el archivo PDF sea otro, o None.

        El tipo entra en la busqueda: una nota de credito lleva su propia
        numeracion y puede repetir el numero de una factura.
        """
        if not self.is_enabled():
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _INVOICE_SELECT +
                    " WHERE i.issuer_cuit = %s AND i.invoice_number = %s"
                    "   AND i.doc_type = %s",
                    (issuer_cuit, invoice_number, doc_type or "FACTURA"))
                row = cur.fetchone()
                return _row_to_invoice(row) if row else None

    def find_payment_by_hash(self, file_hash: str) -> dict | None:
        """
        El cobro ya cargado que corresponde a ese PDF, o None.
        Vuelve con el mismo formato que devuelve el extractor.
        """
        if not self.is_enabled():
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT id, payer_cuit, payer_name, payment_date,
                           amount, bank, reference
                    FROM payments WHERE file_hash = %s
                """, (file_hash,))
                row = cur.fetchone()
                if not row:
                    return None
                return {
                    "_id_bd":          row[0],
                    "cuit_originante": row[1],
                    "originante":      row[2],
                    "fecha":           row[3].strftime("%d/%m/%Y") if row[3] else None,
                    "importe":         float(row[4]) if row[4] else 0.0,
                    "banco":           row[5],
                    "referencia":      row[6],
                }

    # ── Alta ─────────────────────────────────────────────────────────────────

    def persist_invoice(self, inv: dict) -> int:
        """Guarda la factura. Si ya estaba, devuelve el id existente."""
        import json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT persist_invoice(
                        %s::VARCHAR, %s::VARCHAR, %s::VARCHAR, %s::VARCHAR,
                        %s::DATE, %s::NUMERIC, %s::TEXT, %s::VARCHAR,
                        %s::CHAR(64), %s::JSONB, %s::VARCHAR, %s::VARCHAR)
                """, (
                    inv.get("cuit_cliente"),
                    inv.get("razon_social_cliente"),
                    inv.get("cuit_emisor"),
                    inv.get("comprobante"),
                    inv.get("fecha_emision_iso"),
                    inv.get("importe_total"),
                    inv.get("descripcion"),
                    inv.get("archivo"),
                    inv.get("file_hash"),
                    json.dumps(inv.get("raw") or {}),
                    inv.get("tipo_comprobante") or "FACTURA",
                    inv.get("comp_ajustado"),
                ))
                invoice_id = cur.fetchone()[0]
                conn.commit()
                return invoice_id

    def persist_payment(self, pay: dict) -> int:
        """Guarda el cobro. Si ya estaba, devuelve el id existente."""
        import json
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT persist_payment(
                        %s::VARCHAR, %s::VARCHAR, %s::DATE, %s::NUMERIC,
                        %s::VARCHAR, %s::VARCHAR, %s::VARCHAR,
                        %s::CHAR(64), %s::JSONB)
                """, (
                    pay.get("cuit_originante"),
                    pay.get("originante"),
                    pay.get("fecha_iso"),
                    pay.get("importe"),
                    pay.get("banco"),
                    pay.get("referencia"),
                    pay.get("archivo"),
                    pay.get("file_hash"),
                    json.dumps(pay.get("raw") or {}),
                ))
                payment_id = cur.fetchone()[0]
                conn.commit()
                return payment_id

    def persist_match(self, invoice_id: int, payment_id: int, amount: float,
                      confidence: str, confirmed_by: str | None = None) -> int:
        """Guarda el cruce y deja la factura en paid si quedo cubierta."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT persist_match(%s::INT, %s::INT, %s::NUMERIC,
                                         %s::VARCHAR, %s::VARCHAR)
                """, (invoice_id, payment_id, amount, confidence, confirmed_by))
                match_id = cur.fetchone()[0]
                conn.commit()
                return match_id

    # ── Clientes y grupos ────────────────────────────────────────────────────

    def upsert_client(self, cuit: str, name: str) -> int:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT upsert_client(%s::VARCHAR, %s::VARCHAR)",
                            (cuit, name))
                client_id = cur.fetchone()[0]
                conn.commit()
                return client_id

    def set_client_name(self, client_id: int, name: str) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT set_client_name(%s::INT, %s::VARCHAR)",
                            (client_id, name))
                conn.commit()

    def get_groups(self) -> list[dict]:
        """Grupos existentes, para el desplegable de la pantalla."""
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT id, name FROM client_groups ORDER BY name")
                return [{"id": r[0], "nombre": r[1]} for r in cur.fetchall()]

    def upsert_group(self, group_id: int | None, name: str) -> int:
        """Crea el grupo o le cambia el nombre."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT upsert_client_group(%s::INT, %s::VARCHAR)",
                            (group_id, name))
                new_id = cur.fetchone()[0]
                conn.commit()
                return new_id

    def delete_group(self, group_id: int) -> None:
        """Borra el grupo. Los clientes quedan sueltos, no se borran."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("DELETE FROM client_groups WHERE id = %s", (group_id,))
                conn.commit()

    def assign_cuit_to_group(self, cuit: str, name: str, group_id: int | None) -> int:
        """
        Asigna el cliente al grupo. Si el cliente todavia no existe en la base
        se crea, asi se pueden armar grupos antes de guardar nada.
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT upsert_client(%s::VARCHAR, %s::VARCHAR)",
                            (cuit, name))
                client_id = cur.fetchone()[0]
                cur.execute("SELECT assign_client_to_group(%s::INT, %s::INT)",
                            (client_id, group_id))
                conn.commit()
                return client_id

    def get_cuit_group_map(self) -> dict:
        """
        Mapa CUIT -> {group_id, group_name}. Es lo que la pantalla usa para
        agrupar las tarjetas de cuenta corriente.
        """
        if not self.is_enabled():
            return {}
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT c.cuit, g.id, g.name
                    FROM clients c
                    JOIN client_groups g ON g.id = c.group_id
                """)
                return {r[0]: {"group_id": r[1], "group_name": r[2]}
                        for r in cur.fetchall()}

    def get_canonical_names(self) -> dict:
        """
        Mapa CUIT -> nombre canonico. Evita que el mismo cliente salga con
        dos nombres distintos segun que factura lo trajo.
        """
        if not self.is_enabled():
            return {}
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT cuit, name FROM clients")
                return {r[0]: r[1] for r in cur.fetchall()}

    def get_client_account(self) -> list[dict]:
        """Cuenta corriente por cliente tal como quedo guardada en la base."""
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_client_account()")
                return [{
                    "client_id":  r[_CC_CLIENT_ID_IDX],
                    "cuit":       r[_CC_CUIT_IDX],
                    "cliente":    r[_CC_NAME_IDX],
                    "group_id":   r[_CC_GROUP_ID_IDX],
                    "grupo":      r[_CC_GROUP_NAME_IDX],
                    "n_facturas": r[_CC_N_INVOICES_IDX],
                    "facturado":  float(r[_CC_INVOICED_IDX]  or 0),
                    "n_pagos":    r[_CC_N_PAYMENTS_IDX],
                    "cobrado":    float(r[_CC_COLLECTED_IDX] or 0),
                    "saldo":      float(r[_CC_BALANCE_IDX]   or 0),
                } for r in cur.fetchall()]

    # ── Archivos subidos ─────────────────────────────────────────────────────

    def save_uploaded_file(self, file_hash: str, file_name: str | None,
                           mime_type: str | None, content: bytes) -> None:
        """
        Guarda el archivo tal cual se subio, para poder abrirlo mas adelante
        desde la pantalla de Registros. Si ese mismo archivo ya estaba
        guardado, la base lo ignora y no pasa nada.
        """
        if not self.is_enabled() or not content:
            return
        import psycopg2
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT save_uploaded_file(%s::CHAR(64), %s::VARCHAR,
                                              %s::VARCHAR, %s::BYTEA)
                """, (file_hash, file_name, mime_type, psycopg2.Binary(content)))
                conn.commit()

    def get_uploaded_file(self, file_hash: str) -> dict | None:
        """El archivo guardado, o None si no esta."""
        if not self.is_enabled():
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_uploaded_file(%s::CHAR(64))",
                            (file_hash,))
                row = cur.fetchone()
                if not row:
                    return None
                return {
                    "nombre":    row[0],
                    "tipo":      row[1] or "application/pdf",
                    "contenido": bytes(row[2]),
                }

    # ── Pantalla de Registros: todo paginado, todo leido de la base ──────────
    # Cada pedido va a la base. No se guarda nada en memoria entre pedidos.

    def count_records(self, q: str | None = None) -> dict:
        """Cuantos registros hay en cada solapa, con el filtro de busqueda."""
        if not self.is_enabled():
            return {"facturas": 0, "cobros": 0, "cruces": 0, "clientes": 0}
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM count_records(%s::TEXT)",
                            (_escape_like(q),))
                r = cur.fetchone()
                return {"facturas": int(r[0]), "cobros": int(r[1]),
                        "cruces": int(r[2]), "clientes": int(r[3])}

    def _page(self, sql_fn: str, mapper, q: str | None,
              limit: int, offset: int, orden: str = "fecha",
              asc: bool = False) -> list[dict]:
        if not self.is_enabled():
            return []
        if orden not in ("fecha", "cliente", "importe"):
            orden = "fecha"
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(f"SELECT * FROM {sql_fn}(%s::TEXT, %s::INT, %s::INT, %s::TEXT, %s::BOOLEAN)",
                            (_escape_like(q), limit, offset, orden, bool(asc)))
                return [mapper(r) for r in cur.fetchall()]

    def page_invoices(self, q, limit, offset, orden="fecha", asc=False) -> list[dict]:
        """Una pagina de facturas guardadas, en el orden pedido."""
        return self._page("page_invoices", _fila_a_factura_registro, q, limit, offset, orden, asc)

    def page_payments(self, q, limit, offset, orden="fecha", asc=False) -> list[dict]:
        """Una pagina de cobros guardados, en el orden pedido."""
        return self._page("page_payments", _fila_a_pago_registro, q, limit, offset, orden, asc)

    def page_matches(self, q, limit, offset, orden="fecha", asc=False) -> list[dict]:
        """Una pagina de cruces guardados, en el orden pedido."""
        return self._page("page_matches", _fila_a_cruce_registro, q, limit, offset, orden, asc)

    def page_clients(self, q, limit, offset) -> list[dict]:
        """Una pagina de clientes."""
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM page_clients(%s::TEXT, %s::INT, %s::INT)",
                            (_escape_like(q), limit, offset))
                return [_fila_a_cliente_registro(r) for r in cur.fetchall()]

    # ── Cruces nota de credito <-> factura ───────────────────────────────

    def list_nc_applications(self, ids: list[int]) -> list[dict]:
        """Cruces donde participa alguno de estos documentos (nota o factura)."""
        ids = [int(i) for i in ids if i is not None]
        if not self.is_enabled() or not ids:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM list_nc_applications(%s::INT[])", (ids,))
                return [{"id": r[0], "nc_id": r[1], "invoice_id": r[2],
                         "monto": float(r[3] or 0)} for r in cur.fetchall()]

    def save_nc_application(self, nc_id: int, invoice_id: int, monto: float) -> int:
        """Guarda cuanto de la nota se aplica a la factura (la base controla las reglas)."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT save_nc_application(%s::INT, %s::INT, %s::NUMERIC)",
                            (nc_id, invoice_id, monto))
                nuevo = cur.fetchone()[0]
                conn.commit()
                return int(nuevo)

    def delete_nc_application(self, app_id: int) -> None:
        """Deshace un cruce nota de credito <-> factura."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT delete_nc_application(%s::INT)", (app_id,))
                conn.commit()

    def count_nc_applications(self, doc_id: int) -> int:
        """Cuantos cruces con notas de credito tiene un documento."""
        if not self.is_enabled():
            return 0
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT count_nc_applications(%s::INT)", (doc_id,))
                return int(cur.fetchone()[0] or 0)

    def list_matches_of(self, invoice_id: int | None = None,
                        payment_id: int | None = None) -> list[dict]:
        """Los cruces de UNA factura o de UN cobro (el otro va en None)."""
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM list_matches_of(%s::INT, %s::INT)",
                            (invoice_id, payment_id))
                return [_fila_a_cruce_registro(r) for r in cur.fetchall()]

    # ── Cobros cargados a mano ───────────────────────────────────────────────

    def persist_manual_payment(self, pay: dict) -> int:
        """
        Alta de un cobro sin comprobante. Si ese mismo cobro ya se habia
        cargado a mano, devuelve el que ya estaba.
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT persist_manual_payment(
                        %s::VARCHAR, %s::VARCHAR, %s::DATE,
                        %s::NUMERIC, %s::VARCHAR, %s::VARCHAR)
                """, (
                    pay.get("cuit_originante"),
                    pay.get("originante"),
                    pay.get("fecha_iso"),
                    pay.get("importe"),
                    pay.get("banco"),
                    pay.get("referencia"),
                ))
                payment_id = cur.fetchone()[0]
                conn.commit()
                return payment_id

    def delete_invoice(self, invoice_id: int) -> int:
        """
        Baja de una factura. Si tenia cruces, se sacan junto con ella.
        Devuelve cuantos cruces se sacaron, para poder avisarlo.
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT delete_invoice(%s::INT)", (invoice_id,))
                n_cruces = cur.fetchone()[0]
                conn.commit()
                return int(n_cruces or 0)

    def delete_payment(self, payment_id: int) -> int:
        """
        Baja del cobro. Si tenia cruces, se sacan junto con el y las
        facturas que cubria vuelven a quedar pendientes.
        Devuelve cuantos cruces se sacaron, para poder avisarlo.
        """
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT delete_payment(%s::INT)", (payment_id,))
                n_cruces = cur.fetchone()[0]
                conn.commit()
                return int(n_cruces or 0)

    # ── Clientes ─────────────────────────────────────────────────────────────

    # ── Cruces ───────────────────────────────────────────────────────────────
    # No hay ningun metodo que borre cruces en tanda, a proposito.
    # Se saca de a uno, y solo cuando la persona lo pide en pantalla.

    def delete_match(self, match_id: int) -> None:
        """Saca un cruce puntual y recalcula si la factura sigue pagada."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT delete_match(%s::INT)", (match_id,))
                conn.commit()

    # ── Comprobante de un cobro cargado a mano ───────────────────────────────

    def set_payment_file(self, payment_id: int, file_hash: str,
                         file_name: str | None) -> None:
        """Le engancha el comprobante a un cobro que ya estaba cargado."""
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT set_payment_file(%s::INT, %s::CHAR(64), %s::VARCHAR)
                """, (payment_id, file_hash, file_name))
                conn.commit()

    # ── Traer lo guardado a la pantalla de Conciliacion ──────────────────────

    def get_invoices_between(self, desde: str | None, hasta: str | None) -> list[dict]:
        """
        Facturas ya guardadas en ese rango de fechas, con el MISMO formato que
        devuelve el extractor, para que la pantalla no note la diferencia.
        """
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_invoices_between(%s::DATE, %s::DATE)",
                            (desde, hasta))
                return [_fila_a_factura_pantalla(r) for r in cur.fetchall()]

    def get_payments_between(self, desde: str | None, hasta: str | None) -> list[dict]:
        """Cobros ya guardados en ese rango, con el formato de la pantalla."""
        if not self.is_enabled():
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_payments_between(%s::DATE, %s::DATE)",
                            (desde, hasta))
                return [_fila_a_pago_pantalla(r) for r in cur.fetchall()]

    def get_invoices_by_ids(self, ids: list[int]) -> dict[int, dict]:
        """
        Relee de la base estas facturas. Devuelve {id: factura de pantalla}.
        Las que ya no existen no vuelven: asi se detecta que alguien las borro.
        """
        ids = [int(i) for i in ids if i is not None]
        if not self.is_enabled() or not ids:
            return {}
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_invoices_by_ids(%s::INT[])", (ids,))
                return {r[0]: _fila_a_factura_pantalla(r) for r in cur.fetchall()}

    def get_payments_by_ids(self, ids: list[int]) -> dict[int, dict]:
        """Lo mismo que get_invoices_by_ids, para cobros."""
        ids = [int(i) for i in ids if i is not None]
        if not self.is_enabled() or not ids:
            return {}
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_payments_by_ids(%s::INT[])", (ids,))
                return {r[0]: _fila_a_pago_pantalla(r) for r in cur.fetchall()}

    # ── Cruces ya guardados de lo que esta en pantalla ───────────────────────

    def get_saved_matches(self, invoice_hashes: list[str],
                          payment_hashes: list[str]) -> list[dict]:
        """
        Los cruces ya guardados de las facturas y cobros que estan en la
        pantalla de Conciliacion. Es lo que permite recuperar lo conciliado
        sin volver a calcularlo. Solo lee.
        """
        if not self.is_enabled():
            return []
        inv = [h for h in (invoice_hashes or []) if h]
        pay = [h for h in (payment_hashes or []) if h]
        if not inv and not pay:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT * FROM get_saved_matches(%s::TEXT[], %s::TEXT[])",
                            (inv, pay))
                return [{
                    "match_id":       r[0],
                    "monto":          float(r[1] or 0),
                    "confianza":      r[2],
                    "inv_hash":       (r[3] or "").strip(),
                    "comprobante":    r[4],
                    "cliente":        r[5],
                    "cuit":           r[6],
                    "fecha_factura":  r[7].strftime("%d/%m/%Y") if r[7] else None,
                    "importe_factura": float(r[8] or 0),
                    "descripcion":    r[9],
                    "pay_hash":       (r[10] or "").strip(),
                    "originante":     r[11],
                    "cuit_pagador":   r[12],
                    "fecha_pago":     r[13].strftime("%d/%m/%Y") if r[13] else None,
                    "importe_pago":   float(r[14] or 0),
                    "banco":          r[15],
                    "referencia":     r[16],
                } for r in cur.fetchall()]
