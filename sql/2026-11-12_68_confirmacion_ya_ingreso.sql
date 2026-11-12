-- =====================================================================
--  Sin confirmación para quien ya entró (12/11/2026, pedido de Sanviv)
--
--  10 min después del link sale la confirmación («¿pudiste entrar a la
--  sala?»). Si después del link la persona ya escribió que entró, o mandó una
--  captura de que está en el Zoom, esa pregunta sobra. Ahora se cancela.
--
--  Vale para todos los seguimientos, tengan o no la pregunta antes del link.
--
--  Quién decide:
--    1. La IA (Workers AI, el mismo modelo que la pregunta del link) lee la
--       conversación desde el link. SI solo si dice claramente que YA entró o
--       mandó una foto sin decir que tenga un problema. «Ya voy a entrar»,
--       «ya entro», «ya ingreso», «no me deja» o «gracias» son NO: la
--       confirmación sale como siempre.
--    2. Una lista de frases de pasado («ya entré», «ya estoy dentro», «ya me
--       conecté») cancela aunque la IA diga NO, si no dice que tiene un
--       problema. Sin IA (falla, 3 min sin respuesta), también una foto.
--  Prompt probado el 12/11 con 17 frases contra la IA real: acierta todas
--  menos «Okey ya entre» (por eso la lista vale sola) y «ya estoy», que lee
--  como SI.
--  Frases revisadas con los chats reales del 11/11: «Okey ya entre»,
--  «Listo ya dentro», «Correcto hermano ya ingrese» la cancelan; «Ya
--  ingreso», «Listo entro», «Ya voy a entrar», «No me deja» no.
--
--  Las fotos: chats_sync marca cada imagen entrante con `img: 1` en
--  `entrantes_txt` (va dentro del jsonb, no necesita columna). Hasta instalar
--  ese chats_sync en VM1 y VM2 solo cuenta lo escrito, y los audios.
--
--  Los audios: `transcripcion_pendiente` ahora también lista a quien tiene la
--  confirmación pendiente y escribió después del link, para que un «ya estoy
--  adentro» de voz llegue transcrito.
--
--  Solo se toca una confirmación `pendiente`: si el worker ya la tomó, sale.
-- =====================================================================

-- Tabla aparte de `respuestas_ia`: esa guarda la respuesta a la pregunta del
-- link del mismo seguimiento, y compartirla borraría una con la otra.
create table if not exists public.ingresos_ia (
  seguimiento_id uuid primary key references public.seguimientos(id) on delete cascade,
  entrada        text not null,
  request_id     bigint,
  veredicto      text check (veredicto in ('si', 'no')),
  crudo          text,
  error          text,
  pedido_en      timestamptz not null default now(),
  respondido_en  timestamptz
);
-- Sin políticas: solo la toca `ingreso_ia` (security definer).
alter table public.ingresos_ia enable row level security;
revoke all on table public.ingresos_ia from anon, authenticated;

-- 'si' | 'no' | 'pendiente' | NULL (nada que leer, IA no disponible o falló).
-- `p_desde` = cuándo salió el link.
create or replace function public.ingreso_ia(p_sid uuid, p_owner uuid, p_tel text, p_desde timestamptz)
returns text language plpgsql security definer set search_path = '' as $$
declare
  txt text; f public.ingresos_ia; resp record; v text; tok text; acct text; rid bigint;
  MODELO constant text := '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
  INSTR constant text :=
    'Un asesor le envió por WhatsApp a una persona el link de una clase en vivo por Zoom. '
    'Abajo está la conversación desde ese link, con la hora: «Asesor:» son los mensajes del asesor '
    'y «Persona:» los de la persona; «[foto]» es una imagen que mandó la persona. '
    'Decide SOLO por lo que dijo o mandó la persona. Responde SOLO una palabra: '
    'SI si dice claramente, en pasado, que YA entró o ya está dentro de la clase (por ejemplo «ya entré», '
    '«ya entre», «ya ingresé», «ya estoy dentro», «ya me conecté»), o si mandó una foto que puede ser la '
    'captura de que ya está en el Zoom y no dice que tenga un problema; NO en cualquier otro caso. '
    'Ojo: el presente significa que todavía va a entrar y es NO: «ya entro», «ya ingreso», «ya me conecto», '
    '«ya voy», «ya voy a entrar», «me voy a conectar». También es NO si no puede entrar o no lo deja, '
    'si tiene un problema, si pregunta algo, si solo dice «listo» o «ok», o si solo agradece o saluda. '
    'Los audios llegan transcritos, marcados con 🎤. Si cambió lo que dijo, vale lo último.';
begin
  -- Sin nada de la persona después del link no hay qué decidir.
  if not exists (
    select 1 from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde
       and (coalesce(e->>'t', '') <> '' or e->>'img' = '1')) then
    return null;
  end if;

  -- Igual que `respuesta_ia`, con la foto como «[foto]» (y su texto, si trae).
  -- Lo del sistema desde 1 h antes del link: el link y el recordatorio previo
  -- le dicen a la IA de qué clase se habla.
  with conv as (
    select (e->>'en')::timestamptz as en,
           'Persona: ' || trim(case when e->>'img' = '1' then '[foto] ' else '' end || coalesce(e->>'t', '')) as l
      from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde
       and (coalesce(e->>'t', '') <> '' or e->>'img' = '1')
    union all
    select m.enviado_en, 'Asesor: ' || left(m.texto, 200)
      from public.mensajes_programados m
     where m.seguimiento_id = p_sid and m.estado = 'enviado'
       and m.enviado_en >= p_desde - interval '1 hour' and coalesce(m.texto, '') <> ''
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

  select * into f from public.ingresos_ia where seguimiento_id = p_sid;
  if found and f.entrada = txt then
    if f.veredicto is not null then return f.veredicto; end if;
    if f.error is not null then return null; end if;
    select status_code, content, timed_out, error_msg into resp
      from net._http_response where id = f.request_id;
    if not found then
      if f.pedido_en < now() - interval '3 minutes' then
        update public.ingresos_ia set error = 'sin respuesta en 3 min' where seguimiento_id = p_sid;
        return null;
      end if;
      return 'pendiente';
    end if;
    if resp.status_code is distinct from 200 then
      update public.ingresos_ia
         set error = coalesce(resp.error_msg, 'HTTP ' || resp.status_code) || ' ' || left(coalesce(resp.content, ''), 300),
             respondido_en = now()
       where seguimiento_id = p_sid;
      return null;
    end if;
    begin
      v := coalesce((resp.content::jsonb)->'result'->>'response',
                    (resp.content::jsonb)->'result'->'choices'->0->'message'->>'content');
    exception when others then v := null;
    end;
    v := translate(upper(coalesce(v, '')), 'ÍÉ', 'IE');
    -- Cualquier cosa que no sea un SI claro deja la confirmación: preguntar de
    -- más molesta menos que dejar sin ayuda a quien no pudo entrar.
    v := case when v ~ '^\W*SI\M' then 'si' else 'no' end;
    update public.ingresos_ia
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
  insert into public.ingresos_ia (seguimiento_id, entrada, request_id)
  values (p_sid, txt, rid)
  on conflict (seguimiento_id) do update
    set entrada = excluded.entrada, request_id = excluded.request_id, veredicto = null,
        crudo = null, error = null, pedido_en = now(), respondido_en = null;
  return 'pendiente';
exception when others then
  -- Un fallo de la IA no puede tumbar el cron.
  return null;
end;
$$;
revoke all on function public.ingreso_ia(uuid, uuid, text, timestamptz) from public, anon, authenticated;

create or replace function public.procesar_ya_ingreso()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; ia text; motivo text;
begin
  for r in
    select s.id as sid, s.owner_id, k.id as kid, k.telefono, e.enviado_en as desde, t.textos, t.foto
      from public.mensajes_programados k
      join public.seguimientos s on s.id = k.seguimiento_id
      join lateral (
        select max(x.enviado_en) as enviado_en from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.tipo = 'enlace' and x.estado = 'enviado') e on e.enviado_en is not null
      -- Lo que escribió después del link, sin tildes y en minúscula, para la
      -- lista de respaldo; y si mandó alguna foto.
      cross join lateral (
        select string_agg(translate(lower(coalesce(m->>'t', '')), 'áéíóú', 'aeiou'), ' | ') as textos,
               bool_or(m->>'img' = '1') as foto
          from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) m
         where c.owner_id = s.owner_id
           and public.clave_tel(c.telefono) = public.clave_tel(k.telefono)
           and (m->>'en')::timestamptz > e.enviado_en) t
     where k.tipo = 'confirmacion' and k.estado = 'pendiente'
       and s.estado = 'activo'
       and (t.foto or coalesce(t.textos, '') ~ '[a-z]')
  loop
    ia := public.ingreso_ia(r.sid, r.owner_id, r.telefono, r.desde);
    motivo := null;
    if ia = 'si' then
      motivo := 'omitido: ya ingresó (leído por IA)';
    elsif coalesce(r.textos, '') !~ ('no (me )?(deja|puedo|pude|sirve|abre|carga|funciona|entra|aparece)'
                                     '|no (he )?podido|no logro|error|problema|ayuda') then
      -- Las frases de pasado valen aunque la IA diga NO: con el prompt final
      -- leyó «Okey ya entre» (sin tilde) como presente (probado el 12/11).
      if coalesce(r.textos, '') ~ ('\mya (entre|ingrese|me (uni|conecte)|estoy (dentro|adentro|en (la )?(clase|sala|reunion|zoom))|dentro|adentro)\M'
                                   '|\mestoy (dentro|adentro)\M') then
        motivo := 'omitido: dijo que ya ingresó';
      elsif ia is null and r.foto then
        motivo := 'omitido: mandó una captura después del link';
      end if;
    end if;
    -- 'no' y 'pendiente': la confirmación queda; en el siguiente minuto se
    -- vuelve a mirar si escribió algo nuevo o si la IA ya contestó.
    if motivo is not null then
      update public.mensajes_programados set estado = 'cancelado', error = motivo
       where id = r.kid and estado = 'pendiente';
    end if;
  end loop;
end;
$$;
revoke all on function public.procesar_ya_ingreso() from public, anon, authenticated;

-- Base: la del SQL 65, más la segunda rama (confirmación pendiente).
create or replace function public.transcripcion_pendiente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cuenta', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_account_id'),
    'token',  (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_ai_token'),
    'pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('owner_id', q.owner_id, 'telefono', q.tel, 'desde', q.desde))
        from (
          select u.owner_id, u.tel, min(u.desde) as desde
            from (
              -- Pregunta antes del link (SQL 65, sin cambios).
              select s.owner_id, public.clave_tel(c.telefono) as tel, d.desde
                from public.seguimientos s
                join public.clientes c on c.id = s.cliente_id
                left join public.actividades a on a.id = s.actividad_id
                cross join lateral (
                  select coalesce(min(x.enviado_en), s.created_at) as desde from public.mensajes_programados x
                   where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) d
               where s.estado = 'activo' and s.respuesta_manual is null
                 and now() <= greatest(coalesce(a.inicio, s.inicio) + interval '15 minutes',
                                       (select max(x.enviado_en) from public.mensajes_programados x
                                         where x.seguimiento_id = s.id and x.tipo = 'pregunta_link'
                                           and x.estado = 'enviado') + interval '15 minutes')
                 and exists (select 1 from public.mensajes_programados p
                              where p.seguimiento_id = s.id and p.tipo = 'pregunta_link')
                 and exists (select 1 from public.mensajes_programados m
                              where m.seguimiento_id = s.id and m.estado in ('pendiente', 'retenido')
                                and m.tipo in ('rec_60', 'rec_15', 'enlace', 'confirmacion'))
                 and exists (select 1 from public.chats_recientes ch
                              where ch.owner_id = s.owner_id
                                and public.clave_tel(ch.telefono) = public.clave_tel(c.telefono)
                                and ch.entrante_en > d.desde)
              union all
              -- Confirmación pendiente: un audio «ya estoy adentro» después del link.
              select s.owner_id, public.clave_tel(c.telefono), e.enviado_en
                from public.seguimientos s
                join public.clientes c on c.id = s.cliente_id
                join lateral (
                  select max(x.enviado_en) as enviado_en from public.mensajes_programados x
                   where x.seguimiento_id = s.id and x.tipo = 'enlace' and x.estado = 'enviado') e
                  on e.enviado_en is not null
               where s.estado = 'activo'
                 and exists (select 1 from public.mensajes_programados k
                              where k.seguimiento_id = s.id and k.tipo = 'confirmacion' and k.estado = 'pendiente')
                 and exists (select 1 from public.chats_recientes ch
                              where ch.owner_id = s.owner_id
                                and public.clave_tel(ch.telefono) = public.clave_tel(c.telefono)
                                and ch.entrante_en > e.enviado_en)) u
           group by u.owner_id, u.tel) q), '[]'::jsonb));
$$;
revoke all on function public.transcripcion_pendiente() from public, anon, authenticated;
grant execute on function public.transcripcion_pendiente() to service_role;

select cron.schedule('ya_ingreso', '* * * * *', 'select public.procesar_ya_ingreso()');
