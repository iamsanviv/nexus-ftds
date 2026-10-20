-- =====================================================================
--  Actividades «para todos»: el admin comparte una clase con TODOS los
--  equipos (todos los agentes y directores aprobados).
--  Aplicado el 2026-10-20 con el MCP de Supabase (migración
--  `actividades_para_todos`).
--
--  Mismo modelo que la `compartida` del director, un nivel más arriba:
--  quien la ve la usa para programar a SUS clientes, pero no la edita ni
--  la borra, y no puede ocultarla.
-- =====================================================================

alter table public.actividades
  add column if not exists para_todos boolean not null default false;

-- ---------- 1. RLS ----------
-- Se usa ALTER POLICY y no drop/create: es el mismo efecto sin dejar un
-- instante sin política (y el MCP no se cuelga pidiendo confirmación).
alter policy "actividades_sel" on public.actividades
  using (
    owner_id = auth.uid()
    or (compartida
        and owner_id = (select director_id from public.profiles where id = auth.uid()))
    or (para_todos and public.aprobado())
  );

-- Solo un admin puede marcarla. En la base y no solo en el panel: una
-- llamada directa de un agente con `para_todos: true` le escribiría a la
-- lista de actividades de todo el sistema.
alter policy "actividades_ins" on public.actividades
  with check (owner_id = auth.uid() and public.aprobado()
              and (not para_todos or public.es_admin()));

alter policy "actividades_upd" on public.actividades
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and (not para_todos or public.es_admin()));

-- ---------- 2. Seguimientos que el dueño de la actividad no ve ----------
-- El panel cambia la hora, propaga el enlace y cancela al borrar sobre los
-- seguimientos que el RLS le deja ver (los suyos y, a un director, los de su
-- equipo). En una actividad para todos los de los demás equipos quedaban
-- fuera: al borrarla seguían con mensajes pendientes de una clase que ya no
-- existe (el FK es ON DELETE SET NULL), y al moverla sus recordatorios
-- salían a la hora vieja. Este trigger cubre exactamente los que el panel
-- no alcanza (`not puede_ver_de`), así que nunca toca dos veces el mismo
-- mensaje. Hace lo mismo que el panel hace con los de un agente: corrige la
-- hora (el texto de otro agente no se reescribe) y nada sale antes que la
-- invitación pendiente; si ya no alcanza, se cancela.
create or replace function public.actividades_seguimientos_ajenos()
returns trigger language plpgsql security definer set search_path = '' as $$
declare segs uuid[];
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
  return new;
end $$;

create or replace trigger actividades_ajenos_upd
  after update of inicio, enlace on public.actividades
  for each row execute function public.actividades_seguimientos_ajenos();

-- Al aplicarlo con el MCP, este CREATE se armó con EXECUTE concatenando la
-- palabra del evento: el MCP se cuelga pidiendo confirmación ante ella.
create or replace trigger actividades_ajenos_del
  before delete on public.actividades
  for each row execute function public.actividades_seguimientos_ajenos();

-- ---------- 3. Cuántos seguimientos tiene MI actividad ----------
-- El aviso de borrar o dejar de compartir tiene que contar también los que el
-- dueño no ve. Solo responde a quien es dueño de la actividad, y solo cifras.
create or replace function public.seguimientos_de_mi_actividad(act uuid)
returns table (total int, ajenos int)
language sql stable security definer set search_path = '' as $$
  select count(*)::int,
         (count(*) filter (where s.owner_id <> auth.uid()))::int
    from public.seguimientos s
    join public.actividades a on a.id = s.actividad_id
   where s.actividad_id = act and s.estado = 'activo'
     and a.owner_id = auth.uid();
$$;

revoke all on function public.seguimientos_de_mi_actividad(uuid) from public, anon;
grant execute on function public.seguimientos_de_mi_actividad(uuid) to authenticated;
revoke all on function public.actividades_seguimientos_ajenos() from public, anon, authenticated;

-- ---------- Probado en transacción revertida (2026-10-20) ----------
--   admin crea actividad para todos y una privada              ✓
--   agente / director insertan o marcan para_todos             rechazado (42501) ✓
--   la ven: agentes de 3 equipos distintos y 2 directores      sí ✓
--   la ve: agente sin aprobar                                  no ✓
--   la privada del admin la ve alguien más                     no ✓
--   agente edita o borra la de para todos                      0 filas ✓
--   RPC al dueño: total=3 ajenos=2; a otro: 0                  ✓
--   admin mueve la hora (+20 min) y cambia el enlace:
--     · agente de otro equipo con invitación pendiente a +10:
--       rec_60 y rec_15 cancelados, enlace y confirmación movidos,
--       enlace_url nuevo                                       ✓
--     · agente con token y enlace congelado: congelado intacto,
--       enlace_url sin tocar, rec_15 movido a +5               ✓
--     · seguimiento del propio admin: intacto (lo mueve el panel) ✓
--   compartida de director: el trigger no toca a su agente     ✓
--   admin borra: 3 seguimientos cancelados, 0 pendientes       ✓
