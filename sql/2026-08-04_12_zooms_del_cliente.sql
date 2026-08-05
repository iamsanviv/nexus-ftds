-- =====================================================================
--  El embudo de venta pasa de la VENTA al CLIENTE
--  Aplicado el 2026-08-04 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  Los tres zooms (presentación · 1 a 1 · cierre) vivían en `ventas`
--  (`pres_fecha/pres_estado`, `uno_*`, `cierre_*`). Dos problemas:
--
--  1. **La presentación pasa ANTES de que exista una venta.** Hasta hoy no
--     había dónde anotarla: tocaba crear la venta primero, o perder el dato.
--     Justo la etapa más temprana del embudo era la que no se podía registrar.
--  2. **Con un upgrade había dos filas de venta** para la misma persona, cada
--     una con su propio juego de zooms, repitiendo un embudo que le pasó una
--     sola vez.
--
--  El embudo es de la PERSONA. La venta lo lee de ahí.
--
--  QUÉ SE AGREGA
--
--  · `clientes.zooms`  → {"pres":{"f":"YYYY-MM-DD","e":"hecha"}, "uno":…, "cierre":…}
--                        e ∈ hecha | pendiente | no_asistio
--  · `actividades.zoom_tipo` → pres|uno|cierre, solo en las puntuales.
--
--  Una actividad puntual puede SER uno de los tres zooms. Marcarle la
--  asistencia a alguien en esa actividad marca de una vez su etapa: es el
--  mismo hecho, no dos. `zoom_tipo` es nulo en las del catálogo — una del
--  catálogo es recurrente y el embudo de una persona pasa una vez.
-- =====================================================================

alter table public.clientes add column if not exists zooms jsonb not null default '{}'::jsonb;

comment on column public.clientes.zooms is
  'Embudo de venta de la persona: {"pres":{"f":"YYYY-MM-DD","e":"hecha"},"uno":{...},"cierre":{...}}. e ∈ hecha|pendiente|no_asistio.';

alter table public.actividades add column if not exists zoom_tipo text;

alter table public.actividades drop constraint if exists actividades_zoom_tipo_check;
alter table public.actividades add  constraint actividades_zoom_tipo_check
  check (zoom_tipo is null or zoom_tipo in ('pres', 'uno', 'cierre'));

comment on column public.actividades.zoom_tipo is
  'Si la puntual ES un zoom de ventas: pres|uno|cierre. La asistencia se refleja en clientes.zooms.';


-- ---------------------------------------------------------------------
--  Volcado de lo que ya existía
-- ---------------------------------------------------------------------
--  Por etapa se toma la fecha más antigua no nula (el embudo pasó una vez);
--  si no hay fecha pero sí estado, se conserva el estado. Corrió sobre 11
--  ventas de 10 personas (8 tenían algún zoom) y las 10 quedaron con su
--  embudo intacto — verificado fila por fila antes de aplicar.
-- ---------------------------------------------------------------------

with etapas as (
  select cliente_id, 'pres'   as k, pres_fecha   as f, pres_estado   as e from ventas where cliente_id is not null
  union all
  select cliente_id, 'uno',        uno_fecha,         uno_estado         from ventas where cliente_id is not null
  union all
  select cliente_id, 'cierre',     cierre_fecha,      cierre_estado      from ventas where cliente_id is not null
),
mejor as (
  select distinct on (cliente_id, k) cliente_id, k, f, e
  from etapas
  where f is not null or e is not null
  order by cliente_id, k, (f is null), f asc
),
agrupado as (
  select cliente_id,
         jsonb_object_agg(k, jsonb_strip_nulls(
           jsonb_build_object('f', to_char(f, 'YYYY-MM-DD'), 'e', e))) as z
  from mejor group by cliente_id
)
update clientes c set zooms = a.z from agrupado a
where a.cliente_id = c.id and c.zooms = '{}'::jsonb;


-- =====================================================================
--  PENDIENTE: eliminar las seis columnas de zoom de `ventas`
-- =====================================================================
--  `ventas.pres_fecha`, `pres_estado`, `uno_fecha`, `uno_estado`,
--  `cierre_fecha`, `cierre_estado` ya NO las lee ni las escribe el panel.
--  Se dejaron vivas a propósito durante el despliegue: borrarlas antes de
--  que el panel nuevo estuviera arriba habría dejado producción leyendo
--  columnas inexistentes.
--
--  Una vez desplegado y comprobado, se van — dejarlas es la trampa de
--  `imagen_url`, y además serían una SEGUNDA VERDAD del embudo:
--
--    alter table public.ventas
--      drop column pres_fecha,   drop column pres_estado,
--      drop column uno_fecha,    drop column uno_estado,
--      drop column cierre_fecha, drop column cierre_estado;
-- =====================================================================
