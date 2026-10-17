-- =====================================================================
--  Tipos de seguimiento «Urgencia» y «Depósito»
-- =====================================================================
--
--  POR QUÉ
--
--  El tipo de un seguimiento de leads vive en tres tablas con la misma lista
--  cerrada (SQL 27 y 29): `plantillas_lead.tipo`, `campanas.lead_tipo` y
--  `lead_contactos.tipo` (el trigger del SQL 29 copia el tipo de la campaña al
--  contacto al enviar). Agregar un tipo solo en la plantilla haría fallar el
--  envío; por eso se amplían las tres a la vez.
--
--  · urgencia: que actúe ya porque se agotan los cupos.
--  · deposito: pedirle directamente que deposite.
--
--  Solo amplía la lista: ninguna fila existente cambia.
-- =====================================================================

alter table public.lead_contactos drop constraint if exists lead_contactos_tipo_check;
alter table public.lead_contactos add constraint lead_contactos_tipo_check check (tipo in
  ('objecion','prueba_social','valor','fidelizacion','novedad','urgencia','deposito','otro'));

alter table public.plantillas_lead drop constraint if exists plantillas_lead_tipo_check;
alter table public.plantillas_lead add constraint plantillas_lead_tipo_check check (tipo in
  ('objecion','prueba_social','valor','fidelizacion','novedad','urgencia','deposito','otro'));

alter table public.campanas drop constraint if exists campanas_lead_tipo_ok;
alter table public.campanas add constraint campanas_lead_tipo_ok check (lead_tipo is null or lead_tipo in
  ('objecion','prueba_social','valor','fidelizacion','novedad','urgencia','deposito','otro'));
