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


# Una sola instancia — se inicializa una vez al arrancar
templates = Jinja2Templates(directory="templates")

# sv() deja el path tal cual. Nada se reutiliza del navegador: main.py manda
# Cache-Control: no-store en TODAS las respuestas, asi que cada pedido va al
# servidor y los templates no necesitan ningun truco de versionado.
templates.env.globals["sv"] = lambda path: path