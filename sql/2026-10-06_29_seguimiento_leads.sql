-- =====================================================================
--  Seguimiento de leads: plantillas en serie + registro automático
-- =====================================================================
--
--  QUÉ GUARDA
--
--  1. `plantillas_lead`: flujos reutilizables («saludo + video + pregunta»),
--     de 1 a 4 mensajes, cada uno con texto y/o adjunto, con su TIPO de
--     seguimiento (los mismos 6 de `lead_contactos`) y cómo se envían (por
--     usuario / por mensaje, pausa natural / minutos). Privadas de cada agente.
--
--  2. `campanas.lead_tipo`: una campaña con tipo ES un seguimiento de leads.
--     Sale por el mismo camino que el masivo (`pool()` en masivo.js): no se
--     abre una tercera vía de envío.
--
--  3. `mensajes_programados.cliente_id`: a quién va cada mensaje de una
--     campaña de leads. Un masivo solo guardaba el teléfono; para anotar el
--     contacto en la ficha del lead hace falta el lead, no un número.
--
--  POR QUÉ SIN `parte`
--
--  El orden de la serie lo da `enviar_en`, que es como el worker envía. La
--  invitación necesita `parte` para regenerar textos al cambiar la hora de la
--  actividad; un seguimiento no tiene hora que cambie.
--
--  LOS TRIGGERS
--
--  · Serie atómica: si un mensaje de un lead no sale (tope del worker, error,
--    cancelación), se cancelan los siguientes de ESE lead en esa campaña. El
--    mensaje 1 va como `masivo` (el tope lo frena) y del 2 al 4 como
--    `masivo_parte` (el tope no los corta): o llega la serie entera o nada.
--  · Registro: cuando el mensaje 1 sale de verdad, se anota el contacto en
--    `lead_contactos` con el tipo de la campaña y la hora real de envío. Al
--    programar no: un envío que falla dejaría un contacto falso y la
--    temperatura mentiría.
-- =====================================================================

create or replace function public.mensajes_lead_ok(m jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(m) = 'array'
    and jsonb_array_length(m) between 1 and 4
    and not exists (
      select 1 from jsonb_array_elements(m) p
      where jsonb_typeof(p) <> 'object'
         or (coalesce(btrim(p->>'texto'), '') = '' and coalesce(p->>'media', '') = '')
         or length(coalesce(p->>'texto', '')) > 4000)
$$;

create table if not exists public.plantillas_lead (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nombre         text not null check (length(btrim(nombre)) between 1 and 80),
  tipo           text not null check (tipo in
                   ('objecion','prueba_social','valor','fidelizacion','novedad','otro')),
  mensajes       jsonb not null check (public.mensajes_lead_ok(mensajes)),
  modo           text not null default 'usuario' check (modo in ('usuario','mensaje')),
  espera_min     smallint not null default 0 check (espera_min between 0 and 120),
  creado_en      timestamptz not null default now(),
  actualizado_en timestamptz not null default now()
);
create index if not exists plantillas_lead_owner on public.plantillas_lead (owner_id, actualizado_en desc);

alter table public.plantillas_lead enable row level security;
-- Privadas: son la forma de escribir de cada agente, como sus plantillas de
-- actividad. Un director no las necesita para supervisar.
create policy "plantillas lead propias" on public.plantillas_lead
  for select using (owner_id = auth.uid());
create policy "crear plantillas lead" on public.plantillas_lead
  for insert with check (owner_id = auth.uid() and aprobado());
create policy "editar plantillas lead" on public.plantillas_lead
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "borrar plantillas lead" on public.plantillas_lead
  for delete using (owner_id = auth.uid());
grant select, insert, update, delete on public.plantillas_lead to authenticated;

alter table public.campanas add column if not exists lead_tipo text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'campanas_lead_tipo_ok') then
    alter table public.campanas add constraint campanas_lead_tipo_ok check (
      lead_tipo is null or lead_tipo in ('objecion','prueba_social','valor','fidelizacion','novedad','otro'));
  end if;
end $$;
comment on column public.campanas.lead_tipo is
  'Tipo de seguimiento de leads (los de lead_contactos). null = masivo normal.';

alter table public.mensajes_programados
  add column if not exists cliente_id uuid references public.clientes(id) on delete cascade;
create index if not exists mensajes_campana_cliente on public.mensajes_programados (campana_id, cliente_id)
  where campana_id is not null;
comment on column public.mensajes_programados.cliente_id is
  'Lead destinatario en un seguimiento de leads (campana con lead_tipo). Para anotar el contacto al enviar.';

-- Serie atómica por lead.
create or replace function public.cancelar_resto_serie_lead()
returns trigger language plpgsql set search_path to 'public' as $$
begin
  update public.mensajes_programados
     set estado = 'cancelado',
         error  = 'omitido: el mensaje anterior del seguimiento no salió'
   where campana_id = new.campana_id
     and cliente_id = new.cliente_id
     and tipo = 'masivo_parte'
     and estado = 'pendiente'
     and enviar_en > new.enviar_en;
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'mensajes_cancela_serie_lead') then
    create trigger mensajes_cancela_serie_lead
      after update of estado on public.mensajes_programados
      for each row
      when (old.estado = 'pendiente' and new.estado in ('cancelado', 'error')
            and new.tipo in ('masivo', 'masivo_parte')
            and new.campana_id is not null and new.cliente_id is not null)
      execute function public.cancelar_resto_serie_lead();
  end if;
end $$;

-- Registro del contacto al ENVIAR el mensaje 1. security definer: lo dispara
-- el worker (service role) y la ficha es del dueño del lead; el dueño lo fija
-- el trigger de lead_contactos desde el cliente, no quien inserta.
create or replace function public.registrar_contacto_lead()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  insert into public.lead_contactos (cliente_id, tipo, nota, en)
  select new.cliente_id, c.lead_tipo, left(c.nombre, 2000), coalesce(new.enviado_en, now())
    from public.campanas c
   where c.id = new.campana_id and c.lead_tipo is not null;
  return null;
end $$;

do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'mensajes_registra_contacto_lead') then
    create trigger mensajes_registra_contacto_lead
      after update of estado on public.mensajes_programados
      for each row
      when (old.estado is distinct from 'enviado' and new.estado = 'enviado'
            and new.tipo = 'masivo'
            and new.campana_id is not null and new.cliente_id is not null)
      execute function public.registrar_contacto_lead();
  end if;
end $$;
