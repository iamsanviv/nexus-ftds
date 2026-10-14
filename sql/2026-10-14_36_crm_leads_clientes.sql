-- =====================================================================
--  Leads de HighLevel como personas de Nexus (decisión del 14/10/2026)
--
--  El lead de HighLevel entra como lead de Nexus AL LLEGAR (la Edge Function
--  `highlevel-lead` crea o enlaza el `clientes` y guarda `crm_leads.cliente_id`),
--  para poder anotarle registro y promesa antes de que baje a WhatsApp.
--  «Por bajar» NO es una columna de clientes: se deriva de `crm_leads`
--  (estado distinto de 'bajo' y sin mensaje entrante posterior a `asignado_en`).
--
--  `respondio_en`: «Me respondió en el CRM», marcado a mano. Nexus no ve el
--  chat de HighLevel; lo sube a la etapa «Te escribieron» del día.
-- =====================================================================
alter table public.crm_leads add column if not exists respondio_en timestamptz;

-- Los leads que llegaron antes de este cambio: se crean como personas.
with nuevos as (
  insert into public.clientes (owner_id, nombre, telefono, membresia, creado)
  select l.owner_id, coalesce(nullif(l.nombre, ''), l.telefono, 'Lead de HighLevel'), l.telefono, 'Lead',
         (l.asignado_en at time zone 'America/Bogota')::date
  from public.crm_leads l
  where l.cliente_id is null and l.estado <> 'bajo'
  returning id, owner_id, nombre, telefono, creado
)
update public.crm_leads l set cliente_id = n.id
from nuevos n
where l.cliente_id is null and l.owner_id = n.owner_id
  and coalesce(nullif(l.nombre, ''), l.telefono, 'Lead de HighLevel') = n.nombre
  and l.telefono is not distinct from n.telefono;
