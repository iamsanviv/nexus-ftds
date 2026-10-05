-- =====================================================================
--  Leads · seguimiento (F1): contactos, embudo y temperatura manual
--  PENDIENTE DE APLICAR (probado en transacción con rollback el 2026-10-05: 15 casos de RLS y constraints OK).
-- =====================================================================
--
--  QUÉ GUARDA
--
--  1. `lead_contactos`: cada vez que el agente le escribe a un lead, con el
--     PARA QUÉ (6 tipos), una nota, y si respondió. La respuesta se marca
--     después —casi nunca el mismo día—, por eso va en columnas aparte
--     (`respuesta`, `respuesta_en`) y no al crear el contacto.
--
--  2. En `clientes`, el embudo hacia la beca:
--       registro_broker + registro_en  → «abrió cuenta en el broker»
--       promesa_en                     → «prometió depositar» (fecha y hora):
--                                        es lo que convierte al lead en
--                                        PENDIENTE, la máxima prioridad.
--     «Depositó» NO tiene columna: es el FTD de siempre (`ftds`) y el paso a
--     Beca. Duplicarlo daría dos verdades sobre lo mismo.
--
--  3. `temp_manual` + `temp_manual_en`: la corrección a mano de la
--     temperatura. Dura hasta el SIGUIENTE CONTACTO; eso se deriva comparando
--     `temp_manual_en` con el último contacto, sin bandera de «vigente».
--
--  POR QUÉ SOLO EL DUEÑO REGISTRA CONTACTOS
--
--  Visibilidad no es propiedad: un director ve los leads de su equipo
--  (`puede_ver_de`), pero «le escribí» es un acto del agente dueño. Un trigger
--  fija `owner_id` = dueño del lead, y la política exige que ese dueño sea
--  quien inserta. Así un director no puede ensuciar el historial de un agente
--  ni crear contactos a nombre de otro, aunque llame a la API directo.
-- =====================================================================

-- ---------------------------------------------------------------- contactos
create table if not exists public.lead_contactos (
  id           uuid primary key default gen_random_uuid(),
  cliente_id   uuid not null references public.clientes(id) on delete cascade,
  owner_id     uuid not null default auth.uid() references auth.users(id),
  tipo         text not null check (tipo in
                 ('objecion','prueba_social','valor','fidelizacion','novedad','otro')),
  nota         text check (nota is null or length(nota) <= 2000),
  en           timestamptz not null default now(),
  respuesta    text check (respuesta in ('si','no')),
  respuesta_en timestamptz,
  -- Una respuesta sin fecha no sirve para la temperatura, y una fecha sin
  -- respuesta no dice nada.
  constraint lead_contactos_respuesta_ok
    check ((respuesta is null) = (respuesta_en is null))
);

create index if not exists lead_contactos_cliente_en on public.lead_contactos (cliente_id, en desc);
create index if not exists lead_contactos_owner_en   on public.lead_contactos (owner_id, en desc);

comment on table public.lead_contactos is
  'Contactos del agente con sus leads (para qué, nota, si respondió). Solo el dueño del lead los crea; owner_id lo fija un trigger.';

-- El dueño del contacto ES el dueño del lead, y no se puede mover de lead ni de
-- dueño después. Lo fija el servidor: el cliente no decide a nombre de quién.
create or replace function public.lead_contacto_dueno()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if tg_op = 'INSERT' then
    select owner_id into new.owner_id from public.clientes where id = new.cliente_id;
    if new.owner_id is null then
      raise exception 'Lead inexistente' using errcode = '23503';
    end if;
  else
    new.cliente_id := old.cliente_id;
    new.owner_id   := old.owner_id;
    new.en         := old.en;
  end if;
  return new;
end
$$;

drop trigger if exists lead_contactos_dueno on public.lead_contactos;
create trigger lead_contactos_dueno
  before insert or update on public.lead_contactos
  for each row execute function public.lead_contacto_dueno();

alter table public.lead_contactos enable row level security;

drop policy if exists "ver contactos propios o director" on public.lead_contactos;
create policy "ver contactos propios o director" on public.lead_contactos
  for select using (puede_ver_de(owner_id));

drop policy if exists "crear contactos de mis leads" on public.lead_contactos;
create policy "crear contactos de mis leads" on public.lead_contactos
  for insert with check (owner_id = auth.uid() and aprobado());

drop policy if exists "editar mis contactos" on public.lead_contactos;
create policy "editar mis contactos" on public.lead_contactos
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "borrar mis contactos" on public.lead_contactos;
create policy "borrar mis contactos" on public.lead_contactos
  for delete using (owner_id = auth.uid());

grant select, insert, update, delete on public.lead_contactos to authenticated;

-- ------------------------------------------------------------------- embudo
alter table public.clientes
  add column if not exists registro_broker text,
  add column if not exists registro_en     date,
  add column if not exists promesa_en      timestamptz,
  add column if not exists temp_manual     text,
  add column if not exists temp_manual_en  timestamptz;

alter table public.clientes drop constraint if exists clientes_registro_ok;
alter table public.clientes add constraint clientes_registro_ok check (
  -- Broker y fecha van juntos, con la misma forma de clave que `ftds`.
  (registro_broker is null) = (registro_en is null)
  and (registro_broker is null or registro_broker ~ '^[a-z0-9_]{2,24}$')
);

alter table public.clientes drop constraint if exists clientes_promesa_ok;
alter table public.clientes add constraint clientes_promesa_ok check (
  -- Un pendiente es alguien que YA abrió cuenta y prometió depositar.
  promesa_en is null or registro_en is not null
);

alter table public.clientes drop constraint if exists clientes_temp_ok;
alter table public.clientes add constraint clientes_temp_ok check (
  (temp_manual is null) = (temp_manual_en is null)
  and (temp_manual is null or temp_manual in ('caliente','tibio','frio'))
);

comment on column public.clientes.registro_broker is 'Lead: broker donde abrió cuenta (misma clave que ftds). Con registro_en.';
comment on column public.clientes.registro_en     is 'Lead: fecha en que abrió cuenta en el broker.';
comment on column public.clientes.promesa_en      is 'Lead: fecha y hora en que prometió depositar. Lo vuelve PENDIENTE. Requiere registro.';
comment on column public.clientes.temp_manual     is 'Lead: temperatura corregida a mano. Vale hasta el siguiente contacto (se deriva con temp_manual_en).';
