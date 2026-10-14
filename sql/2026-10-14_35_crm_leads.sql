-- =====================================================================
--  crm_leads — leads de HighLevel en «Mi día» (fase 2)
--
--  El agente no tiene token de la API de HighLevel (es usuario de una
--  subcuenta), así que los leads llegan EMPUJADOS: un workflow suyo llama a
--  la Edge Function `highlevel-lead` cuando el contacto queda asignado a él.
--  La función identifica al agente por un token secreto propio en la URL
--  (`crm_tokens`) y es la única que inserta; el agente solo lee y anota.
--
--  Reglas (entrevista del 14/10/2026): llamar y escribir; resultados
--  contesto/no_contesto/buzon/numero_malo/no_interesa; reintento a las 2 h y
--  al día siguiente; solo hoy y ayer salvo «seguir» con fecha propia.
-- =====================================================================

create table if not exists public.crm_tokens (
  owner_id   uuid primary key references auth.users(id) on delete cascade default auth.uid(),
  token      text not null unique default encode(extensions.gen_random_bytes(18), 'hex'),
  created_at timestamptz not null default now()
);
alter table public.crm_tokens enable row level security;
drop policy if exists crm_tokens_own on public.crm_tokens;
-- Solo el dueño ve y crea su token. Sin update: rotarlo es borrar y crear.
create policy crm_tokens_own on public.crm_tokens for select to authenticated using (owner_id = auth.uid());
drop policy if exists crm_tokens_ins on public.crm_tokens;
create policy crm_tokens_ins on public.crm_tokens for insert to authenticated
  with check (owner_id = auth.uid() and public.aprobado());
drop policy if exists crm_tokens_del on public.crm_tokens;
create policy crm_tokens_del on public.crm_tokens for delete to authenticated using (owner_id = auth.uid());

create table if not exists public.crm_leads (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users(id) on delete cascade,
  ghl_id          text not null,            -- id del contacto en HighLevel
  nombre          text,
  telefono        text,
  email           text,
  asignado_en     timestamptz not null default now(),
  -- pendiente: en la guía · bajo: ya escribe por WhatsApp · seguir: vuelve en
  -- `siguiente_en` · fuera: número malo, sin interés o sin más intentos.
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente','bajo','seguir','fuera')),
  intentos        smallint not null default 0,
  resultado       text check (resultado in ('contesto','no_contesto','buzon','numero_malo','no_interesa')),
  resultado_en    timestamptz,
  vuelve_en       timestamptz,               -- reintento: oculto hasta esta hora
  escribi_en      timestamptz,               -- «Le escribí» desde HighLevel
  siguiente       text check (siguiente in ('bajara','crm','llamada')),
  siguiente_en    timestamptz,
  cliente_id      uuid references public.clientes(id) on delete set null,
  payload         jsonb,
  created_at      timestamptz not null default now(),
  unique (owner_id, ghl_id)
);
create index if not exists crm_leads_owner_asig on public.crm_leads (owner_id, asignado_en desc);

alter table public.crm_leads enable row level security;
-- Propiedad estricta (owner_id = auth.uid()), sin `puede_ver_de`: es una lista
-- de trabajo y las anotaciones son del dueño, como en el panel «Hoy».
drop policy if exists crm_leads_sel on public.crm_leads;
create policy crm_leads_sel on public.crm_leads for select to authenticated using (owner_id = auth.uid());
drop policy if exists crm_leads_upd on public.crm_leads;
create policy crm_leads_upd on public.crm_leads for update to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());
-- Sin insert/delete para authenticated: solo la Edge Function (service role) inserta.
