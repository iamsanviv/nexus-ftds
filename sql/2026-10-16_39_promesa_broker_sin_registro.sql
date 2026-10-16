-- =====================================================================
--  Pendiente de depósito por bróker sin registro previo
-- =====================================================================
--
--  POR QUÉ
--
--  `clientes_promesa_ok` (SQL 27) exigía `registro_en` para cualquier promesa:
--  pensado para el lead del embudo (abrió cuenta → prometió depositar). El
--  selector «+ Pendiente de depósito» (SQL 32, pendep.js) escribe
--  `promesa_en + promesa_broker` a becados que ya tienen FTD y nunca pasaron
--  por el registro del embudo, así que la base rechazaba el 2º depósito con
--  «violates check constraint clientes_promesa_ok».
--
--  Una promesa CON bróker ya dice dónde va a depositar; no necesita el
--  registro. La promesa SIN bróker (lead en su 1er depósito) sigue exigiéndolo.
-- =====================================================================

alter table public.clientes drop constraint if exists clientes_promesa_ok;
alter table public.clientes add constraint clientes_promesa_ok check (
  promesa_en is null or registro_en is not null or promesa_broker is not null
);
