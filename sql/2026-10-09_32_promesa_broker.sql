-- =====================================================================
--  Pendiente de depósito por bróker (2º depósito de un becado)
-- =====================================================================
--
--  POR QUÉ
--
--  La promesa de depósito (`promesa_en`) era un solo dato por persona y SIN
--  bróker, y toda la vista de Pendientes estaba amarrada a `mem = 'Lead'`. Pero
--  alguien que ya es Beca (depositó en un bróker) puede tener la oportunidad de
--  depositar en OTRO (p. ej. ya en ExOption y pendiente de IQ Option). Ese
--  pendiente necesita saber de qué bróker es, y poder existir aunque la persona
--  ya no sea lead.
--
--  `promesa_broker`:
--   · null  → promesa sin bróker: el lead en su 1er depósito (histórico, intacto).
--   · valor → pendiente de depósito en ese bróker (normalmente un 2º depósito).
--
--  Se escribe solo desde el embudo/selector «+ Pendiente de depósito», NUNCA
--  desde `mapAEditar` (igual que registro_broker/promesa_en): guardar la ficha
--  no debe pisar el embudo. Al registrar el depósito, el FTD se SUMA a `ftds`
--  (no se reemplaza) y la promesa se limpia (promesa_en + promesa_broker).
-- =====================================================================

alter table public.clientes add column if not exists promesa_broker text;

comment on column public.clientes.promesa_broker is
  'Broker objetivo de la promesa de deposito. null = promesa sin broker (lead en su 1er deposito). Con valor = pendiente de deposito en ese broker (2o deposito de un becado). Se escribe solo desde el embudo/selector, no desde mapAEditar.';
