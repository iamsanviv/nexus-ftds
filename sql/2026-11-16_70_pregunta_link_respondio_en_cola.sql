-- =====================================================================
--  Pregunta del link: si respondió mientras la pregunta esperaba en la cola,
--  no sale (16/11/2026, caso Luis Galán, Operativa en Vivo 15/11)
--
--  El paso a) de `procesar_preguntas_link` decide 2 min antes del
--  recordatorio que reemplaza: si la persona no ha respondido, la pregunta
--  pasa a `pendiente`. Con la cola atrasada sale mucho después (Luis: decidida
--  ~18:58, enviada 19:15), y si en ese rato la persona respondió la
--  invitación, recibe igual la pregunta.
--
--  Ahora, cada minuto: pregunta `pendiente` (activada por el paso a) y aún sin
--  salir) de alguien que escribió después del primer mensaje enviado → se
--  cancela y todo vuelve a como queda para quien respondió: vuelven el
--  recordatorio de 15 min (si su hora no pasó), el enlace y la confirmación.
--  El recordatorio que la pregunta reemplazó no se reactiva si su hora ya
--  pasó: diría «en 1 hora» tarde.
--
--  Límite: la respuesta llega a la base con chats_sync (VM1 cada ~5 min). Si
--  responde y la pregunta sale en el mismo minuto, no se alcanza a ver.
-- =====================================================================

create or replace function public.cancelar_preguntas_respondidas()
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select p.id as pid, s.id as sid
      from public.mensajes_programados p
      join public.seguimientos s on s.id = p.seguimiento_id
      cross join lateral (
        select coalesce(min(x.enviado_en), s.created_at) as primer from public.mensajes_programados x
         where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) e
     where p.tipo = 'pregunta_link' and p.estado = 'pendiente'
       and s.estado = 'activo' and s.respuesta_manual is null
       and exists (select 1 from public.chats_recientes c
                    where c.owner_id = s.owner_id
                      and public.clave_tel(c.telefono) = public.clave_tel(p.telefono)
                      and c.entrante_en > e.primer)
     for update of p skip locked
  loop
    -- Si el worker ya la tomó, no está `pendiente` y no se toca nada.
    update public.mensajes_programados
       set estado = 'cancelado', error = 'omitido: respondió antes de que saliera la pregunta'
     where id = r.pid and estado = 'pendiente';
    if not found then continue; end if;
    update public.mensajes_programados set estado = 'pendiente', error = null
     where seguimiento_id = r.sid and tipo in ('rec_60', 'rec_15') and estado = 'cancelado'
       and enviar_en > now()
       and error in ('omitido: se cambió por la pregunta del link',
                     'omitido: no respondió, se pregunta por el link');
    update public.mensajes_programados set estado = 'pendiente', error = null
     where seguimiento_id = r.sid and tipo in ('enlace', 'confirmacion') and estado = 'retenido';
  end loop;
end;
$$;
revoke all on function public.cancelar_preguntas_respondidas() from public, anon, authenticated;

select cron.schedule('preguntas_respondidas', '* * * * *', 'select public.cancelar_preguntas_respondidas()');
