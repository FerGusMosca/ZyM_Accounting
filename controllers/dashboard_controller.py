# dashboard_controller.py
"""
Dashboard Controller
--------------------
Serves the main landing page and provides lightweight API endpoints
used by the dashboard widgets.

Routes:
    GET  /           → HTML landing page
    GET  /dashboard/recent_invoices   → JSON last N invoices from AFIP
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
            return None, "ARCA not configured"

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


class DashboardController:

    def __init__(self):
        self.router = APIRouter()

        templates_path = os.path.join(RootLocator.get_root(), "templates")
        self.templates = Jinja2Templates(directory=templates_path)

        @self.router.get("/", response_class=HTMLResponse)
        async def landing(request: Request):
            return self.templates.TemplateResponse(
                "dashboard.html",
                {"request": request},
            )

        @self.router.get("/dashboard/recent_invoices")
        async def recent_invoices(limit: int = 10):
            """
            Returns the last `limit` invoices across all sales points.
            Calls ARCAClient.get_recent_invoices() which fetches by number
            (no date filter) so it always returns the most recent ones.
            """
            client, err = _get_arca_client()
            if err:
                return JSONResponse(
                    {"status": "not_configured", "message": err, "invoices": []},
                    status_code=200,
                )
            try:
                invoices = client.get_recent_invoices(limit=limit)
                return JSONResponse({
                    "status":   "ok",
                    "count":    len(invoices),
                    "invoices": invoices,
                })
            except Exception as exc:
                logger.exception("Error fetching recent invoices for dashboard")
                return JSONResponse(
                    {"status": "error", "message": str(exc), "invoices": []},
                    status_code=500,
                )