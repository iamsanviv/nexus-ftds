-- =====================================================================
--  78 · Notificaciones: nombre completo y fin del aviso «sin contestar»
--  (27/11/2026, pedido de Sanviv)
--
--  1) «X te escribió / te respondió» usaba solo el primer nombre
--     (split_part). Con muchos José y Carlos el agente no sabía quién era:
--     ahora va el nombre completo guardado (espacios repetidos colapsados).
--     Sin nombre guardado, el teléfono, para que el título nunca quede
--     « te escribió». Los demás avisos con nombre de cliente («Hora de
--     depósito: …», «Lead nuevo: …») ya usaban el nombre completo.
--
--  2) Se quita el aviso `sin_respuesta` («N sin contestar en «…»», 15 min
--     antes del recordatorio de 1 h). Pedía cancelar a mano en
--     «Seguimiento › 🔕 Sin respuesta», botón que ya no existe (23/11), y
--     ese freno hoy es automático: a quien no escribió le sale la pregunta
--     del link en vez del recordatorio y el link solo si dice que sí
--     (procesar_preguntas_link). `sin_respuesta_de` se conserva: la usan
--     las preguntas del link. Los CHECK de tipo conservan 'sin_respuesta'
--     por las filas históricas de notificaciones / notif_apagadas.
--
--  Base: pg_get_functiondef de producción leído el 27/11/2026 (incluye los
--  bloques sin_enlace y deposito de SQL 73/74).
-- =====================================================================

create or replace function public.notificar_entrante()
returns trigger language plpgsql security definer set search_path = '' as $function$
declare
  old_ent timestamptz := case when tg_op = 'UPDATE' then old.entrante_en end;
  hoy     date := (now() at time zone 'America/Bogota')::date;
  cli     public.clientes;
  msg     record;
  b       record;
  t_antes text; t_ahora text;
  apag    text[];
  partes  text[] := '{}';
  tipo    text;
  titulo  text;
  nombre  text;
  seguir  boolean;
  QUE constant jsonb := '{"invitacion":"tu invitación","invitacion_parte":"tu invitación",
    "rec_60":"tu recordatorio","rec_15":"tu recordatorio","enlace":"el enlace",
    "confirmacion":"tu confirmación","masivo":"tu mensaje masivo","masivo_parte":"tu mensaje masivo"}';
begin
  -- Ver sql/2026-10-14_34_notificaciones_push.sql y sql/2026-11-27_78
  if new.entrante_en is null or (old_ent is not null and new.entrante_en <= old_ent) then return null; end if;
  if not exists (select 1 from public.push_suscripciones where owner_id = new.owner_id) then return null; end if;
  select * into cli from public.clientes c
   where c.owner_id = new.owner_id and c.inactivo_desde is null
     and public.clave_tel(c.telefono) = public.clave_tel(new.telefono)
   limit 1;
  if cli.id is null then return null; end if;
  select coalesce(array_agg(a.tipo), '{}') into apag from public.notif_apagadas a where a.owner_id = new.owner_id;
  -- Nombre completo: el primer nombre solo no distingue entre tantos José.
  nombre := coalesce(nullif(regexp_replace(trim(cli.nombre), '\s+', ' ', 'g'), ''), cli.telefono);
  seguir := cli.membresia = 'Lead' or (cli.promesa_en is not null and cli.promesa_broker is not null);
  if not ('respondio' = any(apag)) then
    select m.tipo, m.enviado_en into msg from public.mensajes_programados m
     where m.owner_id = new.owner_id and m.estado = 'enviado'
       and m.enviado_en > now() - interval '3 days' and m.enviado_en < new.entrante_en
       and (m.cliente_id = cli.id or m.telefono = cli.telefono)
     order by m.enviado_en desc limit 1;
    if msg.enviado_en is not null and (old_ent is null or old_ent <= msg.enviado_en) then
      partes := partes || ('Respondió a ' || coalesce(QUE ->> msg.tipo, 'tu mensaje'));
      tipo := 'respondio';
    end if;
  end if;
  if seguir and not ('temperatura' = any(apag)) then
    select * into b from public.temp_base(cli);
    t_antes := public.temp_con_entrante(b.t, b.en, old_ent);
    t_ahora := public.temp_con_entrante(b.t, b.en, new.entrante_en);
    if array_position(array['frio','tibio','caliente'], t_ahora)
       > array_position(array['frio','tibio','caliente'], t_antes) then
      partes := partes || format('Subió de %s a %s',
        case t_antes when 'frio' then 'Frío' when 'tibio' then 'Tibio' else 'Caliente' end,
        case t_ahora when 'frio' then 'frío' when 'tibio' then 'tibio' else 'caliente' end);
      tipo := coalesce(tipo, 'temperatura');
    end if;
  end if;
  if seguir and not ('escribio_hoy' = any(apag))
     and (new.entrante_en at time zone 'America/Bogota')::date = hoy
     and (old_ent is null or (old_ent at time zone 'America/Bogota')::date < hoy) then
    partes := partes || 'Primer mensaje de hoy'::text;
    tipo := coalesce(tipo, 'escribio_hoy');
  end if;
  if tipo is null then return null; end if;
  titulo := nombre || case when tipo = 'respondio' then ' te respondió' else ' te escribió' end;
  if seguir then
    partes := array[case when cli.membresia = 'Lead' then 'Lead' else 'Pendiente de depósito' end] || partes;
  end if;
  perform public.notificar(new.owner_id, tipo,
    'wa:' || cli.id || ':' || extract(epoch from new.entrante_en)::bigint,
    titulo, array_to_string(partes, ' · '));
  return null;
exception when others then
  raise warning 'notificar_entrante falló: %', sqlerrm;
  return null;
end $function$;
revoke all on function public.notificar_entrante() from public, anon, authenticated;

create or replace function public.generar_notificaciones()
returns void language plpgsql security definer set search_path = '' as $function$
declare r record;
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

  -- Sin enlace: 10 min antes, al creador. Ver sql/2026-11-23_74_aviso_sin_enlace.sql
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

  -- (El aviso «sin_respuesta» se quitó en sql/2026-11-27_78: el freno es automático.)

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
