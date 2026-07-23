// Estado compartido + utilidades + lógica de negocio.
// Todos los módulos leen y mutan este mismo objeto `state`.
import { NIVEL, REQ_DESDE } from "./config.js";

export const state = {
  clientes: [],
  catalogo: [],
  perfiles: {},
  me: null,
  modulo: "comunidad",   // "comunidad" | "leads"
  filtro: "todos",
  orden: "cerca",
  vista: "cliente",      // "cliente" | "servicio"
  abiertos: new Set(),
  // Acordeones de la vista por servicio (true = desplegado).
  srvOpen: { asis: false, conf: true, pend: true },
  cliEdit: null,
  srvEdit: null,
  signupMode: false,
};

/* ---------- utilidades DOM ---------- */
export const $ = id => document.getElementById(id);
export const hoyISO = () => new Date().toISOString().slice(0, 10);
export const fmtF = iso => { const p = (iso || "").split("-"); return p.length === 3 ? `${p[2]}/${p[1]}` : (iso || ""); };
export const esc = s => (s || "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
// Para búsquedas: minúsculas y sin acentos ("César" → "cesar").
export const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
export const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Snippets: reemplaza cada {a|b|c} por una opción al azar. Se resuelve POR
// PERSONA, así dos contactos nunca reciben el texto idéntico (menos riesgo de
// que WhatsApp lo marque como spam). Solo toca grupos que tengan "|", por eso
// las etiquetas normales ({nombre}, {hora}, {enlace}…) quedan intactas.
// OJO: no anidar llaves dentro de un snippet — el grupo no puede contener { }.
export const resolverSnippets = t => (t || "").replace(/\{([^{}]*\|[^{}]*)\}/g,
  (m, g) => { const o = g.split("|"); return o[Math.floor(Math.random() * o.length)].trim(); });

export function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2400);
}

export function copyNum(num) {
  const txt = (num || "").trim();
  const ok = () => toast("📋 Número copiado: " + txt);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(ok).catch(() => fallbackCopy(txt, ok));
  } else {
    fallbackCopy(txt, ok);
  }
}
function fallbackCopy(txt, ok) {
  try {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    document.execCommand("copy"); document.body.removeChild(ta); ok();
  } catch (e) {
    toast("Copia manual: " + txt);
  }
}

/* ---------- lógica de negocio ---------- */
export const todos = () => state.catalogo.flatMap(g => g.items);

// Nivel mínimo de membresía para el que un servicio es "requerido".
export const reqDesde = s => (s.tier ? REQ_DESDE[s.tier] : 1);

// ¿Es requerido para esta persona? (a su nivel o por debajo)
export const esRequerido = (mem, s) => NIVEL[mem] >= reqDesde(s);

// ¿Es adicional/invitación? (por encima de su nivel; igual se puede marcar)
export const esAdicional = (mem, s) => !esRequerido(mem, s);

export const esLead = c => c.mem === "Lead";

// Progreso: el % y "faltan" se miden solo contra los servicios REQUERIDOS.
// `extra` = cuántos servicios adicionales (de invitación) ya tomó.
export function progreso(c) {
  const req = todos().filter(s => esRequerido(c.mem, s));
  const done = req.filter(s => c.acc[s.id]).length;
  const extra = todos().filter(s => esAdicional(c.mem, s) && c.acc[s.id]).length;
  return { done, total: req.length, pct: req.length ? Math.round(done / req.length * 100) : 0, extra };
}

// Siguiente sugerido: primero un requerido pendiente; si no hay, una invitación.
export const siguiente = c => {
  const req = todos().find(s => esRequerido(c.mem, s) && !c.acc[s.id]);
  return req || todos().find(s => !c.acc[s.id]);
};
