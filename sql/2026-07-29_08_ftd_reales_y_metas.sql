-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · FTD reales, metas del agente y cierre mensual — 29 de julio de 2026
--
-- ⚠ ESTADO: NO APLICADO. Correr después de `2026-07-29_07…`, que crea
-- `ftd_base`. Idempotente.
--
-- EL PROBLEMA QUE RESUELVE
--
-- El panel contaba solo los FTD CARGADOS en la plataforma. Un agente que lleva
-- 27 pero solo ha subido 14 veía «14», y encima un mensaje sobre una base que
-- no existía. El número que ve tiene que ser el que lleva.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. LO QUE EL AGENTE DECLARA
--
--   declarado   → los FTD REALES del mes, los diga la plataforma o no.
--   base        → los que traía del mes anterior (ver punto 2).
--   cerrado     → el mes ya se reconcilió el día 1 y queda congelado.
--
-- De aquí salen las tres cifras de la interfaz:
--   reales     = coalesce(declarado, cargados)   ← el número grande
--   cargados   = clientes con comunidad_desde en el mes
--   sin subir  = max(0, declarado − cargados)    ← el chip discreto
--
-- Por eso NO hace falta marcar nada en `clientes`. Al subir uno de los que
-- faltaban, `cargados` sube y «sin subir» baja solo. Y si el cliente nuevo es
-- un FTD que NO estaba en los declarados, la casilla del formulario sube
-- `declarado` en 1. La resta se encarga del resto.
-- ───────────────────────────────────────────────────────────────────────────

alter table public.ftd_base
  add column if not exists declarado    int,
  add column if not exists declarado_en timestamptz,
  add column if not exists cerrado      boolean not null default false;

alter table public.ftd_base
  drop constraint if exists ftd_base_declarado_check;
alter table public.ftd_base
  add  constraint ftd_base_declarado_check check (declarado is null or declarado >= 0);


-- ───────────────────────────────────────────────────────────────────────────
-- 2. QUIÉN ESCRIBE LA BASE  (cambio de política, a conciencia)
--
-- Antes solo director o admin. Ahora el agente escribe su propia fila, porque
-- es él quien sabe cuántos FTD lleva de verdad y quién cierra su mes.
--
-- Se acepta el riesgo a propósito: este panel NO es la fuente de pago. Lo dice
-- el aviso legal de la pantalla — es una guía en tiempo real, no un dato
-- oficial de Nexus para reclamar. Si algún día se paga contra estos números,
-- hay que volver aquí y devolver la escritura al director.
--
-- La base manual es SOLO para arrancar: del mes siguiente en adelante la
-- escribe el cierre del día 1 a partir de lo que el agente declare como final.
-- Eso no se puede imponer desde SQL sin bloquear el propio cierre, así que la
-- app es la que solo ofrece el campo la primera vez.
-- ───────────────────────────────────────────────────────────────────────────

drop policy if exists "ftd_base_wr" on public.ftd_base;

drop policy if exists "ftd_base_ins" on public.ftd_base;
create policy "ftd_base_ins" on public.ftd_base
  for insert to authenticated
  with check (public.puede_ver_de(owner_id) and public.aprobado());

-- Un mes cerrado no se vuelve a tocar: lo que se pagó, se pagó. Solo el admin
-- puede reabrirlo, que es la válvula para cuando alguien se equivoque.
drop policy if exists "ftd_base_upd" on public.ftd_base;
create policy "ftd_base_upd" on public.ftd_base
  for update to authenticated
  using (public.puede_ver_de(owner_id) and (not cerrado or public.es_admin()))
  with check (public.puede_ver_de(owner_id));

drop policy if exists "ftd_base_del" on public.ftd_base;
create policy "ftd_base_del" on public.ftd_base
  for delete to authenticated
  using (public.puede_ver_de(owner_id) and public.mi_rol() in ('director','admin'));


-- ───────────────────────────────────────────────────────────────────────────
-- 3. METAS DEL AGENTE
--
-- Dos que fija él y una que se calcula:
--   meta_ftd     → número de FTD. Vale lo que diga `metas_ftd` para ese número.
--   meta_ventas  → dólares de comisión de VENTAS que se propone en el mes.
--   total        → el pago de meta_ftd + meta_ventas. NO se guarda: se deriva,
--                  igual que la comisión de una venta.
--
-- Por periodo y no por agente a secas: la meta de agosto no tiene por qué ser
-- la de julio, y guardar el histórico permite mirar atrás sin reescribirlo.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.metas_agente (
  owner_id    uuid not null references auth.users(id) on delete cascade,
  periodo     text not null check (periodo ~ '^\d{4}-\d{2}$'),
  meta_ftd    int not null default 0 check (meta_ftd >= 0),
  meta_ventas numeric(12,2) not null default 0 check (meta_ventas >= 0),
  creado_en   timestamptz not null default now(),
  primary key (owner_id, periodo)
);

alter table public.metas_agente enable row level security;

drop policy if exists "metas_agente_sel" on public.metas_agente;
create policy "metas_agente_sel" on public.metas_agente
  for select to authenticated using (public.puede_ver_de(owner_id));

drop policy if exists "metas_agente_wr" on public.metas_agente;
create policy "metas_agente_wr" on public.metas_agente
  for all to authenticated
  using      (public.puede_ver_de(owner_id))
  with check (public.puede_ver_de(owner_id) and public.aprobado());


-- ───────────────────────────────────────────────────────────────────────────
-- 4. PRUEBAS — dentro de begin; … rollback;
--
-- Verificar DOS VECES que el "ajeno" sea ajeno de verdad: ya pasó dos veces
-- que se eligió a alguien que sí colgaba del director y dio falso positivo.
-- ───────────────────────────────────────────────────────────────────────────

/*
begin;
select set_config('request.jwt.claims',
       json_build_object('sub','<UUID-AGENTE>','role','authenticated')::text, true);
select set_config('role','authenticated', true);

-- declara sus propios FTD → debe PASAR (esto es lo que cambió)
insert into public.ftd_base (owner_id, periodo, base, declarado, declarado_en)
values ('<UUID-AGENTE>', '2026-07', 0, 27, now())
on conflict (owner_id, periodo) do update set declarado = 27, declarado_en = now();

-- declara los de OTRO agente → debe FALLAR
insert into public.ftd_base (owner_id, periodo, base, declarado)
values ('<UUID-AJENO>', '2026-07', 99, 99);

-- un mes CERRADO no se puede reescribir
update public.ftd_base set cerrado = true where owner_id='<UUID-AGENTE>' and periodo='2026-07';
update public.ftd_base set declarado = 999 where owner_id='<UUID-AGENTE>' and periodo='2026-07';
select declarado from public.ftd_base where owner_id='<UUID-AGENTE>' and periodo='2026-07';
                                                          -- esperado: 27, no 999

-- sus metas sí, las ajenas no
insert into public.metas_agente (owner_id, periodo, meta_ftd, meta_ventas)
values ('<UUID-AGENTE>', '2026-07', 45, 600);
insert into public.metas_agente (owner_id, periodo, meta_ftd, meta_ventas)
values ('<UUID-AJENO>', '2026-07', 45, 600);            -- esperado: violates RLS

rollback;
*/


-- ───────────────────────────────────────────────────────────────────────────
-- 5. ROLLBACK
-- ───────────────────────────────────────────────────────────────────────────

/*
drop table if exists public.metas_agente;
alter table public.ftd_base
  drop column if exists declarado,
  drop column if exists declarado_en,
  drop column if exists cerrado;
-- y volver a poner la política de escritura anterior:
drop policy if exists "ftd_base_ins" on public.ftd_base;
drop policy if exists "ftd_base_upd" on public.ftd_base;
drop policy if exists "ftd_base_del" on public.ftd_base;
create policy "ftd_base_wr" on public.ftd_base
  for all to authenticated
  using      (public.puede_ver_de(owner_id) and public.mi_rol() in ('director','admin'))
  with check (public.puede_ver_de(owner_id) and public.mi_rol() in ('director','admin'));
*/
