-- =====================================================================
--  canales_wa.host — preparar el reparto de bridges en varias máquinas
--  Aplicado el 2026-08-04 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  Los nueve bridges corren hoy en una sola VM (Oracle Cloud, 1 GB, Always
--  Free), en los puertos 8080–8088. Ahí "puerto 8081" alcanza como
--  dirección porque el worker y el bridge son vecinos: marca a
--  localhost:8081 por REST.
--
--  Lo que empuja a una segunda máquina NO es la memoria. Medido el 04/08:
--  279 de 956 MB usados con los 9 bridges + el worker (~16 MB por bridge),
--  más 2 GB de swap; 20 bridges serían ~320 MB y caben de sobra. Lo que
--  no escala es la **IP**: 20 sesiones de WhatsApp saliendo de la misma
--  dirección. El propio worker ya lo trata como riesgo — ARRANQUE_MAX
--  existe para que varios agentes no disparen en el mismo segundo desde
--  la misma IP.
--
--  En cuanto exista la segunda máquina, "8089" deja de identificar a
--  nadie: falta decir EN CUÁL. Esta columna es ese dato.
--
--  El default es 'localhost' a propósito: mientras el worker no la lea, y
--  para todo lo que se quede en la VM 1, el comportamiento es idéntico al
--  de hoy. Nada cambia hasta que alguien escriba otro valor.
--
--  CÓMO SE SUPO QUE HACÍA FALTA
--
--  El worker no vive en este repo, así que no se leyó su código: se leyó
--  su rastro. Consultando canales_wa con un minuto de diferencia, los tres
--  canales MUERTOS (Majo desde el 30/07, Felipe desde el 31/07, Valery
--  desde el 28/07) tenían `actualizado` avanzando igual, cada ~30 s.
--
--  Un proceso muerto no reescribe su propia fila. Que las nueve se muevan
--  a la vez significa que algo externo las recorre una por una y anota si
--  contestaron — a los vivos les mueve además `ultimo_visto`. Eso es un
--  worker central que SALE A BUSCAR a cada bridge por su puerto.
--
--  Segunda prueba: por RLS ningún navegador puede tocar las nueve filas
--  (cada agente solo la suya), así que quien las escribe lleva el service
--  role. Es un proceso de fondo, no el panel.
--
--  LO QUE ESTA MIGRACIÓN NO HACE
--
--  El worker todavía NO lee esta columna: ese cambio va en su código, que
--  no está en este repositorio. Hasta que lo lea, `host` es una columna
--  inerte — la misma trampa que `imagen_url`. Queda anotada en los
--  pendientes de CLAUDE.md para que no se pierda.
-- =====================================================================

alter table public.canales_wa
  add column if not exists host text not null default 'localhost';

comment on column public.canales_wa.host is
  'Máquina donde corre el bridge. El worker arma host:puerto. Solo la escribe el service role: si un agente pudiera, redirigiría a dónde se conecta el worker.';


-- ---------------------------------------------------------------------
--  Estrechar el UPDATE: `host` no puede nacer siendo escribible
-- ---------------------------------------------------------------------
--  `authenticated` tenía UPDATE sobre TODA la tabla (la política
--  canales_upd solo limita QUÉ FILA, no qué columna). Con eso, `host`
--  habría nacido escribible por el propio agente — y un agente que se
--  ponga host = una máquina suya hace que el worker, que lleva el service
--  role, salga a conectarse allá. No es un riesgo teórico: es una
--  conexión saliente hacia una dirección que elige el usuario.
--
--  El panel escribe UNA sola columna, `comando`, y solo para el botón
--  "desvincular" de Mi WhatsApp (canal.js). Todo lo demás —estado, qr,
--  telefono, ultimo_visto, actualizado— lo escribe el bridge, que va con
--  el service role y ni pasa por estos permisos.
--
--  Efecto secundario bueno: el agente deja de poder fingir
--  `estado = 'vinculado'` (que le habilitaba Seguimiento sin tener canal)
--  y de cambiarse el `telefono`.
-- ---------------------------------------------------------------------

revoke update on public.canales_wa from authenticated, anon;
grant  update (comando) on public.canales_wa to authenticated;


-- =====================================================================
--  PROBADO simulando sesiones, en una transacción revertida.
--  Los seis casos pasaron antes de aplicar:
--
--    | prueba                                        | resultado        |
--    |-----------------------------------------------|------------------|
--    | agente escribe `comando` (lo que hace el panel)| 1 fila — sigue   |
--    | agente reescribe `host`                        | bloqueado        |
--    | agente finge `estado = 'vinculado'`            | bloqueado        |
--    | agente lee su propio canal                     | 1 fila           |
--    | agente ve canales ajenos                       | solo el suyo     |
--    | director ve los canales de su equipo           | 9 de 9           |
--
--  Ojo con el patrón de prueba: una tabla temporal + `set role
--  authenticated` da "permission denied for table res". Se resuelve con
--  `grant all on res to authenticated` justo después de crearla, o
--  capturando los conteos en variables y volviendo al rol antes de
--  insertar.
-- =====================================================================
