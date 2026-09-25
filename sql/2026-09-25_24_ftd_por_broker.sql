-- FTD por broker.
--
-- Contexto: los FTD se hacían en ExOption y ahora se hacen en IQ Option. Una
-- misma persona puede depositar en los DOS, y cada depósito cuenta en el mes de
-- SU propia fecha. Por eso el FTD deja de ser una fecha suelta en el cliente y
-- pasa a ser un mapa broker -> fecha.
--
-- Se guarda en `clientes` y no en tabla aparte por dos razones: hereda el RLS
-- que ya distingue jerarquía (`puede_ver_de`), que no conviene duplicar, y sigue
-- el patrón que la tabla ya usa para los mapas por persona (`acc`, `puntuales`,
-- `zooms`, `conf`).
--
-- `comunidad_desde` NO desaparece: queda como DERIVADO —el FTD más antiguo— y lo
-- mantiene un trigger. Así ventas, segmentos y todo lo que ya lo leía siguen
-- funcionando sin tocarse, y las dos fuentes no pueden desincronizarse.

begin;

alter table public.clientes
  add column if not exists ftds jsonb not null default '{}'::jsonb;

-- Validación de forma. Una cadena basura dentro del jsonb rompería el conteo del
-- mes en silencio, y esto paga comisiones: se valida en la base, no solo en la
-- interfaz. Un CHECK no admite subconsultas, así que va en una función inmutable.
create or replace function public.ftds_valido(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = public, pg_temp
as $$
  select p is null or (
    jsonb_typeof(p) = 'object'
    and not exists (
      select 1 from jsonb_each_text(p) e
      where e.key !~ '^[a-z0-9_]{2,24}$'
         or e.value !~ '^\d{4}-\d{2}-\d{2}$'
    )
  );
$$;

alter table public.clientes drop constraint if exists clientes_ftds_ok;
alter table public.clientes add constraint clientes_ftds_ok check (public.ftds_valido(ftds));

-- Backfill ANTES del trigger: todo lo que existe hoy se hizo en ExOption, que es
-- el broker con el que se venía trabajando. Se respeta lo que ya tenga `ftds`
-- por si esta migración se corre dos veces.
update public.clientes
   set ftds = jsonb_build_object('exoption', to_char(comunidad_desde, 'YYYY-MM-DD'))
 where comunidad_desde is not null
   and ftds = '{}'::jsonb;

-- `comunidad_desde` pasa a ser derivado. Escribirlo directamente deja de tener
-- efecto: el trigger lo recalcula siempre desde `ftds`. Es deliberado — una sola
-- fuente de verdad para la fecha de ingreso.
create or replace function public.clientes_sync_comunidad()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.comunidad_desde := (select min(value::date) from jsonb_each_text(new.ftds));
  return new;
end $$;

drop trigger if exists trg_clientes_sync_comunidad on public.clientes;
create trigger trg_clientes_sync_comunidad
  before insert or update of ftds on public.clientes
  for each row execute function public.clientes_sync_comunidad();

-- Si `clientes` tuviera permisos por columna (como los tiene `canales_wa`), la
-- columna nueva nacería sin permiso y el panel no podría escribirla.
-- `has_column_privilege` ya tiene en cuenta los permisos a nivel de tabla, así
-- que esto no concede nada de más cuando no hace falta.
do $$
begin
  if not has_column_privilege('authenticated', 'public.clientes', 'ftds', 'UPDATE') then
    execute 'grant select (ftds), update (ftds) on public.clientes to authenticated';
  end if;
end $$;

commit;

-- Verificación:
--
--   select ftds, comunidad_desde from public.clientes
--    where ftds <> '{}'::jsonb limit 5;
--
--   -- el derivado tiene que coincidir con el FTD más antiguo, sin excepciones
--   select count(*) as desincronizados from public.clientes c
--    where c.comunidad_desde is distinct from
--          (select min(value::date) from jsonb_each_text(c.ftds));
