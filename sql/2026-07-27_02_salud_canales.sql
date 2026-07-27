-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Salud de canales — 27 de julio de 2026
--
-- Correr después de 2026-07-27_01_seguridad.sql.
--
-- Motivo: a una agente le restringieron el WhatsApp, se le cayó la sesión y
-- sus mensajes empezaron a fallar. Nadie se enteró en tres días — se supo
-- revisando la base a mano. Esta vista es la fuente única para que la app
-- avise sola: al agente en su pantalla de Seguimiento, y al director en su
-- panel de «Agentes y canales».
--
-- `security_invoker = true` hace que la vista respete el RLS de las tablas de
-- abajo: un agente ve solo su fila, el director las ve todas. La app no
-- necesita filtrar por owner_id.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view public.salud_canales
with (security_invoker = true) as
with m as (
  select
    owner_id,
    count(*)                                                        as total_mensajes,
    count(*) filter (where estado = 'enviado'
                       and enviar_en > now() - interval '24 hours')  as enviados_24h,
    count(*) filter (where estado = 'error'
                       and enviar_en > now() - interval '24 hours')  as fallidos_24h,
    count(*) filter (where estado = 'pendiente'
                       and enviar_en < now() - interval '15 minutes') as atascados,
    max(enviado_en) filter (where estado = 'enviado')                as ultimo_envio_ok,
    (array_agg(error order by enviar_en desc)
       filter (where estado = 'error' and error is not null))[1]     as ultimo_error
  from public.mensajes_programados
  group by owner_id
),
-- Los últimos 10 intentos, sin importar cuándo fueron. Hace falta porque la
-- ventana de 24 h se queda ciega: un agente que dejó de enviar hace tres días
-- con todo fallando aparecería "ok" solo por no haber intentado nada hoy.
-- Fue exactamente el caso que se nos escapó.
u as (
  select owner_id,
         count(*) filter (where estado = 'error') as fallidos_u10,
         count(*)                                  as intentos_u10
  from (
    select owner_id, estado,
           row_number() over (partition by owner_id order by enviar_en desc) as rn
    from public.mensajes_programados
    where estado in ('enviado', 'error')
  ) t
  where rn <= 10
  group by owner_id
)
select
  p.id                                as owner_id,
  p.full_name                         as nombre,
  p.role                              as rol,
  coalesce(c.estado, 'sin_vincular')  as estado_canal,
  c.telefono,
  coalesce(m.total_mensajes, 0)       as total_mensajes,
  coalesce(m.enviados_24h, 0)         as enviados_24h,
  coalesce(m.fallidos_24h, 0)         as fallidos_24h,
  coalesce(m.atascados, 0)            as atascados,
  coalesce(u.fallidos_u10, 0)         as fallidos_u10,
  coalesce(u.intentos_u10, 0)         as intentos_u10,
  m.ultimo_envio_ok,
  m.ultimo_error,
  -- Semáforo, calculado aquí para que la vista del agente y la del director
  -- nunca discrepen sobre qué es "estar mal".
  case
    -- Nunca usó el sistema: es un pendiente de activación, no una avería.
    -- Se separa a propósito para que no ensucie las alertas reales.
    when coalesce(m.total_mensajes, 0) = 0
     and coalesce(c.estado, 'sin_vincular') <> 'vinculado'
      then 'sin_uso'
    -- Tenía historial y se quedó sin canal: eso sí se rompió.
    when coalesce(c.estado, 'sin_vincular') <> 'vinculado'
      then 'sin_canal'
    -- 70% o más de los últimos intentos fallaron (con al menos 5 intentos).
    when coalesce(u.intentos_u10, 0) >= 5
     and coalesce(u.fallidos_u10, 0) * 10 >= coalesce(u.intentos_u10, 0) * 7
      then 'fallando'
    when coalesce(m.fallidos_24h, 0) >= 3
     and coalesce(m.fallidos_24h, 0) >= coalesce(m.enviados_24h, 0)
      then 'fallando'
    when coalesce(m.fallidos_24h, 0) >= 3
      then 'degradado'
    when coalesce(m.atascados, 0) >= 5
      then 'atascado'
    else 'ok'
  end                                 as salud
from public.profiles p
left join public.canales_wa c on c.owner_id = p.id
left join m                   on m.owner_id = p.id
left join u                   on u.owner_id = p.id;

grant select on public.salud_canales to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN
--
--   select nombre, salud, estado_canal, total_mensajes,
--          fallidos_u10 || '/' || intentos_u10 as ultimos_10
--     from public.salud_canales order by salud, nombre;
--
-- Como director deberías ver las 9 filas; como agente, solo la tuya.
-- Con los datos de hoy: Majo Guzman debe salir 'fallando' (10/10), los dos
-- que nunca arrancaron 'sin_uso', y el resto 'ok'.
-- ───────────────────────────────────────────────────────────────────────────
