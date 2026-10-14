-- =====================================================================
--  Notificaciones push al agente (PC y teléfono)
--  Aplicado el 2026-10-14 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  El agente solo se entera de algo si abre el panel. Push web llega con
--  el panel cerrado, en el escritorio y en el teléfono, sin app nativa.
--  En iPhone solo funciona con el panel agregado a la pantalla de inicio
--  (requisito de Apple, iOS 16.4+).
--
--  CÓMO FLUYE
--
--    evento (trigger o cron) → notificar() → fila en `notificaciones`
--      → trigger de sentencia → pg_net → Edge Function `enviar-push`
--      → Web Push a cada `push_suscripciones` del dueño
--
--  `notificaciones` es a la vez cola y registro de deduplicación: la
--  clave (owner_id, clave) impide que el cron de cada minuto repita el
--  mismo aviso. Cada generador arma su clave para que un episodio nuevo
--  (otro horario del zoom, otra caída del canal) sí vuelva a avisar.
--
--  ALCANCE: SOLO EL PROPIO
--
--  Igual que `chats_recientes`, ninguna de estas tablas usa
--  `puede_ver_de()`. Un aviso es para quien tiene que actuar: el dueño
--  del cliente o del canal. Un director supervisa desde el panel; no
--  recibe en su teléfono los avisos de su equipo.
--
--  LLAVES VAPID
--
--  Las genera la propia Edge Function la primera vez y las guarda en
--  Vault. La privada nunca sale de Supabase; la pública la pide el panel
--  con `vapid_publica()`.
-- =====================================================================

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------
--  Tablas
-- ---------------------------------------------------------------------

-- Un navegador = un endpoint. Es la PK porque si en esa PC entra otro
-- agente, el dispositivo pasa a ser suyo (registrar_push lo reasigna) y
-- el anterior deja de recibir ahí.
create table if not exists public.push_suscripciones (
  endpoint    text primary key,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  p256dh      text not null,
  auth        text not null,
  dispositivo text,
  creada_en   timestamptz not null default now(),
  usada_en    timestamptz
);
create index if not exists push_suscripciones_owner on public.push_suscripciones(owner_id);

create table if not exists public.notificaciones (
  id          bigint generated always as identity primary key,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  -- 'prueba' es el botón «Enviar una prueba»; no se puede apagar.
  tipo        text not null check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','prueba')),
  clave       text not null,
  titulo      text not null,
  cuerpo      text not null,
  url         text not null default '/',
  creada_en   timestamptz not null default now(),
  enviando_en timestamptz,
  enviada_en  timestamptz,
  intentos    int not null default 0,
  unique (owner_id, clave)
);
create index if not exists notificaciones_pendientes
  on public.notificaciones(id) where enviada_en is null;

-- Lo que el agente apagó. Se guarda lo apagado (no lo encendido) para que
-- un tipo nuevo llegue encendido sin migrar a nadie.
create table if not exists public.notif_apagadas (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  tipo     text not null check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal')),
  primary key (owner_id, tipo)
);

alter table public.push_suscripciones enable row level security;
alter table public.notificaciones     enable row level security;
alter table public.notif_apagadas     enable row level security;

drop policy if exists push_propias on public.push_suscripciones;
create policy push_propias on public.push_suscripciones
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists notif_propias on public.notificaciones;
create policy notif_propias on public.notificaciones
  for select to authenticated using (owner_id = auth.uid());

drop policy if exists apagadas_propias on public.notif_apagadas;
create policy apagadas_propias on public.notif_apagadas
  for all to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Las suscripciones se escriben solo por RPC: la reasignación de un
-- endpoint ajeno no cabe en una política de UPDATE sin abrir la tabla.
revoke insert, update, delete on public.push_suscripciones from anon, authenticated;
revoke insert, update, delete on public.notificaciones     from anon, authenticated;

-- ---------------------------------------------------------------------
--  RPC del panel
-- ---------------------------------------------------------------------

create or replace function public.registrar_push(p_endpoint text, p_p256dh text, p_auth text, p_dispositivo text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sin sesión'; end if;
  if p_endpoint !~ '^https://' then raise exception 'endpoint inválido'; end if;
  insert into public.push_suscripciones(endpoint, owner_id, p256dh, auth, dispositivo)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(p_dispositivo, 200))
  on conflict (endpoint) do update
    set owner_id = excluded.owner_id, p256dh = excluded.p256dh,
        auth = excluded.auth, dispositivo = excluded.dispositivo;
end $$;

create or replace function public.quitar_push(p_endpoint text)
returns void language sql security definer set search_path = '' as $$
  delete from public.push_suscripciones where endpoint = p_endpoint and owner_id = auth.uid();
$$;

create or replace function public.vapid_publica()
returns text language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'vapid_publica';
$$;

revoke all on function public.registrar_push(text,text,text,text) from public, anon;
revoke all on function public.quitar_push(text)                   from public, anon;
revoke all on function public.vapid_publica()                     from public, anon;
grant execute on function public.registrar_push(text,text,text,text) to authenticated;
grant execute on function public.quitar_push(text)                   to authenticated;
grant execute on function public.vapid_publica()                     to authenticated;

-- ---------------------------------------------------------------------
--  RPC de la Edge Function (solo service_role)
-- ---------------------------------------------------------------------

create or replace function public.vapid_claves()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'publica', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_publica'),
    'privada', (select decrypted_secret from vault.decrypted_secrets where name = 'vapid_privada'));
$$;

-- Primera ejecución de la función: guarda el par si todavía no existe.
-- El nombre es único en Vault, así que dos invocaciones simultáneas no
-- pueden dejar una pública de un par y una privada de otro: la segunda
-- falla entera y relee el par de la primera.
create or replace function public.guardar_vapid(p_publica text, p_privada text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from vault.secrets where name = 'vapid_publica') then return; end if;
  perform vault.create_secret(p_publica, 'vapid_publica', 'Web Push: llave pública VAPID');
  perform vault.create_secret(p_privada, 'vapid_privada', 'Web Push: llave privada VAPID');
end $$;

-- Reclama un lote. `enviando_en` evita que dos invocaciones concurrentes
-- (trigger + cron) manden el mismo aviso dos veces; si la función muere a
-- mitad, a los 2 minutos el lote vuelve a ser reclamable. Un aviso de hace
-- más de 2 horas ya no sirve («tu zoom empieza en 1 h») y se abandona.
create or replace function public.reclamar_notificaciones(p_limite int default 100)
returns setof public.notificaciones language sql security definer set search_path = '' as $$
  update public.notificaciones n
     set enviando_en = now(), intentos = n.intentos + 1
   where n.id in (
     select id from public.notificaciones
      where enviada_en is null and intentos < 3
        and creada_en > now() - interval '2 hours'
        and (enviando_en is null or enviando_en < now() - interval '2 minutes')
      order by id limit p_limite
      for update skip locked)
  returning n.*;
$$;

revoke all on function public.vapid_claves()                from public, anon, authenticated;
revoke all on function public.guardar_vapid(text,text)      from public, anon, authenticated;
revoke all on function public.reclamar_notificaciones(int)  from public, anon, authenticated;
grant execute on function public.vapid_claves()               to service_role;
grant execute on function public.guardar_vapid(text,text)     to service_role;
grant execute on function public.reclamar_notificaciones(int) to service_role;

-- ---------------------------------------------------------------------
--  Encolar y disparar
-- ---------------------------------------------------------------------

-- Punto único para crear un aviso. Idempotente por (owner, clave). No
-- encola si el agente no tiene ningún dispositivo o apagó ese tipo: una
-- fila sin destinatario solo engorda la tabla.
create or replace function public.notificar(p_owner uuid, p_tipo text, p_clave text,
                                            p_titulo text, p_cuerpo text, p_url text default '/')
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.push_suscripciones where owner_id = p_owner) then return; end if;
  if exists (select 1 from public.notif_apagadas where owner_id = p_owner and tipo = p_tipo) then return; end if;
  insert into public.notificaciones(owner_id, tipo, clave, titulo, cuerpo, url)
  values (p_owner, p_tipo, p_clave, p_titulo, p_cuerpo, coalesce(p_url, '/'))
  on conflict (owner_id, clave) do nothing;
end $$;
revoke all on function public.notificar(uuid,text,text,text,text,text) from public, anon, authenticated;

-- «Enviar una prueba» desde el panel: recorre la cadena entera (cola,
-- pg_net, Edge Function, servicio push del navegador), no solo el dibujo.
create or replace function public.notificar_prueba()
returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'sin sesión'; end if;
  -- Clave por segundo: cada pulsación es un aviso nuevo, pero un doble
  -- clic no manda dos.
  perform public.notificar(auth.uid(), 'prueba',
    'prueba:' || extract(epoch from date_trunc('second', now()))::bigint,
    'Notificaciones activadas',
    'Así te van a llegar los avisos de Seguimiento.');
end $$;
revoke all on function public.notificar_prueba() from public, anon;
grant execute on function public.notificar_prueba() to authenticated;

-- La anon key es pública (está en public/js/config.js); solo sirve para
-- pasar verify_jwt. Invocar la función de más no hace daño: reclama lo
-- pendiente y, si no hay nada, termina.
create or replace function public.disparar_push()
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform net.http_post(
    url     := 'https://cizjalpqscqftxtbdlmw.supabase.co/functions/v1/enviar-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpemphbHBxc2NxZnR4dGJkbG13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTY0NzgsImV4cCI6MjA5Njg3MjQ3OH0.XINBRXlgO5Mxtx-1bX8Y8pzTGWWDLL1mMjLSHyk1wAI'),
    body    := '{}'::jsonb,
    timeout_milliseconds := 15000);
end $$;
revoke all on function public.disparar_push() from public, anon, authenticated;

-- Solo si la sentencia insertó algo (con ON CONFLICT DO NOTHING un aviso
-- repetido no inserta). Llamadas de más no duplican: las ordena
-- reclamar_notificaciones().
--
-- El EXCEPTION no es decorativo: este insert puede ocurrir dentro de un
-- UPDATE del bridge o del worker, y un fallo de pg_net no puede tumbar
-- el latido de un canal ni el registro de un envío. Si se pierde el
-- disparo, el cron del minuto siguiente reintenta.
create or replace function public.notificaciones_disparar()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from nuevas) then
    perform public.disparar_push();
  end if;
  return null;
exception when others then
  raise warning 'disparar_push falló: %', sqlerrm;
  return null;
end $$;

drop trigger if exists notificaciones_disparar on public.notificaciones;
create trigger notificaciones_disparar after insert on public.notificaciones
  referencing new table as nuevas
  for each statement execute function public.notificaciones_disparar();

-- ---------------------------------------------------------------------
--  Generador: WhatsApp desconectado (por transición)
-- ---------------------------------------------------------------------

-- Solo la transición vinculado → otra cosa. El bridge reescribe `estado`
-- en cada latido con el mismo valor; eso no es un cambio. Si el propio
-- agente pidió desvincular (`comando`), ya lo sabe. La clave por hora
-- frena un canal que oscila.
create or replace function public.notificar_canal_desvinculado()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.estado = 'vinculado' and new.estado is distinct from 'vinculado'
     and new.baja_en is null and new.estado not in ('bajando', 'baja')
     and new.comando is null
     and (new.comando_en is null or new.comando_en < now() - interval '10 minutes') then
    perform public.notificar(new.owner_id, 'canal',
      'canal_desv:' || to_char(now(), 'YYYYMMDDHH24'),
      'Tu WhatsApp se desconectó',
      'Tus mensajes programados no van a salir. Entra a Mi WhatsApp para volver a vincularlo.');
  end if;
  return null;
exception when others then
  -- Corre dentro del latido del bridge: un aviso nunca puede tumbarlo.
  raise warning 'notificar_canal_desvinculado falló: %', sqlerrm;
  return null;
end $$;

drop trigger if exists canales_wa_notifica_desvinculo on public.canales_wa;
create trigger canales_wa_notifica_desvinculo after update of estado on public.canales_wa
  for each row execute function public.notificar_canal_desvinculado();

-- ---------------------------------------------------------------------
--  Generador del cron (cada minuto): zoom en 1 hora, canal mudo, fallos
-- ---------------------------------------------------------------------

create or replace function public.generar_notificaciones()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  -- Zoom: al dueño de la actividad y a quien tenga seguimientos vivos en
  -- ella (las compartidas las invitan otros agentes). La clave lleva el
  -- inicio: si se reprograma, el nuevo horario vuelve a avisar.
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

  -- Canal mudo: figura vinculado pero el bridge dejó de latir (~60 s).
  -- 10 min de margen para no avisar por un reinicio. La clave es el
  -- último latido: mientras siga caído es el mismo episodio. Más de un
  -- día caído no es noticia nueva.
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

  -- Envíos fallando: 3+ errores en 30 min y no menos que los enviados.
  -- Una vez por día (Bogotá, como el resto del panel).
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

  -- Reintento de lo que quedó sin enviar (función caída, timeout).
  if exists (select 1 from public.notificaciones
              where enviada_en is null and intentos < 3
                and creada_en > now() - interval '2 hours'
                and (enviando_en is null or enviando_en < now() - interval '2 minutes')) then
    perform public.disparar_push();
  end if;

end $$;
revoke all on function public.generar_notificaciones() from public, anon, authenticated;

select cron.unschedule('notificaciones') where exists (select 1 from cron.job where jobname = 'notificaciones');
select cron.schedule('notificaciones', '* * * * *', 'select public.generar_notificaciones()');

-- ---------------------------------------------------------------------
--  Generador: WhatsApp entrante (respondió, escribió hoy, temperatura)
-- ---------------------------------------------------------------------
--
--  Punto de enganche documentado por el hilo de entrantes: una fila de
--  `chats_recientes` cuyo `entrante_en` cambia ES «esta persona te
--  escribió». El worker la publica cada ~5 min, así que el aviso llega
--  con esa demora.
--
--  UN aviso por mensaje entrante, nunca tres: respondió, primer mensaje
--  del día y subida de temperatura suelen ocurrir con el MISMO mensaje.
--  Se arma un solo texto con los hechos nuevos y el tipo (para los
--  ajustes) es el más importante que el agente tenga encendido.
--
--  Cada hecho es nuevo solo en su transición, comparando OLD con NEW:
--   · respondió: el primer entrante posterior a tu último envío;
--   · escribió hoy: el primer entrante del día (Bogotá);
--   · temperatura: el nivel con este mensaje supera al que había.
--  Un segundo mensaje sin hechos nuevos no avisa.

-- La misma normalización que `claveTel` (public/js/entrantes.js):
-- WhatsApp guarda México como 521… y Argentina como 549…; la ficha no.
create or replace function public.clave_tel(t text)
returns text language sql immutable set search_path = '' as $$
  select regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''), '\D', '', 'g'),
         '^521(\d{10})$', '52\1'), '^549(\d{10})$', '54\1');
$$;

-- Días entre una fecha y hoy, en Colombia, como `dias()` de leads.js.
create or replace function public.dias_co(v timestamptz)
returns int language sql stable set search_path = '' as $$
  select ((now() at time zone 'America/Bogota')::date - (v at time zone 'America/Bogota')::date);
$$;

-- `porDias()` de leads.js.
create or replace function public.temp_por_dias(d int, hoy_es text default 'caliente')
returns text language sql immutable set search_path = '' as $$
  select case when d is null then 'frio' when d <= 0 then hoy_es when d <= 2 then 'tibio' else 'frio' end;
$$;

-- `base()` de leads.js: la temperatura SIN contar lo que te escribió y
-- desde cuándo vale. ES UNA COPIA de la regla del panel: si cambian las
-- reglas de temperatura en leads.js, hay que cambiar esto también, o el
-- aviso dirá «subió» cuando el panel no lo muestra (ver brain).
-- Las fechas sin hora (registro_en, creado) valen medianoche UTC, igual
-- que `new Date('YYYY-MM-DD')` en el navegador.
create or replace function public.temp_base(c public.clientes, out t text, out en timestamptz)
language plpgsql stable set search_path = '' as $$
declare
  ult  timestamptz;   -- último contacto
  pri  timestamptz;   -- primer contacto
  si   timestamptz;   -- respuesta del último contacto que respondió
  reg  timestamptz := c.registro_en::timestamp at time zone 'UTC';
  lleg timestamptz := coalesce(c.creado::timestamp at time zone 'UTC',
                               (c.created_at at time zone 'America/Bogota')::date::timestamp at time zone 'UTC');
begin
  select max(x.en), min(x.en) into ult, pri from public.lead_contactos x where x.cliente_id = c.id;
  select x.respuesta_en into si from public.lead_contactos x
   where x.cliente_id = c.id and x.respuesta = 'si' order by x.en desc limit 1;

  if c.temp_manual is not null and (ult is null or c.temp_manual_en > ult) then
    t := c.temp_manual; en := c.temp_manual_en; return;
  end if;
  if c.promesa_en is not null then
    t := public.temp_por_dias(public.dias_co(c.promesa_en)); en := c.promesa_en; return;
  end if;
  if si is not null or reg is not null then
    en := greatest(si, reg);
    -- Fechas sin hora: los días se cuentan sobre la fecha, no sobre la
    -- medianoche UTC pasada a Bogotá (que caería el día anterior).
    t := public.temp_por_dias(case when reg is not null and (si is null or reg > si)
                                   then (now() at time zone 'America/Bogota')::date - c.registro_en
                                   else public.dias_co(en) end);
    return;
  end if;
  if ult is null then
    en := lleg;
    t := public.temp_por_dias(coalesce((now() at time zone 'America/Bogota')::date
                                       - (lleg at time zone 'UTC')::date, 99));
    return;
  end if;
  t := public.temp_por_dias(public.dias_co(pri), 'tibio'); en := ult;
end $$;

-- `calcTemp()` de leads.js con un entrante dado.
create or replace function public.temp_con_entrante(b_t text, b_en timestamptz, ent timestamptz)
returns text language sql stable set search_path = '' as $$
  select case
    when ent is null or b_en is null or ent <= b_en then b_t
    else (array['frio','tibio','caliente'])[least(
           least(array_position(array['frio','tibio','caliente'], b_t) + 1, 3),
           array_position(array['frio','tibio','caliente'], public.temp_por_dias(public.dias_co(ent))))]
  end;
$$;

create or replace function public.notificar_entrante()
returns trigger language plpgsql security definer set search_path = '' as $$
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
  if new.entrante_en is null or (old_ent is not null and new.entrante_en <= old_ent) then return null; end if;
  if not exists (select 1 from public.push_suscripciones where owner_id = new.owner_id) then return null; end if;

  -- Solo clientes PROPIOS: el chat es del WhatsApp de este dueño.
  select * into cli from public.clientes c
   where c.owner_id = new.owner_id and c.inactivo_desde is null
     and public.clave_tel(c.telefono) = public.clave_tel(new.telefono)
   limit 1;
  if cli.id is null then return null; end if;

  select coalesce(array_agg(a.tipo), '{}') into apag from public.notif_apagadas a where a.owner_id = new.owner_id;
  nombre := split_part(trim(cli.nombre), ' ', 1);
  -- Lo mismo que lista el panel «Hoy»: leads y pendientes de depósito.
  seguir := cli.membresia = 'Lead' or (cli.promesa_en is not null and cli.promesa_broker is not null);

  -- Respondió: primer entrante posterior al último envío de los 3 días.
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

  -- Temperatura: solo leads y pendientes, que son quienes la tienen.
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

  -- Escribió hoy: primer entrante del día.
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
  -- Corre dentro de la sincronización del worker: nunca la tumba.
  raise warning 'notificar_entrante falló: %', sqlerrm;
  return null;
end $$;
revoke all on function public.notificar_entrante() from public, anon, authenticated;

create index if not exists mensajes_enviados_owner
  on public.mensajes_programados (owner_id, enviado_en desc) where estado = 'enviado';

create trigger chats_recientes_notifica_ins after insert on public.chats_recientes
  for each row execute function public.notificar_entrante();
create trigger chats_recientes_notifica_upd after update of entrante_en on public.chats_recientes
  for each row when (new.entrante_en is distinct from old.entrante_en)
  execute function public.notificar_entrante();
