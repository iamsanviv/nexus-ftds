-- Notas de voz «Solo yo» en actividades compartidas (pedido de Sanviv, 12/11/2026).
--
-- Quien crea una actividad Global o de equipo elige, audio por audio, si su
-- nota de voz la puede enviar cualquiera que programe la actividad o solo él.
-- La marca va por URL: viaja con el audio al reordenar los mensajes y sirve
-- igual para el mensaje 1 (`imagen`) que para los 2..4 (`serie_invitacion`).
--
-- El panel ya la respeta (no la manda y ofrece «Usar mi voz»), pero el panel
-- no es frontera: estas dos piezas sostienen la regla en la base.

alter table public.actividades
  add column if not exists audios_privados text[] not null default '{}';

comment on column public.actividades.audios_privados is
  'URLs de notas de voz de esta actividad que solo envía su dueño (owner_id). Las demás se comparten.';

-- 1) Nadie más encola una nota «Solo yo». Ni por el panel viejo en caché, ni
--    con una pestaña que no se enteró del cambio, ni con una llamada directa.
--    SECURITY DEFINER: el agente ve la actividad, pero así no depende de RLS.
create or replace function public.mensaje_respeta_audio_privado()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  dueno uuid;
  priv text[];
begin
  if new.media_url is null or new.seguimiento_id is null then return new; end if;
  select a.owner_id, a.audios_privados into dueno, priv
    from seguimientos s join actividades a on a.id = s.actividad_id
   where s.id = new.seguimiento_id;
  if dueno is not null and new.owner_id is distinct from dueno and new.media_url = any(priv) then
    raise exception 'Esa nota de voz es solo de quien creó la actividad. Recarga la página y vuelve a programar.'
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger mensajes_audio_privado
  before insert or update of media_url on public.mensajes_programados
  for each row execute function public.mensaje_respeta_audio_privado();

-- 2) Si el dueño marca «Solo yo» una nota que otros YA programaron, esa nota
--    sale de sus mensajes pendientes y el resto del flujo sigue igual: por
--    cada invitación afectada, los contenidos que quedan se corren hacia
--    arriba sobre las mismas filas (conservan su hora) y sobra la última, que
--    se omite. Se omite y no se borra a propósito: cancelar una parte
--    intermedia dispararía `mensajes_cancela_partes` y se llevaría las de
--    después; la última no tiene después. Si no queda nada, la invitación se
--    omite con `omitido:`, que no cancela el seguimiento (recordatorios y
--    enlace siguen).
--    SECURITY DEFINER: el dueño no ve por RLS los mensajes de otros equipos.
create or replace function public.actividad_aplica_audios_privados()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  nuevos text[];
  sg uuid;
  ids uuid[];
  txs text[];
  mds text[];
  k int;
  n int;
begin
  select coalesce(array_agg(u), '{}') into nuevos
    from unnest(new.audios_privados) u where not (u = any(old.audios_privados));
  if cardinality(nuevos) = 0 then return null; end if;

  for sg in
    select distinct mp.seguimiento_id from mensajes_programados mp
      join seguimientos s on s.id = mp.seguimiento_id
     where s.actividad_id = new.id and mp.owner_id <> new.owner_id
       and mp.tipo in ('invitacion', 'invitacion_parte')
       and mp.estado in ('pendiente', 'retenido') and mp.media_url = any(nuevos)
  loop
    -- Filas pendientes de esa invitación, en orden de llegada.
    select array_agg(id order by (tipo = 'invitacion') desc, parte nulls first)
      into ids from mensajes_programados
     where seguimiento_id = sg and tipo in ('invitacion', 'invitacion_parte')
       and estado in ('pendiente', 'retenido');
    -- Lo que sí puede salir: una nota bloqueada sin texto desaparece; si
    -- llevara texto, queda el texto.
    select coalesce(array_agg(coalesce(texto, '') order by (tipo = 'invitacion') desc, parte nulls first), '{}'),
           coalesce(array_agg(case when media_url = any(nuevos) then null else media_url end
                              order by (tipo = 'invitacion') desc, parte nulls first), '{}')
      into txs, mds from mensajes_programados
     where seguimiento_id = sg and tipo in ('invitacion', 'invitacion_parte')
       and estado in ('pendiente', 'retenido')
       and not (coalesce(media_url = any(nuevos), false) and coalesce(btrim(texto), '') = '');
    n := coalesce(cardinality(txs), 0);
    for k in 1 .. cardinality(ids) loop
      if k <= n then
        update mensajes_programados set texto = txs[k], media_url = mds[k]
         where id = ids[k] and (texto is distinct from txs[k] or media_url is distinct from mds[k]);
      else
        update mensajes_programados
           set media_url = null, estado = 'cancelado',
               error = 'omitido: la nota de voz es solo de quien creó la actividad'
         where id = ids[k];
      end if;
    end loop;
  end loop;
  return null;
end $$;

create trigger actividades_audios_privados
  after update of audios_privados on public.actividades
  for each row when (new.audios_privados is distinct from old.audios_privados)
  execute function public.actividad_aplica_audios_privados();
