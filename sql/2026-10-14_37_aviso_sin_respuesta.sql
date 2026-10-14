-- =====================================================================
--  Aviso «cancela a quien no te contestó» (15 min antes del recordatorio de 1 h)
-- =====================================================================
--
--  QUÉ RESUELVE
--
--  En Seguimiento, cada actividad tiene «🔕 Sin respuesta»: cancela de una vez
--  los seguimientos de quienes no contestaron la invitación. Para que el agente
--  se acuerde de hacerlo ANTES de que salga el recordatorio de 1 h, el cron
--  le manda un push 15 min antes de ese recordatorio.
--
--  «No contestó» (misma regla que `abrirSinRespuesta` en seguimiento.js; si se
--  cambia una, cambiar la otra):
--    - seguimiento propio y `activo`;
--    - su primer mensaje ya salió (`enviado`), si no, no tuvo cómo contestar;
--    - no te escribió por WhatsApp después de ese primer envío
--      (`chats_recientes` del mismo dueño, cruzado por `clave_tel`);
--    - no abrió su enlace (`clic_en` / `clics`).
--
--  CUÁNDO AVISA
--
--  Cuando hay un `rec_60` pendiente del agente en esa actividad que sale en
--  los próximos 15 min, y solo si queda al menos una persona sin contestar.
--  Si el agente desmarcó el recordatorio de 1 h, no hay aviso. La clave lleva
--  el inicio de la actividad: un aviso por actividad; reprogramarla vuelve a
--  avisar (igual que `zoom`).
-- =====================================================================

-- Tipo nuevo, encendido por defecto (notif_apagadas guarda solo lo apagado).
alter table public.notificaciones drop constraint if exists notificaciones_tipo_check;
alter table public.notificaciones add constraint notificaciones_tipo_check
  check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','prueba'));
alter table public.notif_apagadas drop constraint if exists notif_apagadas_tipo_check;
alter table public.notif_apagadas add constraint notif_apagadas_tipo_check
  check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta'));

create or replace function public.sin_respuesta_de(p_owner uuid, p_actividad uuid)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int
    from public.seguimientos s
    join public.clientes cl on cl.id = s.cliente_id
    cross join lateral (
      select min(m.enviado_en) as primer from public.mensajes_programados m
       where m.seguimiento_id = s.id and m.estado = 'enviado' and m.enviado_en is not null) e
   where s.owner_id = p_owner and s.actividad_id = p_actividad and s.estado = 'activo'
     and e.primer is not null
     and s.clic_en is null and coalesce(s.clics, 0) = 0
     and not exists (
       select 1 from public.chats_recientes c
        where c.owner_id = p_owner
          and public.clave_tel(c.telefono) = public.clave_tel(cl.telefono)
          and c.entrante_en > e.primer);
$$;
revoke all on function public.sin_respuesta_de(uuid, uuid) from public, anon, authenticated;

create or replace function public.generar_notificaciones()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; n int;
begin
  -- Ver sql/2026-10-14_34_notificaciones_push.sql
  for r in
    select distinct o.owner, a.id, a.nombre, a.inicio
      from public.actividades a
      cross join lateral (
        select a.owner_id as owner
        union
        select s.owner_id from public.seguimientos s
         where s.actividad_id = a.id and s.estado <> 'cancelado') o
     where a.estado = 'activa'
       and a.inicio > now() and a.inicio <= now() + interval '60 minutes'
  loop
    perform public.notificar(r.owner, 'zoom',
      'zoom:' || r.id || ':' || extract(epoch from r.inicio)::bigint,
      'Tu zoom empieza pronto',
      format('«%s» empieza en %s min.', r.nombre,
             greatest(1, round(extract(epoch from r.inicio - now()) / 60))::int));
  end loop;

  -- Sin respuesta: 15 min antes del recordatorio de 1 h. Ver
  -- sql/2026-10-14_37_aviso_sin_respuesta.sql
  for r in
    select s.owner_id as owner, a.id, a.nombre, a.inicio, min(m.enviar_en) as rec60
      from public.mensajes_programados m
      join public.seguimientos s on s.id = m.seguimiento_id
      join public.actividades a on a.id = s.actividad_id
     where m.tipo = 'rec_60' and m.estado = 'pendiente'
       and m.enviar_en > now() and m.enviar_en <= now() + interval '15 minutes'
       and s.estado = 'activo' and a.estado = 'activa'
     group by s.owner_id, a.id, a.nombre, a.inicio
  loop
    n := public.sin_respuesta_de(r.owner, r.id);
    if n > 0 then
      perform public.notificar(r.owner, 'sin_respuesta',
        'sinresp:' || r.id || ':' || extract(epoch from r.inicio)::bigint,
        format('%s sin contestar en «%s»', n, r.nombre),
        format('El recordatorio de 1 h sale en %s min. Cancela su seguimiento en Seguimiento › 🔕 Sin respuesta.',
               greatest(1, round(extract(epoch from r.rec60 - now()) / 60))::int));
    end if;
  end loop;

  for r in
    select owner_id, actualizado from public.canales_wa
     where estado = 'vinculado' and baja_en is null
       and actualizado < now() - interval '10 minutes'
       and actualizado > now() - interval '1 day'
  loop
    perform public.notificar(r.owner_id, 'canal',
      'canal_mudo:' || extract(epoch from r.actualizado)::bigint,
      'Tu WhatsApp no da señales',
      'Tus mensajes programados no van a salir hasta que vuelva. Revisa Mi WhatsApp.');
  end loop;

  for r in
    select owner_id, count(*) filter (where estado = 'error') as fallos
      from public.mensajes_programados
     where estado in ('enviado', 'error') and enviar_en > now() - interval '30 minutes'
     group by owner_id
    having count(*) filter (where estado = 'error') >= 3
       and count(*) filter (where estado = 'error') >= count(*) filter (where estado = 'enviado')
  loop
    perform public.notificar(r.owner_id, 'canal',
      'canal_fallos:' || to_char(now() at time zone 'America/Bogota', 'YYYYMMDD'),
      'Tus mensajes están fallando',
      format('%s envíos fallaron en la última media hora. Revisa Mi WhatsApp.', r.fallos));
  end loop;

  if exists (select 1 from public.notificaciones
              where enviada_en is null and intentos < 3
                and creada_en > now() - interval '2 hours'
                and (enviando_en is null or enviando_en < now() - interval '2 minutes')) then
    perform public.disparar_push();
  end if;
end $$;
