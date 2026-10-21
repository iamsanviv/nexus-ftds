-- =====================================================================
--  Plantillas de seguimiento públicas (`plantillas_lead.publica`)
--  Aplicado el 2026-10-21 con el MCP de Supabase (migración
--  `plantillas_lead_publicas`).
--
--  Hasta ahora las plantillas eran privadas de su autor. Un agente que
--  arma un buen seguimiento puede marcarlo como público para que cualquier
--  otro usuario aprobado lo USE (o lo guarde como copia propia). Solo el
--  autor la edita, la borra o la vuelve privada: las políticas de update y
--  delete siguen exigiendo `owner_id = auth.uid()`.
--
--  Usarla no cambia a quién se le escribe: el envío sigue saliendo del
--  universo propio de quien envía (`destinatariosMasivo`), con su canal.
--  Compartir el texto no comparte clientes.
-- =====================================================================

alter table public.plantillas_lead
  add column if not exists publica boolean not null default false;

-- ALTER POLICY y no drop/create: mismo efecto sin un instante sin política.
-- `aprobado()` para que una cuenta pendiente de aprobación no lea las
-- plantillas del equipo entero.
alter policy "plantillas lead propias" on public.plantillas_lead
  using (owner_id = auth.uid() or (publica and public.aprobado()));

-- Un agente no puede leer el perfil de otro (RLS de `profiles`), así que el
-- nombre del autor se entrega aparte y SOLO de quien publicó algo: publicar
-- es aceptar que se vea quién lo escribió. Sin columna `autor` en la tabla:
-- se desactualizaría al cambiar el nombre del perfil.
create or replace function public.autores_plantillas_publicas()
returns table (id uuid, nombre text)
language sql stable security definer set search_path = '' as $$
  select p.id, coalesce(p.full_name, '(sin nombre)')
    from public.profiles p
   where public.aprobado()
     and exists (select 1 from public.plantillas_lead t
                  where t.owner_id = p.id and t.publica);
$$;
revoke all on function public.autores_plantillas_publicas() from public, anon;
grant execute on function public.autores_plantillas_publicas() to authenticated;

-- ---------- Pruebas (begin … rollback) ----------
-- Con A = autor, B = otro agente aprobado de OTRO equipo:
--   · B no ve la plantilla privada de A; la ve al marcarla pública.
--   · B no puede update/delete la pública de A (0 filas afectadas).
--   · B no puede insertar con owner_id = A.
--   · B puede crear una campaña con plantilla_id = la pública de A.
--   · Cuenta no aprobada: no ve públicas y la RPC devuelve vacío.
