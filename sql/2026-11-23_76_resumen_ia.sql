-- Resumen nocturno con IA (23/11/2026, pedido de Sanviv). Un proceso en la VM
-- del bridge lee la conversación de WhatsApp de cada cliente, transcribe los
-- audios del día y escribe `clientes.necesidad` y `clientes.recomendacion`
-- (SQL 75). Decisiones de Sanviv: cada noche, solo los clientes que escribieron
-- ese día; la IA REEMPLAZA siempre lo que haya (aunque se haya editado a mano).
--
-- Quién lo tiene: solo los agentes listados aquí. Tabla propia y no `config`
-- porque `config` la editan directores desde el panel, y activar la lectura de
-- los chats de un agente no es decisión de su director.
create table if not exists public.resumen_ia_agentes (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  desde timestamptz not null default now()
);
alter table public.resumen_ia_agentes enable row level security;
-- Sin políticas: ni anon ni authenticated la leen o escriben; solo service_role.
revoke all on public.resumen_ia_agentes from anon, authenticated;

insert into public.resumen_ia_agentes (owner_id)
values ('a70d2670-74b2-4eb7-be6e-ed3c92068c14')   -- Santiago Viveros
on conflict do nothing;

-- Credenciales de Workers AI (las mismas de la pregunta del link) y los
-- clientes de Comunidad de esos agentes, con lo que la IA necesita para
-- orientar la recomendación. Solo service_role.
create or replace function public.resumen_ia_pendiente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cuenta', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_account_id'),
    'token',  (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_ai_token'),
    'clientes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'owner_id', c.owner_id, 'nombre', c.nombre,
               'telefono', public.clave_tel(c.telefono), 'membresia', c.membresia,
               'comunidad_desde', c.comunidad_desde, 'zooms', c.zooms))
        from public.clientes c
        join public.resumen_ia_agentes a on a.owner_id = c.owner_id
       where c.membresia <> 'Lead' and c.inactivo_desde is null
         and coalesce(c.telefono, '') <> ''), '[]'::jsonb));
$$;
revoke all on function public.resumen_ia_pendiente() from public, anon, authenticated;
grant execute on function public.resumen_ia_pendiente() to service_role;
