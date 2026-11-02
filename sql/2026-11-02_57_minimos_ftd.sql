-- =====================================================================
--  Mínimos de pago de FTD: 35 = 280 USD y 25 = 200 USD
--  Aplicado el 2026-11-02 con el MCP de Supabase, DESPUÉS de fusionar el
--  frontend que los separa: el frontend anterior los habría ofrecido como
--  metas en el cuadro de la meta.
--
--  Pedido de Sanviv (02/11/2026): «Se agrega 35 y 25, pero el sistema debe
--  preguntar si te pagarán los 35 o 25 que hagas (con opción de cambiarlo).
--  No agregarlo como si fuera meta, solo que aparezca al final de mes y en
--  las cuentas.»
--
--  - metas_ftd.minimo marca los escalones que NO son metas: cada agente elige
--    uno y solo entra en el cálculo de la comisión. El frontend los separa al
--    cargar (data.js) para que el cuadro de la meta nunca los ofrezca.
--  - ftd_base.minimo guarda el mínimo elegido por mes: un mes cerrado conserva
--    el suyo aunque el agente cambie después. Un mes sin valor hereda el del
--    último mes que lo tuvo (minimoDe en state.js). null = nunca respondió.
-- =====================================================================

alter table public.metas_ftd
  add column if not exists minimo boolean not null default false;

insert into public.metas_ftd (ftd, pago, minimo) values
  (25, 200, true), (35, 280, true)
on conflict (ftd) do update set pago = excluded.pago, minimo = true;

alter table public.ftd_base
  add column if not exists minimo int references public.metas_ftd(ftd) on update cascade;

-- RLS sin cambios: ftd_base ya deja al dueño escribir su mes mientras no esté
-- cerrado (ftd_base_upd) y metas_ftd solo la escriben director/admin.
