-- =====================================================================
--  Etapas «Posible» y «Caídos» del panel «Hoy» de Leads
--  Aplicado el 2026-11-08 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ (decisiones de Sanviv, 07–08/11/2026)
--
--  Pendientes se inflaba con promesas vencidas que ya no eran reales. Ahora:
--  · «Pendientes vencidos» se DERIVA de `promesa_en` (2+ días después de la
--    fecha prometida): no necesita columna.
--  · «Posible»: a quien creó cuenta se le habló de depósito sin promesa. La
--    fecha es opcional. Hace falta saber CUÁNDO se marcó para vencerlo a los
--    2 días cuando no hay fecha → `posible_en` (marca) + `posible_fecha`.
--  · «Caídos»: el agente marca a mano que el lead decidió no depositar. Es una
--    decisión del agente, no derivable de nada → `caido_en`. Se deshace
--    poniéndola en null. La promesa se conserva (al deshacer vuelve donde estaba).
--
--  Reglas en base: un Posible requiere cuenta (la regla de la UI), y una fecha
--  de Posible sin marca no significa nada.
-- =====================================================================

alter table public.clientes
  add column if not exists posible_en    timestamptz,
  add column if not exists posible_fecha date,
  add column if not exists caido_en      timestamptz;

alter table public.clientes add constraint clientes_posible_ok check (
  (posible_en is null or registro_en is not null)
  and (posible_fecha is null or posible_en is not null)
);

comment on column public.clientes.posible_en    is 'Lead: cuándo se marcó como posible depósito (se le habló de depósito, sin promesa). Requiere registro.';
comment on column public.clientes.posible_fecha is 'Lead: fecha opcional en que posiblemente deposita. Sin ella, el Posible vence a los 2 días de posible_en.';
comment on column public.clientes.caido_en      is 'Lead: cuándo el agente lo marcó como Caído (decidió no depositar). null = no caído.';
