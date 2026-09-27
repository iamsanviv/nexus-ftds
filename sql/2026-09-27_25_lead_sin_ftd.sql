-- Un Lead no puede tener FTD.
--
-- APLICADA en producción el 2026-09-27.
--
--  EL DEFECTO
--
--  Ser Lead SIGNIFICA no haber hecho FTD: salir de Lead ES la conversión. La
--  ficha ya escondía el bloque de FTD para un Lead, pero esconder no es borrar.
--
--  Al SALIR de Lead el formulario rellena el broker vigente con la fecha de hoy
--  —eso es correcto, una conversión sin FTD no existe—. Al VOLVER a Lead se
--  escondía el bloque y esa fecha seguía viva, invisible, y se guardaba.
--
--  Reproducido: abrir «Nuevo cliente» → Lead → Beca → Lead → guardar.
--
--  Y no era cosmético. `ftdDelMes` cuenta las fechas de `ftds` sin mirar la
--  membresía, así que ese Lead contaba como FTD del mes. En producción había
--  exactamente uno (Edgar Barrios, 27/09/2026, owner Santiago Viveros): su mes
--  marcaba 12 cargados cuando solo 11 eran reales. El mes no estaba cerrado y
--  `declarado` ya era 12, así que `reales = max(declarado, cargados)` no cambió
--  y no se pagó nada de más — pero con un declarado menor sí habría inflado.
--
--  POR QUÉ UN CHECK Y NO SOLO EL ARREGLO EN LA FICHA
--
--  Una advertencia de interfaz no protege contra dos pestañas, contra una
--  llamada directa a la API ni contra la próxima regresión de este mismo
--  formulario. La regla es invariante, así que vive en la base.
--
--  Nótese que degradar a alguien a Lead exige limpiar `ftds` en la MISMA
--  sentencia. Es deliberado: si alguien vuelve a Lead, su FTD dejó de valer.

begin;

-- Limpieza previa: sin esto el CHECK no puede crearse.
update public.clientes
   set ftds = '{}'::jsonb
 where membresia = 'Lead' and ftds <> '{}'::jsonb;
-- `comunidad_desde` se va sola a null: la mantiene el trigger
-- `trg_clientes_sync_comunidad` desde `ftds`.

alter table public.clientes drop constraint if exists clientes_lead_sin_ftd;
alter table public.clientes add constraint clientes_lead_sin_ftd
  check (membresia <> 'Lead' or ftds = '{}'::jsonb);

commit;

-- Verificación:
--
--   select count(*) as leads_con_ftd from public.clientes
--    where membresia = 'Lead' and ftds <> '{}'::jsonb;   -- tiene que dar 0
