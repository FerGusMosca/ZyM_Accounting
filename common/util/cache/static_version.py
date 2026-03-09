"""
static_version.py — Cache busting para archivos estáticos
Ubicación sugerida: common/utils/static_version.py

Uso en main.py:
    from common.utils.static_version import build_static_version, static_url

    STATIC_VERSION = build_static_version("static")

    templates = Jinja2Templates(directory="templates")
    templates.env.globals["sv"] = lambda path: static_url(path, STATIC_VERSION)

En los templates HTML:
    <link rel="stylesheet" href="{{ sv('/static/css/theme.css') }}">
    <script src="{{ sv('/static/js/main_dashboard.js') }}"></script>
"""

import hashlib
import os
from pathlib import Path


def build_static_version(static_dir: str = "static") -> str:
    """
    Recorre todos los archivos en static_dir y genera un hash MD5
    del contenido combinado. Cambia automáticamente cuando cambia
    cualquier archivo CSS, JS, imagen, etc.
    """
    hasher = hashlib.md5()
    static_path = Path(static_dir)

    if not static_path.exists():
        # Fallback: usar timestamp del proceso
        import time
        return str(int(time.time()))

    # Ordenar para que el hash sea determinista
    for filepath in sorted(static_path.rglob("*")):
        if filepath.is_file():
            try:
                hasher.update(filepath.read_bytes())
            except (OSError, PermissionError):
                pass

    # Primeros 8 caracteres alcanzan — "a3f9c2d1"
    return hasher.hexdigest()[:8]


def static_url(path: str, version: str) -> str:
    """
    Agrega ?v=HASH al path del archivo estático.
    Ejemplo: /static/css/theme.css → /static/css/theme.css?v=a3f9c2d1
    """
    return f"{path}?v={version}"