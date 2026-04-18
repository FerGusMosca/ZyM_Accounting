# dashboard_controller.py
"""
Dashboard Controller
--------------------
Serves the main landing page and provides lightweight API endpoints
used by the dashboard widgets.

Routes:
    GET  /                          → HTML landing page
    GET  /dashboard/meta            → JSON product_name + customer_name (instant, no ARCA)
    GET  /dashboard/recent_invoices → JSON last N invoices from AFIP
"""

import logging
import os
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, JSONResponse

from common.util.std_in_out.root_locator import RootLocator
from common.util.templates import templates

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


def _app_meta() -> dict:
    """Return product_name and customer_name from settings (.env)."""
    try:
        from common.config.settings import get_settings
        s = get_settings()
        return {
            "product_name":  getattr(s, "product_name",  "") or "",
            "customer_name": getattr(s, "customer_name", "") or "",
        }
    except Exception:
        return {"product_name": "", "customer_name": ""}


class DashboardController:

    def __init__(self):
        self.router = APIRouter()
        self.templates = templates

        @self.router.get("/", response_class=HTMLResponse)
        async def landing(request: Request):
            return self.templates.TemplateResponse(
                "main_dashboard.html",
                {"request": request},
            )

        @self.router.get("/dashboard/meta")
        async def meta():
            """
            Instant endpoint — returns only product_name and customer_name.
            No ARCA calls. Used by the dashboard to render the brand/title
            immediately without waiting for the slow ARCA connection.
            """
            return JSONResponse(_app_meta())

        @self.router.get("/dashboard/recent_invoices")
        async def recent_invoices(limit: int = 10):
            """
            Returns the last `limit` invoices across all sales points.
            Always includes product_name and customer_name from .env.

            Always returns HTTP 200 — the dashboard widget is non-critical,
            and bubbling 5xx up to the browser just makes the whole page look
            broken when AFIP is having a bad day. The `status` field tells the
            frontend what actually happened:

              "ok"              — all good
              "not_configured"  — ARCA credentials missing
              "unavailable"     — AFIP is down / network issue (transient)
              "auth_error"      — certificate / credential problem (permanent-ish)
              "error"           — anything else
            """
            meta = _app_meta()

            # Defer the import so we can reference the typed exceptions below
            # even if the ARCA_client module had a collateral import issue.
            try:
                from service_client.ARCA_client import (
                    ArcaUnavailableError, ArcaAuthError, ArcaConfigError
                )
            except Exception:  # pragma: no cover
                ArcaUnavailableError = ArcaAuthError = ArcaConfigError = ()  # type: ignore

            client, err = _get_arca_client()
            if err:
                return JSONResponse({
                    "status":   "not_configured",
                    "message":  err,
                    "invoices": [],
                    **meta,
                })

            try:
                invoices = client.get_recent_invoices(limit=limit)
                from common.config.settings import get_settings
                s = get_settings()
                return JSONResponse({
                    "status":   "ok",
                    "count":    len(invoices),
                    "invoices": invoices,
                    "cuit":     getattr(s, "arca_cuit", "") or "",
                    **meta,
                })
            except ArcaUnavailableError as exc:
                # AFIP está caída / timeout / red — no es culpa del usuario.
                logger.warning("Dashboard: ARCA unavailable: %s", exc)
                return JSONResponse({
                    "status":   "unavailable",
                    "message":  "AFIP no responde en este momento. Reintentá en unos minutos.",
                    "detail":   str(exc),
                    "invoices": [],
                    **meta,
                })
            except ArcaAuthError as exc:
                logger.error("Dashboard: ARCA auth error: %s", exc)
                return JSONResponse({
                    "status":   "auth_error",
                    "message":  "Problema de autenticación con ARCA. Revisá el certificado.",
                    "detail":   str(exc),
                    "invoices": [],
                    **meta,
                })
            except ArcaConfigError as exc:
                logger.error("Dashboard: ARCA config error: %s", exc)
                return JSONResponse({
                    "status":   "not_configured",
                    "message":  str(exc),
                    "invoices": [],
                    **meta,
                })
            except Exception as exc:
                logger.exception("Error fetching recent invoices for dashboard")
                return JSONResponse({
                    "status":   "error",
                    "message":  str(exc),
                    "invoices": [],
                    **meta,
                })