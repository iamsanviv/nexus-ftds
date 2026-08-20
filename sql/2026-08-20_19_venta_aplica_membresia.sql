-- La venta de una membresía aplica el nivel al cliente
--
-- Problema: al vender un Platino a alguien que era Beca, el nivel del cliente
-- seguía en Beca hasta que alguien se acordara de cambiarlo a mano. Y como el
-- nivel decide el progreso, los servicios requeridos y el precio del siguiente
-- upgrade, quedaba mal en varios sitios a la vez.
--
-- Ahora, cuando una venta de categoría `membresia` queda saldada, el cliente
-- sube al nivel del producto. Si esa venta deja de estar saldada —se borra un
-- abono, se corrige a la baja, se da por perdida— vuelve a lo que tenía.
--
-- Para poder volver hay que RECORDAR de dónde venía, y eso no se puede deducir:
--   * `nivel_origen` solo se llena en upgrades (de VIP para arriba), así que no
--     cubre Beca -> membresía, que es el caso más común;
--   * mirar la venta de membresía anterior falla con los clientes que entraron
--     antes de que existiera el módulo de ventas.
--
-- Por eso la columna guarda el valor tal cual, y su presencia es además la
-- señal de «esta venta tiene un nivel aplicado».

alter table public.ventas
  add column if not exists membresia_previa text;

comment on column public.ventas.membresia_previa is
  'Membresia del cliente antes de que esta venta le aplicara el nivel. NULL = sin aplicar. Es el valor de retorno al desmarcar el pago.';

alter table public.ventas
  drop constraint if exists ventas_membresia_previa_valida;
alter table public.ventas
  add constraint ventas_membresia_previa_valida
  check (membresia_previa is null
         or membresia_previa in ('Lead','Beca','VIP','Platino','Oro'));

-- Sin cambios de RLS: la columna hereda las políticas de `ventas`.
--
-- Las ventas que YA estaban saldadas antes de este cambio se quedan con NULL a
-- propósito: no se les aplica nada retroactivamente, porque su nivel actual ya
-- lo puso alguien a mano y pisarlo sería peor que dejarlo quieto.
