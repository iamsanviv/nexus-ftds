-- =====================================================================
--  Baja de canal — retirar a un agente sin borrarlo
--  Aplicado el 2026-09-15 con el MCP de Supabase.
-- =====================================================================
--
--  EL PROBLEMA
--
--  Cuando alguien deja la empresa, su bridge de WhatsApp sigue corriendo
--  en la VM y su puerto sigue "ocupado" para `provisionar.sh`, que se
--  niega a repetirlo. Con <20 puertos repartidos entre dos máquinas, cada
--  agente retirado se lleva un número que ya nadie usa, y el proceso
--  sigue gastando CPU y latidos contra Supabase para siempre.
--
--  Retirar a alguien NO es borrarlo: sus clientes, ventas, seguimientos e
--  historial de mensajes se quedan tal cual. Lo único que se apaga es la
--  infraestructura.
--
--  POR QUÉ UNA COLUMNA NUEVA Y NO `estado`
--
--  `estado` lo escribe el bridge en cada latido (~30 s). Un `estado='baja'`
--  puesto desde el panel duraría medio minuto antes de que el propio bridge
--  lo pisara con su realidad ('vinculado'/'vinculando'). La señal tiene que
--  vivir en una columna que el bridge no toque nunca.
--
--  `baja_en` es esa columna, y además sirve de máquina de estados completa
--  sin inventar más banderas, porque `puerto` ya dice si el trabajo del
--  servidor está hecho:
--
--      baja_en IS NULL                         → canal normal
--      baja_en + puerto + estado<>'bajando'    → pedida, sin ejecutar
--      baja_en + puerto + estado ='bajando'    → el ejecutor la tomó
--      baja_en + puerto IS NULL                → puerto liberado, hecho
--
--  El `estado='bajando'` es el reclamo de dos fases: existe solo para que
--  «Deshacer» sepa que ya es tarde. Sin él, el admin podría deshacer una
--  baja cuyo `systemctl stop` ya se ejecutó, y el panel diría que el canal
--  está bien mientras el bridge está muerto.
--
--  QUIÉN EJECUTA
--
--  El panel no alcanza la VM. `bajas.py` (systemd timer, cada 2 min, en
--  CADA máquina con bridges) lee las filas pendientes, busca el bridge en
--  SU propio disco por `WA_OWNER=<uuid>`, lo apaga, archiva el directorio
--  con punto delante — un `.bak` normal NO libera el puerto, porque
--  `provisionar.sh` recorre `*/` y bash sí incluye `algo.bak` pero no
--  `.algo` — y solo entonces pone `puerto = null`.
--
--  POR QUÉ RPC Y NO UPDATE DIRECTO
--
--  `authenticated` tiene UPDATE sobre UNA columna: `comando` (ver
--  2026-08-27_22). Ese grant estrecho es deliberado y no se amplía. Además
--  la política `canales_upd` es `owner_id = auth.uid()`: un admin no puede
--  escribir la fila de otro ni queriendo. La baja entra por una función
--  SECURITY DEFINER que verifica `es_admin()` ella misma.
-- =====================================================================

alter table public.canales_wa
  add column if not exists baja_en  timestamptz,
  add column if not exists baja_por uuid references auth.users(id);

comment on column public.canales_wa.baja_en is
  'Cuándo se retiró este canal desde el panel. NULL = activo. La escribe solo dar_de_baja_canal(); el bridge nunca la toca, por eso sobrevive a sus latidos. Con `puerto` forma la máquina de estados de la baja: puerto no nulo = el servidor todavía no la ejecutó.';
comment on column public.canales_wa.baja_por is
  'Quién pidió la baja. Solo para auditoría.';

-- `authenticated` no hereda grants al agregar columnas: hay que darlos a
-- mano, y solo SELECT. Nadie escribe estas columnas sin pasar por la RPC.
grant select (baja_en, baja_por) on public.canales_wa to authenticated;

-- =====================================================================
--  Vista de salud: una baja no es una avería
-- =====================================================================
--  Sin esto, un canal retirado cae en 'sin_canal' (estado <> 'vinculado')
--  y el panel lo pinta en rojo pidiendo atención para siempre. 'baja' va
--  de último y queda fuera de `alertar`.

create or replace view public.salud_canales as
 WITH m AS (
         SELECT mensajes_programados.owner_id,
            count(*) AS total_mensajes,
            count(*) FILTER (WHERE mensajes_programados.estado = 'enviado'::text AND mensajes_programados.enviar_en > (now() - '24:00:00'::interval)) AS enviados_24h,
            count(*) FILTER (WHERE mensajes_programados.estado = 'error'::text AND mensajes_programados.enviar_en > (now() - '24:00:00'::interval)) AS fallidos_24h,
            count(*) FILTER (WHERE mensajes_programados.estado = 'pendiente'::text AND mensajes_programados.enviar_en < (now() - '00:15:00'::interval)) AS atascados,
            max(mensajes_programados.enviado_en) FILTER (WHERE mensajes_programados.estado = 'enviado'::text) AS ultimo_envio_ok,
            max(mensajes_programados.enviar_en) FILTER (WHERE mensajes_programados.estado = 'error'::text) AS ultimo_fallo_en,
            (array_agg(mensajes_programados.error ORDER BY mensajes_programados.enviar_en DESC) FILTER (WHERE mensajes_programados.estado = 'error'::text AND mensajes_programados.error IS NOT NULL))[1] AS ultimo_error
           FROM mensajes_programados
          GROUP BY mensajes_programados.owner_id
        ), u AS (
         SELECT t.owner_id,
            count(*) FILTER (WHERE t.estado = 'error'::text) AS fallidos_u10,
            count(*) AS intentos_u10
           FROM ( SELECT mensajes_programados.owner_id,
                    mensajes_programados.estado,
                    row_number() OVER (PARTITION BY mensajes_programados.owner_id ORDER BY mensajes_programados.enviar_en DESC) AS rn
                   FROM mensajes_programados
                  WHERE mensajes_programados.estado = ANY (ARRAY['enviado'::text, 'error'::text])) t
          WHERE t.rn <= 10
          GROUP BY t.owner_id
        ), s AS (
         SELECT p.id,
            p.full_name,
            p.role,
            p.director_id,
            p.alerta_vista_en,
            c.estado AS estado_canal,
            c.telefono,
            c.baja_en,
            c.puerto,
            m.total_mensajes,
            m.enviados_24h,
            m.fallidos_24h,
            m.atascados,
            m.ultimo_envio_ok,
            m.ultimo_fallo_en,
            m.ultimo_error,
            u.fallidos_u10,
            u.intentos_u10,
                CASE
                    -- Primero que todo: un canal retirado no se juzga por sus
                    -- cifras. Dejó de existir a propósito.
                    WHEN c.baja_en IS NOT NULL THEN 'baja'::text
                    WHEN COALESCE(m.total_mensajes, 0::bigint) = 0 AND COALESCE(c.estado, 'sin_vincular'::text) <> 'vinculado'::text THEN 'sin_uso'::text
                    WHEN COALESCE(c.estado, 'sin_vincular'::text) <> 'vinculado'::text THEN 'sin_canal'::text
                    WHEN COALESCE(u.intentos_u10, 0::bigint) >= 5 AND (COALESCE(u.fallidos_u10, 0::bigint) * 10) >= (COALESCE(u.intentos_u10, 0::bigint) * 7) THEN 'fallando'::text
                    WHEN COALESCE(m.fallidos_24h, 0::bigint) >= 3 AND COALESCE(m.fallidos_24h, 0::bigint) >= COALESCE(m.enviados_24h, 0::bigint) THEN 'fallando'::text
                    WHEN COALESCE(m.fallidos_24h, 0::bigint) >= 3 THEN 'degradado'::text
                    WHEN COALESCE(m.atascados, 0::bigint) >= 5 THEN 'atascado'::text
                    ELSE 'ok'::text
                END AS salud
           FROM profiles p
             LEFT JOIN canales_wa c ON c.owner_id = p.id
             LEFT JOIN m ON m.owner_id = p.id
             LEFT JOIN u ON u.owner_id = p.id
          WHERE p.id = auth.uid() OR es_admin() OR mi_rol() = 'director'::text AND p.director_id = auth.uid()
        )
 SELECT id AS owner_id,
    full_name AS nombre,
    role AS rol,
    director_id,
    COALESCE(estado_canal, 'sin_vincular'::text) AS estado_canal,
        CASE
            WHEN id = auth.uid() THEN telefono
            ELSE NULL::text
        END AS telefono,
    COALESCE(total_mensajes, 0::bigint) AS total_mensajes,
    COALESCE(enviados_24h, 0::bigint) AS enviados_24h,
    COALESCE(fallidos_24h, 0::bigint) AS fallidos_24h,
    COALESCE(atascados, 0::bigint) AS atascados,
    COALESCE(fallidos_u10, 0::bigint) AS fallidos_u10,
    COALESCE(intentos_u10, 0::bigint) AS intentos_u10,
    ultimo_envio_ok,
        CASE
            WHEN id = auth.uid() THEN ultimo_error
            ELSE regexp_replace(COALESCE(ultimo_error, ''::text), '\d{7,}'::text, '[número]'::text, 'g'::text)
        END AS ultimo_error,
    salud,
    ultimo_fallo_en,
    alerta_vista_en,
    (salud <> ALL (ARRAY['ok'::text, 'sin_uso'::text, 'baja'::text])) AND (alerta_vista_en IS NULL OR COALESCE(ultimo_fallo_en, '-infinity'::timestamp with time zone) > alerta_vista_en) AS alertar,
    -- Las dos columnas nuevas van AL FINAL a la fuerza: `create or replace
    -- view` no deja insertar ni reordenar columnas («cannot change name of
    -- view column»), solo agregarlas después de las que ya existían. Meterlas
    -- donde se leen mejor obligaría a un DROP, y de eso dependen el panel y
    -- el aviso del agente. El orden en una vista no le importa a nadie.
    baja_en,
    -- El número de puerto es detalle de infraestructura: solo el admin lo
    -- ve, y le sirve para saber cuál quedó libre.
        CASE
            WHEN es_admin() THEN puerto
            ELSE NULL::integer
        END AS puerto
   FROM s;

-- =====================================================================
--  Pedir la baja (solo admin)
-- =====================================================================

create or replace function public.dar_de_baja_canal(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_puerto     int;
  v_host       text;
  v_baja       timestamptz;
  v_cancelados int;
begin
  if not public.es_admin() then
    raise exception 'Solo el administrador puede dar de baja un canal'
      using errcode = '42501';
  end if;
  -- Quitarse el propio canal desde el panel deja al admin sin poder enviar
  -- y sin forma de revertirlo desde el mismo panel. Se hace a mano o no se hace.
  if p_owner = auth.uid() then
    raise exception 'No puedes dar de baja tu propio canal'
      using errcode = '22023';
  end if;

  select puerto, host, baja_en into v_puerto, v_host, v_baja
    from public.canales_wa where owner_id = p_owner for update;
  if not found then
    raise exception 'Esa persona no tiene canal aprovisionado'
      using errcode = 'P0002';
  end if;
  if v_baja is not null then
    raise exception 'Ese canal ya estaba dado de baja'
      using errcode = '22023';
  end if;

  -- Lo que quedó en cola se cancela aquí. Si se dejara, el worker lo
  -- intentaría uno por uno contra un bridge muerto y convertiría la baja en
  -- una lluvia de errores que además dispararía la alerta de canal caído.
  update public.mensajes_programados
     set estado = 'cancelado',
         error  = 'Canal dado de baja'
   where owner_id = p_owner and estado = 'pendiente';
  get diagnostics v_cancelados = row_count;

  -- `estado` se pone en 'baja' de una vez aunque el bridge pueda pisarlo en
  -- su próximo latido: mientras aguante, `puerto_de()` del worker falla
  -- cerrado (exige 'vinculado') y nada sale por ese canal. El ejecutor lo
  -- vuelve a fijar al final, ya con el bridge apagado, y ahí sí queda.
  update public.canales_wa
     set baja_en  = now(),
         baja_por = auth.uid(),
         estado   = 'baja',
         comando  = null,
         qr       = null
   where owner_id = p_owner;

  return jsonb_build_object(
    'puerto', v_puerto, 'host', v_host, 'cancelados', v_cancelados);
end
$$;

comment on function public.dar_de_baja_canal(uuid) is
  'Retira el canal de WhatsApp de un agente: cancela su cola y marca la fila para que el ejecutor de la VM apague su bridge y libere el puerto. No borra ni un dato del agente.';

-- =====================================================================
--  Deshacer, mientras el servidor todavía no la ejecutó
-- =====================================================================

create or replace function public.deshacer_baja_canal(p_owner uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_puerto int;
  v_estado text;
  v_baja   timestamptz;
begin
  if not public.es_admin() then
    raise exception 'Solo el administrador puede deshacer una baja'
      using errcode = '42501';
  end if;

  select puerto, estado, baja_en into v_puerto, v_estado, v_baja
    from public.canales_wa where owner_id = p_owner for update;
  if not found then
    raise exception 'Esa persona no tiene canal aprovisionado'
      using errcode = 'P0002';
  end if;
  if v_baja is null then
    raise exception 'Ese canal no está dado de baja' using errcode = '22023';
  end if;
  -- A partir del reclamo ya no se puede prometer nada: el `systemctl stop`
  -- puede haber corrido. Mentir aquí dejaría el panel diciendo que el canal
  -- está bien con el bridge muerto.
  if v_estado = 'bajando' or v_puerto is null then
    raise exception 'La baja ya se está ejecutando en el servidor. Para reactivar el canal hay que volver a aprovisionar el bridge en la máquina.'
      using errcode = '22023';
  end if;

  update public.canales_wa
     set baja_en  = null,
         baja_por = null,
         estado   = 'sin_vincular'   -- el latido del bridge lo corrige solo
   where owner_id = p_owner;

  return jsonb_build_object('puerto', v_puerto);
end
$$;

comment on function public.deshacer_baja_canal(uuid) is
  'Retira una baja que el ejecutor de la VM todavía no tomó. Los mensajes ya cancelados no se reviven: eso es a propósito.';

revoke all on function public.dar_de_baja_canal(uuid)   from public, anon;
revoke all on function public.deshacer_baja_canal(uuid) from public, anon;
grant execute on function public.dar_de_baja_canal(uuid)   to authenticated;
grant execute on function public.deshacer_baja_canal(uuid) to authenticated;
