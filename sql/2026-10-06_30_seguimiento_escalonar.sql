-- =====================================================================
--  Seguimiento de leads: escalonar también entre leads (opción nueva)
-- =====================================================================
--
--  Hasta ahora, «por usuario + N minutos» separaba por N minutos los
--  mensajes DENTRO de la serie de cada lead, pero los leads entre sí
--  arrancaban al ritmo del worker (~7 s). Eso amontona los saludos en la
--  vista de salida del agente (varios casi a la vez).
--
--  `escalona` agrega la opción de que cada lead arranque N minutos después
--  del anterior, con el mismo intervalo de la serie, para que ni los saludos
--  se junten. Solo tiene efecto en «por usuario» con minutos (> 0); en
--  «pausa natural» o «por mensaje» se ignora. Default false: las plantillas
--  y los envíos existentes conservan el comportamiento anterior.
--
--  Es un ADD COLUMN puro (no deriva de modo/espera_min: es una elección
--  independiente del agente, la lee envioleads.js al programar y el editor
--  de plantillas al reabrirlas).
-- =====================================================================

alter table public.plantillas_lead
  add column if not exists escalona boolean not null default false;

comment on column public.plantillas_lead.escalona is
  'Seguimiento por usuario con minutos: si true, cada lead arranca N minutos despues del anterior (no al ritmo del worker), para que ni los saludos se junten. Se ignora en pausa natural o por mensaje.';
