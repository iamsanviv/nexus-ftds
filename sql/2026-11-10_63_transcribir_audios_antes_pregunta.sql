-- =====================================================================
--  Se transcriben también los audios de quien responde ANTES de la pregunta
--  Aplicado el 2026-11-10 con el MCP de Supabase. Pedido de Sanviv.
--
--  Caso Ana Arciniegas (9/11/2026, Trading Sin Filtros): respondió a la
--  invitación con un mensaje sin texto 2 min después. `transcripcion_pendiente`
--  solo listaba a quien ya tenía la pregunta del link ENVIADA y el link
--  retenido, así que su audio no se transcribió y el panel decía «Escribió sin
--  texto». El paso d) de `procesar_preguntas_link` (quien respondió y dijo que
--  no, caso Luis Gudiño) solo lee texto: un «no puedo» por audio antes de la
--  pregunta no cancelaba nada y le salían recordatorio, link y confirmación.
--
--  Ahora la lista son los seguimientos en curso con la pregunta del link en
--  la tanda, sin decisión manual, hasta `inicio + 10 min`, con algo aún por
--  salir o retenido, y que te escribieron desde el primer mensaje enviado (o
--  desde que se programó, si se invitó a mano). Incluye a los de antes (la
--  pregunta enviada y el link retenido) cuando escribieron, que es cuando hay
--  audio que transcribir.
--
--  Cuota (medida el 10/11 sobre las últimas 12 h): 4 personas con 5 mensajes
--  sin texto entre 42 seguimientos con pregunta; a 46,63 neuronas por minuto
--  de audio, de 145 a 495 neuronas al día de 10.000 gratis.
--
--  `chats_sync.py` no cambia: transcribe los audios posteriores a `desde` de
--  quien esté en la lista. Una persona por (owner, teléfono), con el `desde`
--  más antiguo si tiene dos seguimientos a la vez.
-- =====================================================================

create or replace function public.transcripcion_pendiente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cuenta', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_account_id'),
    'token',  (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_ai_token'),
    'pendientes', coalesce((
      select jsonb_agg(jsonb_build_object('owner_id', q.owner_id, 'telefono', q.tel, 'desde', q.desde))
        from (
          select s.owner_id, public.clave_tel(c.telefono) as tel, min(d.desde) as desde
            from public.seguimientos s
            join public.clientes c on c.id = s.cliente_id
            left join public.actividades a on a.id = s.actividad_id
            -- Igual que procesar_preguntas_link: sin mensaje del sistema enviado,
            -- cuenta desde que se programó.
            cross join lateral (
              select coalesce(min(x.enviado_en), s.created_at) as desde from public.mensajes_programados x
               where x.seguimiento_id = s.id and x.estado = 'enviado' and x.enviado_en is not null) d
           where s.estado = 'activo' and s.respuesta_manual is null
             and now() <= coalesce(a.inicio, s.inicio) + interval '10 minutes'
             and exists (select 1 from public.mensajes_programados p
                          where p.seguimiento_id = s.id and p.tipo = 'pregunta_link')
             -- Algo que su respuesta todavía puede cambiar.
             and exists (select 1 from public.mensajes_programados m
                          where m.seguimiento_id = s.id and m.estado in ('pendiente', 'retenido')
                            and m.tipo in ('rec_60', 'rec_15', 'enlace', 'confirmacion'))
             and exists (select 1 from public.chats_recientes ch
                          where ch.owner_id = s.owner_id
                            and public.clave_tel(ch.telefono) = public.clave_tel(c.telefono)
                            and ch.entrante_en > d.desde)
           group by s.owner_id, public.clave_tel(c.telefono)) q), '[]'::jsonb));
$$;
revoke all on function public.transcripcion_pendiente() from public, anon, authenticated;
grant execute on function public.transcripcion_pendiente() to service_role;
