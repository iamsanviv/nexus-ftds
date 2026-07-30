-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Enlace rastreado por persona («trigger link»)
-- 30 de julio de 2026
--
-- ESTADO: APLICADO EN PRODUCCIÓN (migraciones `enlace_rastreado_por_persona` y
-- `ventana_de_asistencia_del_enlace_rastreado`). Este archivo refleja el
-- resultado FINAL de las dos: la función que está en la base es la de abajo.
--
-- QUÉ RESUELVE
-- Saber quién entró a la actividad sin preguntárselo a cincuenta personas. A
-- cada seguimiento se le da un token propio; el mensaje del enlace lleva
-- `…/i.html?t=<token>` en vez de la URL de Zoom. Al abrirlo se registra el clic
-- y se redirige a la sala.
--
-- POR QUÉ ASÍ Y NO DE OTRA FORMA
-- · El token va en el SEGUIMIENTO, no en el mensaje: es lo que identifica a la
--   persona en esta actividad, y sobrevive a que se reprogramen los mensajes.
-- · La redirección se hace en el NAVEGADOR (una página estática que llama a
--   esta función), no en el servidor. Los bots que generan la previsualización
--   del enlace en WhatsApp no ejecutan JavaScript: así una previsualización no
--   cuenta como clic.
-- · La función devuelve el enlace VIGENTE de la actividad, no la copia que el
--   seguimiento guardó al programar. Efecto secundario bueno: con rastreo ya no
--   hace falta propagar el enlace a los mensajes pendientes cuando se agrega o
--   se corrige la sala; se resuelve al hacer clic.
-- ═══════════════════════════════════════════════════════════════════════════

-- Qué significa cada columna (importa, porque de ahí sale toda la lógica):
--   clic_token → el token de esta persona en esta actividad
--   clics      → TODAS las aperturas, siempre
--   clic_en    → la primera apertura QUE CONTÓ como asistencia
-- Por eso `clics > 0` con `clic_en` en nulo es exactamente «abrió, pero
-- demasiado tarde». La ventana se decide en un solo sitio y la interfaz solo
-- traduce; no repite el cálculo.
alter table public.seguimientos
  add column if not exists clic_token text,
  add column if not exists clic_en    timestamptz,
  add column if not exists clics      int not null default 0;

-- Índice PARCIAL: los seguimientos viejos (y los de actividades sin rastreo)
-- tienen el token en nulo. En Postgres varios nulos no chocan en un índice
-- único, pero dejarlo explícito lo hace más pequeño y más claro.
create unique index if not exists seguimientos_clic_token_uq
  on public.seguimientos (clic_token) where clic_token is not null;

-- Se puede apagar POR ACTIVIDAD. Cambiar un `zoom.us` reconocible por un enlace
-- corto ajeno resta confianza y es señal de spam para WhatsApp, y aquí ya hubo
-- un número restringido. Por defecto va encendido porque es la razón de ser de
-- la función; el agente lo apaga si el público es frío o desconfiado.
alter table public.actividades
  add column if not exists rastrear boolean not null default true;


-- ───────────────────────────────────────────────────────────────────────────
-- Resuelve un token: registra el clic, marca asistencia y devuelve el destino.
--
--   null  → el token no existe (enlace inválido)
--   ''    → existe, pero la actividad todavía no tiene enlace
--   url   → a dónde ir
--
-- Los tres casos se distinguen a propósito: la página muestra un mensaje
-- distinto en cada uno. Antes devolvía null para los dos primeros y la persona
-- veía «enlace inválido» cuando en realidad el asesor no había pegado la sala.
--
-- SECURITY DEFINER y ejecutable por `anon`: quien abre el enlace es el cliente,
-- que no tiene sesión. No devuelve NADA del cliente ni del agente, solo la URL,
-- y lo único que hay que adivinar es el token (16 caracteres al azar de un
-- alfabeto de 32 → 80 bits).
-- ───────────────────────────────────────────────────────────────────────────
create or replace function public.abrir_enlace(t text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  sg        record;
  destino   text;
  a_tiempo  boolean;
  -- La fecha se toma en Colombia: `acc` guarda día, no instante, y en UTC un
  -- vivo de las 8 p. m. quedaría marcado al día siguiente.
  hoy       text := to_char((now() at time zone 'America/Bogota')::date, 'YYYY-MM-DD');
  base      jsonb;
begin
  if t is null or length(t) < 10 then return null; end if;

  select s.id, s.cliente_id, s.actividad_id, s.enlace as enlace_seg,
         s.inicio as inicio_seg,
         a.enlace as enlace_act, a.servicio_id, a.nombre as act_nombre,
         a.inicio as inicio_act
    into sg
  from public.seguimientos s
  left join public.actividades a on a.id = s.actividad_id
  where s.clic_token = t;

  if not found then return null; end if;

  -- Enlace vigente de la actividad. Si la actividad ya se borró
  -- (`actividad_id` queda en nulo por el ON DELETE SET NULL), sirve la copia
  -- que el seguimiento guardó al programar.
  destino := coalesce(nullif(sg.enlace_act, ''), nullif(sg.enlace_seg, ''), '');

  -- VENTANA DE ASISTENCIA: una hora desde el inicio. El mensaje del enlace sale
  -- justo a la hora de arranque, así que un clic dentro de esa hora es alguien
  -- entrando. Más tarde es alguien abriendo el mensaje al otro día, y marcarle
  -- asistencia sería inventarla.
  -- La hora de la ACTIVIDAD manda sobre la copia del seguimiento: si se
  -- reprogramó, la ventana se corre con ella. La copia solo entra si la
  -- actividad ya no existe.
  a_tiempo := now() <= coalesce(sg.inicio_act, sg.inicio_seg) + interval '1 hour';

  -- El clic se registra SIEMPRE, aunque llegue tarde o no haya destino: dice
  -- que la persona intentó entrar, y eso ya es información. Lo que cambia es si
  -- cuenta: `clic_en` solo se pone dentro de la ventana, y una reapertura tardía
  -- no borra el clic bueno que ya estaba.
  update public.seguimientos
     set clics   = clics + 1,
         clic_en = case when a_tiempo then coalesce(clic_en, now()) else clic_en end
   where id = sg.id;

  -- Fuera de la ventana se sale acá: redirige igual (la persona sí quiere entrar
  -- a la sala) pero no se toca la asistencia.
  if not a_tiempo then return destino; end if;

  -- Asistencia. NO se sobreescribe lo que ya esté marcado: si el agente lo
  -- confirmó a mano en el repaso, su fecha manda sobre la del clic.
  if sg.servicio_id is not null then
    -- Actividad del catálogo: `acc` va indexado por servicio.
    update public.clientes
       set acc = coalesce(acc, '{}'::jsonb) || jsonb_build_object(sg.servicio_id, hoy)
     where id = sg.cliente_id
       and coalesce(acc, '{}'::jsonb) ->> sg.servicio_id is null;
  elsif sg.actividad_id is not null then
    -- Actividad puntual: su propio mapa. Se rellenan `n` e `i` por si la
    -- entrada no existiera, para que el perfil siga teniendo sentido aunque la
    -- actividad desaparezca. Lo que ya estuviera guardado gana sobre esa base.
    base := jsonb_build_object(
      'n', coalesce(sg.act_nombre, 'Actividad'),
      'i', to_char(coalesce(sg.inicio_act, sg.inicio_seg) at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
    update public.clientes
       set puntuales = coalesce(puntuales, '{}'::jsonb) || jsonb_build_object(
             sg.actividad_id::text,
             base
               || coalesce(coalesce(puntuales, '{}'::jsonb) -> sg.actividad_id::text, '{}'::jsonb)
               || jsonb_build_object('acc', hoy))
     where id = sg.cliente_id
       and coalesce(puntuales, '{}'::jsonb) -> sg.actividad_id::text ->> 'acc' is null;
  end if;

  return destino;
end $$;

-- Por defecto Postgres da EXECUTE a PUBLIC en toda función nueva. Se quita y se
-- concede explícito, igual que en el resto del proyecto.
revoke execute on function public.abrir_enlace(text) from public;
grant  execute on function public.abrir_enlace(text) to anon, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICADO en transacción revertida (30/07), con datos insertados a propósito
--
--   token desconocido → null                                       ✓
--   catálogo → devuelve el enlace VIGENTE, no la copia del seg.     ✓
--   dos aperturas → clics = 2 y clic_en se queda en el primero      ✓
--   marca acc['zz_test_srv'] = fecha de hoy (Bogotá)                ✓
--   puntual sin enlace → devuelve '' (no null)                      ✓
--   marca puntuales[act] = { n, i, acc } conservando n e i          ✓
--   NO sobreescribe una asistencia puesta a mano (2020-01-01)       ✓
--   anon SELECT directo sobre seguimientos → no ve filas            ✓
--   anon SELECT directo sobre clientes     → no ve filas            ✓
--   anon UPDATE directo sobre seguimientos → no afecta filas        ✓
--   anon vía abrir_enlace  → resuelve y deja el clic escrito        ✓
--
-- Los tres últimos son los que importan: `anon` no puede leer ni escribir nada
-- por su cuenta, y todo lo que puede hacer pasa por esta función, que solo
-- devuelve una URL.
--
-- Y la ventana de asistencia, con actividades sembradas a distintas horas:
--
--   empezó hace 20 min → redirige, clic_en puesto, asistencia marcada  ✓
--   empezó hace 3 h    → redirige igual, clic_en NULO, SIN asistencia  ✓
--   puntual de ayer    → redirige igual, SIN asistencia                ✓
--   entró a tiempo y reabre 5 h después → clics=2, clic_en intacto     ✓
--
-- El segundo y el tercero son la razón de ser de la ventana: quien abre el
-- mensaje al otro día no asistió, y darle asistencia ensuciaría el progreso.
-- El cuarto es la trampa evidente: una reapertura tardía no puede borrar el
-- clic bueno que ya estaba.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- LO QUE ESTE DISEÑO NO PUEDE SABER (decirlo, no esconderlo)
--
-- · Un clic es que ABRIÓ el enlace, no que se quedó en la clase. Es una
--   aproximación, y la pantalla lo dice.
-- · La ventana de una hora corta por el otro lado: quien entró de verdad pero
--   abrió el enlace hora y media después (llegó tarde a la clase y se quedó)
--   queda sin asistencia. Se prefiere ese error al contrario, porque el repaso
--   manual sigue estando para corregirlo y una asistencia inventada no se ve.
-- · El token es de la persona, no del dispositivo: si reenvía el mensaje a un
--   amigo y el amigo entra, el clic queda a nombre de quien lo recibió. No hay
--   forma de distinguirlo sin pedir identificación, que costaría más de lo que
--   vale.
-- · Quien entre por su cuenta a Zoom (porque ya tenía el enlace de antes) no
--   genera clic. El repaso manual sigue existiendo para esos casos.
-- · El agente que abra el enlace para probarlo marca asistencia a ese cliente.
-- ───────────────────────────────────────────────────────────────────────────
