// Repaso de asistencias: al primer ingreso del día (después de las 7 AM)
// pregunta, una por una, por las invitaciones que quedaron sin respuesta
// (¿asistió o no?), para mantener el sistema al día.
//
// También se puede abrir a demanda desde el indicador del header, por si se
// omitió el repaso automático.
//
// Margen: una invitación solo se pregunta cuando ya pasó al menos MARGEN_MS
// desde el inicio de la actividad. Como `conf` guarda solo la fecha (sin hora),
// la hora real se busca en la tabla `actividades`; si no hay actividad asociada
// (invitación marcada a mano), se usa la regla de "día anterior".
import { state, $, esc, fmtF, toast, todos, hoyISO } from "./state.js";
import { SB } from "./supabase.js";
import { dbPatch } from "./data.js";
import { render } from "./ui.js";

const clave = () => "nexusRepaso:" + state.me.id;

const MARGEN_MS = 60 * 60 * 1000;   // 1 hora después del inicio de la actividad

// Índice "servicio_id|fecha" -> inicio (ms), con las actividades del agente.
// Permite saber a qué hora empezó realmente la actividad que se invitó.
let horarios = null;

async function cargarHorarios() {
  if (horarios) return horarios;
  horarios = new Map();
  try {
    const { data } = await SB.from("actividades")
      .select("servicio_id, inicio")
      .eq("owner_id", state.me.id);
    for (const a of data || []) {
      const d = new Date(a.inicio);
      if (isNaN(d)) continue;
      const fecha = fechaLocalISO(d);
      const k = a.servicio_id + "|" + fecha;
      // Si hubo varias del mismo servicio ese día, vale la última en empezar.
      const prev = horarios.get(k);
      if (!prev || d.getTime() > prev) horarios.set(k, d.getTime());
    }
  } catch (e) {
    // Sin horarios se cae a la regla de "día anterior": nunca bloquea el repaso.
  }
  return horarios;
}

// Fecha local en formato ISO (no UTC): así coincide con lo que guarda `conf`.
function fechaLocalISO(d) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ¿Ya se le puede preguntar a esta invitación?
function yaSePuedePreguntar(sid, f, hoy) {
  const inicio = horarios?.get(sid + "|" + f);
  if (inicio != null) return Date.now() >= inicio + MARGEN_MS;
  return f < hoy;   // sin hora conocida: solo desde el día siguiente
}

// Invitados (conf) sin asistencia marcada (acc), míos, ya "preguntables".
function pendientes() {
  const hoy = hoyISO();
  const items = [];
  for (const c of state.clientes) {
    if (c.owner_id !== state.me.id) continue;
    for (const s of todos()) {
      const f = (c.conf || {})[s.id];
      if (f && !c.acc[s.id] && yaSePuedePreguntar(s.id, f, hoy)) items.push({ c, s, f });
    }
  }
  return items.sort((a, b) => a.f.localeCompare(b.f));
}

// Cuántas quedan sin responder (para el indicador del header).
export function repasoPendientes() {
  if (!state.me) return 0;
  return pendientes().length;
}

// Precarga los horarios y refresca el indicador (no abre nada).
export async function repasoPreparar() {
  await cargarHorarios();
  render();
}

/* ---------- overlay ---------- */

function abrir(items, marcarHecho) {
  const hoy = hoyISO();
  let i = 0;

  const cerrar = () => {
    if (marcarHecho) localStorage.setItem(clave(), hoy);
    $("repOverlay").classList.remove("open");
    render();
  };

  const paso = () => {
    if (i >= items.length) {
      $("repSub").textContent = "Repaso completado";
      $("repBody").innerHTML = `<div class="naplica" style="font-size:.95rem">🎉 Todo al día. ¡Buen trabajo!</div>`;
      if (marcarHecho) localStorage.setItem(clave(), hoy);
      return;
    }
    const { c, s, f } = items[i];
    $("repSub").textContent = `${i + 1} de ${items.length} · invitaciones sin respuesta`;
    $("repBody").innerHTML = `
      <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
        <div style="font-size:.95rem">¿<b>${esc(c.nombre)}</b> <span class="badge b-${c.mem}">${c.mem}</span> asistió a <b>${esc(s.n)}</b>?
          <span class="sfecha">invitado el ${fmtF(f)}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="pmark" data-r="si">✓ Sí asistió</button>
          <button class="pmark off" data-r="no">✗ No asistió</button>
          <button class="tbtn" data-r="skip">Saltar por hoy</button>
        </div>
      </div>`;
    $("repBody").querySelectorAll("[data-r]").forEach(b => b.onclick = async () => {
      if (b.dataset.r === "si") {
        c.acc[s.id] = f;
        await dbPatch(c, { acc: c.acc });
        toast(`✓ ${c.nombre.split(" ")[0]} asistió a «${s.n}»`);
      } else if (b.dataset.r === "no") {
        delete c.conf[s.id];
        await dbPatch(c, { conf: c.conf });
        toast(`${c.nombre.split(" ")[0]} vuelve a «por invitar»`);
      }
      i++;
      paso();
    });
  };

  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };
  paso();
  $("repOverlay").classList.add("open");
}

/* ---------- entradas ---------- */

// Automático: una vez al día, al entrar.
export async function repasoDiario() {
  const hoy = hoyISO();
  await cargarHorarios();
  render();                                            // pinta el indicador
  if (new Date().getHours() < 7) return;               // antes de las 7 no molesta
  if (localStorage.getItem(clave()) === hoy) return;   // ya se hizo hoy
  const items = pendientes();
  if (!items.length) { localStorage.setItem(clave(), hoy); return; }
  abrir(items, true);
}

// A demanda: desde el indicador del header, sin importar el candado del día.
export async function repasoManual() {
  await cargarHorarios();
  horarios = null;                 // refresca horarios en el próximo cálculo
  await cargarHorarios();
  const items = pendientes();
  if (!items.length) { toast("🎉 No hay invitaciones pendientes"); render(); return; }
  abrir(items, false);             // abrirlo a mano no marca el repaso del día
}
