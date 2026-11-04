-- =====================================================================
--  Pregunta antes del link: la IA lee la conversación completa
--  (03/11/2026, pedido de Sanviv)
--
--  La IA solo veía lo que escribió la persona. Asael escribió «Ok mándame el
--  link» y un minuto después «No aun no»; la IA tomó lo último como un no,
--  pero no podía saber si respondía otra pregunta del asesor.
--
--  Ahora la IA recibe la conversación desde la invitación, con cada línea
--  marcada «Asesor:» o «Persona:»:
--    - lo que el sistema le envió en ese seguimiento (`mensajes_programados`);
--    - lo que el asesor le escribió a mano (`chats_recientes.salientes_txt`,
--      nueva; la publica chats_sync en VM1 y VM2).
--  Decide igual que antes por lo que dijo la persona; si la persona no ha
--  escrito nada, no se llama a la IA.
--
--  ORDEN: esta migración ANTES del chats_sync nuevo (sin la columna,
--  Supabase rechaza la subida). Sin el chats_sync nuevo la IA ya ve los
--  mensajes del sistema; los escritos a mano llegan al instalarlo.
-- =====================================================================

alter table public.chats_recientes add column if not exists salientes_txt jsonb;

create or replace function public.respuesta_ia(p_sid uuid, p_owner uuid, p_tel text, p_desde timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  txt text; f public.respuestas_ia; resp record; v text; tok text; acct text; rid bigint;
  -- El modelo: buen español coloquial; ~5,5 neuronas por respuesta (medido).
  MODELO constant text := '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  INSTR constant text :=
    'Un asesor invitó por WhatsApp a una persona a una clase en vivo por Zoom y le preguntó si quiere que le envíe el link. '
    'Abajo está la conversación desde la invitación, con la hora: «Asesor:» son los mensajes del asesor '
    'y «Persona:» los de la persona. Decide SOLO por lo que dijo la persona; los del asesor sirven para '
    'entender a qué responde cada mensaje (un «no» puede contestar otra pregunta del asesor y no la invitación). '
    'Responde SOLO una palabra: SI si quiere recibir el link o va a asistir; '
    'NO si dice que no puede, no quiere o no va a asistir; '
    'DUDA si no se puede saber (solo saludos, preguntas, temas no relacionados). '
    'Los audios llegan transcritos, marcados con 🎤. '
    'Si cambió de opinión, vale lo último que dijo sobre asistir o recibir el link.';
begin
  -- Sin nada escrito por la persona no hay qué decidir: no se gasta la IA.
  if not exists (
    select 1 from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde
       and coalesce(e->>'t', '') <> '') then
    return null;
  end if;

  -- La conversación: lo que escribió la persona, lo que el sistema le envió en
  -- este seguimiento (invitación, recordatorios, pregunta) y lo que le escribió
  -- el asesor a mano desde su teléfono (`salientes_txt`, desde 2 min antes de la
  -- invitación). Si el bridge también guardó lo que mandó el sistema, ese
  -- duplicado se quita por texto.
  with conv as (
    select (e->>'en')::timestamptz as en, 'Persona: ' || (e->>'t') as l
      from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde
       and coalesce(e->>'t', '') <> ''
    union all
    select m.enviado_en, 'Asesor: ' || left(m.texto, 200)
      from public.mensajes_programados m
     where m.seguimiento_id = p_sid and m.estado = 'enviado'
       and m.enviado_en is not null and coalesce(m.texto, '') <> ''
    union all
    select (e->>'en')::timestamptz, 'Asesor: ' || (e->>'t')
      from public.chats_recientes c, jsonb_array_elements(coalesce(c.salientes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz >= p_desde - interval '2 minutes'
       and coalesce(e->>'t', '') <> ''
       and not exists (select 1 from public.mensajes_programados m
                        where m.seguimiento_id = p_sid and m.estado = 'enviado'
                          and left(trim(m.texto), 200) = left(trim(e->>'t'), 200)))
  select string_agg(to_char(en at time zone 'America/Bogota', 'HH24:MI') || ' ' || l, E'\n' order by en)
    into txt from conv;

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
      -- Hoy llega en los dos campos (probado el 29/10); si Cloudflare deja
      -- solo el formato OpenAI, se sigue leyendo.
      v := coalesce((resp.content::jsonb)->'result'->>'response',
                    (resp.content::jsonb)->'result'->'choices'->0->'message'->>'content');
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
