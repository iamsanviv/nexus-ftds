-- =====================================================================
--  Masivo en serie: la serie atómica también sin `cliente_id`
-- =====================================================================
--
--  QUÉ CAMBIA
--
--  El masivo (masivo.js) ahora puede mandar hasta 4 mensajes por persona,
--  con el mismo contrato que el seguimiento a leads: el mensaje 1 va como
--  `masivo` (el tope diario lo frena) y del 2 al 4 como `masivo_parte`.
--
--  La atomicidad («o llega la serie entera o nada») la sostenía
--  `cancelar_resto_serie_lead()`, que identifica a la persona por
--  `cliente_id`. Las filas del masivo NO llevan `cliente_id`, a propósito:
--  Mi día (midia.js) cuenta un `masivo` con `cliente_id` como «le enviaste un
--  seguimiento» al lead, y un saludo general no debe tachar esa tarea.
--
--  Sin `cliente_id`, la persona dentro de una campaña es su teléfono. El
--  trigger ahora usa `cliente_id` cuando existe (leads: idéntico a antes) y el
--  teléfono cuando no (masivo).
--
--  POR QUÉ EN LA BASE Y NO EN LA INTERFAZ
--
--  Quien cancela el mensaje 1 es el worker (tope diario) o el agente desde
--  «Envíos masivos». Sin esto, una persona que no recibió el saludo recibiría
--  igual los mensajes 2..4 sueltos.
--
--  NEUTRAL AL APLICARLO: antes de este cambio no existía ningún `masivo_parte`
--  sin `cliente_id`, así que la rama nueva no toca filas existentes.
-- =====================================================================

create or replace function public.cancelar_resto_serie_lead()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  update public.mensajes_programados
     set estado = 'cancelado',
         error  = 'omitido: el mensaje anterior del seguimiento no salió'
   where campana_id = new.campana_id
     and case when new.cliente_id is not null
              then cliente_id = new.cliente_id
              else cliente_id is null and telefono = new.telefono end
     and tipo = 'masivo_parte'
     and estado = 'pendiente'
     and enviar_en > new.enviar_en;
  return null;
end $$;

-- `create or replace trigger` y no drop + create: así no hay instante sin
-- trigger mientras el worker está enviando.
create or replace trigger mensajes_cancela_serie_lead
  after update of estado on public.mensajes_programados
  for each row
  when (old.estado = 'pendiente' and new.estado in ('cancelado', 'error')
        and new.tipo in ('masivo', 'masivo_parte')
        and new.campana_id is not null)
  execute function public.cancelar_resto_serie_lead();

-- Aplicado en producción el 15/10/2026. Prueba en un bloque que termina en
-- excepción (rollback): una campaña de 2 personas × 3 mensajes sin
-- `cliente_id`; se cancela el mensaje 1 de A.
--   a1=cancelado, a2=cancelado, a3=cancelado   ← cae la serie de A
--   b1=pendiente, b2=pendiente, b3=pendiente   ← B no se toca
-- Y un lead con `cliente_id` cuyo mensaje 1 pasa a error:
--   l1=error, l2=cancelado                     ← igual que antes
