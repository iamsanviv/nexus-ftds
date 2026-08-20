-- Desfase horario del cliente
--
-- Problema: las plantillas de seguimiento anuncian la hora de la actividad en
-- hora Colombia («a las 7:00 p. m. (hora Colombia)»). Quien vive en España o en
-- México centro tiene que convertirla de cabeza, y algunos no llegan por eso.
--
-- Se guarda la diferencia con Colombia en MINUTOS, no en horas, porque hay
-- husos a la media hora. NULL significa «no se sabe»: en ese caso el mensaje
-- sigue anunciando hora Colombia, exactamente como antes de este cambio.
--
-- OJO: es un desfase fijo, no un huso horario. Los países con horario de verano
-- (España, México, Chile, EEUU) cambian dos veces al año y el número hay que
-- corregirlo a mano. Guardar un huso IANA lo resolvería solo, pero obliga al
-- agente a elegir zona en vez de un número que puede deducir de una charla
-- («aquí son las 3, allá las 9»).

alter table public.clientes
  add column if not exists tz_offset_min integer;

comment on column public.clientes.tz_offset_min is
  'Diferencia horaria con Colombia en minutos. NULL = desconocida (se anuncia hora Colombia).';

-- Es una diferencia entre dos husos, no un huso: el rango real va de -7h a +19h.
-- El tope se deja holgado para no tener que migrar si aparece un caso raro.
alter table public.clientes
  drop constraint if exists clientes_tz_offset_min_rango;
alter table public.clientes
  add constraint clientes_tz_offset_min_rango
  check (tz_offset_min is null or tz_offset_min between -720 and 1140);

-- Sin cambios de RLS: la columna hereda las políticas de `clientes`, que ya
-- limitan lectura y escritura por `owner_id` / `puede_ver_de(owner)`.
