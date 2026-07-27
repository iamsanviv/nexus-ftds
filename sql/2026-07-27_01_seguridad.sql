-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Arreglo de seguridad — 27 de julio de 2026
--
-- Correr COMPLETO en Supabase → SQL Editor, de una sola vez.
-- Es idempotente: se puede volver a correr sin efectos secundarios.
--
-- Cierra tres agujeros. El primero es crítico y explotable hoy.
-- ═══════════════════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────────────────
-- 1. ESCALAMIENTO DE PRIVILEGIOS  (crítico)
--
-- La política de UPDATE sobre `profiles` es:
--     USING (id = auth.uid())   ← sin WITH CHECK
--
-- En Postgres, cuando falta el WITH CHECK se reutiliza el USING. Y el rol
-- `authenticated` tiene permiso UPDATE sobre la columna `role`. Entonces
-- cualquier agente podía correr contra la API pública:
--
--     PATCH /rest/v1/profiles?id=eq.<su-propio-id>   {"role": "director"}
--
-- La fila nueva sigue cumpliendo id = auth.uid(), así que la política la
-- deja pasar. Y is_director() lee exactamente esa columna: en un segundo
-- el agente veía los clientes de TODOS los demás agentes, con nombre y
-- teléfono. La anon key es pública, así que bastaba un curl.
--
-- Se cierra con un trigger en vez de revocar el permiso de columna, para
-- no romper la capacidad legítima del director de asignar roles.
-- ───────────────────────────────────────────────────────────────────────────

-- La condición `auth.uid() is not null` importa: el ataque que se cierra es el
-- de un agente autenticado llamando a la API REST con la anon key (pública).
-- Los contextos administrativos —el editor SQL del panel, la service_role key,
-- un backup— no tienen auth.uid() y ya son de confianza. Sin esa condición el
-- trigger también los bloquea, y el director se queda sin forma de asignar
-- roles desde ningún lado.
create or replace function public.impedir_cambio_de_rol()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  if new.role is distinct from old.role
     and auth.uid() is not null
     and not public.is_director() then
    raise exception 'Solo un director puede cambiar el rol de una cuenta'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_impedir_cambio_de_rol on public.profiles;
create trigger trg_impedir_cambio_de_rol
  before update on public.profiles
  for each row execute function public.impedir_cambio_de_rol();

-- Solo la dispara el trigger; nadie debe poder llamarla por RPC.
-- (Postgres verifica el permiso al CREAR el trigger, no al dispararlo,
--  así que revocarlo no impide que funcione.)
revoke execute on function public.impedir_cambio_de_rol() from public, anon, authenticated;

-- Un visitante sin sesión no tiene por qué escribir perfiles nunca.
revoke insert, update on public.profiles from anon;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. REGISTRO ABIERTO
--
-- Hoy cualquiera que llegue a la URL puede crear cuenta y queda como
-- 'agente'. Combinado con el punto 1, eso significaba que un desconocido
-- podía registrarse, promoverse a director y llevarse la base de clientes.
--
-- A partir de aquí el correo tiene que estar autorizado ANTES de registrarse.
-- El director los agrega desde «Más → Agentes» en la app.
-- ───────────────────────────────────────────────────────────────────────────

create table if not exists public.agentes_autorizados (
  email      text primary key,
  nota       text,
  creado_por uuid references auth.users(id) on delete set null,
  creado_en  timestamptz not null default now(),
  usado_en   timestamptz
);

alter table public.agentes_autorizados enable row level security;

drop policy if exists "director gestiona autorizados" on public.agentes_autorizados;
create policy "director gestiona autorizados" on public.agentes_autorizados
  for all
  using (public.is_director())
  with check (public.is_director());

-- El trigger de alta ahora exige autorización previa. Los 9 usuarios que ya
-- existen no se tocan: esto solo corre al crear una cuenta nueva.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  autorizado boolean;
begin
  select exists (
    select 1 from public.agentes_autorizados
     where lower(email) = lower(new.email)
       and usado_en is null
  ) into autorizado;

  if not autorizado then
    -- Marca estable para que la app lo traduzca a un mensaje entendible.
    raise exception 'CORREO_NO_AUTORIZADO' using errcode = '42501';
  end if;

  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', ''), 'agente');

  update public.agentes_autorizados
     set usado_en = now()
   where lower(email) = lower(new.email);

  return new;
end;
$$;

-- Igual que arriba: es función de trigger, no un endpoint.
revoke execute on function public.handle_new_user() from public, anon, authenticated;


-- ───────────────────────────────────────────────────────────────────────────
-- 3. BUCKETS QUE PERMITÍAN LISTAR ARCHIVOS
--
-- Ambos buckets son públicos, así que la URL pública de cada archivo sigue
-- funcionando sin política de SELECT. Lo único que habilitaba esa política
-- era ENUMERAR el contenido — es decir, un agente podía listar y descargar
-- las imágenes de campaña de los otros.
--
-- Comprobado en el código: la app solo usa upload(), remove() y
-- getPublicUrl() (que no llama a la API, solo arma la cadena). No hay
-- ningún .list() ni .download(), así que quitarlas no rompe nada.
-- ───────────────────────────────────────────────────────────────────────────

-- `mensajes`: imágenes y notas de voz de campañas. Rutas aleatorias.
-- No hay borrado desde la app, así que no necesita SELECT para nada.
drop policy if exists "mensajes_select" on storage.objects;

-- `servicios`: imágenes del catálogo, que es compartido por diseño entre
-- todos los agentes. Se deja legible, pero solo con sesión iniciada
-- (antes lo podía listar cualquiera sin autenticarse).
drop policy if exists "servicios_select" on storage.objects;
create policy "servicios_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'servicios');


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICACIÓN — correr después y revisar la salida
-- ───────────────────────────────────────────────────────────────────────────

-- (a) El trigger de rol quedó puesto:
--     select tgname from pg_trigger where tgrelid = 'public.profiles'::regclass;
--     → debe aparecer trg_impedir_cambio_de_rol

-- (b) Los buckets ya no se pueden listar:
--     select policyname, cmd, roles::text from pg_policies
--      where schemaname='storage' and tablename='objects' order by policyname;
--     → mensajes_select no debe existir; servicios_select debe decir {authenticated}

-- (c) La tabla de autorizados existe y está protegida:
--     select relrowsecurity from pg_class where relname='agentes_autorizados';
--     → debe decir true


-- ───────────────────────────────────────────────────────────────────────────
-- ESTADO: APLICADO EN PRODUCCIÓN el 27/07/2026.
--
-- Probado simulando la sesión de un agente vía PostgREST:
--   · intento de UPDATE profiles SET role='director' → BLOQUEADO
--   · el rol quedó en 'agente'
--   · el contexto admin (este editor) sí puede cambiar roles
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- DOS AVISOS DEL LINTER QUE SE DEJAN A PROPÓSITO
--
-- 1. «Public bucket `servicios` allows listing»
--    El catálogo de servicios es compartido por todos los agentes por diseño:
--    todos ven las mismas imágenes en la interfaz. Poder listarlas no expone
--    nada que el agente no vea igual en pantalla. Se restringió de `public` a
--    `authenticated`, que era la parte que sí importaba (antes lo listaba
--    cualquiera sin sesión). El bucket `mensajes`, donde sí había datos de un
--    agente que otro no debía ver, quedó cerrado del todo.
--
-- 2. «Public/authenticated can execute is_director()»
--    NO se puede revocar. Se probó en una transacción revertida: al quitarle
--    EXECUTE a `authenticated`, las políticas RLS que la invocan dejan de
--    evaluarse y el agente pierde acceso hasta a sus propios clientes
--    («permission denied for function is_director»). Además la función solo
--    revela si QUIEN LLAMA es director — para anon siempre devuelve false, así
--    que no filtra datos de nadie.
-- ───────────────────────────────────────────────────────────────────────────


-- ───────────────────────────────────────────────────────────────────────────
-- QUEDA PENDIENTE, Y NO SE PUEDE HACER DESDE SQL
--
-- Activar la protección contra contraseñas filtradas (compara contra
-- HaveIBeenPwned). Es un interruptor del panel:
--     Supabase → Authentication → Policies → Leaked password protection
-- ───────────────────────────────────────────────────────────────────────────
