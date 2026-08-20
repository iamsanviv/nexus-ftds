-- Personas inactivas
--
-- Problema: hay gente que dejó de responder o pidió no seguir, y no había forma
-- de distinguirla. Seguían apareciendo en la lista para programar y en las
-- campañas masivas, así que recibían mensajes que nadie iba a leer.
--
-- Una persona inactiva NO se borra: conserva asistencia, ventas e historial.
-- Solo deja de ser candidata a recibir mensajes.
--
-- `inactivo_desde` NULL = activa, que es el estado de siempre. Toda la base
-- existente queda activa sin migrar nada.
--
-- El motivo es SOLO un dato: la exclusión es idéntica para los cuatro. Se
-- guarda para poder distinguir después «se enfrió» de «pidió que no le
-- escriba», por si algún día esa diferencia tiene que pesar.
--
-- Estado y membresía son ejes independientes: alguien puede ser Oro e inactivo.
-- Por eso NO se metió como un valor más de `membresia`, que habría contaminado
-- el cálculo de FTD y comisiones.

alter table public.clientes
  add column if not exists inactivo_desde timestamptz,
  add column if not exists inactivo_motivo text;

comment on column public.clientes.inactivo_desde is
  'Cuando se marco inactiva. NULL = activa. No recibe mensajes programados ni masivos.';
comment on column public.clientes.inactivo_motivo is
  'Por que: no_responde | no_quiere | numero_malo | otro. Solo dato; la exclusion es la misma para todos.';

alter table public.clientes
  drop constraint if exists clientes_inactivo_motivo_valido;
alter table public.clientes
  add constraint clientes_inactivo_motivo_valido
  check (inactivo_motivo is null
         or inactivo_motivo in ('no_responde','no_quiere','numero_malo','otro'));

-- Un motivo sin fecha sería un estado a medias: la fila diría «no quiere
-- continuar» y el sistema le seguiría escribiendo. Los dos campos van juntos.
alter table public.clientes
  drop constraint if exists clientes_inactivo_coherente;
alter table public.clientes
  add constraint clientes_inactivo_coherente
  check ((inactivo_desde is null) = (inactivo_motivo is null));

-- La lista de Personas y los dos cuellos de envío filtran por esto en cada
-- render; con 500+ filas por agente el índice parcial se paga solo.
create index if not exists clientes_activos_idx
  on public.clientes (owner_id) where inactivo_desde is null;

-- Sin cambios de RLS: las columnas heredan las políticas de `clientes`.
