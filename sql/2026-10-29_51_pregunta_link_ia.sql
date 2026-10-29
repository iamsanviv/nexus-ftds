-- =====================================================================
--  Pregunta antes del link: una IA lee las respuestas dudosas
--  (29/10/2026, pedido de Sanviv)
--
--  La lista de palabras de `respuesta_link` falla en dos sentidos: un «no»
--  suelto dentro de un sí («sí quiero, no me lo pierdo») cancela el link, y
--  lo que no trae ninguna palabra clave («estaré pendiente del inicio») se
--  queda sin decidir. Ahora, cuando las palabras NO dicen un sí limpio, se le
--  pregunta a Cloudflare Workers AI (cuota gratis diaria; Cloudflare no
--  entrena con el contenido). Un sí limpio de las palabras no gasta cuota.
--
--  - Asíncrono con pg_net: el cron de cada minuto hace la petición, y en las
--    vueltas siguientes lee `net._http_response`. Mientras tanto se espera.
--  - Se pregunta de nuevo solo si la persona escribió algo más (`entrada`).
--  - Si la IA no está disponible (sin token en Vault, error, cuota agotada,
--    más de 3 min sin respuesta) o duda, decide la lista de palabras como
--    antes: la falla nunca deja peor que sin IA.
--  - `respuestas_ia` queda como registro para medir aciertos.
--
--  Requiere en Vault: `cloudflare_ai_token` y `cloudflare_account_id`.
-- =====================================================================

create table if not exists public.respuestas_ia (
  seguimiento_id uuid primary key references public.seguimientos(id) on delete cascade,
  entrada        text not null,
  request_id     bigint,
  veredicto      text check (veredicto in ('si', 'no', 'duda')),
  crudo          text,
  error          text,
  pedido_en      timestamptz not null default now(),
  respondido_en  timestamptz
);
-- Sin políticas: solo la toca `respuesta_ia` (security definer).
alter table public.respuestas_ia enable row level security;

-- 'si' | 'no' | 'duda' | 'pendiente' | NULL (IA no disponible o falló).
create or replace function public.respuesta_ia(p_sid uuid, p_owner uuid, p_tel text, p_desde timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  txt text; f public.respuestas_ia; resp record; v text; tok text; acct text; rid bigint;
  -- El modelo: buen español coloquial; ~11 neuronas por respuesta.
  MODELO constant text := '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  INSTR constant text :=
    'Un asesor invitó por WhatsApp a una persona a una clase en vivo por Zoom y le preguntó si quiere que le envíe el link. '
    'Abajo están los mensajes que esa persona escribió desde la invitación, con la hora. '
    'Responde SOLO una palabra: SI si quiere recibir el link o va a asistir; '
    'NO si dice que no puede, no quiere o no va a asistir; '
    'DUDA si no se puede saber (solo saludos, preguntas, audios, temas no relacionados). '
    'Si cambió de opinión, vale lo último que dijo.';
begin
  select string_agg(to_char((e->>'en')::timestamptz at time zone 'America/Bogota', 'HH24:MI') || ' ' || (e->>'t'),
                    E'\n' order by (e->>'en')::timestamptz)
    into txt
    from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
   where c.owner_id = p_owner
     and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
     and (e->>'en')::timestamptz > p_desde
     and coalesce(e->>'t', '') <> '';
  if txt is null then return null; end if;

  select * into f from public.respuestas_ia where seguimiento_id = p_sid;
  if found and f.entrada = txt then
    if f.veredicto is not null then return f.veredicto; end if;
    if f.error is not null then return null; end if;
    select status_code, content, timed_out, error_msg into resp
      from net._http_response where id = f.request_id;
    if not found then
      if f.pedido_en < now() - interval '3 minutes' then
        update public.respuestas_ia set error = 'sin respuesta en 3 min' where seguimiento_id = p_sid;
        return null;
      end if;
      return 'pendiente';
    end if;
    if resp.status_code is distinct from 200 then
      update public.respuestas_ia
         set error = coalesce(resp.error_msg, 'HTTP ' || resp.status_code) || ' ' || left(coalesce(resp.content, ''), 300),
             respondido_en = now()
       where seguimiento_id = p_sid;
      return null;
    end if;
    begin
      v := (resp.content::jsonb)->'result'->>'response';
    exception when others then v := null;
    end;
    v := translate(upper(coalesce(v, '')), 'ÍÉ', 'IE');
    v := case when v ~ '^\W*SI\M' then 'si' when v ~ '^\W*NO\M' then 'no' else 'duda' end;
    update public.respuestas_ia
       set veredicto = v, crudo = left(resp.content, 500), respondido_en = now()
     where seguimiento_id = p_sid;
    return v;
  end if;

  select decrypted_secret into tok from vault.decrypted_secrets where name = 'cloudflare_ai_token';
  select decrypted_secret into acct from vault.decrypted_secrets where name = 'cloudflare_account_id';
  if tok is null or acct is null then return null; end if;

  rid := net.http_post(
    url     := 'https://api.cloudflare.com/client/v4/accounts/' || trim(acct) || '/ai/run/' || MODELO,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || trim(tok)),
    body    := jsonb_build_object(
                 'messages', jsonb_build_array(
                   jsonb_build_object('role', 'system', 'content', INSTR),
                   jsonb_build_object('role', 'user', 'content', txt)),
                 'max_tokens', 5,
                 'temperature', 0),
    timeout_milliseconds := 20000);
  insert into public.respuestas_ia (seguimiento_id, entrada, request_id)
  values (p_sid, txt, rid)
  on conflict (seguimiento_id) do update
    set entrada = excluded.entrada, request_id = excluded.request_id, veredicto = null,
        crudo = null, error = null, pedido_en = now(), respondido_en = null;
  return 'pendiente';
exception when others then
  -- Un fallo de la IA no puede tumbar el cron de las preguntas.
  return null;
end;
$$;
revoke all on function public.respuesta_ia(uuid, uuid, text, timestamptz) from public, anon, authenticated;

create or replace function public.procesar_preguntas_link()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v text; k text; ia text;
begin
  -- a) Decidir, 2 min antes del recordatorio que reemplaza. «Respondió» es la misma
  --    regla que «🔕 Sin respuesta» (sin_respuesta_de): te escribió por
  --    WhatsApp después del primer mensaje enviado de ese seguimiento.
  for r in
    select p.id as pid, m.id as rid, m.enviar_en, s.id as sid, s.owner_id,
           e.primer,
           exists (select 1 from public.chats_recientes c
                    where c.owner_id = s.owner_id
                      and public.clave_tel(c.telefono) = public.clave_tel(p.telefono)
                      and c.entrante_en > e.primer) as respondio,
           exists (select 1 from public.chats_recientes c
                    where c.owner_id = s.owner_id and c.entrantes_txt is not null) as lee_textos
      from public.mensajes_programados p
      join public.seguimientos s on s.id = p.seguimiento_id
      -- El recordatorio que reemplaza: el de 1 h si la tanda lo tiene, si no el
      -- de 15 min (el panel pone la pregunta a la hora de ese mismo).
      join lateral (
        select x.id, x.enviar_en, x.estado from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.tipo in ('rec_60', 'rec_15')
         order by (x.tipo = 'rec_60') desc limit 1) m on m.estado = 'pendiente'
      cross join lateral (
        select min(x.enviado_en) as primer from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) e
     where p.tipo = 'pregunta_link' and p.estado = 'retenido'
       and s.estado = 'activo'
       and m.enviar_en <= now() + interval '2 minutes'
     for update of p skip locked
  loop
    if r.primer is null or r.respondio or not r.lee_textos then
      update public.mensajes_programados
         set estado = 'cancelado',
             error = case when r.respondio then 'omitido: respondió, va el recordatorio normal'
                          when r.primer is null then 'omitido: aún no se le había enviado nada'
                          else 'omitido: este WhatsApp todavía no publica las respuestas' end
       where id = r.pid;
      continue;
    end if;
    -- El `estado = 'pendiente'` en cada update: si el worker ya lo tomó, no se toca.
    update public.mensajes_programados set estado = 'cancelado', error = 'omitido: se cambió por la pregunta del link'
     where id = r.rid and estado = 'pendiente';
    if not found then
      update public.mensajes_programados set estado = 'cancelado', error = 'omitido: el recordatorio ya había salido'
       where id = r.pid;
      continue;
    end if;
    update public.mensajes_programados set estado = 'pendiente', enviar_en = r.enviar_en, error = null
     where id = r.pid;
    update public.mensajes_programados set estado = 'cancelado', error = 'omitido: no respondió, se pregunta por el link'
     where seguimiento_id = r.sid and tipo = 'rec_15' and estado = 'pendiente';
    update public.mensajes_programados set estado = 'retenido', error = null
     where seguimiento_id = r.sid and tipo in ('enlace', 'confirmacion') and estado = 'pendiente';
  end loop;

  -- b) y c) Lo retenido de quien recibió la pregunta. La respuesta se lee desde
  --    el primer mensaje enviado (`desde`), no desde la pregunta: ver cabecera.
  for r in
    select s.id as sid, s.owner_id, s.estado as sest, p.telefono, p.estado as pest,
           (select min(x.enviado_en) from public.mensajes_programados x
             where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) as desde,
           coalesce(a.inicio, s.inicio) as inicio
      from public.seguimientos s
      join public.mensajes_programados p on p.seguimiento_id = s.id and p.tipo = 'pregunta_link'
      left join public.actividades a on a.id = s.actividad_id
     where exists (select 1 from public.mensajes_programados m
                    where m.seguimiento_id = s.id and m.estado = 'retenido'
                      and m.tipo in ('enlace', 'confirmacion'))
  loop
    v := null;
    if r.sest = 'cancelado' then
      v := 'cancelar:omitido: seguimiento cancelado';
    elsif r.pest in ('error', 'cancelado') then
      -- La pregunta no llegó: no se le puede exigir respuesta. Vuelve a lo normal.
      v := 'liberar';
    elsif r.pest = 'enviado' then
      if now() > r.inicio + interval '10 minutes' then
        v := 'cancelar:omitido: no confirmó a tiempo';
      else
        -- Un sí limpio de la lista de palabras basta. Si no, decide la IA; si
        -- la IA no está o duda, decide la lista de palabras como antes.
        k := public.respuesta_link_de(r.owner_id, r.telefono, r.desde);
        ia := case when k = 'si' then null else public.respuesta_ia(r.sid, r.owner_id, r.telefono, r.desde) end;
        if k = 'si' or ia = 'si' then
          v := 'liberar';
        elsif ia = 'no' then
          v := 'cancelar:omitido: respondió que no (leído por IA)';
        elsif ia = 'pendiente' then
          null;   -- se espera a la IA
        elsif k = 'no' then
          v := 'cancelar:omitido: respondió que no';
        end if;
      end if;
    elsif now() > r.inicio + interval '10 minutes' then
      v := 'cancelar:omitido: no confirmó a tiempo';   -- pregunta aún pendiente: la hora ya pasó
    end if;

    if v = 'liberar' then
      update public.mensajes_programados
         set estado = 'pendiente', error = null,
             enviar_en = greatest(r.inicio, now())
       where seguimiento_id = r.sid and tipo = 'enlace' and estado = 'retenido';
      update public.mensajes_programados
         set estado = 'pendiente', error = null,
             enviar_en = greatest(r.inicio, now()) + interval '10 minutes'
       where seguimiento_id = r.sid and tipo = 'confirmacion' and estado = 'retenido';
    elsif v like 'cancelar:%' then
      update public.mensajes_programados set estado = 'cancelado', error = substr(v, 10)
       where seguimiento_id = r.sid and tipo in ('enlace', 'confirmacion') and estado = 'retenido';
    end if;
  end loop;

  -- Pregunta que nunca se activó (se silenció o ya salió su recordatorio, se
  -- canceló el seguimiento): no debe quedar colgada. Se mira el recordatorio y
  -- no la hora de la pregunta porque el cambio de hora de la actividad mueve solo pendientes.
  update public.mensajes_programados p set estado = 'cancelado', error = 'omitido: no hizo falta preguntar'
    from public.seguimientos s
   where p.tipo = 'pregunta_link' and p.estado = 'retenido' and s.id = p.seguimiento_id
     and (s.estado <> 'activo'
          or not exists (select 1 from (
                           select x.estado from public.mensajes_programados x
                            where x.seguimiento_id = s.id and x.tipo in ('rec_60', 'rec_15')
                            order by (x.tipo = 'rec_60') desc limit 1) t
                          where t.estado = 'pendiente'));
end;
$$;
revoke all on function public.procesar_preguntas_link() from public, anon, authenticated;
