# ZyM - Confesión: trampas y malas decisiones encontradas (04-oct-2026)

Cada punto dice qué era, si lo puse yo o ya estaba, si te lo avisé, y cómo quedó.

1. **El cartel "Leave site?"** — Ya existía en el código original para cruces sin guardar. Yo lo amplié a facturas y pagos sin guardar y lo dejé. Salía en cada recarga porque los cruces que propone el sistema contaban como "sin guardar". No te lo avisé; en mi lista de la vuelta anterior no figuraba. Ahora no existe en ninguna parte de la aplicación (probado en Chrome real).
2. **Cambiar de paso se frenaba** — Si el guardado fallaba, la pantalla no avanzaba, y mientras guardaba tapaba todo con un cartel de espera. Decisión mía, no pedida. Ahora cambiar de tab es instantáneo.
3. **Sin base, no guardaba y no decía nada** — Si la base no respondía, el guardado se salteaba en silencio. Ahora hay un cartel rojo permanente.
4. **Textos que mentían** — "Todavía no se guarda nada hasta Guardar en base", "Las facturas y los pagos ya se fueron guardando", "Cancelar cambios anula todo": ya no eran ciertos. Corregidos.
5. **Mis pruebas anteriores eran de un navegador simulado escrito por mí**, no de Chrome. Dije "probado" sin haber visto la pantalla real. Esta vez: Chrome real, con capturas revisadas.
6. **La paginación de Conciliación la agregué recién cuando lo reclamaste**: la leí solo para Registros. 
7. **Había tocado la parte de ARCA (otra pantalla)** sin que lo pidieras: ese cambio NO va en este zip, queda como estaba.
8. **Quedan referencias a cache que no toqué**: token de ingreso a ARCA (si se quita, ARCA rechaza el login mientras hay un token vigente) y lectura de configuración de arranque. Lo expliqué, pero tu pedido decía "totalmente".
9. **"Agrupar clientes"** ya no se recuerda al recargar (antes se guardaba en el navegador). No te lo avisé.
10. **Enter cierra los cuadros como "Cancelar"** — viene del código original (es la opción segura); no lo cambié.
11. **Guardado automático al terminar una carga y al confirmar un cruce a mano o un desarme**: no lo pediste con esas palabras; lo hice porque, sin el cartel de salida, es la única forma de que no se pierda nada. Si no lo querés, se saca.
12. **Cosas que encontré midiendo y que ya estaban** (no las introduje, no las arreglé porque necesito tus reglas): ver sección "Reglas de inconsistencia" del informe de evidencia (cruce borrado que vuelve a proponerse, la base acepta un cruce mayor al pago, nota de crédito que no descuenta de su factura).
