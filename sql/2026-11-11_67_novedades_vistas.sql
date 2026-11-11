-- =====================================================================
--  Novedades vistas: el tutorial de una funcionalidad nueva sale UNA vez
--  Rama `novedades-campana`. Aditiva: una tabla nueva, nada más.
-- =====================================================================
--
--  El panel anuncia novedades con su tutorial (public/js/novedades.js). Cada
--  una se abre sola a cada cuenta la primera vez que entra, y después queda en
--  la campana del header para volver a verla.
--
--  «Visto» va por CUENTA y no por dispositivo: quien vio el tutorial en el
--  celular no lo recibe de nuevo en el computador. Es el mismo criterio que
--  `aviso_vistos`, pero sin tabla de avisos detrás: las novedades viven en el
--  código del panel, identificadas por `clave` (p. ej. 'notas-de-voz-2026-11').
--
--  Sin esta tabla el panel igual funciona: recuerda el visto solo en ese
--  navegador (localStorage), y en otro dispositivo el tutorial se repite una vez.
-- =====================================================================

create table if not exists public.novedades_vistas (
  clave text not null check (clave ~ '^[a-z0-9-]{3,60}$'),
  owner_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  visto_en timestamptz not null default now(),
  primary key (clave, owner_id)
);

alter table public.novedades_vistas enable row level security;

-- Cada cuenta ve y escribe solo sus propias marcas.
drop policy if exists novedades_vistas_sel on public.novedades_vistas;
create policy novedades_vistas_sel on public.novedades_vistas for select to authenticated
  using (owner_id = auth.uid());
drop policy if exists novedades_vistas_ins on public.novedades_vistas;
create policy novedades_vistas_ins on public.novedades_vistas for insert to authenticated
  with check (owner_id = auth.uid());

-- Una marca no se edita ni se borra desde el panel.
revoke update, delete on public.novedades_vistas from anon, authenticated;
revoke all on public.novedades_vistas from anon;
grant select, insert on public.novedades_vistas to authenticated;

comment on table public.novedades_vistas is
  'Qué novedad del panel (clave definida en public/js/novedades.js) ya vio cada cuenta. Una fila = esa cuenta ya vio el tutorial; no se le vuelve a abrir solo.';
