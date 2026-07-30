-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · El director puede cancelar y reprogramar lo de su equipo
-- 27 de julio de 2026
--
-- ESTADO: APLICADO EN PRODUCCIÓN (migración
-- `director_puede_cancelar_seguimientos_de_su_equipo`).
-- ═══════════════════════════════════════════════════════════════════════════

-- EL FALLO SILENCIOSO QUE HABÍA
--
-- `seguimientos` y `mensajes_programados` tenían una sola política FOR ALL:
--
--     FOR ALL USING (puede_ver_de(owner_id))
--             WITH CHECK (owner_id = auth.uid() AND aprobado())
--
-- Ese WITH CHECK está puesto para la regla de oro del INSERT (nadie crea
-- seguimientos a nombre de otro), pero en Postgres el WITH CHECK de una
-- política FOR ALL se aplica TAMBIÉN al UPDATE. Consecuencia: un director veía
-- los seguimientos de sus agentes pero no podía modificarlos, y la propagación
-- del enlace nuevo en una actividad COMPARTIDA no hacía nada, sin error.
--
-- Comprobado antes de tocar nada, simulando la sesión del director:
--   director VE el seguimiento de su agente       sí
--   director CANCELA el de su agente              BLOQUEADO — new row violates RLS
--
-- LA CORRECCIÓN: separar por comando.

drop policy if exists "seguimientos propios" on public.seguimientos;
create policy "seguimientos_sel" on public.seguimientos
  for select using (public.puede_ver_de(owner_id));
create policy "seguimientos_ins" on public.seguimientos
  for insert with check (owner_id = auth.uid() and public.aprobado());
create policy "seguimientos_upd" on public.seguimientos
  for update using (public.puede_ver_de(owner_id))
              with check (public.puede_ver_de(owner_id));
create policy "seguimientos_del" on public.seguimientos
  for delete using (public.puede_ver_de(owner_id));

drop policy if exists "mensajes propios" on public.mensajes_programados;
create policy "mensajes_sel" on public.mensajes_programados
  for select using (public.puede_ver_de(owner_id));
create policy "mensajes_ins" on public.mensajes_programados
  for insert with check (owner_id = auth.uid() and public.aprobado());
create policy "mensajes_upd" on public.mensajes_programados
  for update using (public.puede_ver_de(owner_id))
              with check (public.puede_ver_de(owner_id));
create policy "mensajes_del" on public.mensajes_programados
  for delete using (public.puede_ver_de(owner_id));


-- ───────────────────────────────────────────────────────────────────────────
-- VERIFICADO después, en transacción revertida
--
--   director cancela el seguimiento de su agente          PUDO ✓
--   director reprograma el mensaje de su agente           PUDO ✓
--   director CREA un seguimiento a nombre del agente      BLOQUEADO ✓
--
-- El tercero es el que importa: se abrió la puerta para supervisar sin abrirla
-- para suplantar. La regla de oro (cada quien le escribe a los suyos) sigue
-- garantizada por el WITH CHECK del INSERT, que no se tocó.
-- ───────────────────────────────────────────────────────────────────────────
