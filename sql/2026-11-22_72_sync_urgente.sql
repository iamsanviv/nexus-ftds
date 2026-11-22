-- =====================================================================
--  Vuelta urgente de chats (22/11/2026, pedido de Sanviv)
--
--  chats_sync publica las respuestas cada ~5 min. Una respuesta de las 7:58
--  podía no llegar a la decisión de las 7:59. Ahora `correr.py --urgente`
--  (timer cada minuto, a los :30, en VM1 y VM2) pregunta aquí qué agentes
--  tienen una decisión en los próximos minutos y relee solo esos bridges; el
--  cron de la base (cada minuto, a los :00) decide ya con lo fresco.
--
--  Urgente = el agente tiene un seguimiento activo con:
--    a) pregunta del link sin decidir y su recordatorio en los próximos 5 min;
--    b) pregunta activada que aún no sale (SQL 70);
--    c) enlace o confirmación retenidos esperando la respuesta (hasta 30 min
--       después del inicio: el plazo más largo de la pregunta);
--    d) confirmación pendiente en los próximos 5 min con el link ya enviado
--       (SQL 69, «ya ingresó»).
-- =====================================================================

create or replace function public.sync_urgente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(distinct s.owner_id), '[]'::jsonb)
    from public.seguimientos s
    left join public.actividades a on a.id = s.actividad_id
   where s.estado = 'activo'
     and exists (
       select 1 from public.mensajes_programados m
        where m.seguimiento_id = s.id
          and (
            (m.tipo = 'pregunta_link' and m.estado = 'retenido'
               and exists (select 1 from public.mensajes_programados r
                            where r.seguimiento_id = s.id and r.tipo in ('rec_60', 'rec_15')
                              and r.estado = 'pendiente'
                              and r.enviar_en between now() and now() + interval '5 minutes'))
            or (m.tipo = 'pregunta_link' and m.estado = 'pendiente')
            or (m.tipo in ('enlace', 'confirmacion') and m.estado = 'retenido'
                and now() <= coalesce(a.inicio, s.inicio) + interval '30 minutes')
            or (m.tipo = 'confirmacion' and m.estado = 'pendiente'
                and m.enviar_en between now() and now() + interval '5 minutes'
                and exists (select 1 from public.mensajes_programados e
                             where e.seguimiento_id = s.id and e.tipo = 'enlace' and e.estado = 'enviado'))));
$$;
revoke all on function public.sync_urgente() from public, anon, authenticated;
grant execute on function public.sync_urgente() to service_role;
