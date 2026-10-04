# ZyM - Evidencia de los pedidos (04-oct-2026, segunda vuelta)

Probado en un **Chrome real (versión 141)** manejado por script, contra un Postgres real (scripts de base corridos 2 veces seguidas, sin error), con lectura de PDF simulada (el archivo trae los datos adentro, porque no hay acceso a la IA ni a ARCA desde acá).
La vez anterior las pruebas se hicieron en un navegador simulado escrito por mí: eso no era suficiente. Las capturas de pantalla se miraron una por una.

## Antes de usar
1. Correr de nuevo 03_sps.sql (idempotente; no cambia tablas).
2. Borrar del proyecto la carpeta common/util/cache (cache_manager.py, static_version.py, __init__.py): ya nada la usa.

## Matriz: pedido -> prueba -> resultado
| Pedido | Prueba (Chrome real) | Resultado |
|---|---|---|
| Moverse libremente entre tabs | Servidor con 2,5 s de demora: paso 1->2 en ~90 ms, 2->3 en ~80 ms, volver al 1 en pleno cálculo en ~70 ms; las 3 solapas del paso 3, cinco saltos seguidos, ~40-70 ms cada uno | OK |
| Saltar es smooth: asíncrono + spinner visible | Cartelito "Guardando…" arriba a la derecha y franja con spinner adentro del paso 3 mientras calcula; desaparecen al terminar | OK |
| Al saltar de tab todo se guarda | Facturas, pagos y cruces hechos a mano / desarmados se guardan en cada salto, al terminar una carga y al confirmar un cruce o un desarme | OK |
| El cartel "Leave site" desaparece de TODA la aplicación | Se recargó y se salió de las 5 pantallas (inicio, generar factura, facturas enviadas, conciliación, registros) tras interactuar con la página (sin eso Chrome nunca lo muestra): 0 carteles. `window.onbeforeunload` vacío en las 5. Cero apariciones de beforeunload en el código | OK |
| Carga de facturas/pagos queda guardada | Subir por la pantalla 2 facturas y 1 pago: quedan en la base sin saltar de solapa; al llegar al paso 3 todo tiene id de la base | OK |
| Si falla el guardado se ve y no se pierde la libertad | Con el guardado roto: cartel rojo con Reintentar, se puede seguir saltando; Reintentar guarda y el error desaparece | OK |
| Si la base está caída se ve | Cartel rojo "NO se está guardando" (antes era silencioso) | OK |
| Nada de caches | Ver búsqueda de abajo; navegador sin sessionStorage ni localStorage | OK |
| Conciliación en 3 tabs (cuenta corriente / cruce factura<->pago / pendientes de cobro) | Las tres, con contador | OK |
| Conciliación paginada | 25 por página, selector 10/25/50/100 | OK |
| Registros todo paginado | Facturas, cobros, cruces y clientes: cada página se lee de la base | OK |
| Eliminación con popup de confirmación | Borrar factura y pago: cuadro propio; Cancelar no borra | OK |
| Factura con cruce: se elimina el cruce y se avisa | Aviso previo con el detalle del cruce + aviso posterior "se eliminaron 1 cruce(s)"; base verificada | OK |
| Pago con cruce: idem | Idem; la factura vuelve a pendiente | OK |

## Resultados de las pruebas
### Cartel de salida y errores de JavaScript (5 pantallas)
```
OK:    /: sin onbeforeunload
OK:    /billing_extractor_n_generator/: sin onbeforeunload
OK:    /invoice_history/: sin onbeforeunload
OK:    /reconciliation/: sin onbeforeunload
OK:    /reconciliation/registros: sin onbeforeunload
OK:    Conciliacion abierta con cruces propuestos SIN guardar: Conciliado: 8 cruce(s). Podés cruzar a mano, 
OK:    salir/recargar en las 5 pantallas -> carteles del navegador: []
OK:    errores de JavaScript en las 5 pantallas: []
RESUMEN A: 8 OK, 0 FALLAS
```
### Moverse entre tabs con servidor lento
```
OK:    paso 1->2 cambia al instante (91 ms) con servidor lento
OK:    cartelito visible mientras guarda: Guardando…
OK:    paso 2->3 cambia al instante (78 ms)
OK:    spinner visible adentro del paso 3 mientras calcula
OK:    volver al paso 1 en pleno calculo: instantaneo (74 ms)
OK:    y al 2 otra vez, sin trabarse
OK:    al terminar el trabajo desaparece el spinner del panel y queda el resultado
OK:    solapa 2 del paso 3 instantanea (39 ms)
OK:    solapa 3 del paso 3 instantanea (56 ms)
OK:    solapa 1 del paso 3 instantanea (51 ms)
OK:    solapa 2 del paso 3 instantanea (65 ms)
OK:    solapa 3 del paso 3 instantanea (62 ms)
RESUMEN B: 12 OK, 0 FALLAS
```
### Cargas, cruce a mano, desarme, base caída, falla de guardado
```
OK:    subir 2 facturas por la pantalla: quedan en la base SIN saltar de solapa (se guardan al terminar la carga)
OK:    subir 1 pago por la pantalla: queda en la base
OK:    al llegar al paso 3 todo lo de pantalla tiene id de la base
OK:    facturas pendientes del cliente: 2
OK:    cruce a mano guardado al confirmar, sin tocar nada mas (cruces 0 -> 2)
OK:    desarmar un cruce guardado: se saca de la base al confirmar
OK:    errores JS: []
OK:    base caida: cartel rojo 'NO se está guardando': ⚠️ Sin conexión con la base: lo que hagas NO se está guardan
OK:    falla de guardado: cartel de error con Reintentar
OK:    con el guardado roto igual se puede seguir saltando
OK:    Reintentar -> se guarda y el error desaparece
RESUMEN C-F: 11 OK, 0 FALLAS
```
### Registros: paginado y borrados
```
OK:    Registros facturas: 25 filas de 40 (25 por pagina)
OK:    paginador: 1–25 de 40 « ‹ Página 1 de 2 › » Por página 10 25 50 100
OK:    pagina 2 de facturas
OK:    paginador en solapa 2
OK:    paginador en solapa 3
OK:    paginador en solapa 4
OK:    popup previo avisa el cruce que se elimina
OK:    Cancelar no borra
OK:    aviso posterior: Se borró la factura 00001-00000001 y se eliminaron 1 cruce(s).  Los cobros que tenía imput
OK:    factura y su cruce eliminados en la base
OK:    pago con cruce borrado: cruces 7 -> 6
OK:    cartelitos nativos del navegador en Registros: []
OK:    errores JS: []
RESUMEN REGISTROS: 13 OK, 0 FALLAS
```
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

## Búsqueda de referencias a cache en el código entregado
(búsqueda: cache, sessionStorage, localStorage, redis)
```
./main.py:26:    response.headers["Cache-Control"] = "no-store, no-cache, max-age=0, must-revalidate"
./main.py:27:    response.headers["Pragma"] = "no-cache"
./static/js/reconciliation.js:88:  return fetch(url, { ...opciones, cache: 'no-store' });
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
Lo único que aparece es la orden de NO guardar (Cache-Control no-store en el servidor y cache no-store en cada pedido) y el token de ingreso a ARCA (credencial de login: ARCA rechaza pedir otro mientras hay uno vigente; no son datos de facturas). Sin tocar por quedar fuera de estas pantallas: lectura de configuración de arranque (env_deploy_reader, settings, root_locator).

## Reglas de inconsistencia: NO las inventé. Necesito que me las definas
Medí cómo se comporta hoy cada eliminación y carga. Esto es lo que encontré y lo que necesito saber:
1. **Cruce borrado a mano en Registros**: al abrir Conciliación el sistema lo vuelve a proponer (verificado). ¿Debe recordarse como "rechazado" para que no vuelva? (requiere una tabla nueva en la base)
2. **Importe cruzado mayor que el pago o que la factura**: la pantalla no lo deja armar, pero la base lo acepta si llega forzado (verificado: cruce de 900 contra un pago de 300). ¿La base debe rechazarlo?
3. **Nota de crédito**: queda guardada en negativo y resta de lo facturado, pero no se aplica a la factura que ajusta. ¿Debe descontar de esa factura?
4. **✕ en Conciliación sobre un documento ya guardado**: solo lo saca de la pantalla; en la base sigue y vuelve con Traer o al recargar. ¿Debe borrarlo de la base o está bien así?
5. **Pago que sobra**: queda como remanente libre para cruzar después. ¿Está bien?
6. **Misma factura con otro archivo**: la base devuelve la que ya existe (no duplica). ¿Está bien?
7. **Borrar cliente o grupo con facturas**: no existe borrar cliente; borrar un grupo deja a los clientes sin grupo. ¿Falta alguna regla?
8. **Cruces que solo propone el sistema**: hoy se guardan con el botón "Guardar en base"; lo hecho a mano se guarda solo. Si se guardaran solos en cada salto, un cruce que borraste volvería a crearse (punto 1). ¿Cuál querés?
