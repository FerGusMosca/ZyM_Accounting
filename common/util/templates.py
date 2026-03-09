"""
common/templates.py — Instancia compartida de Jinja2Templates

Todos los controllers importan `templates` desde acá.
Así sv() está disponible en TODOS los templates sin duplicar lógica.

Uso en cualquier controller:
    from common.templates import templates
    ...
    return templates.TemplateResponse("mi_template.html", {"request": request})
"""

from fastapi.templating import Jinja2Templates

from common.util.cache.static_version import build_static_version, static_url

# Una sola instancia — se inicializa una vez al arrancar
templates = Jinja2Templates(directory="templates")

STATIC_VERSION = build_static_version("static")
templates.env.globals["sv"] = lambda path: static_url(path, STATIC_VERSION)