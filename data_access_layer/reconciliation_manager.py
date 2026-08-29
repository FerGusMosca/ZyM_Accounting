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
    }


# Consulta usada para los duplicados. Trae todo lo que la pantalla necesita
# para poder seguir trabajando con la factura sin volver a leer el PDF.
_INVOICE_SELECT = """
    SELECT i.id, i.client_id, c.name, c.cuit, i.issuer_cuit,
           i.invoice_number, i.issue_date, i.amount, i.status,
           i.description, i.file_name
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

    def find_invoice_by_number(self, issuer_cuit: str, invoice_number: str) -> dict | None:
        """La misma factura aunque el archivo PDF sea otro, o None."""
        if not self.is_enabled():
            return None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    _INVOICE_SELECT +
                    " WHERE i.issuer_cuit = %s AND i.invoice_number = %s",
                    (issuer_cuit, invoice_number))
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
                        %s::CHAR(64), %s::JSONB)
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
