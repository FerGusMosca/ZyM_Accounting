# invoice_history_controller.py
"""
Invoice History Controller
--------------------------
Serves the invoice history page and provides the /list endpoint
that fetches all issued invoices from AFIP via ARCAClient.get_invoices().

Routes:
    GET  /invoice_history/           → HTML page
    GET  /invoice_history/list       → JSON list of invoices
                                       ?from=YYYY-MM-DD&to=YYYY-MM-DD
"""

import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.templating import Jinja2Templates

from common.util.std_in_out.root_locator import RootLocator

logger = logging.getLogger(__name__)


def _get_arca_client():
    """Return (ARCAClient, None) or (None, error_message)."""
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


class InvoiceHistoryController:
    """
    FastAPI controller — mounted at /invoice_history

    The /list endpoint calls ARCAClient.get_invoices() which queries AFIP
    directly via FECompConsultar for every invoice number in each sales point.

    Important caveat: AFIP's WSFE does NOT store razon_social_cliente or
    descripcion — those fields will be empty in the response. The frontend
    displays what AFIP actually returns: CUIT, amount, date, CAE.
    """

    def __init__(self):
        self.router = APIRouter(prefix="/invoice_history")

        templates_path = os.path.join(RootLocator.get_root(), "templates")
        self.templates = Jinja2Templates(directory=templates_path)

        @self.router.get("/", response_class=HTMLResponse)
        async def page(request: Request):
            return self.templates.TemplateResponse(
                "invoice_history.html",
                {"request": request},
            )

        @self.router.get("/list")
        async def list_invoices(
            request: Request,
            from_date: Optional[str] = None,   # query param: ?from=YYYY-MM-DD
            to_date:   Optional[str] = None,   # query param: ?to=YYYY-MM-DD
        ):
            """
            Fetch invoices from AFIP for the given date range.

            Query params:
              from   → start date "YYYY-MM-DD" (default: 30 days ago)
              to     → end date   "YYYY-MM-DD" (default: today)
            """
            # FastAPI query param names can't start with 'from' as keyword
            # so we also check the raw query string
            params    = dict(request.query_params)
            from_date = from_date or params.get("from")
            to_date   = to_date   or params.get("to")

            client, err = _get_arca_client()
            if err:
                return JSONResponse(
                    {"status": "not_configured", "message": err, "invoices": []},
                    status_code=200,   # return 200 so frontend can show a friendly message
                )

            try:
                invoices = client.get_invoices(
                    from_date    = from_date,
                    to_date      = to_date,
                    sales_points = [1, 2],   # extend if more sales points are added
                )
                return JSONResponse({
                    "status":   "ok",
                    "count":    len(invoices),
                    "invoices": invoices,
                })
            except Exception as exc:
                logger.exception("Error fetching invoice history")
                return JSONResponse(
                    {"status": "error", "message": str(exc), "invoices": []},
                    status_code=500,
                )