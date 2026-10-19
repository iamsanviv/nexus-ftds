-- =====================================================================
--  Aviso push «Lead nuevo de HighLevel»
--  Aplicado el 2026-10-19 con el MCP de Supabase.
--
--  Un lead de HighLevel se atiende antes que cualquier pendiente: llega
--  fresco. El aviso sale cuando la Edge Function `highlevel-lead` INSERTA
--  la fila (contacto nuevo para ese agente). Una reasignación del mismo
--  contacto es un UPDATE y no vuelve a avisar.
--
--  Mecánica de entrega: sql/2026-10-14_34_notificaciones_push.sql.
-- =====================================================================

alter table public.notificaciones drop constraint notificaciones_tipo_check,
  add constraint notificaciones_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl','prueba'));
alter table public.notif_apagadas drop constraint notif_apagadas_tipo_check,
  add constraint notif_apagadas_tipo_check check (tipo in ('respondio','escribio_hoy','temperatura','zoom','canal','sin_respuesta','lead_hl'));

create or replace function public.notificar_lead_hl()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform public.notificar(new.owner_id, 'lead_hl', 'hl:' || new.id,
    'Lead nuevo: ' || coalesce(nullif(trim(new.nombre), ''), 'sin nombre'),
    case when new.estado = 'bajo' then 'De HighLevel · ya te escribe por WhatsApp'
         when new.telefono is null then 'De HighLevel · llegó sin teléfono'
         else 'De HighLevel · ' || new.telefono || ' · llámalo ahora' end);
  return null;
exception when others then
  -- Corre dentro de la inserción del webhook: un aviso nunca la tumba
  -- (si fallara, HighLevel reintentaría y el lead llegaría duplicado).
  raise warning 'notificar_lead_hl falló: %', sqlerrm;
  return null;
end $$;
revoke all on function public.notificar_lead_hl() from public, anon, authenticated;

drop trigger if exists crm_leads_notifica on public.crm_leads;
create trigger crm_leads_notifica after insert on public.crm_leads
  for each row execute function public.notificar_lead_hl();
