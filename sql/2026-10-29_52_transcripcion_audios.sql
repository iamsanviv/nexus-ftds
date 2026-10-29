-- =====================================================================
--  Pregunta antes del link: los audios se transcriben
--  (29/10/2026, pedido de Sanviv)
--
--  Quien contesta la pregunta con una nota de voz se quedaba sin link: el
--  bridge guarda el audio sin texto. Ahora `chats_sync.py` (VM1 y VM2) pide
--  a esta función a quién le tiene que transcribir los audios — solo a quien
--  tiene la pregunta enviada y el link retenido, para no gastar la cuota
--  gratis de Workers AI en audios que no deciden nada —, los descarga con el
--  bridge, los transcribe con Whisper y los publica en `entrantes_txt` como
--  «🎤 texto». Desde ahí se leen igual que un mensaje escrito.
--
--  Devuelve el token de Cloudflare: solo `service_role` puede llamarla (es
--  la misma clave con la que la VM ya escribe en la base).
-- =====================================================================

create or replace function public.transcripcion_pendiente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cuenta', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_account_id'),
    'token',  (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_ai_token'),
    'pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('owner_id', s.owner_id,
                                          'telefono', public.clave_tel(p.telefono),
                                          'desde', d.desde))
        from public.seguimientos s
        join public.mensajes_programados p
          on p.seguimiento_id = s.id and p.tipo = 'pregunta_link' and p.estado = 'enviado'
        left join public.actividades a on a.id = s.actividad_id
        cross join lateral (
          select min(x.enviado_en) as desde from public.mensajes_programados x
           where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) d
       where s.estado = 'activo'
         and now() <= coalesce(a.inicio, s.inicio) + interval '10 minutes'
         and exists (select 1 from public.mensajes_programados m
                      where m.seguimiento_id = s.id and m.estado = 'retenido'
                        and m.tipo in ('enlace', 'confirmacion'))), '[]'::jsonb));
$$;
revoke all on function public.transcripcion_pendiente() from public, anon, authenticated;
grant execute on function public.transcripcion_pendiente() to service_role;

-- La IA de texto: los audios ya no son «dudosos» por ser audios.
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
    'DUDA si no se puede saber (solo saludos, preguntas, temas no relacionados). '
    'Los audios llegan transcritos, marcados con 🎤. '
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
