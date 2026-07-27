-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Alertas que se pueden dar por vistas — 27 de julio de 2026
--
-- CORRER EN Supabase → SQL Editor. Idempotente.
--
-- ───────────────────────────────────────────────────────────────────────────
-- EL PROBLEMA
--
-- El canal de una agente lleva días fallando. Mientras no vuelva a enviar algo
-- con éxito, su estado sigue siendo 'fallando' para siempre, así que el
-- indicador de «Agentes y canales» dice «1 con problemas» de forma permanente.
--
-- Una alerta que no se puede acusar de recibida deja de ser una alerta: se
-- vuelve parte del paisaje. Y cuando aparezca un problema NUEVO no se va a
-- distinguir del viejo. Es peor que no tener alerta, porque da falsa
-- sensación de cobertura.
--
-- ───────────────────────────────────────────────────────────────────────────
-- LA SOLUCIÓN
--
-- Un botón «Visto» que guarda CUÁNDO se revisó (`alerta_vista_en`). La alerta
-- se calcula comparando esa marca con la fecha del último fallo:
--
--     alertar = hay problema  Y  (nunca se revisó  O  falló DESPUÉS de revisar)
--
-- Es decir: dar por visto silencia lo ya conocido, pero si esa misma persona
-- vuelve a fallar mañana, la alerta reaparece sola. No hay que acordarse de
-- volver a mirar, y no se pierde la señal.
--
-- Ojo: esto silencia el indicador del ADMIN/DIRECTOR, no el aviso que ve la
-- propia agente en su pantalla de Seguimiento. Ella debe seguir viéndolo hasta
-- que su canal funcione — el problema sigue siendo suyo aunque tú ya lo sepas.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.profiles add column if not exists alerta_vista_en timestamptz;

-- `alerta_vista_en` NO se añade al trigger `impedir_cambio_de_rol` a propósito:
-- no es un privilegio, es una marca de lectura. Que un agente pueda marcar la
-- suya no le da ningún poder, y el aviso de su pantalla no depende de esto.

drop view if exists public.salud_canales;
create view public.salud_canales as
with m as (
  select owner_id,
    count(*)                                                          as total_mensajes,
    count(*) filter (where estado='enviado'
                       and enviar_en > now() - interval '24 hours')    as enviados_24h,
    count(*) filter (where estado='error'
                       and enviar_en > now() - interval '24 hours')    as fallidos_24h,
    count(*) filter (where estado='pendiente'
                       and enviar_en < now() - interval '15 minutes')  as atascados,
    max(enviado_en) filter (where estado='enviado')                    as ultimo_envio_ok,
    max(enviar_en)  filter (where estado='error')                      as ultimo_fallo_en,
    (array_agg(error order by enviar_en desc)
       filter (where estado='error' and error is not null))[1]         as ultimo_error
  from public.mensajes_programados group by owner_id
),
u as (
  select owner_id,
         count(*) filter (where estado='error') as fallidos_u10,
         count(*)                                as intentos_u10
  from (select owner_id, estado,
               row_number() over (partition by owner_id order by enviar_en desc) rn
        from public.mensajes_programados where estado in ('enviado','error')) t
  where rn <= 10 group by owner_id
),
s as (
  select
    p.id, p.full_name, p.role, p.director_id, p.alerta_vista_en,
    c.estado as estado_canal, c.telefono,
    m.total_mensajes, m.enviados_24h, m.fallidos_24h, m.atascados,
    m.ultimo_envio_ok, m.ultimo_fallo_en, m.ultimo_error,
    u.fallidos_u10, u.intentos_u10,
    case
      when coalesce(m.total_mensajes,0) = 0
       and coalesce(c.estado,'sin_vincular') <> 'vinculado'              then 'sin_uso'
      when coalesce(c.estado,'sin_vincular') <> 'vinculado'              then 'sin_canal'
      when coalesce(u.intentos_u10,0) >= 5
       and coalesce(u.fallidos_u10,0)*10 >= coalesce(u.intentos_u10,0)*7 then 'fallando'
      when coalesce(m.fallidos_24h,0) >= 3
       and coalesce(m.fallidos_24h,0) >= coalesce(m.enviados_24h,0)      then 'fallando'
      when coalesce(m.fallidos_24h,0) >= 3                               then 'degradado'
      when coalesce(m.atascados,0) >= 5                                  then 'atascado'
      else 'ok'
    end as salud
  from public.profiles p
  left join public.canales_wa c on c.owner_id = p.id
  left join m on m.owner_id = p.id
  left join u on u.owner_id = p.id
  where p.id = auth.uid()
     or public.es_admin()
     or (public.mi_rol() = 'director' and p.director_id = auth.uid())
)
select
  s.id                              as owner_id,
  s.full_name                       as nombre,
  s.role                            as rol,
  s.director_id,
  coalesce(s.estado_canal, 'sin_vincular') as estado_canal,
  case when s.id = auth.uid() then s.telefono else null end as telefono,
  coalesce(s.total_mensajes, 0)     as total_mensajes,
  coalesce(s.enviados_24h, 0)       as enviados_24h,
  coalesce(s.fallidos_24h, 0)       as fallidos_24h,
  coalesce(s.atascados, 0)          as atascados,
  coalesce(s.fallidos_u10, 0)       as fallidos_u10,
  coalesce(s.intentos_u10, 0)       as intentos_u10,
  s.ultimo_envio_ok,
  -- Los errores del bridge traen el teléfono del cliente; a quien no sea el
  -- dueño se le enmascaran los dígitos.
  case when s.id = auth.uid() then s.ultimo_error
       else regexp_replace(coalesce(s.ultimo_error, ''), '\d{7,}', '[número]', 'g') end
                                    as ultimo_error,
  s.salud,
  s.ultimo_fallo_en,
  s.alerta_vista_en,
  -- Hay algo que atender Y (nunca se revisó O volvió a fallar desde entonces).
  -- 'sin_uso' nunca alerta: es un pendiente de activación, no una avería.
  (s.salud not in ('ok', 'sin_uso')
   and (s.alerta_vista_en is null
        or coalesce(s.ultimo_fallo_en, '-infinity'::timestamptz) > s.alerta_vista_en)
  )                                 as alertar
from s;

grant select on public.salud_canales to authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN
--
--   select nombre, salud, alertar, ultimo_fallo_en, alerta_vista_en
--     from public.salud_canales order by alertar desc, nombre;
--
-- Con los datos de hoy, Majo Guzman debe salir salud='fallando' y alertar=true.
-- Después de tocar «Visto» en la app: salud sigue 'fallando' (el problema no se
-- inventó), pero alertar pasa a false y el indicador de afuera se apaga. Si
-- vuelve a fallar, alertar se pone en true solo.
-- ───────────────────────────────────────────────────────────────────────────
