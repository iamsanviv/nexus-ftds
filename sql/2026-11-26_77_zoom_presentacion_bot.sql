-- =====================================================================
--  Etapa nueva del embudo de venta: Zoom Presentación Bot (clave `bot`)
-- =====================================================================
--
--  El selector «¿Es un zoom de ventas?» de las actividades puntuales suma
--  «Zoom Presentación Bot». Es una etapa más de `clientes.zooms` (jsonb sin
--  restricción de claves, no requiere cambio); solo hay que permitir la
--  clave en `actividades.zoom_tipo`.
--
--  No cuenta como la etapa «Presentación» de Comunidad: esa sigue siendo
--  `pres` (Zoom Presentación Membresías), ver public/js/embudo.js.
-- =====================================================================

alter table public.actividades drop constraint if exists actividades_zoom_tipo_check;
alter table public.actividades add  constraint actividades_zoom_tipo_check
  check (zoom_tipo is null or zoom_tipo in ('pres', 'ftds', 'bot', 'avanzada', 'uno', 'cierre'));

comment on column public.actividades.zoom_tipo is
  'Si la puntual ES un zoom de ventas: pres|ftds|bot|avanzada|uno|cierre. La asistencia se refleja en clientes.zooms.';
