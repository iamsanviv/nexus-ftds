-- =====================================================================
--  chats_recientes.primer_entrante_dia — primer mensaje que la persona te
--  escribió HOY (día de Colombia, UTC-5), para «te escribió hoy desde las …».
--
--  Lo publica chats_sync.py en la MISMA consulta que ya calcula entrante_en
--  (MIN en vez de MAX, acotado al día): no agrega lecturas ni peticiones.
--
--  Es el día de la ÚLTIMA sincronización, no un historial: una fila de un
--  bridge caído conserva el valor de ayer. Quien lo lea compara su fecha con
--  hoy antes de usarlo. NULL = no te escribió hoy (o el worker aún no lo
--  publica, como VM2 o un worker sin el parche).
--
--  `entrante_en` (`2026-10-05`) se agregó directo en Supabase y no tenía SQL
--  en el repo: queda registrado aquí también, idempotente.
-- =====================================================================
alter table public.chats_recientes
  add column if not exists entrante_en timestamptz,
  add column if not exists primer_entrante_dia timestamptz;

comment on column public.chats_recientes.entrante_en is
  'Último mensaje que la persona NOS escribió (is_from_me=0). ultimo_en es en cualquier dirección.';
comment on column public.chats_recientes.primer_entrante_dia is
  'Primer mensaje entrante del día (Colombia) de la última sincronización. Comparar la fecha con hoy antes de usarlo.';
