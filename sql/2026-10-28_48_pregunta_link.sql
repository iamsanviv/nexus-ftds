-- =====================================================================
--  Pregunta antes del link (28/10/2026, pedido de Sanviv)
--
--  A quien NO te escribió desde la invitación, en vez del recordatorio de
--  1 hora le llega «Nombre, ¿deseas que te envíe el link?» (u otra
--  variación). Solo recibe el link si contesta que sí y el sistema lo ve
--  hasta 10 min después del inicio. Tampoco recibe el de 15 min.
--
--  Piezas:
--  1. `chats_recientes.entrantes_txt`: los mensajes que la persona te
--     escribió en las últimas 12 h ([{en, t}]). Lo publica `chats_sync.py`
--     (VM1 y VM2). NULL = esa VM todavía no tiene la versión que lee textos:
--     sin poder leer la respuesta no se pregunta (se manda el recordatorio
--     normal), porque si no nadie recibiría el link.
--  2. `mensajes_programados.estado = 'retenido'`: existe pero el worker no lo
--     ve (solo toma `pendiente`). Nace así la fila `pregunta_link` al
--     programar, y pasan a él el enlace y la confirmación de quien no
--     respondió. No se usa el centinela de «❄ Congelar enlace» a propósito:
--     «▶ Enviar enlace» lo liberaría para todos.
--  3. `procesar_preguntas_link()` cada minuto (pg_cron):
--     a) 2 min antes del rec_60 decide: respondió → recordatorio normal; no
--        respondió → pregunta en lugar del recordatorio, sin rec_15, enlace y
--        confirmación retenidos.
--     b) libera el enlace (a la hora de inicio, o ya si el inicio pasó) a
--        quien contestó que sí; lo cancela si contestó que no.
--     c) pasada la hora de inicio + 10 min, cancela lo retenido.
--  Todo lo que cancela lleva `error` 'omitido: …': no es un fallo del envío
--  y no debe disparar el aviso push de envío fallido (mensajes_notifica_fallo).
--  Si el cron no corre, el rec_60 sale normal y el enlace también: la falla
--  vuelve al comportamiento anterior, no deja a nadie sin link.
-- =====================================================================

alter table public.chats_recientes add column if not exists entrantes_txt jsonb;

-- ¿Lo que escribió dice que sí, que no, o no se sabe? Conservador: cualquier
-- negación gana («sí, pero hoy no puedo» = no), y lo dudoso (audio, sticker,
-- «a qué hora es?») no manda el link.
create or replace function public.respuesta_link(t text)
returns text language sql immutable set search_path = '' as $$
  with n as (select translate(lower(coalesce(t, '')), 'áéíóúü', 'aeiouu') as x)
  select case
    when x ~ '\m(no+|nop|nel|tampoco|imposible|ocupad[oa]s?)\M|otro dia|otra ocasion|otra vez sera|cancel'
      then 'no'
    when x ~ '\m(si+|sip|sisas|claro|dale|ok|okey|okay|oki|listo|bueno|perfecto|obvio|porfa|confirmo|confirmado|voy)\M|de una|de acuerdo|por favor|por supuesto|ahi estare|\menvia|\mmanda|\mpasa(me|lo|melo)\M|\masist|👍|✅|👌|🙌|🙏'
      then 'si'
  end from n;
$$;

-- Lo que la persona escribió DESPUÉS de `desde`, ya clasificado: 'no' si algo
-- dice que no, 'si' si algo dice que sí, NULL si nada concluyente.
create or replace function public.respuesta_link_de(p_owner uuid, p_tel text, p_desde timestamptz)
returns text language sql stable security definer set search_path = '' as $$
  with r as (
    select public.respuesta_link(e->>'t') as v
      from public.chats_recientes c, jsonb_array_elements(coalesce(c.entrantes_txt, '[]')) e
     where c.owner_id = p_owner
       and public.clave_tel(c.telefono) = public.clave_tel(p_tel)
       and (e->>'en')::timestamptz > p_desde)
  select case when bool_or(v = 'no') then 'no' when bool_or(v = 'si') then 'si' end from r;
$$;
revoke all on function public.respuesta_link_de(uuid, text, timestamptz) from public, anon, authenticated;

create or replace function public.procesar_preguntas_link()
returns void language plpgsql security definer set search_path = '' as $$
declare r record; v text;
begin
  -- a) Decidir, 2 min antes del recordatorio de 1 h. «Respondió» es la misma
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
      join public.mensajes_programados m
        on m.seguimiento_id = s.id and m.tipo = 'rec_60' and m.estado = 'pendiente'
      cross join lateral (
        select min(x.enviado_en) as primer from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) e
     where p.tipo = 'pregunta_link' and p.estado = 'retenido'
       and s.estado = 'activo'
       and m.enviar_en <= now() + interval '2 minutes'
     for update of p, m skip locked
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

  -- b) y c) Lo retenido de quien recibió la pregunta.
  for r in
    select s.id as sid, s.owner_id, s.estado as sest, p.telefono, p.estado as pest, p.enviado_en as preg_en,
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
        case public.respuesta_link_de(r.owner_id, r.telefono, r.preg_en)
          when 'si' then v := 'liberar';
          when 'no' then v := 'cancelar:omitido: respondió que no';
          else null;
        end case;
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

  -- Pregunta que nunca se activó (se silenció o ya salió el rec_60, se canceló
  -- el seguimiento): no debe quedar colgada. Se mira el rec_60 y no la hora de
  -- la pregunta porque el cambio de hora de la actividad mueve solo pendientes.
  update public.mensajes_programados p set estado = 'cancelado', error = 'omitido: no hizo falta preguntar'
    from public.seguimientos s
   where p.tipo = 'pregunta_link' and p.estado = 'retenido' and s.id = p.seguimiento_id
     and (s.estado <> 'activo'
          or not exists (select 1 from public.mensajes_programados m
                          where m.seguimiento_id = s.id and m.tipo = 'rec_60' and m.estado = 'pendiente'));
end;
$$;
revoke all on function public.procesar_preguntas_link() from public, anon, authenticated;

select cron.unschedule('preguntas_link') where exists (select 1 from cron.job where jobname = 'preguntas_link');
select cron.schedule('preguntas_link', '* * * * *', 'select public.procesar_preguntas_link()');
