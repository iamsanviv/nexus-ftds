-- =====================================================================
--  Aviso push «Hora de depósito»
--  Aplicado el 2026-11-23 con el MCP de Supabase.
--
--  Cuando llega la hora que el lead prometió para depositar, el dueño
--  recibe un push para escribirle (Sanviv, 23/11/2026):
--    · promesa CON hora → a esa hora exacta;
--    · promesa SIN hora → a las 9:00 (Bogotá) del día prometido.
--  «Sin hora» se reconoce por las 00:00:01 que guarda `promesaISO()` en
--  public/js/leads.js; si eso cambia, hay que cambiar `deposito_aviso_en`.
--
--  Mismo universo que «Pendientes» de Hoy: leads propios activos y becados
--  con promesa de 2º depósito (promesa_broker); sin Caídos ni inactivos.
--  La clave lleva la promesa: reagendar vuelve a avisar, el mismo minuto no.
--  Ventana de 15 min hacia atrás: si el cron se salta un minuto el aviso
--  igual sale, y una promesa registrada horas tarde no dispara uno viejo.
--
--  Mecánica de entrega: sql/2026-10-14_34_notificaciones_push.sql.
-- =====================================================================

alter table public.notificaciones drop constraint notificaciones_tipo_check,
  add constraint notificaciones_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','aviso','prueba','envio','deposito'));
alter table public.notif_apagadas drop constraint notif_apagadas_tipo_check,
  add constraint notif_apagadas_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','envio','deposito'));

create or replace function public.deposito_aviso_en(p timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select case when (p at time zone 'America/Bogota')::time = time '00:00:01'
              then ((p at time zone 'America/Bogota')::date + time '09:00') at time zone 'America/Bogota'
              else p end
$$;
revoke all on function public.deposito_aviso_en(timestamptz) from public, anon, authenticated;

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

  -- Hora de depósito. Ver sql/2026-11-23_73_aviso_hora_deposito.sql
  for r in
    select c.id, c.owner_id, c.nombre, c.promesa_en
      from public.clientes c
     where c.promesa_en is not null
       and c.caido_en is null and c.inactivo_desde is null
       and (c.membresia = 'Lead' or c.promesa_broker is not null)
       and public.deposito_aviso_en(c.promesa_en) <= now()
       and public.deposito_aviso_en(c.promesa_en) > now() - interval '15 minutes'
  loop
    perform public.notificar(r.owner_id, 'deposito',
      'deposito:' || r.id || ':' || extract(epoch from r.promesa_en)::bigint,
      'Hora de depósito: ' || coalesce(nullif(trim(r.nombre), ''), 'sin nombre'),
      case when (r.promesa_en at time zone 'America/Bogota')::time = time '00:00:01'
           then 'Prometió depositar hoy. Escríbele para confirmar.'
           else 'Prometió depositar a las '
                || lower(replace(replace(to_char(r.promesa_en at time zone 'America/Bogota', 'FMHH12:MI AM'), 'AM', 'a. m.'), 'PM', 'p. m.'))
                -- «p. m.» ya cierra con punto: no agregar otro.
                || ' Escríbele para confirmar.' end);
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
revoke all on function public.generar_notificaciones() from public, anon, authenticated;
