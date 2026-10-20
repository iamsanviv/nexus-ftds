-- =====================================================================
--  Avisos del administrador: un mensaje para todo el equipo, ya o a una
--  fecha y hora, con plantillas guardadas.
--  Aplicado el 2026-10-20 con el MCP de Supabase.
--
--  Cada aviso sale por dos caminos:
--   · push (tipo 'aviso' en la cola `notificaciones`) a quien tenga las
--     notificaciones activadas; no se puede apagar desde «Notificaciones»
--     porque 'aviso' no está permitido en notif_apagadas;
--   · ventana dentro del panel para todas las cuentas aprobadas, hasta que
--     la cierren (aviso_vistos). Sin esto el aviso solo llegaba a quien
--     activó push: 3 de 20 cuentas al crearlo.
-- =====================================================================

-- ---------- 1. Tablas ----------
create table public.aviso_plantillas (
  id bigint generated always as identity primary key,
  titulo text not null check (length(trim(titulo)) between 1 and 80),
  cuerpo text not null check (length(trim(cuerpo)) between 1 and 300),
  creado_por uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  creada_en timestamptz not null default now()
);

create table public.avisos (
  id bigint generated always as identity primary key,
  titulo text not null check (length(trim(titulo)) between 1 and 80),
  cuerpo text not null check (length(trim(cuerpo)) between 1 and 300),
  enviar_en timestamptz not null default now(),
  enviado_en timestamptz,
  cancelado_en timestamptz,
  creado_por uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  creado_en timestamptz not null default now(),
  check (enviado_en is null or cancelado_en is null)
);
create index avisos_pendientes on public.avisos (enviar_en)
  where enviado_en is null and cancelado_en is null;

create table public.aviso_vistos (
  aviso_id bigint not null references public.avisos(id) on delete cascade,
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  visto_en timestamptz not null default now(),
  primary key (aviso_id, owner_id)
);

-- ---------- 2. Permisos ----------
alter table public.aviso_plantillas enable row level security;
alter table public.avisos enable row level security;
alter table public.aviso_vistos enable row level security;

create policy plantillas_admin on public.aviso_plantillas for all to authenticated
  using (public.es_admin()) with check (public.es_admin() and creado_por = auth.uid());

-- Los aprobados leen los avisos ya enviados (para la ventana del panel); el
-- admin, todos. Nadie borra: cancelar deja la historia.
create policy avisos_sel on public.avisos for select to authenticated
  using (public.es_admin() or (public.aprobado() and enviado_en is not null));
create policy avisos_ins on public.avisos for insert to authenticated
  with check (public.es_admin() and creado_por = auth.uid());
-- Solo se edita/cancela lo que todavía no salió.
create policy avisos_upd on public.avisos for update to authenticated
  using (public.es_admin() and enviado_en is null)
  with check (public.es_admin() and enviado_en is null);
-- `enviado_en` lo marca solo la base: desde la API no se puede escribir.
revoke insert, update, delete on public.avisos from anon, authenticated;
grant insert (titulo, cuerpo, enviar_en) on public.avisos to authenticated;
grant update (titulo, cuerpo, enviar_en, cancelado_en) on public.avisos to authenticated;

create policy vistos_propios_sel on public.aviso_vistos for select to authenticated
  using (owner_id = auth.uid());
create policy vistos_propios_ins on public.aviso_vistos for insert to authenticated
  with check (owner_id = auth.uid() and public.aprobado());
revoke update, delete on public.aviso_vistos from anon, authenticated;

-- ---------- 3. Tipo 'aviso' en la cola push ----------
alter table public.notificaciones
  drop constraint notificaciones_tipo_check,
  add constraint notificaciones_tipo_check check (tipo in
    ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','aviso','prueba'));

-- ---------- 4. Envío ----------
-- Encola el push de cada aviso vencido para todas las cuentas aprobadas y lo
-- marca enviado. `skip locked`: el cron y el trigger de inserción pueden
-- coincidir; la clave 'aviso:<id>' además impide el doble push.
create or replace function public.enviar_avisos()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select id, titulo, cuerpo from public.avisos
     where enviado_en is null and cancelado_en is null and enviar_en <= now()
     order by enviar_en
     for update skip locked
  loop
    perform public.notificar(p.id, 'aviso', 'aviso:' || r.id, r.titulo, r.cuerpo)
       from public.profiles p where p.aprobado;
    update public.avisos set enviado_en = now() where id = r.id;
  end loop;
end $$;
revoke all on function public.enviar_avisos() from public, anon, authenticated;

-- «Enviar ahora» no espera al cron del minuto siguiente.
create or replace function public.avisos_enviar_al_crear()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.enviar_avisos();
  return null;
exception when others then
  -- Un fallo del envío no debe impedir guardar el aviso: el cron lo reintenta.
  raise warning 'enviar_avisos falló: %', sqlerrm;
  return null;
end $$;
revoke all on function public.avisos_enviar_al_crear() from public, anon, authenticated;

create trigger avisos_enviar_al_crear after insert on public.avisos
  for each statement execute function public.avisos_enviar_al_crear();

-- El cron de cada minuto también envía los programados. El resto del cuerpo
-- es el vigente (sql/_34 y _37) sin cambios.
create or replace function public.generar_notificaciones()
returns void language plpgsql security definer set search_path = '' as $$
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
revoke all on function public.generar_notificaciones() from public, anon, authenticated;

-- ---------- 5. Destinatarios ----------
-- Para que el admin sepa a cuántos llegará el push antes de enviar.
create or replace function public.admin_alcance_avisos()
returns table (aprobados bigint, con_push bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  return query select count(*),
    count(*) filter (where exists (select 1 from public.push_suscripciones s where s.owner_id = p.id))
    from public.profiles p where p.aprobado;
end $$;
revoke all on function public.admin_alcance_avisos() from public, anon;
grant execute on function public.admin_alcance_avisos() to authenticated;
