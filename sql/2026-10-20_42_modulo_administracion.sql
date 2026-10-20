-- =====================================================================
--  Módulo «Administración»: catálogo de productos y resumen del equipo
--  Aplicado el 2026-10-20 con el MCP de Supabase.
--
--  Requisitos acordados con el usuario (solo el admin ve y edita):
--   · crear/editar nombre, precio y comisión de cada producto;
--   · la comisión puede ser fija o un porcentaje del precio;
--   · borrar solo si el producto no tiene ventas; si las tiene, se retira;
--   · ver a los agentes agrupados por director, con su total de personas
--     y el estado de su WhatsApp.
-- =====================================================================

-- ---------- 1. Comisión por porcentaje ----------
-- `comision` sigue siendo el monto que leen las ventas (se copia y se
-- congela al crear cada venta, y el upgrade resta montos). Con porcentaje,
-- el monto pasa a ser DERIVADO del precio y lo mantiene este trigger: así
-- cambiar el precio de un bot ya no obliga a recalcular la comisión a mano,
-- y nada de ventas.js tiene que saber que existen porcentajes.
alter table public.productos
  add column if not exists comision_pct numeric(5,2)
  check (comision_pct is null or (comision_pct > 0 and comision_pct <= 100));

create or replace function public.productos_comision_derivada()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.comision_pct is not null then
    new.comision := round(new.precio * new.comision_pct / 100, 2);
  end if;
  return new;
end $$;

create or replace trigger productos_comision_derivada before insert or update on public.productos
  for each row execute function public.productos_comision_derivada();

-- ---------- 2. Un producto con ventas no se borra ----------
-- El FK ventas.producto_id es ON DELETE SET NULL: borrar un producto vendido
-- dejaba sus ventas sin producto en silencio (y sin él el upgrade y la subida
-- de nivel no saben de dónde venían). La regla vive en la base, no solo en el
-- botón. Es un trigger y no un cambio del FK para no tener que soltar la
-- restricción en producción; el errcode 23503 es el mismo que daría el FK.
create or replace function public.productos_no_borrar_vendido()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.ventas v where v.producto_id = old.id) then
    raise exception 'El producto «%» tiene ventas: no se puede borrar, solo retirar', old.nombre
      using errcode = '23503';
  end if;
  return old;
end $$;
revoke all on function public.productos_no_borrar_vendido() from public, anon, authenticated;

create or replace trigger productos_no_borrar_vendido before delete on public.productos
  for each row execute function public.productos_no_borrar_vendido();

-- ---------- 3. Solo el admin escribe el catálogo ----------
-- Antes también podían los directores (sin pantalla, pero por API sí).
alter policy productos_wr on public.productos
  using (public.es_admin()) with check (public.es_admin());

-- ---------- 4. Ventas por producto ----------
-- El admin no ve ventas ajenas (RLS), pero necesita saber si un producto
-- tiene alguna para ofrecer «Borrar» o «Retirar». Solo cuenta: no expone
-- ninguna fila.
create or replace function public.admin_ventas_por_producto()
returns table (producto_id text, ventas bigint)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  return query select v.producto_id, count(*) from public.ventas v
    where v.producto_id is not null group by v.producto_id;
end $$;
revoke all on function public.admin_ventas_por_producto() from public, anon;
grant execute on function public.admin_ventas_por_producto() to authenticated;

-- ---------- 5. Resumen del equipo ----------
-- Una fila por cuenta aprobada de agente o director: total de personas y
-- los datos de su canal. Solo totales; ningún dato de los clientes.
-- El estado visible (Conectado / Sin señal / Sin vincular / Retirado) se
-- deriva en el panel a partir de estado, ultimo_visto y baja_en.
create or replace function public.admin_resumen_equipo()
returns table (id uuid, nombre text, rol text, director_id uuid, personas bigint,
               estado_canal text, ultimo_visto timestamptz, baja_en timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.es_admin() then raise exception 'Solo el administrador'; end if;
  return query
    select p.id, p.full_name, p.role, p.director_id,
           (select count(*) from public.clientes c where c.owner_id = p.id),
           w.estado, w.ultimo_visto, w.baja_en
      from public.profiles p
      left join public.canales_wa w on w.owner_id = p.id
     where p.aprobado and p.role in ('agente', 'director');
end $$;
revoke all on function public.admin_resumen_equipo() from public, anon;
grant execute on function public.admin_resumen_equipo() to authenticated;
