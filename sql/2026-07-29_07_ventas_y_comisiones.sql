-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Ventas, abonos y comisiones — 29 de julio de 2026
--
-- ⚠ ESTADO: **NO APLICADO**. Escrito sin acceso a la base (el MCP de Supabase
-- respondió "permission denied" a list_tables y execute_sql ese día), así que
-- NO se pudo verificar contra el esquema real ni probar el RLS simulando
-- sesiones, que es como se prueba aquí. Antes de darlo por bueno:
--   1. correrlo completo en el SQL Editor,
--   2. correr el bloque de PRUEBAS del final y comparar con lo esperado,
--   3. volver a este archivo y cambiar este encabezado.
-- Es idempotente: se puede correr de nuevo sin efectos secundarios.
--
-- Módulo nuevo y aditivo: no toca ninguna tabla, política ni función que ya
-- exista. Si algo sale mal, se borra con el bloque de ROLLBACK del final y el
-- resto del sistema queda como estaba.
--
-- Moneda: TODO en dólares. Un solo número, sin tasa de cambio.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. PRODUCTOS  (membresías y servicios)
--
-- La comisión es un MONTO FIJO por producto, no un porcentaje: Oro promoción
-- vale 789 y comisiona 200, que no es ningún porcentaje redondo. Por eso no
-- hay tabla de porcentajes por membresía.
--
-- `comision = 0` significa SIN DEFINIR, no "no comisiona". La app lo muestra
-- como «comisión sin definir» y esa venta no suma al total: más vale un hueco
-- visible que una cifra inventada con la que alguien cuente. Los productos que
-- hoy están en cero salieron así de la lista del 29/07 («por confirmar»).
--
-- `nivel` solo lo tienen las membresías, y es el mismo de NIVEL en config.js
-- (Beca 1, VIP 2, Platino 3, Oro 4). Es lo que permite detectar que una venta
-- es un upgrade y cobrar solo la diferencia de precio.
-- ───────────────────────────────────────────────────────────────────────────

-- `categoria` agrupa el selector del formulario. Los bots van aparte de los
-- demás servicios porque son once de dieciséis productos: mezclados, tapaban
-- todo lo demás en la lista.
create table if not exists public.productos (
  id        text primary key,
  nombre    text not null,
  categoria text not null check (categoria in ('membresia','servicio','bot')),
  precio    numeric(12,2) not null check (precio >= 0),
  comision  numeric(12,2) not null default 0 check (comision >= 0),
  nivel     int,                      -- solo membresías; null en servicios
  orden     int  not null default 0,
  activo    boolean not null default true,
  constraint productos_nivel_solo_membresias
    check ((categoria = 'membresia') = (nivel is not null))
);

insert into public.productos (id, nombre, categoria, precio, comision, nivel, orden) values
  ('oro',            'Oro',                    'membresia', 900, 0,   4, 10),
  ('oro_promo',      'Oro (promoción)',        'membresia', 789, 200, 4, 11),
  ('platino',        'Platino',                'membresia', 550, 0,   3, 20),
  ('platino_promo',  'Platino (promoción)',    'membresia', 439, 100, 3, 21),
  ('vip',            'VIP',                    'membresia', 300, 0,   2, 30),
  ('vip_promo',      'VIP (promoción)',        'membresia', 220, 55,  2, 31),

  ('trader_vip',     'Trader VIP',             'servicio',  270, 50, null, 40),

  ('bot_ia_45',      'Bot IA (45 días)',       'bot',        30, 10, null, 50),
  ('bot_ia_vit',     'Bot IA (Vitalicio)',     'bot',       400, 0,  null, 51),
  ('gopro_anual',    'Bot GoPro (Anual)',      'bot',       415, 0,  null, 52),
  ('gopro_vit',      'Bot GoPro (Vitalicio)',  'bot',       615, 0,  null, 53),
  ('gopro_vip',      'Bot GoPro (Servicios VIP)','bot',     135, 0,  null, 54),
  ('gotraders_anual','Bot GoTraders (Anual)',  'bot',       415, 0,  null, 55),
  ('gotraders_vit',  'Bot GoTraders (Vitalicio)','bot',     615, 0,  null, 56),
  ('gold_anual',     'Bot Gold (Anual)',       'bot',       335, 0,  null, 57),
  ('gold_vit',       'Bot Gold (Vitalicio)',   'bot',       375, 0,  null, 58)
on conflict (id) do nothing;   -- no pisa precios que ya hayan ajustado

-- Si la migración ya se corrió con los bots dentro de 'servicio', reclasifícalos.
-- El `check` de arriba hay que ampliarlo antes, o el update falla.
alter table public.productos drop constraint if exists productos_categoria_check;
alter table public.productos add  constraint productos_categoria_check
  check (categoria in ('membresia','servicio','bot'));

update public.productos set categoria = 'bot'
 where categoria = 'servicio' and nombre like 'Bot %';

alter table public.productos enable row level security;

drop policy if exists "productos_sel" on public.productos;
create policy "productos_sel" on public.productos
  for select to authenticated using (true);

-- Escribir: solo director o admin. Quien pueda mover estos números se sube el
-- sueldo a sí mismo y a todo el equipo.
drop policy if exists "productos_wr" on public.productos;
create policy "productos_wr" on public.productos
  for all to authenticated
  using (public.mi_rol() in ('director','admin'))
  with check (public.mi_rol() in ('director','admin'));


-- ───────────────────────────────────────────────────────────────────────────
-- 2. PARÁMETROS SUELTOS
--
-- Por ahora uno solo: cuánto comisiona un upgrade. Es un MONTO FIJO, igual
-- para cualquier combinación origen → destino, porque en el upgrade ya se
-- cobró comisión por el pago inicial y esta es la parte nueva.
--
-- Nace en 0 = SIN DEFINIR (el valor real quedó pendiente el 29/07). Mientras
-- siga en cero, la app marca los upgrades como «comisión sin definir» y no los
-- suma, igual que a los productos sin comisión.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.parametros (
  clave text primary key,
  valor numeric(12,2) not null default 0,
  nota  text
);

insert into public.parametros (clave, valor, nota) values
  ('comision_upgrade', 0, 'Monto fijo por upgrade de membresía. 0 = sin definir.')
on conflict (clave) do nothing;

alter table public.parametros enable row level security;

drop policy if exists "parametros_sel" on public.parametros;
create policy "parametros_sel" on public.parametros
  for select to authenticated using (true);

drop policy if exists "parametros_wr" on public.parametros;
create policy "parametros_wr" on public.parametros
  for all to authenticated
  using (public.mi_rol() in ('director','admin'))
  with check (public.mi_rol() in ('director','admin'));


-- ───────────────────────────────────────────────────────────────────────────
-- 3. METAS DE FTD
--
-- Los FTD no comisionan uno por uno: se pagan por meta mensual alcanzada.
-- Si un agente no llega a la siguiente meta, lo que sobró se acumula como
-- «base» y le ayuda el mes siguiente.
--
--   efectivos      = FTD del mes + base que traía
--   meta alcanzada = la mayor meta <= efectivos
--   comisión       = el pago de esa meta (0 si no alcanzó ninguna)
--   base siguiente = efectivos − meta alcanzada
--
-- El cálculo vive en JS (state.js), junto al resto de la lógica de negocio.
-- Aquí solo está la tabla de metas, que es configurable.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.metas_ftd (
  ftd  int primary key check (ftd > 0),
  pago numeric(12,2) not null check (pago >= 0)
);

-- La primera meta es 45. Hubo una de 25 = 200 USD que se quitó el 29/07: por
-- debajo de 45 no se paga nada y todo se acumula como base.
insert into public.metas_ftd (ftd, pago) values
  (45, 360), (65, 585), (90, 850), (120, 1200), (150, 1500)
on conflict (ftd) do nothing;

-- Si esta migración ya se corrió con la meta de 25, hay que sacarla.
delete from public.metas_ftd where ftd = 25;

alter table public.metas_ftd enable row level security;

drop policy if exists "metas_sel" on public.metas_ftd;
create policy "metas_sel" on public.metas_ftd
  for select to authenticated using (true);

drop policy if exists "metas_wr" on public.metas_ftd;
create policy "metas_wr" on public.metas_ftd
  for all to authenticated
  using (public.mi_rol() in ('director','admin'))
  with check (public.mi_rol() in ('director','admin'));


-- Base ENTRANTE de cada agente en cada periodo.
--
-- Se guarda en vez de derivarse porque derivarla obligaría a recorrer todos
-- los meses desde el principio de los tiempos, y bastaría un FTD registrado
-- tarde para mover la comisión de meses ya pagados. Aquí queda congelada:
-- lo que se pagó, se pagó.
--
-- `periodo` es 'YYYY-MM'. La app propone el valor calculado al cerrar el mes;
-- guardarlo es un acto explícito.
create table if not exists public.ftd_base (
  owner_id uuid not null references auth.users(id) on delete cascade,
  periodo  text not null check (periodo ~ '^\d{4}-\d{2}$'),
  base     int  not null default 0 check (base >= 0),
  primary key (owner_id, periodo)
);

alter table public.ftd_base enable row level security;

drop policy if exists "ftd_base_sel" on public.ftd_base;
create policy "ftd_base_sel" on public.ftd_base
  for select to authenticated using (public.puede_ver_de(owner_id));

-- Escribir la base es decidir cuánto se le paga a alguien: solo director o
-- admin, y solo de gente a la que ya pueden ver.
drop policy if exists "ftd_base_wr" on public.ftd_base;
create policy "ftd_base_wr" on public.ftd_base
  for all to authenticated
  using      (public.puede_ver_de(owner_id) and public.mi_rol() in ('director','admin'))
  with check (public.puede_ver_de(owner_id) and public.mi_rol() in ('director','admin'));


-- ───────────────────────────────────────────────────────────────────────────
-- 4. VENTAS
--
-- Una fila por venta. Cuelga del cliente que ya existe en Personas, pero
-- guarda copia del nombre y del producto: mismo criterio que
-- `clientes.puntuales`, que copia nombre y hora de la actividad para que el
-- historial no dependa de que la otra fila siga existiendo. Si se borra el
-- cliente, la venta sobrevive con `cliente_id = null` — perder facturación por
-- borrar un contacto sería inaceptable, así que NO hay cascade.
--
-- NO existe columna de facturación. Para la empresa lo facturado es lo
-- RECAUDADO, así que facturado = suma de abonos y no hay nada más que marcar.
-- Un `facturado_en` aparte solo podría contradecir a los abonos.
--
-- Tampoco existe «saldada»: se deduce de que los abonos alcancen el valor.
-- Y la comisión no se guarda como total causado, se deriva. Un solo lugar
-- donde está la verdad.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.ventas (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null default auth.uid() references auth.users(id) on delete cascade,

  cliente_id      uuid references public.clientes(id) on delete set null,
  cliente_nombre  text not null,          -- copia, ver arriba

  producto_id     text references public.productos(id) on delete set null,
  producto_nombre text not null,          -- copia; también sirve para "Otro"

  -- Un upgrade cobra la diferencia de precio y comisiona el monto fijo de
  -- `parametros.comision_upgrade`, no la comisión del producto: el pago
  -- inicial ya comisionó en su momento.
  es_upgrade      boolean not null default false,
  nivel_origen    text,                   -- membresía que tenía al comprar (copia)

  valor           numeric(12,2) not null check (valor >= 0),
  -- Comisión CONGELADA al crear la venta. Deliberado, y al revés que las
  -- imágenes del catálogo (que se resuelven vigentes al enviar): una comisión
  -- pactada no puede cambiar retroactivamente porque alguien ajustó la tabla
  -- de productos en octubre. `productos` es el valor por defecto al crear, no
  -- la fuente de verdad de lo ya vendido. 0 = sin definir.
  comision        numeric(12,2) not null default 0 check (comision >= 0),

  -- Mientras no esté saldada: qué tan firme es el pago esperado.
  tipo            text not null default 'agendado' check (tipo in ('agendado','posible')),
  -- 'abierta' o 'perdida'. "Saldada" NO va aquí: se deduce de los abonos.
  estado          text not null default 'abierta' check (estado in ('abierta','perdida')),

  fecha_pago      date,                   -- cuándo quedó de pagar

  -- Los tres zooms son etapas con fecha y estado. No mandan WhatsApp ni tocan
  -- `mensajes_programados`: programar recordatorios sigue viviendo en
  -- Seguimiento, sin duplicar esa maquinaria. Columnas explícitas y no jsonb
  -- porque sobre esto se va a reportar (cuántas en cierre, cuántas no fueron).
  pres_fecha      timestamptz, pres_estado   text not null default 'pendiente'
                  check (pres_estado   in ('pendiente','hecha','no_asistio')),
  uno_fecha       timestamptz, uno_estado    text not null default 'pendiente'
                  check (uno_estado    in ('pendiente','hecha','no_asistio')),
  cierre_fecha    timestamptz, cierre_estado text not null default 'pendiente'
                  check (cierre_estado in ('pendiente','hecha','no_asistio')),

  creado_en       timestamptz not null default now()
);

create index if not exists ventas_owner_idx   on public.ventas (owner_id);
create index if not exists ventas_cliente_idx on public.ventas (cliente_id);
create index if not exists ventas_creado_idx  on public.ventas (creado_en);

alter table public.ventas enable row level security;

-- Alcance: la regla única de siempre. El agente lo suyo; el director lo suyo
-- + lo de sus agentes. El admin, como en `clientes`, solo lo suyo.
drop policy if exists "ventas_sel" on public.ventas;
create policy "ventas_sel" on public.ventas
  for select to authenticated using (public.puede_ver_de(owner_id));

-- Crear: como en `clientes`, un director puede registrar la venta a nombre de
-- uno de sus agentes. Y una cuenta sin aprobar no crea nada: sin este
-- `aprobado()`, "en espera" sería solo una pantalla y por la API con la anon
-- key (que es pública) podría escribir igual.
--
-- La condición del cliente evita que alguien cuelgue una venta de un cliente
-- que no le corresponde: `cliente_id` viaja desde el navegador y ahí nada es
-- un límite. Se permite nulo para no romper la venta cuando el cliente se
-- borre después.
drop policy if exists "ventas_ins" on public.ventas;
create policy "ventas_ins" on public.ventas
  for insert to authenticated
  with check (
    public.puede_ver_de(owner_id)
    and public.aprobado()
    and (cliente_id is null or exists (
          select 1 from public.clientes c
           where c.id = cliente_id and public.puede_ver_de(c.owner_id)))
  );

-- OJO con la trampa de siempre: en un UPDATE la fila resultante debe seguir
-- siendo VISIBLE para quien la edita. Aquí no muerde porque el USING y el
-- WITH CHECK son la misma condición — pero si algún día se restringe el
-- SELECT (p. ej. ocultar las perdidas), reaparece.
drop policy if exists "ventas_upd" on public.ventas;
create policy "ventas_upd" on public.ventas
  for update to authenticated
  using (public.puede_ver_de(owner_id))
  with check (public.puede_ver_de(owner_id));

drop policy if exists "ventas_del" on public.ventas;
create policy "ventas_del" on public.ventas
  for delete to authenticated using (public.puede_ver_de(owner_id));


-- ───────────────────────────────────────────────────────────────────────────
-- 5. ABONOS
--
-- Pagos contra una venta. Su suma es lo facturado/recaudado, y cuando alcanza
-- el valor la venta queda saldada y la comisión se causa.
--
-- No lleva método de pago: se descartó a propósito el 29/07 (no aporta nada
-- que alguien vaya a mirar).
--
-- No lleva `owner_id`. Se pensó denormalizarlo para simplificar las políticas
-- y se descartó: al registrar un director un abono sobre la venta de su
-- agente, `default auth.uid()` pondría al director como dueño del abono y la
-- venta y su abono quedarían con dueños distintos. El dueño de un abono es,
-- por definición, el de su venta — así que se lee de ahí y no puede desviarse.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.abonos (
  id        uuid primary key default gen_random_uuid(),
  venta_id  uuid not null references public.ventas(id) on delete cascade,
  monto     numeric(12,2) not null check (monto > 0),
  fecha     date not null default current_date,
  creado_en timestamptz not null default now()
);

create index if not exists abonos_venta_idx on public.abonos (venta_id);
create index if not exists abonos_fecha_idx on public.abonos (fecha);

alter table public.abonos enable row level security;

-- Todo cuelga de la venta: si puedes verla o tocarla, puedes ver o tocar sus
-- abonos. Un solo lugar donde se decide.
drop policy if exists "abonos_all" on public.abonos;
create policy "abonos_all" on public.abonos
  for all to authenticated
  using      (exists (select 1 from public.ventas v
                       where v.id = venta_id and public.puede_ver_de(v.owner_id)))
  with check (exists (select 1 from public.ventas v
                       where v.id = venta_id and public.puede_ver_de(v.owner_id))
              and public.aprobado());


-- ───────────────────────────────────────────────────────────────────────────
-- 6. NOTAS ACUMULADAS POR CLIENTE
--
-- `clientes.nota` es un solo texto que se sobrescribe. Aquí las notas se
-- APILAN con su fecha, y en la interfaz se muestran plegadas («3 notas ·
-- última: …») para no comerse la pantalla.
--
-- Tabla aparte y no un jsonb dentro de `clientes` porque cada nota necesita
-- su fecha y su autor, y porque así no se toca la tabla que ya existe.
-- `clientes.nota` sigue funcionando igual que siempre; esto se suma.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.notas_cliente (
  id         uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references public.clientes(id) on delete cascade,
  autor_id   uuid not null default auth.uid() references auth.users(id) on delete set null,
  texto      text not null check (length(trim(texto)) > 0),
  creado_en  timestamptz not null default now()
);

create index if not exists notas_cliente_idx on public.notas_cliente (cliente_id, creado_en desc);

alter table public.notas_cliente enable row level security;

-- Cuelga del cliente, igual que los abonos cuelgan de la venta.
drop policy if exists "notas_cliente_sel" on public.notas_cliente;
create policy "notas_cliente_sel" on public.notas_cliente
  for select to authenticated
  using (exists (select 1 from public.clientes c
                  where c.id = cliente_id and public.puede_ver_de(c.owner_id)));

drop policy if exists "notas_cliente_ins" on public.notas_cliente;
create policy "notas_cliente_ins" on public.notas_cliente
  for insert to authenticated
  with check (exists (select 1 from public.clientes c
                       where c.id = cliente_id and public.puede_ver_de(c.owner_id))
              and public.aprobado());

-- Borrar solo lo propio: una nota es de quien la escribió. El director puede
-- leer las de su equipo pero no reescribirles el historial.
drop policy if exists "notas_cliente_del" on public.notas_cliente;
create policy "notas_cliente_del" on public.notas_cliente
  for delete to authenticated using (autor_id = auth.uid());


-- ───────────────────────────────────────────────────────────────────────────
-- 7. DE DÓNDE SALEN LOS FTD  (no hace falta tabla)
--
-- Un FTD es alguien que entró a la comunidad. Ese dato YA existe:
-- `clientes.comunidad_desde`.
--
-- TRAMPA EVITADA: contar «clientes con membresia = 'Beca'» habría sido lo
-- obvio y está mal. `membresia` es el nivel de HOY: en cuanto alguien sube a
-- VIP deja de ser Beca y desaparecería de los FTD de meses ya cerrados, que
-- ya se pagaron. `comunidad_desde` no se mueve nunca, y todo el que hoy es VIP
-- entró siendo un FTD.
--
--   FTD de un mes = clientes propios con comunidad_desde dentro de ese mes,
--                   sin importar en qué nivel estén ahora.
--
-- No hay nada que crear aquí: se calcula en JS sobre `state.clientes`, que ya
-- viene cargado.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- 8. PRUEBAS — correr DESPUÉS de aplicar, y comparar con lo esperado
--
-- Patrón de la casa: simular sesiones dentro de begin; … rollback;
-- Reemplazar los UUID por los reales. Y verificar DOS VECES que el "ajeno"
-- sea ajeno de verdad: ya pasó dos veces que se eligió a alguien que sí
-- colgaba del director y la prueba dio un falso positivo.
-- ───────────────────────────────────────────────────────────────────────────

/*
begin;

-- ── un AGENTE solo ve lo suyo ──────────────────────────────────────────────
select set_config('request.jwt.claims',
       json_build_object('sub','<UUID-AGENTE>','role','authenticated')::text, true);
select set_config('role','authenticated', true);

select count(*) as ventas_que_ve from public.ventas;      -- esperado: solo las suyas
select count(*) as abonos_que_ve from public.abonos;      -- esperado: solo los de sus ventas

-- colgar una venta de un cliente ajeno → debe FALLAR
insert into public.ventas (cliente_id, cliente_nombre, producto_nombre, valor)
values ('<UUID-CLIENTE-AJENO>','Prueba','Oro (promoción)',789);
                                                          -- esperado: violates RLS

-- tocar precios o comisiones → sin efecto
update public.productos set comision = 999 where id = 'oro_promo';
select comision from public.productos where id = 'oro_promo';   -- esperado: 200

-- ponerse base de FTD → sin efecto
update public.ftd_base set base = 99 where owner_id = '<UUID-AGENTE>';
select base from public.ftd_base where owner_id = '<UUID-AGENTE>';

-- ── un DIRECTOR ve lo de su equipo ─────────────────────────────────────────
select set_config('request.jwt.claims',
       json_build_object('sub','<UUID-DIRECTOR>','role','authenticated')::text, true);

select count(*) from public.ventas;                        -- esperado: suyas + de sus agentes

-- abono sobre la venta de SU agente → debe PASAR
insert into public.abonos (venta_id, monto) values ('<UUID-VENTA-DE-SU-AGENTE>', 100);

-- ── notas: el director LEE las de su equipo pero no las borra ──────────────
delete from public.notas_cliente where id = '<UUID-NOTA-DE-SU-AGENTE>';
                                                           -- esperado: 0 filas

rollback;
*/


-- ───────────────────────────────────────────────────────────────────────────
-- 9. ROLLBACK  (si hay que deshacer todo el módulo)
-- ───────────────────────────────────────────────────────────────────────────

/*
drop table if exists public.notas_cliente;
drop table if exists public.abonos;          -- cuelgan de ventas
drop table if exists public.ventas;
drop table if exists public.ftd_base;
drop table if exists public.metas_ftd;
drop table if exists public.parametros;
drop table if exists public.productos;
*/


-- ───────────────────────────────────────────────────────────────────────────
-- PENDIENTES QUE DEJA ESTE ARCHIVO
--
-- · `parametros.comision_upgrade` está en 0 (sin definir). Hasta que se ponga
--   el valor real, los upgrades se muestran como «comisión sin definir».
-- · Nueve productos tienen `comision = 0` porque en la lista del 29/07 decían
--   «por confirmar»: oro, platino, vip, bot_ia_vit, gopro_anual, gopro_vit,
--   gopro_vip, gotraders_anual, gotraders_vit, gold_anual, gold_vit.
-- · Meta mensual de FACTURACIÓN (distinta de las metas de FTD): pedida el
--   29/07, aplazada a propósito hasta que lo demás funcione.
-- ───────────────────────────────────────────────────────────────────────────
