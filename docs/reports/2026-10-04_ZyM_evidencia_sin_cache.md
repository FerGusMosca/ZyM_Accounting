# ZyM - Evidencia: nada cacheado, todo sale de la BD (04-oct-2026)

## Archivos a BORRAR del proyecto (ya no se usan)
- common/util/cache/cache_manager.py
- common/util/cache/static_version.py
- common/util/cache/__init__.py

## Base: correr de nuevo db/initial_deploy/03_sps.sql (idempotente, sin cambios en tablas)

## Busqueda de referencias a cache en el codigo entregado (grep -rniE 'cache|sessionStorage|localStorage|redis')
```
./main.py:26:    response.headers["Cache-Control"] = "no-store, no-cache, max-age=0, must-revalidate"
./main.py:27:    response.headers["Pragma"] = "no-cache"
./static/js/reconciliation.js:76:  return fetch(url, { ...opciones, cache: 'no-store' });
./static/js/records.js:33:  return fetch(url, { ...opciones, cache: 'no-store' });
./common/util/templates.py:20:# Cache-Control: no-store en TODAS las respuestas, asi que cada pedido va al
./service_client/ARCA_client.py:63:_TOKEN_CACHE_DIR = Path(__file__).parent / ".token_cache"
./service_client/ARCA_client.py:106:      - "TA ya valido" edge case (active token not in local cache)
./service_client/ARCA_client.py:256:# Disk-based token cache
./service_client/ARCA_client.py:259:def _token_cache_path(cuit: str, homo: bool) -> Path:
./service_client/ARCA_client.py:261:    _TOKEN_CACHE_DIR.mkdir(parents=True, exist_ok=True)
./service_client/ARCA_client.py:262:    return _TOKEN_CACHE_DIR / f"token_{cuit}_{env}.json"
./service_client/ARCA_client.py:266:    path = _token_cache_path(cuit, homo)
./service_client/ARCA_client.py:277:        logger.info("WSAA: cached token expired — requesting new one.")
./service_client/ARCA_client.py:287:    path = _token_cache_path(cuit, homo)
./service_client/ARCA_client.py:296:    _token_cache_path(cuit, homo).unlink(missing_ok=True)
./service_client/ARCA_client.py:681:    Token management — two-layer cache:
./service_client/ARCA_client.py:696:        self._mem_cache: Optional[dict] = None
./service_client/ARCA_client.py:718:        if self._mem_cache and self._is_valid(self._mem_cache):
./service_client/ARCA_client.py:719:            return self._mem_cache
./service_client/ARCA_client.py:722:            self._mem_cache = disk
./service_client/ARCA_client.py:723:            return self._mem_cache
./service_client/ARCA_client.py:728:            # "TA ya valido" is a special case — wipe local cache and re-raise
./service_client/ARCA_client.py:733:                self._mem_cache = None
./service_client/ARCA_client.py:735:                    "ARCA reports an active token that is not available in local cache "
./service_client/ARCA_client.py:742:        self._mem_cache = token_data
./service_client/ARCA_client.py:743:        return self._mem_cache
```

Lo unico que aparece es la orden de NO guardar (Cache-Control no-store en main.py y cache no-store en cada pedido de las dos pantallas)
y el token de ARCA en ARCA_client.py (credencial de login: ARCA rechaza pedir otro mientras hay uno vigente, no son datos de facturas).
Fuera de lo pedido y sin tocar: configuracion de arranque (env_deploy_reader.py, settings.py, root_locator.py).

## Que se saco
- Conciliacion: sessionStorage, Guardar sesion, Cargar sesion (JS y HTML)
- Modulo CacheManager (Redis/memoria) y el versionado de estaticos
- Memoria de facturas de ARCA en el servidor (cada consulta va a ARCA)
- Registros: ninguna lista queda en el navegador, cada pagina se lee de la base

## Pruebas (Postgres real, scripts corridos 2 veces)
```
1) Cache-Control no-store en pagina y static: OK
2) sync_docs guarda y relee: [1, 2] [1]
3) sync_docs repetido no duplica: OK
4) /save guarda cruces: 2
5) Registros paginado (paginas, busqueda, pagina fuera de rango, escape de %): OK
6) cruces por factura / por cobro: 1 y 2
7) borrar factura con cruce -> n_cruces=1; quedan cruces: 1 facturas: 1
8) borrar cobro con cruce -> n_cruces=1; factura vuelve a pendiente: OK
9) sync_docs detecta lo borrado en Registros (null): OK
10) /save con docs borrados -> 409 y no los resucita: OK
11) borrar sin cruces -> n_cruces=0: OK
TODO OK
OK: sessionStorage vacio al arrancar
OK: docs nuevos sin id de base
OK: beforeunload avisa si hay docs sin guardar
OK: al pasar al paso 2 se guardaron y se releyeron de la base
OK: paso 3: concilia leyendo de la base
OK: solapa 1 (cuenta corriente) visible por defecto
OK: solapa 2 cruce factura-pago
OK: solapa 3 facturas pendientes
OK: contador de pendientes = 2
OK: nombres de las 3 solapas
OK: nada en sessionStorage/localStorage despues de todo
OK: sin guardar/cargar sesion
OK: factura borrada en Registros desaparece de la pantalla al cambiar de paso
OK: al recargar vuelve solo lo que esta en la base (1 factura, 1 pago)
OK: si falla el guardado NO cambia de paso
OK: Registros: paginador de facturas
OK: paginador de cobros
OK: paginador de cruces
OK: paginador de clientes
OK: Registros: nada guardado en el navegador
```
