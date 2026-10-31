-- =====================================================================
--  Pregunta antes del link: quien queda EN DUDA no recibe más mensajes
--  Aplicado el 2026-10-30 con el MCP de Supabase.
--
--  Pedido de Sanviv (30/10/2026): «si está en duda, no se envíe ni el
--  recordatorio ni la pregunta». Eligió retener el link hasta que se aclare.
--
--  - Paso d): a quien escribió desde la invitación y la IA lee en DUDA se le
--    cancelan los recordatorios y la pregunta (error 'omitido: en duda, se espera que aclare')
--    y el enlace y la confirmación pasan a `retenido`.
--  - Paso b): ese seguimiento se trata como si hubiera recibido la pregunta:
--    lee lo que escribe; un sí (palabras o IA) suelta el link a la hora de
--    inicio, un no de la IA lo cancela, y pasado inicio + 10 min se cancela.
--  - Paso b), para todos: con la IA en duda se espera; antes un «no» de la
--    lista de palabras cancelaba aunque la IA dudara («No Nada · Jaja»).
--    Lo retenido no sale igual; solo se deja la puerta abierta a un sí tardío.
--  - «Sí va» (fijar_respuesta) devuelve los recordatorios cancelados por la
--    duda si su hora no pasó.
--
--  Resto igual que sql/2026-10-30_55_respuestas_invitados.sql.
-- =====================================================================

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
    select s.id as sid, s.owner_id, s.estado as sest, p.telefono, p.estado as pest, p.error as perr,
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
      if now() > r.inicio + interval '10 minutes' then
        v := 'cancelar:omitido: no confirmó a tiempo';
      else
        -- Un sí limpio de la lista de palabras basta. Si no, decide la IA; con
        -- la IA en duda se espera, y sin IA decide la lista de palabras.
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
          or error in ('omitido: marcaste que no va', 'omitido: se cambió por la pregunta del link', 'omitido: en duda, se espera que aclare',
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
