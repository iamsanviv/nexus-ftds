-- ═══════════════════════════════════════════════════════════════════════════
-- Nexus · Actividades compartidas y asistencia puntual — 27 de julio de 2026
--
-- ESTADO: APLICADO EN PRODUCCIÓN (migración
-- `actividades_compartidas_y_asistencia_puntual`).
-- ═══════════════════════════════════════════════════════════════════════════

-- 1. ACTIVIDADES COMPARTIDAS ─────────────────────────────────────────────
-- El director arma la actividad una vez y les aparece a sus agentes, que la
-- usan para programar seguimientos a SUS clientes pero no pueden tocarla.
alter table public.actividades
  add column if not exists compartida boolean not null default false;

-- CORREGIDO poco después: la primera versión usaba puede_ver_de(), que para un
-- director incluye las actividades de SUS agentes. Resultado: al director le
-- salían las de su gente etiquetadas «De tu director», que es al revés.
--
-- El modelo correcto es que cada quien opera SUS actividades, y la única
-- excepción va hacia abajo: lo que un director comparte con su equipo. La
-- supervisión del director no vive en esta lista sino en «Agentes y canales».
drop policy if exists "actividades_sel" on public.actividades;
create policy "actividades_sel" on public.actividades
  for select using (
    owner_id = auth.uid()
    or (compartida
        and owner_id = (select director_id from public.profiles where id = auth.uid()))
  );

-- Editar y borrar: solo lo propio, dicho explícitamente en vez de quedar
-- implícito en que la fila no se puede ni ver.
drop policy if exists "actividades_upd" on public.actividades;
create policy "actividades_upd" on public.actividades
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "actividades_del" on public.actividades;
create policy "actividades_del" on public.actividades
  for delete using (owner_id = auth.uid());

-- Editar y borrar NO se tocaron: siguen en puede_ver_de(owner_id), que para un
-- agente mirando la actividad de su director da falso. La compartición queda de
-- solo lectura sin tener que declararlo en ningún otro sitio.
--
-- El interruptor «Compartir con mi equipo» sale marcado por defecto, pero
-- existe: sin él un director perdería la posibilidad de tener una actividad
-- propia, que es una capacidad que ya tenía.
--
-- Probado en transacción revertida:
--   director ve la actividad de su AGENTE    no ✓  (este era el bug)
--   director ve las suyas                    2 de 2 ✓
--   agente ve la COMPARTIDA de su director   sí ✓
--   agente ve la PRIVADA de su director      no ✓
--   agente ve la de OTRO director            no ✓
--   agente EDITA la compartida               sin efecto ✓
--   agente EDITA la suya                     pudo ✓
--
-- ───────────────────────────────────────────────────────────────────────────
-- A QUIÉN SE LE PUEDE ESCRIBIR
--
-- Un director ve los clientes de sus agentes para supervisar, pero los
-- mensajes saldrían desde SU WhatsApp a gente que agregó otra persona. Por eso
-- tanto Seguimiento como Masivo filtran a los clientes PROPIOS
-- (owner_id = auth.uid()), no a todo lo que el RLS deja ver. Un director es
-- también un agente: le escribe a los suyos.


-- 2. ASISTENCIA A ACTIVIDADES PUNTUALES ──────────────────────────────────
-- `clientes.acc` y `conf` están indexados por servicio del catálogo, y una
-- actividad puntual no tiene servicio. Se usa un mapa propio, auto-contenido:
--
--   puntuales = {
--     "<actividad_id>": { "n": "Lanzamiento…", "i": "<inicio ISO>",
--                         "conf": "2026-07-28", "acc": "2026-07-30" }
--   }
--
-- El nombre y la hora se COPIAN al programar. Así el perfil y el repaso no
-- dependen de que la actividad siga existiendo ni de resolver nada contra otra
-- tabla, que es lo que la haría frágil cuando la actividad se cierre o se
-- borre.
--
-- `progreso()` solo recorre el catálogo, así que esto sigue sin contar para los
-- porcentajes de nadie — que es lo que se prometió de las puntuales.
alter table public.clientes
  add column if not exists puntuales jsonb not null default '{}'::jsonb;


-- ───────────────────────────────────────────────────────────────────────────
-- PENDIENTE CONOCIDO
--
-- El CSV no exporta ni importa las asistencias puntuales: sus columnas son una
-- por servicio del catálogo. La importación solo INSERTA clientes nuevos
-- (nunca actualiza), así que no hay riesgo de que borre las que ya existan.
-- ───────────────────────────────────────────────────────────────────────────
