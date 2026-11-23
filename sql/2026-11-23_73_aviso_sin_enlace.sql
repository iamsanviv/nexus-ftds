-- =====================================================================
--  Aviso push «Falta el enlace» (pedido de Sanviv, 23/11/2026)
--  SIN APLICAR hasta que Sanviv lo apruebe. Aplicar ANTES de fusionar el
--  panel: apagar el tipo inserta `sin_enlace` en notif_apagadas y sin
--  este CHECK nuevo fallaría.
--
--  10 minutos antes de que empiece una actividad activa sin enlace, se
--  avisa a quien la creó (actividades.owner_id). Solo al creador: es el
--  único que puede poner el enlace (un agente no edita la actividad de su
--  director ni la «🌐 Global» del admin).
--
--  Siempre, aunque nadie haya programado invitados todavía (Sanviv eligió
--  «Siempre» el 23/11/2026 frente a «solo si hay invitados»).
--
--  «Tiene enlace» = cualquier texto no vacío. Vale igual un Zoom que el
--  enlace de comunidad (https://comunidadnexus.com.co/en-vivo?clase=…).
--  Si el creador lo agrega a tiempo, el panel lo propaga a los mensajes de
--  enlace pendientes y la URL rastreada /i resuelve el vigente al abrirse.
--
--  Clave con el inicio: si se reprograma, vuelve a avisar en el horario
--  nuevo. Se puede apagar en Más › Notificaciones (tipo `sin_enlace`).
--
--  generar_notificaciones() se reescribe entera a partir de la versión de
--  producción del 23/11/2026; lo único nuevo es el bloque «Sin enlace».
--  Mecánica de entrega: sql/2026-10-14_34_notificaciones_push.sql.
-- =====================================================================

alter table public.notificaciones drop constraint notificaciones_tipo_check,
  add constraint notificaciones_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','aviso','prueba','envio','sin_enlace'));
alter table public.notif_apagadas drop constraint notif_apagadas_tipo_check,
  add constraint notif_apagadas_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','envio','sin_enlace'));

create or replace function public.generar_notificaciones()
 returns void
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare r record; n int;
begin
  -- Ver sql/2026-10-14_34_notificaciones_push.sql
  begin
    perform public.enviar_avisos();
  exception when others then raise warning 'enviar_avisos falló: %', sqlerrm;
  end;

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

  -- Sin enlace: 10 min antes, al creador. Ver sql/2026-11-23_73_aviso_sin_enlace.sql
  for r in
    select a.owner_id as owner, a.id, a.nombre, a.inicio
      from public.actividades a
     where a.estado = 'activa'
       and nullif(btrim(a.enlace), '') is null
       and a.inicio > now() and a.inicio <= now() + interval '10 minutes'
  loop
    perform public.notificar(r.owner, 'sin_enlace',
      'sinenlace:' || r.id || ':' || extract(epoch from r.inicio)::bigint,
      'Falta el enlace de tu actividad',
      format('«%s» empieza en %s min y no tiene enlace. Agrégalo en Seguimiento para que puedan entrar.',
             r.nombre, greatest(1, round(extract(epoch from r.inicio - now()) / 60))::int));
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
end $function$;
