-- =====================================================================
--  Nombre público de la actividad (`actividades.nombre_publico`)
--  Aplicado el 2026-10-26 con el MCP de Supabase (migración
--  `actividades_nombre_publico`).
--
--  `nombre` es como los agentes ven la actividad en el panel (puede llevar
--  notas internas: «Operativa · grupo B», «Lanzamiento prueba 2»).
--  `nombre_publico` es como les llega a las personas en `{actividad}` de los
--  mensajes. Nulo = se usa `nombre`, que es lo que hacía el sistema antes.
--
--  El texto de cada mensaje se arma en el navegador al programar, así que no
--  hace falta tocar el worker ni ninguna función: basta con que el panel lea
--  esta columna. RLS sin cambios: la columna vive en la misma fila.
-- =====================================================================

alter table public.actividades
  add column if not exists nombre_publico text;

-- Vacío o solo espacios no es un nombre: obligar a guardar nulo evita que una
-- actividad mande «*  *» en el mensaje por un campo que se borró a medias.
alter table public.actividades
  drop constraint if exists actividades_nombre_publico_no_vacio,
  add constraint actividades_nombre_publico_no_vacio
    check (nombre_publico is null or btrim(nombre_publico) <> '');
