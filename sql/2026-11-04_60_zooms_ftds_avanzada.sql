-- =====================================================================
--  Dos etapas más en el embudo de venta: Presentación FTDs y Clase Avanzada
--  Aplicado el 2026-11-04 con el MCP de Supabase.
-- =====================================================================
--
--  El selector «¿Es un zoom de ventas?» de las actividades puntuales suma
--  «Zoom Presentación FTDs» (ftds) y «Clase Avanzada» (avanzada). Son etapas
--  del embudo igual que las otras: marcar asistencia en esa actividad marca
--  la etapa en `clientes.zooms`.
--
--  «Zoom de presentación» pasa a llamarse «Zoom Presentación Membresías» solo
--  en la interfaz: conserva la clave `pres`, así que las actividades y los
--  embudos ya guardados no cambian.
--
--  `clientes.zooms` es jsonb sin restricción de claves: no requiere cambio.
-- =====================================================================

alter table public.actividades drop constraint if exists actividades_zoom_tipo_check;
alter table public.actividades add  constraint actividades_zoom_tipo_check
  check (zoom_tipo is null or zoom_tipo in ('pres', 'ftds', 'avanzada', 'uno', 'cierre'));

comment on column public.actividades.zoom_tipo is
  'Si la puntual ES un zoom de ventas: pres|ftds|avanzada|uno|cierre. La asistencia se refleja en clientes.zooms.';
