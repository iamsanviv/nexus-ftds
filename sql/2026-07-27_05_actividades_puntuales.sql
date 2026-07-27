-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Actividades puntuales e imagen propia — 27 de julio de 2026
--
-- ESTADO: APLICADO EN PRODUCCIÓN (migraciones `actividades_puntuales_sin_servicio`
-- e `imagen_por_actividad`). Este archivo queda como referencia.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. Un lanzamiento de membresías o una clase única no son servicios
--    recurrentes y no deberían ensuciar el catálogo, pero antes meterlos ahí
--    era la única forma de armarles un seguimiento.
alter table public.actividades alter column servicio_id drop not null;

-- 2. Imagen propia de la actividad.
alter table public.actividades add column if not exists imagen text;


-- ───────────────────────────────────────────────────────────────────────────
-- CÓMO LLEGA LA IMAGEN AL WORKER
--
-- `mensajes_programados` tiene TRES columnas relacionadas. Se revisaron los
-- datos reales antes de elegir, en vez de suponer:
--
--   imagen_url   0 filas en toda la tabla → columna muerta, no se usa.
--   media_url    328 en masivos y 35 en invitaciones. Esas 35 tienen
--                servicio_id nulo y estado 'enviado' (10/07): prueba de que el
--                worker SÍ manda imagen por esta vía en una invitación.
--   servicio_id  203 invitaciones. El worker resuelve la imagen vigente del
--                servicio al enviar, así no se congela si se cambia después.
--
-- Por eso la precedencia al programar es:
--
--   1. Si la actividad tiene imagen propia  → media_url.
--   2. Si no, y es de un servicio           → servicio_id (imagen del catálogo).
--
-- Se manda UNA sola de las dos, nunca ambas, para no depender de cómo el
-- worker resolvería el empate.
--
-- ───────────────────────────────────────────────────────────────────────────
-- QUÉ CAMBIA CUANDO LA ACTIVIDAD NO TIENE SERVICIO
--
-- `clientes.acc` y `clientes.conf` están indexados por servicio, así que sin
-- servicio no hay asistencia ni confirmación que registrar:
--
--   · El universo de invitables pasa a ser toda la gente con teléfono, en vez
--     de «a quién le falta el servicio».
--   · Se esconde «incluir a quienes ya asistieron» y el distintivo «ya asistió».
--   · No se marca `conf` al programar.
--   · En el diálogo de cancelar desaparece «volver a por invitar».
--   · No cuenta para el progreso ni los porcentajes de nadie.
-- ───────────────────────────────────────────────────────────────────────────
