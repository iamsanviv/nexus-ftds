-- =====================================================================
--  Avisar cuando un envío no sale, y no mandar recordatorios sin invitación
--  Aplicado el 2026-10-28 con el MCP de Supabase (execute_sql, en dos lotes:
--  el MCP cuelga con DROP TRIGGER, así que los triggers se crearon sin él).
--
--  Caso real (25/10/2026): «Operativa 8pm» se canceló entera por el tope
--  diario (220) y el agente no se enteró. El worker deja el motivo en
--  `error`, pero solo se veía abriendo el registro de envíos.
--
--  1. Aviso push tipo `envio` cuando el worker cancela o falla un mensaje.
--     Uno por causa, campaña/actividad y día: 23 cancelaciones = 1 aviso.
--  2. Si la invitación de un seguimiento no sale (tope, error del bridge,
--     canal), se cancela el resto del seguimiento. Antes solo se cancelaban
--     sus partes 2..4 y los recordatorios, enlace y confirmación SÍ salían:
--     en las 203 invitaciones cortadas por el tope hasta hoy, salieron 285
--     confirmaciones, 317 enlaces, 232 recordatorios de 15 min y 161 de 1 h
--     a personas que nunca recibieron la invitación. Viola «nada sale antes
--     que la invitación» (brain/03-domain/messaging-rules.md).
--
--  Lo que pone el panel (cancelar a mano, silenciar) deja `error` nulo, así
--  que no dispara ninguna de las dos cosas. Las cancelaciones en cascada
--  llevan `error` 'omitido: …' y tampoco avisan: ya avisó su cabeza.
-- =====================================================================

alter table public.notificaciones drop constraint notificaciones_tipo_check,
  add constraint notificaciones_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','aviso','prueba','envio'));
alter table public.notif_apagadas drop constraint notif_apagadas_tipo_check,
  add constraint notif_apagadas_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','envio'));

-- ---------------------------------------------------------------------
-- 1. Aviso push
-- ---------------------------------------------------------------------
create or replace function public.notificar_envio_fallido()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_causa text := case
    when new.error like 'tope diario%' then 'tope'
    when new.error ilike '%no vinculado%' then 'canal'
    else 'error' end;
  v_grupo text;
  v_nombre text;
begin
  if new.campana_id is not null then
    select c.id::text, c.nombre into v_grupo, v_nombre from public.campanas c where c.id = new.campana_id;
  elsif new.seguimiento_id is not null then
    select s.actividad_id::text, s.actividad into v_grupo, v_nombre from public.seguimientos s where s.id = new.seguimiento_id;
  end if;
  perform public.notificar(new.owner_id, 'envio',
    'envio:' || v_causa || ':' || coalesce(v_grupo, new.id::text) || ':'
      || to_char(now() at time zone 'America/Bogota', 'YYYYMMDD'),
    case v_causa
      when 'tope'  then 'Mensajes cancelados: límite diario'
      when 'canal' then 'Mensajes sin enviar: WhatsApp desvinculado'
      else 'Mensajes que no se pudieron enviar' end,
    coalesce('«' || v_nombre || '»: ', '') || case v_causa
      when 'tope'  then 'no salen porque hoy ya llegaste al límite de envíos. Se reinicia a medianoche.'
      when 'canal' then 'tu WhatsApp no está vinculado. Vincúlalo en Más › Mi WhatsApp.'
      else 'WhatsApp rechazó el envío. El motivo está en el registro de envíos de Seguimiento.' end);
  return null;
exception when others then
  -- Corre dentro del UPDATE del worker: un aviso nunca puede tumbar el
  -- registro de un envío.
  raise warning 'notificar_envio_fallido falló: %', sqlerrm;
  return null;
end $$;
revoke all on function public.notificar_envio_fallido() from public, anon, authenticated;

drop trigger if exists mensajes_notifica_fallo on public.mensajes_programados;
create trigger mensajes_notifica_fallo after update of estado on public.mensajes_programados
  for each row when (old.estado = 'pendiente' and new.estado in ('cancelado', 'error')
                     and new.error is not null and new.error not like 'omitido:%'
                     and new.error <> 'Enlace congelado que nunca se envió')
  execute function public.notificar_envio_fallido();

-- ---------------------------------------------------------------------
-- 2. Sin invitación no hay seguimiento
-- ---------------------------------------------------------------------
-- El seguimiento pasa a `cancelado` para que el agente pueda volver a
-- programar a esa persona en la misma actividad (el índice de uno activo
-- por actividad lo bloquearía).
create or replace function public.cancelar_seguimiento_sin_invitacion()
returns trigger language plpgsql as $$
begin
  update public.mensajes_programados
     set estado = 'cancelado', error = 'omitido: la invitación no salió'
   where seguimiento_id = new.seguimiento_id and estado = 'pendiente' and id <> new.id;
  update public.seguimientos set estado = 'cancelado'
   where id = new.seguimiento_id and estado = 'activo';
  return null;
end $$;

drop trigger if exists mensajes_cancela_seguimiento on public.mensajes_programados;
create trigger mensajes_cancela_seguimiento after update of estado on public.mensajes_programados
  for each row when (old.estado = 'pendiente' and new.estado in ('cancelado', 'error')
                     and new.tipo = 'invitacion' and new.seguimiento_id is not null
                     and new.error is not null and new.error not like 'omitido:%')
  execute function public.cancelar_seguimiento_sin_invitacion();

-- Las dos cascadas buscan por seguimiento; sin índice recorren la tabla.
create index if not exists mensajes_pendientes_seguimiento
  on public.mensajes_programados (seguimiento_id) where estado = 'pendiente';
