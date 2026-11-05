-- =====================================================================
--  Imagen del mensaje del link: de la ACTIVIDAD, no de la tanda
--  Aplicado el 2026-11-05 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  La primera versión (05/11) ponía la imagen en las filas `enlace` de la
--  tanda que se estaba programando. Sanviv la quiere general: TODOS los que
--  vayan a la actividad reciben el link con la misma imagen, se hayan
--  programado antes o después, y los haya programado quien sea (actividades
--  compartidas o «para todos» las programan otros agentes).
--
--  QUÉ SE AGREGA
--
--  · `actividades.imagen_enlace` → URL de la imagen. Solo la cambia el dueño
--    (la política `actividades_upd` ya lo exige).
--  · Al INSERTAR un mensaje `enlace` sin media_url, se le pone la de su
--    actividad. Así cualquier tanda nueva la lleva, también desde una pestaña
--    con el panel viejo cargado.
--  · Al CAMBIAR la imagen, se propaga a los `enlace` aún no enviados
--    (pendiente o retenido por la pregunta del link) de todos los seguimientos
--    activos de esa actividad, incluidos los de otros agentes: el dueño no
--    puede tocar filas ajenas por RLS, por eso es security definer.
-- =====================================================================

alter table public.actividades add column if not exists imagen_enlace text;

comment on column public.actividades.imagen_enlace is
  'Imagen que acompaña al mensaje del link (tipo enlace) de todos los seguimientos de la actividad. null = el link sale solo con texto.';

create or replace function public.enlace_toma_imagen_actividad()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'enlace' and new.media_url is null and new.seguimiento_id is not null then
    select nullif(a.imagen_enlace, '') into new.media_url
      from public.seguimientos s join public.actividades a on a.id = s.actividad_id
     where s.id = new.seguimiento_id;
  end if;
  return new;
end $$;

drop trigger if exists mensajes_enlace_imagen on public.mensajes_programados;
create trigger mensajes_enlace_imagen
  before insert on public.mensajes_programados
  for each row execute function public.enlace_toma_imagen_actividad();

create or replace function public.actividad_propaga_imagen_enlace()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.mensajes_programados m
     set media_url = nullif(new.imagen_enlace, '')
    from public.seguimientos s
   where s.actividad_id = new.id and s.estado = 'activo'
     and m.seguimiento_id = s.id and m.tipo = 'enlace'
     and m.estado in ('pendiente', 'retenido');
  return new;
end $$;

drop trigger if exists actividades_imagen_enlace on public.actividades;
create trigger actividades_imagen_enlace
  after update of imagen_enlace on public.actividades
  for each row when (new.imagen_enlace is distinct from old.imagen_enlace)
  execute function public.actividad_propaga_imagen_enlace();
