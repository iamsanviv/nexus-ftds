-- =====================================================================
--  Lista de palabras: solo un sí corto y limpio se salta la IA
--  (22/11/2026, caso Edgar Barrios, Clase Avanzada 18/11 21:20)
--
--  Edgar respondió la invitación «Hola Santiago, qué pena voy viajando» y
--  «A partir del sábado cuenta conmigo». La lista de palabras vio «voy» y lo
--  tomó como sí; con ese sí el paso d) no consulta a la IA (`continue`), así
--  que le salieron el recordatorio, el link y la confirmación.
--
--  La regla elegida (30/10) era «si no es un sí limpio decide la IA», pero
--  bastaba con que apareciera una palabra de sí en cualquier parte del texto.
--  Ahora respuesta_link_de devuelve:
--    'no'          como antes;
--    'si'          solo si hay un mensaje de sí de 4 palabras o menos y ningún
--                  mensaje trae señales de excusa o condición (pena, pero,
--                  viajando, trabajando, luego, tarde, «voy a…», etc.);
--    'probable_si' si hay palabras de sí pero no es limpio: decide la IA, y
--                  solo si la IA no responde vale como sí (lo de antes).
--  respuesta_link (la lista) no cambia.
--  Base de procesar_preguntas_link: SQL 71 (md5 49f23442… en producción el 22/11).
-- =====================================================================

create or replace function public.respuesta_link_de(p_owner uuid, p_tel text, p_desde timestamptz)
returns text language sql stable security definer set search_path = '' as $$
  with r as (
    select public.respuesta_link(e->>'t') as v,
           translate(lower(coalesce(e->>'t', '')), 'áéíóúü', 'aeiouu') as x
      from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde),
  f as (
    select v,
           array_length(regexp_split_to_array(trim(regexp_replace(x, '[^a-z0-9ñ ]', ' ', 'g')), '\s+'), 1) as palabras,
           -- Excusas o condiciones: con ellas un «voy», «ok» o «sí» no es un sí claro.
           x ~ 'pena|pero|viaj|trabaj|siento|disculp|despues|luego|manana|tarde|intent|\mveo\M|creo|quiz|tal vez|aunque|ojala|\mvoy\s+[a-z]' as excusa
      from r)
  select case
    when bool_or(v = 'no') then 'no'
    when bool_or(v = 'si' and palabras <= 4) and not bool_or(excusa) then 'si'
    when bool_or(v = 'si') then 'probable_si'
  end from f;
$$;

create or replace function public.procesar_preguntas_link()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v text; k text; ia text;
begin
  -- d) Quien respondió: si dijo que no, se le cancela todo lo que falta; si
  --    queda en duda, solo los recordatorios y la pregunta, y el link se retiene.
  for r in
    select s.id as sid, s.owner_id, p.telefono, d.desde
      from public.seguimientos s
      join public.mensajes_programados p on p.seguimiento_id = s.id and p.tipo = 'pregunta_link'
      left join public.actividades a on a.id = s.actividad_id
      -- Sin invitación del sistema (el agente invitó a mano) cuenta desde que
      -- se programó el seguimiento.
      cross join lateral (
        select coalesce(min(x.enviado_en), s.created_at) as desde from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) d
     where s.estado = 'activo' and s.respuesta_manual is null
       and now() <= coalesce(a.inicio, s.inicio) + interval '15 minutes'
       and exists (select 1 from public.mensajes_programados m
                    where m.seguimiento_id = s.id and m.estado = 'pendiente'
                      and m.tipo in ('rec_60', 'rec_15', 'enlace', 'confirmacion'))
       -- Quien espera la respuesta a la pregunta lo lleva el paso b).
       and not exists (select 1 from public.mensajes_programados m
                        where m.seguimiento_id = s.id and m.estado = 'retenido'
                          and m.tipo in ('enlace', 'confirmacion'))
       and exists (select 1 from public.chats_recientes c
                    where c.owner_id = s.owner_id
                      and public.clave_tel(c.telefono) = public.clave_tel(p.telefono)
                      and c.entrante_en > d.desde)
  loop
    k := public.respuesta_link_de(r.owner_id, r.telefono, r.desde);
    if k = 'si' then
      continue;
    end if;
    ia := public.respuesta_ia(r.sid, r.owner_id, r.telefono, r.desde);
    if ia = 'no' or (ia is null and k = 'no') then
      update public.mensajes_programados
         set estado = 'cancelado',
             error = case when ia = 'no' then 'omitido: dijo que no puede (leído por IA)'
                          else 'omitido: dijo que no puede' end
       where seguimiento_id = r.sid
         and ((estado = 'pendiente' and tipo in ('rec_60', 'rec_15', 'enlace', 'confirmacion'))
              or (estado = 'retenido' and tipo = 'pregunta_link'));
    elsif ia = 'duda' then
      -- En duda (Sanviv, 30/10): ni recordatorios ni pregunta, y el link
      -- queda retenido; el paso b) lo suelta si aclara que sí.
      -- La pregunta lleva el motivo aunque ya estuviera cancelada («respondió,
      -- va el recordatorio normal»): con él el paso b) sabe que el link espera
      -- un sí, y no lo suelta como a quien nunca le llegó la pregunta.
      update public.mensajes_programados set estado = 'cancelado', error = 'omitido: en duda, se espera que aclare'
       where seguimiento_id = r.sid
         and ((estado = 'pendiente' and tipo in ('rec_60', 'rec_15'))
              or (estado in ('retenido', 'cancelado') and tipo = 'pregunta_link'));
      update public.mensajes_programados set estado = 'retenido', error = null
       where seguimiento_id = r.sid and tipo in ('enlace', 'confirmacion') and estado = 'pendiente';
    end if;
  end loop;

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
      -- Sin invitación del sistema (el agente invitó a mano) no hay primer
      -- mensaje enviado: cuenta desde que se programó el seguimiento.
      cross join lateral (
        select coalesce(min(x.enviado_en), s.created_at) as primer from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) e
      -- Desde cuándo pudo responder: la invitación enviada (NULL si aún no
      -- sale); sin invitación del sistema, desde que se programó.
      cross join lateral (
        select case when exists (select 1 from public.mensajes_programados x
                                  where x.seguimiento_id = s.id and x.tipo = 'invitacion')
                    then (select min(x.enviado_en) from public.mensajes_programados x
                           where x.seguimiento_id = s.id and x.tipo = 'invitacion' and x.estado = 'enviado')
                    else s.created_at end as invitado) iv
      -- El recordatorio que reemplaza: el de 1 h solo si la invitación salió
      -- al menos 15 min antes de él; si no, el de 15 min (ver cabecera).
      join lateral (
        select x.id, x.enviar_en, x.estado from public.mensajes_programados x
         where x.seguimiento_id = s.id
           and (x.tipo = 'rec_15'
                or (x.tipo = 'rec_60' and x.enviar_en >= iv.invitado + interval '15 minutes'))
         order by (x.tipo = 'rec_60') desc limit 1) m on m.estado = 'pendiente'
     where p.tipo = 'pregunta_link' and p.estado = 'retenido'
       and s.estado = 'activo' and s.respuesta_manual is null
       and m.enviar_en <= now() + interval '2 minutes'
     for update of p skip locked
  loop
    if r.respondio or not r.lee_textos then
      update public.mensajes_programados
         set estado = 'cancelado',
             error = case when r.respondio then 'omitido: respondió, va el recordatorio normal'
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
    select s.id as sid, s.owner_id, s.estado as sest, p.telefono, p.estado as pest, p.error as perr,
           p.enviado_en as penv,
           (select coalesce(min(x.enviado_en), s.created_at) from public.mensajes_programados x
             where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) as desde,
           coalesce(a.inicio, s.inicio) as inicio
      from public.seguimientos s
      join public.mensajes_programados p on p.seguimiento_id = s.id and p.tipo = 'pregunta_link'
      left join public.actividades a on a.id = s.actividad_id
     where s.respuesta_manual is null
       and exists (select 1 from public.mensajes_programados m
                    where m.seguimiento_id = s.id and m.estado = 'retenido'
                      and m.tipo in ('enlace', 'confirmacion'))
  loop
    v := null;
    if r.sest = 'cancelado' then
      v := 'cancelar:omitido: seguimiento cancelado';
    elsif r.pest in ('error', 'cancelado') and r.perr is distinct from 'omitido: en duda, se espera que aclare' then
      -- La pregunta no llegó: no se le puede exigir respuesta. Vuelve a lo normal.
      v := 'liberar';
    elsif r.pest = 'enviado' or r.perr = 'omitido: en duda, se espera que aclare' then
      -- Plazo: inicio + 15 min, o 15 min desde que salió la pregunta si salió
      -- tarde (cola atrasada). `greatest` ignora el NULL de quien no la recibió.
      if now() > greatest(r.inicio + interval '15 minutes', r.penv + interval '15 minutes') then
        v := 'cancelar:omitido: no confirmó a tiempo';
      else
        -- Un sí limpio de la lista de palabras basta. Si no, decide la IA; con
        -- la IA en duda se espera, y sin IA decide la lista de palabras
        -- (también un 'probable_si', SQL 73).
        k := public.respuesta_link_de(r.owner_id, r.telefono, r.desde);
        ia := case when k = 'si' then null else public.respuesta_ia(r.sid, r.owner_id, r.telefono, r.desde) end;
        if k = 'si' or ia = 'si' then
          v := 'liberar';
        elsif ia = 'no' then
          v := 'cancelar:omitido: respondió que no (leído por IA)';
        elsif ia in ('pendiente', 'duda') then
          null;   -- se espera a la IA, o a que aclare: lo retenido no sale con una duda
        elsif k = 'no' then
          v := 'cancelar:omitido: respondió que no';
        elsif k = 'probable_si' then
          v := 'liberar';   -- sin IA, un sí con texto de más vale como antes
        end if;
      end if;
    end if;
    -- Pregunta aún sin salir: se espera aunque haya pasado el inicio (Sanviv,
    -- 10/11). Su plazo empieza cuando sale.

    if v = 'liberar' then
      -- Confirmó (o la pregunta no llegó): vuelven los recordatorios que se
      -- cancelaron por la pregunta o por la duda, si su hora no pasó. Caso
      -- Heidy (1/11): dijo «Si» a las 7:09 y no le llegó el de 15 min.
      update public.mensajes_programados set estado = 'pendiente', error = null
       where seguimiento_id = r.sid and tipo = 'rec_15' and estado = 'cancelado'
         and enviar_en > now()
         and error in ('omitido: no respondió, se pregunta por el link',
                       'omitido: en duda, se espera que aclare');
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
  -- canceló el seguimiento): no debe quedar colgada. El recordatorio se elige
  -- con la misma regla del paso a). Se mira el recordatorio y no la hora de la
  -- pregunta porque el cambio de hora de la actividad mueve solo pendientes.
  update public.mensajes_programados p set estado = 'cancelado', error = 'omitido: no hizo falta preguntar'
    from public.seguimientos s
   where p.tipo = 'pregunta_link' and p.estado = 'retenido' and s.id = p.seguimiento_id
     and (s.estado <> 'activo'
          or not exists (
               select 1 from (
                 select x.estado from public.mensajes_programados x
                  where x.seguimiento_id = s.id
                    and (x.tipo = 'rec_15'
                         or (x.tipo = 'rec_60' and x.enviar_en >= (
                               case when exists (select 1 from public.mensajes_programados y
                                                  where y.seguimiento_id = s.id and y.tipo = 'invitacion')
                                    then (select min(y.enviado_en) from public.mensajes_programados y
                                           where y.seguimiento_id = s.id and y.tipo = 'invitacion' and y.estado = 'enviado')
                                    else s.created_at end) + interval '15 minutes'))
                  order by (x.tipo = 'rec_60') desc limit 1) t
                where t.estado = 'pendiente'));
end;
$$;
revoke all on function public.procesar_preguntas_link() from public, anon, authenticated;

-- Panel «✎ Mensajes»: un 'probable_si' lo muestra la IA; sin IA, sí por palabras.
create or replace function public.respuestas_de(p_ids uuid[])
returns table(seguimiento_id uuid, respuesta text, fuente text, pregunta boolean, mensajes jsonb, ultima timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare r record; k text; iav text; iae text; hay_ia boolean; msgs jsonb; escribio timestamptz;
begin
  for r in
    select s.id, s.owner_id, s.respuesta_manual, c.telefono,
           exists (select 1 from public.mensajes_programados m
                    where m.seguimiento_id = s.id and m.tipo = 'pregunta_link') as pregunta,
           exists (select 1 from public.mensajes_programados m
                    where m.seguimiento_id = s.id and m.tipo = 'invitacion' and m.estado = 'pendiente') as en_cola,
           -- Igual que la pregunta del link: sin mensaje del sistema, desde que se programó.
           (select coalesce(min(x.enviado_en), s.created_at) from public.mensajes_programados x
             where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) as desde
      from public.seguimientos s
      join public.clientes c on c.id = s.cliente_id
     where s.id = any(p_ids) and s.owner_id = auth.uid()
  loop
    select coalesce(jsonb_agg(e order by (e->>'en')::timestamptz) filter (where e is not null), '[]'),
           max(ce.entrante_en)
      into msgs, escribio
      from public.chats_recientes ce
      left join lateral jsonb_array_elements(coalesce(ce.entrantes_txt, '[]')) e
        on (e->>'en')::timestamptz > r.desde
     where ce.owner_id = r.owner_id
       and public.clave_tel(ce.telefono) = public.clave_tel(r.telefono)
       and ce.entrante_en > r.desde;

    seguimiento_id := r.id; pregunta := r.pregunta; mensajes := coalesce(msgs, '[]'); ultima := escribio;
    if r.respuesta_manual is not null then
      respuesta := r.respuesta_manual; fuente := 'manual';
    elsif r.en_cola then
      respuesta := 'en_cola'; fuente := null;
    elsif escribio is null then
      respuesta := 'sin_respuesta'; fuente := null;
    elsif not exists (select 1 from jsonb_array_elements(mensajes) e where coalesce(e->>'t', '') <> '') then
      respuesta := 'sin_texto'; fuente := null;   -- sticker, imagen, o su VM aún no publica textos
    else
      k := public.respuesta_link_de(r.owner_id, r.telefono, r.desde);
      select f.veredicto, f.error into iav, iae from public.respuestas_ia f where f.seguimiento_id = r.id;
      hay_ia := found;
      if k = 'si' then respuesta := 'si'; fuente := 'palabras';
      elsif iav in ('si', 'no', 'duda') then respuesta := iav; fuente := 'ia';
      elsif hay_ia and iav is null and iae is null then respuesta := 'leyendo'; fuente := 'ia';
      elsif k = 'no' then respuesta := 'no'; fuente := 'palabras';
      elsif k = 'probable_si' then respuesta := 'si'; fuente := 'palabras';
      else respuesta := 'duda'; fuente := 'palabras';
      end if;
    end if;
    return next;
  end loop;
end $$;
