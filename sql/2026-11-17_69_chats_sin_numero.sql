-- =====================================================================
--  69 · chats_sin_numero — quien te escribió y WhatsApp no deja ver su número
-- =====================================================================
--
--  POR QUÉ
--
--  `chats_sync` solo publicaba en `chats_recientes` los chats cuya identidad
--  oculta (LID) whatsmeow sabe traducir a teléfono. El resto se descartaba en
--  silencio. Medido el 17/11/2026: 326 chats de los últimos 30 días en las dos
--  VM (~8%), gente que escribió y que el agente no podía registrar desde
--  «Traer de un chat reciente».
--
--  POR QUÉ UNA TABLA APARTE Y NO `telefono` NULL EN `chats_recientes`
--
--  Todo lo que lee `chats_recientes` cruza por teléfono: «te escribió»,
--  temperatura, notificaciones push, pregunta del link, transcripción de
--  audios. Su PK es (owner_id, telefono). Meter filas sin teléfono ahí obliga
--  a revisar cada uno de esos consumidores; aquí no tocan nada.
--
--  `clientes.wa_lid` guarda de qué chat sin número se registró la persona.
--  Lo lee el selector para no volver a ofrecerla, y es lo que permitiría más
--  adelante enviarle por su LID o completar su número cuando se conozca.
--  Mientras no tenga teléfono NO recibe mensajes: `mios()` y `pool()` ya
--  exigen teléfono, igual que con los 92 clientes sin número que ya existían.
-- =====================================================================

create table if not exists public.chats_sin_numero (
  -- Mismo significado que en `chats_recientes`: de quién es el WhatsApp.
  owner_id    uuid not null references auth.users(id) on delete cascade,
  -- La parte de usuario del JID `@lid`, solo dígitos.
  lid         text not null check (lid ~ '^[0-9]{6,20}$'),
  nombre_wa   text,
  ultimo_en   timestamptz not null,
  entrante_en timestamptz,
  visto_en    timestamptz not null default now(),
  primary key (owner_id, lid)
);

comment on table public.chats_sin_numero is
  'Chats 1:1 recientes por identidad oculta (LID) cuyo teléfono el bridge no conoce. La llena SOLO chats_sync (service role). Sirve para registrar a quien escribió sin número visible.';

create index if not exists chats_sin_numero_owner_fecha
  on public.chats_sin_numero (owner_id, ultimo_en desc);

alter table public.chats_sin_numero enable row level security;

-- LECTURA: estrictamente los propios, igual que `chats_recientes` (es la
-- agenda del WhatsApp personal, no la cartera; sin `puede_ver_de`).
drop policy if exists "chats_sin_numero_sel" on public.chats_sin_numero;
create policy "chats_sin_numero_sel" on public.chats_sin_numero
  for select to authenticated using (owner_id = auth.uid());

-- ESCRITURA: ninguna política para `authenticated`, a propósito (mismo motivo
-- que `chats_recientes`: nadie puede fabricarse un chat que no existió).
revoke insert, update, delete on public.chats_sin_numero from anon, authenticated;
revoke all on public.chats_sin_numero from anon;
grant select on public.chats_sin_numero to authenticated;

-- ---------------------------------------------------------------------
--  clientes.wa_lid
-- ---------------------------------------------------------------------
alter table public.clientes add column if not exists wa_lid text;

alter table public.clientes drop constraint if exists clientes_wa_lid_formato;
alter table public.clientes add constraint clientes_wa_lid_formato
  check (wa_lid is null or wa_lid ~ '^[0-9]{6,20}$');

-- Un mismo chat no puede quedar registrado dos veces en la cartera de un
-- dueño. Es la versión en base del «ese número ya es de…» del formulario: dos
-- pestañas o un doble clic no se lo saltan.
create unique index if not exists clientes_owner_wa_lid
  on public.clientes (owner_id, wa_lid) where wa_lid is not null;
