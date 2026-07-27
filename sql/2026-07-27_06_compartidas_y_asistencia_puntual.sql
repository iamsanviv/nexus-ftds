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

drop policy if exists "actividades_sel" on public.actividades;
create policy "actividades_sel" on public.actividades
  for select using (
    public.puede_ver_de(owner_id)
    or (compartida
        and owner_id = (select director_id from public.profiles where id = auth.uid()))
  );

-- Editar y borrar NO se tocaron: siguen en puede_ver_de(owner_id), que para un
-- agente mirando la actividad de su director da falso. La compartición queda de
-- solo lectura sin tener que declararlo en ningún otro sitio.
--
-- El interruptor «Compartir con mi equipo» sale marcado por defecto, pero
-- existe: sin él un director perdería la posibilidad de tener una actividad
-- propia, que es una capacidad que ya tenía.
--
-- Probado en transacción revertida, con un segundo director:
--   agente ve la COMPARTIDA de su director   SÍ ✓
--   agente ve la PRIVADA de su director      no ✓
--   agente ve la de OTRO director            no ✓
--   agente EDITA la compartida               sin efecto ✓
--   agente BORRA la compartida               sin efecto ✓


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
