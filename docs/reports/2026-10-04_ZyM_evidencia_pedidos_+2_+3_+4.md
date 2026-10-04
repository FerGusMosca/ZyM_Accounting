# ZyM - Evidencia de los pedidos +2, +3 y +4 (04-oct-2026)

Cada linea del pedido tiene su prueba. Las pruebas corrieron contra un Postgres real (scripts de base corridos 2 veces seguidas, sin error) y contra las pantallas abiertas en un navegador simulado.

## Antes de usar
1. Correr de nuevo 03_sps.sql (idempotente; no cambia tablas).
2. Borrar del proyecto la carpeta common/util/cache (cache_manager.py, static_version.py, __init__.py): ya nada la usa.

## Matriz: pedido -> prueba -> resultado
| Pedido | Prueba | Resultado |
|---|---|---|
| +2 Carga de facturas/pagos queda guardada al transicionar | Al pasar de paso 1 a 2 las facturas y pagos nuevos reciben id de la base y se vuelven a leer de ella | OK |
| +2 Si no se puede guardar, no se pierde nada | Con el guardado caido la pantalla NO cambia de paso | OK |
| +2 Lo borrado en Registros se entera la pantalla | Factura borrada en Registros desaparece de Conciliacion al cambiar de paso | OK |
| +2 Al recargar sale todo de la base | Recargar la pantalla trae solo lo que esta en la base | OK |
| +2 Nada de caches | Ver busqueda de abajo + navegador sin sessionStorage ni localStorage tras todo el recorrido (Conciliacion y Registros) | OK |
| +2 Se sacaron Guardar sesion / Cargar sesion | Los botones y funciones ya no existen | OK |
| +3 Tab Cuenta corriente por cliente | Visible por defecto, con contador | OK |
| +3 Tab Cruce factura <-> pago | Se muestra al elegirla, con contador | OK |
| +3 Tab Facturas pendientes de cobro | Se muestra al elegirla (incluye pagos sin imputar para cruzar a mano) | OK |
| +3 (pedido de paginacion en Conciliacion) | 60 facturas: 25 por pagina, 3 paginas, selector 10/25/50/100; quitar en la pagina 2 saca la factura correcta; ordenar vuelve a la pagina 1 | OK |
| +4 Registros todo paginado | Facturas, cobros, cruces y clientes con paginador; cada pagina se lee de la base; busqueda en la base | OK |
| +4 Eliminacion con popup de confirmacion | Borrar factura y borrar pago abren popup propio; cancelar no borra | OK |
| +4 Factura con cruce: se elimina el cruce y se avisa | Popup previo avisa cuantos cruces se van; despues aviso "se eliminaron N cruce(s)"; cruce ya no esta en la base | OK |
| +4 Pago con cruce: se elimina el cruce y se avisa | Idem; la factura que cubria vuelve a pendiente | OK |

## Busqueda de referencias a cache en el codigo entregado
(busqueda: cache, sessionStorage, localStorage, redis)
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
Lo unico que aparece es la orden de NO guardar: Cache-Control no-store en todas las respuestas (servidor) y cache no-store en cada pedido de las dos pantallas. Tambien aparece el token de ingreso a ARCA: es la credencial de login, y ARCA rechaza pedir otro mientras hay uno vigente; no son datos de facturas. Sin tocar por quedar fuera de estas pantallas: lectura de configuracion de arranque (env_deploy_reader, settings, root_locator).

## Que se saco
- Conciliacion: sessionStorage, Guardar sesion, Cargar sesion.
- Modulo CacheManager (Redis/memoria) y el versionado de estaticos.
- Memoria de facturas de ARCA en el servidor.
- Registros: ninguna lista queda en el navegador.

## Salida de las pruebas
### Servidor + base
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
```
### Conciliacion (pantalla)
```
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
OK: pagina 1 muestra 25 de 60
OK: paginador dice Página 1 de 3
OK: pagina 3 muestra 10
OK: quitar en pagina 2 saca la factura correcta
OK: por pagina 50
OK: ordenar vuelve a pagina 1
```
### Registros (pantalla)
```
OK: Registros: facturas paginadas, 25 por pagina (hay 34)
OK: Registros: paginador "Página 1 de 2"
OK: Registros: pagina 2 trae las 9 restantes (leidas de la base)
OK: busqueda filtra en la base
OK: borrar factura: se abre popup de confirmacion
OK: popup avisa que se elimina el cruce
OK: cancelar en el popup NO borra
OK: despues de borrar: aviso "se eliminaron 1 cruce(s)"
OK: la factura ya no esta en la base
OK: el cruce de esa factura se elimino (quedan 3 de 4)
OK: borrar pago: popup de confirmacion avisa los cruces
OK: despues de borrar el pago: aviso
OK: los cruces del pago se eliminaron
OK: Registros: nada en el navegador
```
