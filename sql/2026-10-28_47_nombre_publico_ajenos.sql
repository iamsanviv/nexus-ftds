-- =====================================================================
--  Nombre público: corregir también los mensajes que el editor no ve
--  Aplicado el 2026-10-28 con el MCP de Supabase (migración
--  `nombre_publico_ajenos`).
--
--  El panel (`renombrarPendientes`) corrige los pendientes que el RLS le deja
--  ver. En una `para_todos`, los de otros equipos quedan fuera del alcance
--  del admin; este trigger cubre ese conjunto (`not puede_ver_de`), igual que
--  ya hacía con la hora y el enlace. Los dos conjuntos son disjuntos.
--  Reemplazo literal del nombre viejo por el nuevo: no re-sortea el texto ni
--  pisa la invitación que escribió cada agente.
-- =====================================================================

create or replace function public.actividades_seguimientos_ajenos()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare segs uuid[];
        nom_antes text;
        nom_ahora text;
begin
  -- Solo dispara en UPDATE y en DELETE: lo que no es UPDATE es el borrado.
  if tg_op <> 'UPDATE' then
    -- Al borrar se cancelan TODOS los activos, no solo los ajenos: el panel ya
    -- canceló los visibles, y repetirlo no cambia nada.
    select array_agg(id) into segs from public.seguimientos
     where actividad_id = old.id and estado = 'activo';
    if segs is not null then
      update public.mensajes_programados set estado = 'cancelado'
       where seguimiento_id = any(segs) and estado = 'pendiente';
      update public.seguimientos set estado = 'cancelado' where id = any(segs);
    end if;
    return old;
  end if;

  select array_agg(s.id) into segs from public.seguimientos s
   where s.actividad_id = new.id and s.estado = 'activo'
     and not public.puede_ver_de(s.owner_id);
  if segs is null then return new; end if;

  if new.inicio is distinct from old.inicio then
    with piso as (
      select seguimiento_id, max(enviar_en) as inv
        from public.mensajes_programados
       where seguimiento_id = any(segs) and estado = 'pendiente'
         and tipo in ('invitacion', 'invitacion_parte')
       group by seguimiento_id
    ), nuevo as (
      select m.id,
             new.inicio + case m.tipo
               when 'rec_60' then interval '-60 minutes'
               when 'rec_15' then interval '-15 minutes'
               when 'enlace' then interval '0'
               else interval '10 minutes' end as cuando,
             greatest(now(), coalesce(p.inv, '-infinity'::timestamptz)) as piso
        from public.mensajes_programados m
        left join piso p on p.seguimiento_id = m.seguimiento_id
       where m.seguimiento_id = any(segs) and m.estado = 'pendiente'
         and m.tipo in ('rec_60', 'rec_15', 'enlace', 'confirmacion')
         -- Congelado (centinela del año 2999): lo retuvo su agente a propósito.
         and m.enviar_en < '2900-01-01'::timestamptz
    )
    update public.mensajes_programados m
       set estado    = case when n.cuando <= n.piso then 'cancelado' else m.estado end,
           enviar_en = case when n.cuando <= n.piso then m.enviar_en else n.cuando end
      from nuevo n
     where m.id = n.id;
  end if;

  -- Con token el enlace se resuelve al abrirse (/i): ya apunta al nuevo.
  if new.enlace is distinct from old.enlace then
    update public.mensajes_programados
       set enlace_url = nullif(new.enlace, '')
     where seguimiento_id in (select id from public.seguimientos
                               where id = any(segs) and coalesce(clic_token, '') = '')
       and tipo = 'enlace' and estado = 'pendiente';
  end if;

  -- Misma regla que `nombreParaPersonas` en el panel.
  nom_antes := coalesce(nullif(btrim(old.nombre_publico), ''), old.nombre);
  nom_ahora := coalesce(nullif(btrim(new.nombre_publico), ''), new.nombre);
  if nom_antes is distinct from nom_ahora and coalesce(nom_antes, '') <> ''
     and coalesce(nom_ahora, '') <> '' then
    update public.mensajes_programados
       set texto = replace(texto, nom_antes, nom_ahora)
     where seguimiento_id = any(segs) and estado = 'pendiente'
       and strpos(texto, nom_antes) > 0;
  end if;
  return new;
end $function$;

drop trigger if exists actividades_ajenos_upd on public.actividades;
create trigger actividades_ajenos_upd
  after update of inicio, enlace, nombre, nombre_publico on public.actividades
  for each row execute function public.actividades_seguimientos_ajenos();
