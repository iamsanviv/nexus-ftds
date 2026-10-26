// Aviso en el panel de lo que no salió hoy y de lo programado que no va a salir.
//
// «Operativa 8pm» (25/10/2026) se canceló entera por el tope diario y el agente
// no se enteró: el motivo solo estaba en el registro de envíos. El push de la
// base (`mensajes_notifica_fallo`) avisa al momento, pero solo llega a quien
// activó notificaciones; este aviso lo ve todo el que abre el panel.
import { SB } from "./supabase.js";
import { state, esc, fechaCO } from "./state.js";
import { cargarCola, simularCupo } from "./data.js";

const VIGENCIA_MS = 2 * 60 * 1000;
let datos = null, leidoEn = 0, enCurso = null;

const MOTIVO = {
  tope: "llegaste al límite diario de envíos",
  canal: "tu WhatsApp no estaba vinculado",
  error: "WhatsApp rechazó el envío",
};
const causaDe = e => /^tope diario/.test(e) ? "tope" : /no vinculado/i.test(e) ? "canal" : "error";
// Lo que el panel mismo cancela con motivo, y las cascadas («omitido: …»)
// de un primer mensaje que ya se cuenta: no son fallos nuevos.
const esFalloDelWorker = e => e && !e.startsWith("omitido:") && e !== "Enlace congelado que nunca se envió";

async function leer() {
  const hoy = fechaCO();
  const [r, cola] = await Promise.all([
    SB.from("mensajes_programados")
      .select("error, campana_id, seguimiento_id, campanas(nombre), seguimientos(actividad)")
      .eq("owner_id", state.me.id).in("estado", ["cancelado", "error"]).not("error", "is", null)
      .gte("enviar_en", `${hoy}T00:00:00-05:00`).lte("enviar_en", new Date().toISOString()),
    cargarCola().catch(() => null),
  ]);
  const grupos = new Map();
  for (const m of (r.data || []).filter(m => esFalloDelWorker(m.error))) {
    const nombre = m.campanas?.nombre || m.seguimientos?.actividad || "Mensajes sueltos";
    const causa = causaDe(m.error), k = causa + "|" + nombre;
    const g = grupos.get(k) || { nombre, causa, n: 0 };
    g.n++; grupos.set(k, g);
  }
  const porDia = new Map();
  if (cola) for (const m of simularCupo(cola).fueraPrevias) porDia.set(m.dia, (porDia.get(m.dia) || 0) + 1);
  return { hoy, fallos: [...grupos.values()].sort((a, b) => b.n - a.n), futuros: [...porDia].sort(), tope: cola?.tope };
}

// Se pide al pintar y se repinta cuando llega; no más de una vez cada 2 min.
export function cargarAvisoEnvios(render) {
  if (!state.me || enCurso || (datos && Date.now() - leidoEn < VIGENCIA_MS)) return;
  enCurso = leer().then(d => { datos = d; leidoEn = Date.now(); render?.(); })
    .catch(() => {}).finally(() => { enCurso = null; });
}

// Firma de lo que se muestra: «Entendido» lo oculta hasta que cambie.
const firma = d => JSON.stringify([d.fallos.map(g => [g.nombre, g.causa, g.n]), d.futuros]);
const claveVisto = () => `nx.envAviso.${state.me?.id}`;
function visto(d) {
  try { return localStorage.getItem(claveVisto()) === d.hoy + firma(d); } catch { return false; }
}

const diaTxt = (d, hoy) => {
  if (d === hoy) return "hoy";
  if (d === fechaCO(new Date(Date.parse(hoy + "T12:00:00-05:00") + 864e5))) return "mañana";
  return `el ${d.slice(8, 10)}/${d.slice(5, 7)}`;
};

export function avisoEnviosHTML() {
  const d = datos;
  if (!d || (!d.fallos.length && !d.futuros.length) || visto(d)) return "";
  const MAX = 3;
  const filas = d.fallos.slice(0, MAX).map(g =>
    `<li><b>${g.n}</b> ${g.n === 1 ? "mensaje" : "mensajes"} de «${esc(g.nombre)}» no ${g.n === 1 ? "salió" : "salieron"}: ${MOTIVO[g.causa]}.</li>`);
  if (d.fallos.length > MAX) filas.push(`<li>Y ${d.fallos.length - MAX} envíos más con fallos: míralos en el registro de envíos de Seguimiento.</li>`);
  for (const [dia, n] of d.futuros) filas.push(
    `<li><b>${n}</b> ${n === 1 ? "persona programada" : "personas programadas"} para ${diaTxt(dia, d.hoy)} no ${n === 1 ? "recibirá" : "recibirán"} su mensaje: no ${n === 1 ? "cabe" : "caben"} en el límite diario de ${d.tope} envíos.</li>`);
  const titulo = d.fallos.length && d.futuros.length ? "Hay mensajes que no salieron y otros que no van a salir"
    : d.fallos.length ? "Hoy hay mensajes que no salieron" : "Hay mensajes programados que no van a salir";
  return `<div class="alerta mal envaviso" role="status">
    <div class="at">⚠ ${titulo}</div>
    <ul class="ax">${filas.join("")}</ul>
    <button type="button" class="envok" data-envok>Entendido</button>
  </div>`;
}

// «Entendido» guarda lo visto. Delegado: el aviso se repinta con cada render.
document.addEventListener("click", e => {
  if (!e.target.closest("[data-envok]") || !datos) return;
  try { localStorage.setItem(claveVisto(), datos.hoy + firma(datos)); } catch { /* sin storage: vuelve a salir */ }
  document.querySelectorAll(".envaviso").forEach(el => el.remove());
});
