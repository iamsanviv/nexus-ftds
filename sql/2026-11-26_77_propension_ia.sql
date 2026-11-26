-- Propensión a comprar (26/11/2026, pedido de Sanviv): el resumen nocturno con
-- IA (SQL 76, vm/resumen-ia/resumir.py) además de necesidad y recomendación
-- clasifica a cada cliente de Comunidad en alta / media / baja y dice por qué.
-- Mi día muestra las 5 más propensas (paso «Cerrar») y la Tabla de Comunidad
-- la muestra en una columna ordenable.
--
-- «Qué hacer» NO es columna nueva: es `recomendacion` (SQL 75), que ya escribe
-- la misma IA en la misma llamada.
--
-- Corrección a mano (decisión de Sanviv): el agente puede cambiar el nivel y su
-- corrección gana HASTA QUE EL CLIENTE VUELVA A ESCRIBIR. `propension_manual_en`
-- guarda cuándo lo corrigió; la IA solo lo pisa si hay un mensaje del cliente
-- posterior, y entonces lo deja en NULL. NULL = el nivel lo puso la IA.
-- Como `necesidad`, no viaja en `mapAEditar`: se guarda campo por campo.
alter table public.clientes
  add column if not exists propension text,
  add column if not exists propension_motivo text,
  add column if not exists propension_manual_en timestamptz;

alter table public.clientes
  drop constraint if exists clientes_propension_valida,
  add constraint clientes_propension_valida check (propension in ('alta', 'media', 'baja')),
  drop constraint if exists clientes_propension_motivo_largo,
  add constraint clientes_propension_motivo_largo check (char_length(propension_motivo) <= 1000);

-- Lo que la IA necesita del panel además del chat: asistencias a la Básica y a
-- las operativas (`acc`), los zooms de venta, la corrección manual vigente y
-- la venta de membresía abierta (valor, lo abonado y la fecha de pago). Se
-- calcula aquí para no exponer ventas/abonos al script por otra vía.
create or replace function public.resumen_ia_pendiente()
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cuenta', (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_account_id'),
    'token',  (select decrypted_secret from vault.decrypted_secrets where name = 'cloudflare_ai_token'),
    'clientes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', c.id, 'owner_id', c.owner_id, 'nombre', c.nombre,
               'telefono', public.clave_tel(c.telefono), 'membresia', c.membresia,
               'comunidad_desde', c.comunidad_desde, 'zooms', c.zooms,
               'acc', jsonb_build_object(
                 'basica', c.acc->>'nivel0',
                 'operativa', greatest(c.acc->>'opJuan', c.acc->>'opJuanVip', c.acc->>'smtc006mh2nl1')),
               'propension_manual_en', c.propension_manual_en,
               'venta', (
                 select jsonb_build_object('producto', v.producto_nombre, 'valor', v.valor,
                          'abonado', coalesce((select sum(a.monto) from public.abonos a where a.venta_id = v.id), 0),
                          'fecha_pago', v.fecha_pago)
                   from public.ventas v
                   join public.productos p on p.id = v.producto_id and p.categoria = 'membresia'
                  where v.cliente_id = c.id and v.estado = 'abierta'
                    and coalesce((select sum(a.monto) from public.abonos a where a.venta_id = v.id), 0) < v.valor
                  order by v.creado_en desc limit 1)))
        from public.clientes c
        join public.resumen_ia_agentes a on a.owner_id = c.owner_id
       where c.membresia <> 'Lead' and c.inactivo_desde is null
         and coalesce(c.telefono, '') <> ''), '[]'::jsonb));
$$;
revoke all on function public.resumen_ia_pendiente() from public, anon, authenticated;
grant execute on function public.resumen_ia_pendiente() to service_role;
