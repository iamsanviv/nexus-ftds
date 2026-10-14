-- =====================================================================
--  Historial de plantillas de seguimiento por lead
-- =====================================================================
--
--  QUÉ RESUELVE
--
--  El agente necesita saber qué plantilla (`plantillas_lead`) ya le mandó a
--  cada lead para no repetirla. El envío ya deja rastro por lead en
--  `mensajes_programados` (cliente_id + campana_id, el mensaje 1 con tipo
--  `masivo`), pero la campaña solo guardaba el NOMBRE: renombrar la plantilla
--  rompía el vínculo y dos plantillas con el mismo nombre eran indistinguibles.
--
--  `campanas.plantilla_id` es ese vínculo. Null = envío sin plantilla guardada
--  (borrador «Nueva (sin guardar)») o masivo normal. `on delete set null`:
--  borrar la plantilla no borra el historial, que sigue mostrando el nombre de
--  la campaña.
--
--  El historial NO se guarda aparte: se deriva de `mensajes_programados`
--  (pendiente = programada, enviado = recibida). Una tabla propia se
--  desincronizaría con cancelaciones y fallos del worker.
-- =====================================================================

alter table public.campanas
  add column if not exists plantilla_id uuid references public.plantillas_lead(id) on delete set null;

create index if not exists campanas_plantilla_idx on public.campanas (plantilla_id) where plantilla_id is not null;

-- Relleno de lo ya enviado: la campaña lleva el nombre de la plantilla
-- recortado a 60. Solo se enlaza cuando hay UNA plantilla del mismo dueño con
-- ese nombre; si hay ambigüedad se deja null antes que adivinar.
update public.campanas c
   set plantilla_id = p.id
  from public.plantillas_lead p
 where c.lead_tipo is not null
   and c.plantilla_id is null
   and p.owner_id = c.owner_id
   and left(p.nombre, 60) = c.nombre
   and (select count(*) from public.plantillas_lead q
         where q.owner_id = c.owner_id and left(q.nombre, 60) = c.nombre) = 1;
