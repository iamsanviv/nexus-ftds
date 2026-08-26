-- =====================================================================
--  chats_recientes — registrar a alguien que ya te escribió
--  Aplicado el 2026-08-26 con el MCP de Supabase.
-- =====================================================================
--
--  POR QUÉ
--
--  WhatsApp está retirando el número de teléfono como identificador. Con
--  la función de nombres de usuario (despliegue por países desde julio de
--  2026) y con LID, quien te escribe llega identificado por una identidad
--  oculta y la app ya no muestra su número. El agente no puede copiarlo
--  para crear la persona en Nexus: no lo ve.
--
--  Pero el bridge SÍ lo sabe. whatsmeow mantiene `whatsmeow_lid_map`
--  (lid → teléfono) y al 24/08/2026 resolvía 9.102 de 9.157 chats `@lid`
--  en los doce bridges, un 99%. El dato existe; lo que faltaba era un
--  camino desde ahí hasta el formulario.
--
--  Esta tabla es ese camino: el worker la llena leyendo los stores de los
--  bridges, y el panel la lee para ofrecer «registrar desde un chat».
--
--  POR QUÉ NO SE TOCÓ EL BRIDGE
--
--  Los doce bridges comparten UN solo ejecutable
--  (`whatsapp-bridge-mt`). Agregarle un endpoint obliga a recompilar y
--  reiniciar los doce, y una sesión de WhatsApp que se cae hay que
--  volver a vincularla con QR. El worker ya corre en la misma máquina y
--  como el mismo usuario que los bridges, así que puede leer sus SQLite
--  en solo-lectura sin tocar nada de eso.
--
--  ALCANCE DE LECTURA: SOLO LOS PROPIOS
--
--  A diferencia de `clientes`, esta política NO usa `puede_ver_de()`.
--  El contenido no es la cartera de un agente: es quién le escribió a su
--  WhatsApp PERSONAL, lo que incluye a gente que no es cliente ni lo será.
--  Un director supervisa clientes, no la agenda personal de su equipo.
--
--  Si más adelante hace falta que un director registre a alguien que
--  escribió a un agente, la vía correcta es que lo haga el agente, o
--  crear la persona a mano con «A nombre de», que ya existe.
-- =====================================================================

create table if not exists public.chats_recientes (
  -- De quién es el WhatsApp que recibió el mensaje. NO es el dueño futuro
  -- del cliente: es la identidad de enrutamiento, la misma que usa el worker.
  owner_id  uuid not null references auth.users(id) on delete cascade,
  -- Formato canónico de la app: '+' y dígitos, sin espacios ni guiones.
  -- Los 559 clientes existentes ya cumplen esto, así que comparar por
  -- igualdad basta para saber si alguien ya está registrado.
  telefono  text not null check (telefono ~ '^\+[0-9]{7,15}$'),
  -- Como se ve en WhatsApp: nombre del contacto o push name. Puede faltar.
  nombre_wa text,
  ultimo_en timestamptz not null,
  -- Solo para diagnóstico: de qué identidad oculta se resolvió el número.
  -- NULL cuando el chat llegó ya con número (`s.whatsapp.net`).
  lid       text,
  visto_en  timestamptz not null default now(),
  primary key (owner_id, telefono)
);

comment on table public.chats_recientes is
  'Chats 1:1 recientes de cada bridge, con el teléfono ya resuelto desde LID. La llena SOLO el worker (service role). Sirve para registrar a alguien cuyo número WhatsApp no muestra.';

-- El panel siempre pide «los míos, del más reciente al más viejo».
create index if not exists chats_recientes_owner_fecha
  on public.chats_recientes (owner_id, ultimo_en desc);

alter table public.chats_recientes enable row level security;

-- LECTURA: estrictamente los propios (ver «ALCANCE DE LECTURA» arriba).
drop policy if exists "chats_recientes_sel" on public.chats_recientes;
create policy "chats_recientes_sel" on public.chats_recientes
  for select to authenticated using (owner_id = auth.uid());

-- ESCRITURA: ninguna política para `authenticated`, a propósito. Solo el
-- worker escribe, con service role (que salta RLS). Si un agente pudiera
-- insertar, podría fabricarse un chat que nunca existió y usarlo para
-- meter un número cualquiera como si le hubiera escrito.
