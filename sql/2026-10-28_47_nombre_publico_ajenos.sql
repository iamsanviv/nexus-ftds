-- =====================================================================
--  Nombre público: corregir también los mensajes que el editor no ve
--  Aplicado el 2026-10-28 con el MCP de Supabase (migración
--  `nombre_publico_ajenos`).
--
--  El panel (`renombrarPendientes`) corrige los pendientes que el RLS le deja
--  ver. En una `para_todos`, los de otros equipos quedan fuera del alcance
--  del admin; este trigger cubre ese conjunto (`not puede_ver_de`), como
--  `actividades_ajenos_upd` con la hora y el enlace. Los dos conjuntos son
--  disjuntos. Trigger aparte y no dentro de `actividades_ajenos_upd` para no
--  tener que borrar y recrear ese disparador en producción.
--  Reemplazo literal del nombre viejo por el nuevo: no re-sortea el texto ni
--  pisa la invitación que escribió cada agente.
--
--  Probado en begin…rollback con la sesión de un agente ajeno a la jerarquía
--  del dueño (puede_ver_de = false): 24 pendientes pasaron al nombre nuevo.
-- =====================================================================

create or replace function public.actividades_nombre_ajenos()
 returns trigger
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare nom_antes text := coalesce(nullif(btrim(old.nombre_publico), ''), old.nombre);
        nom_ahora text := coalesce(nullif(btrim(new.nombre_publico), ''), new.nombre);
begin
  if nom_antes is not distinct from nom_ahora or coalesce(nom_antes, '') = ''
     or coalesce(nom_ahora, '') = '' then
    return new;
  end if;
  update public.mensajes_programados m
     set texto = replace(m.texto, nom_antes, nom_ahora)
    from public.seguimientos s
   where s.id = m.seguimiento_id and s.actividad_id = new.id and s.estado = 'activo'
     and not public.puede_ver_de(s.owner_id)
     and m.estado = 'pendiente' and strpos(m.texto, nom_antes) > 0;
  return new;
end $function$;

create trigger actividades_ajenos_nombre
  after update of nombre, nombre_publico on public.actividades
  for each row execute function public.actividades_nombre_ajenos();
