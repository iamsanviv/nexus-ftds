-- =====================================================================
--  Qué respondió cada invitado, y corregirlo a mano
--  Aplicado el 2026-10-30 con el MCP de Supabase.
--
--  Pedido de Sanviv (30/10/2026): ver en «✎ Mensajes» de cada seguimiento si
--  la persona dijo que sí, que no, si la IA dudó o si no ha respondido, y
--  poder revertir lo que dedujo el sistema.
--
--  1. `seguimientos.respuesta_manual` ('si' | 'no'): la decisión del agente.
--     No se deriva de nada: es entrada nueva. Gana sobre las palabras y la IA,
--     y `procesar_preguntas_link` ya no toca ese seguimiento (si no, el paso
--     d volvería a cancelar a quien el agente marcó «sí va»).
--  2. `respuestas_de(ids)`: el estado de cada seguimiento propio, con lo que
--     escribió. Solo del dueño: `chats_recientes` es privado de cada agente
--     (su política es owner_id = auth.uid()) y un director no lee los chats
--     de sus agentes.
--  3. `fijar_respuesta(id, 'si'|'no')`: solo el dueño, porque cambia lo que
--     sale de SU WhatsApp (visibilidad no es propiedad de envío).
--     - «No va»: cancela recordatorios, pregunta, link y confirmación.
--     - «Sí va»: cancela la pregunta y devuelve lo que el sistema canceló por
--       la respuesta (recordatorios cuya hora no pasó; link a la hora de
--       inicio o ya, confirmación 10 min después).
--
--  La clasificación repite la de `procesar_preguntas_link`: un sí limpio de
--  las palabras basta; si no, vale la IA; si la IA no está, las palabras.
-- =====================================================================

alter table public.seguimientos
  add column if not exists respuesta_manual text check (respuesta_manual in ('si', 'no')),
  add column if not exists respuesta_manual_en timestamptz;

-- ---------------------------------------------------------------------
-- 2. Leer
-- ---------------------------------------------------------------------
create or replace function public.respuestas_de(p_ids uuid[])
returns table (seguimiento_id uuid, respuesta text, fuente text, pregunta boolean,
               mensajes jsonb, ultima timestamptz)
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
      else respuesta := 'duda'; fuente := 'palabras';
      end if;
    end if;
    return next;
  end loop;
end $$;
revoke all on function public.respuestas_de(uuid[]) from public, anon;
grant execute on function public.respuestas_de(uuid[]) to authenticated;

-- ---------------------------------------------------------------------
-- 3. Corregir
-- ---------------------------------------------------------------------
create or replace function public.fijar_respuesta(p_sid uuid, p_valor text)
returns void language plpgsql security definer set search_path = '' as $$
declare s record; ini timestamptz;
begin
  if p_valor not in ('si', 'no') then raise exception 'valor inválido'; end if;
  select x.*, coalesce(a.inicio, x.inicio) as ini into s
    from public.seguimientos x left join public.actividades a on a.id = x.actividad_id
   where x.id = p_sid and x.owner_id = auth.uid() and x.estado = 'activo'
   for update of x;
  if not found then raise exception 'Solo puedes cambiar seguimientos tuyos en curso'; end if;
  ini := s.ini;

  update public.seguimientos set respuesta_manual = p_valor, respuesta_manual_en = now() where id = p_sid;

  if p_valor = 'no' then
    update public.mensajes_programados set estado = 'cancelado', error = 'omitido: marcaste que no va'
     where seguimiento_id = p_sid and estado in ('pendiente', 'retenido')
       and tipo in ('rec_60', 'rec_15', 'pregunta_link', 'enlace', 'confirmacion');
    return;
  end if;

  update public.mensajes_programados set estado = 'cancelado', error = 'omitido: marcaste que sí va'
   where seguimiento_id = p_sid and tipo = 'pregunta_link' and estado in ('pendiente', 'retenido');
  -- Lo que el sistema canceló por la respuesta (o por la pregunta), y lo que
  -- el agente canceló con «No va». No toca lo silenciado a mano (error nulo).
  update public.mensajes_programados set estado = 'pendiente', error = null
   where seguimiento_id = p_sid and tipo in ('rec_60', 'rec_15') and estado = 'cancelado'
     and enviar_en > now()
     and (error like 'omitido: dijo que no puede%' or error like 'omitido: respondió que no%'
          or error in ('omitido: marcaste que no va', 'omitido: se cambió por la pregunta del link',
                       'omitido: no respondió, se pregunta por el link'));
  update public.mensajes_programados
     set estado = 'pendiente', error = null,
         enviar_en = greatest(ini, now()) + case when tipo = 'confirmacion' then interval '10 minutes' else interval '0' end
   where seguimiento_id = p_sid and tipo in ('enlace', 'confirmacion')
     and (estado = 'retenido'
          or (estado = 'cancelado'
              and (error like 'omitido: dijo que no puede%' or error like 'omitido: respondió que no%'
                   or error = 'omitido: marcaste que no va')));
end $$;
revoke all on function public.fijar_respuesta(uuid, text) from public, anon;
grant execute on function public.fijar_respuesta(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 4. La base respeta lo que el agente decidió
-- ---------------------------------------------------------------------
-- Igual que sql/2026-10-30_54_…, más `s.respuesta_manual is null` en los
-- pasos d, a y b.
create or replace function public.procesar_preguntas_link()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v text; k text; ia text;
begin
  -- d) Quien respondió y dijo que no: se le cancela todo lo que falta.
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
       and now() <= coalesce(a.inicio, s.inicio) + interval '10 minutes'
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
      -- El recordatorio que reemplaza: el de 1 h si la tanda lo tiene, si no el
      -- de 15 min (el panel pone la pregunta a la hora de ese mismo).
      join lateral (
        select x.id, x.enviar_en, x.estado from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.tipo in ('rec_60', 'rec_15')
         order by (x.tipo = 'rec_60') desc limit 1) m on m.estado = 'pendiente'
      -- Sin invitación del sistema (el agente invitó a mano) no hay primer
      -- mensaje enviado: cuenta desde que se programó el seguimiento.
      cross join lateral (
        select coalesce(min(x.enviado_en), s.created_at) as primer from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) e
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
    select s.id as sid, s.owner_id, s.estado as sest, p.telefono, p.estado as pest,
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
