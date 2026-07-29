// Estado compartido + utilidades + lógica de negocio.
// Todos los módulos leen y mutan este mismo objeto `state`.
import { NIVEL, REQ_DESDE } from "./config.js";

export const state = {
  clientes: [],
  catalogo: [],
  perfiles: {},
  // Miembros aprobados del equipo de un director (él incluido), para el
  // selector de «a nombre de quién» al crear un cliente. Vacío para los demás.
  equipo: [],
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

  /* ---- módulo de ventas ---- */
  ventas: [],
  productos: [],
  parametros: {},        // { comision_upgrade: 0 }
  metasFtd: [],          // [{ ftd, pago }] ordenadas
  ftdBase: {},           // { "<owner>|<YYYY-MM>": { base, declarado, cerrado } }
  metasAgente: {},       // { "<owner>|<YYYY-MM>": { meta_ftd, meta_ventas } }
  notas: {},             // { <cliente_id>: [nota, …] } más recientes primero
  // false mientras la migración de ventas no esté aplicada; la vista lo avisa
  // en vez de dejar la pantalla en blanco.
  ventasOk: false,
  ventasError: "",
  ventasPeriodo: new Date().toISOString().slice(0, 7),   // "YYYY-MM"
  ventaEdit: null,
  ventasAbiertas: new Set(),
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

/* ---------- ventas, abonos y comisiones ---------- */
// Todo en dólares. Sin decimales cuando son redondos, que es el caso normal.
export const usd = n => "$" + (Number(n) || 0).toLocaleString("en-US",
  { minimumFractionDigits: Number.isInteger(Number(n)) ? 0 : 2, maximumFractionDigits: 2 });

export const periodoDe = iso => (iso || "").slice(0, 7);
export const mesLegible = p => {
  const M = ["enero","febrero","marzo","abril","mayo","junio",
             "julio","agosto","septiembre","octubre","noviembre","diciembre"];
  const [a, m] = (p || "").split("-");
  return m ? `${M[+m - 1]} ${a}` : p;
};
// El periodo anterior a "2026-01" es "2025-12": no se puede restar sobre el texto.
export const periodoAntes = p => {
  const [a, m] = (p || "").split("-").map(Number);
  const d = new Date(a, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export const pagado = v => (v.abonos || []).reduce((s, a) => s + a.monto, 0);
export const saldo  = v => Math.max(0, v.valor - pagado(v));
// "Saldada" no es un estado que alguien marque: se deduce de los abonos. Así no
// puede haber dos verdades que se contradigan.
export const estaSaldada = v => v.estado !== "perdida" && v.valor > 0 && pagado(v) >= v.valor;

// Fecha en que la venta quedó saldada = la del abono que completó el valor.
// Es la que decide en qué mes se causa la comisión.
export function fechaSaldo(v) {
  let acc = 0;
  for (const a of v.abonos || []) { acc += a.monto; if (acc >= v.valor) return a.fecha; }
  return null;
}

// comision = 0 significa SIN DEFINIR, no "no comisiona". Esas ventas se marcan
// en la interfaz y NO suman: más vale un hueco visible que una cifra inventada.
export const comisionSinDefinir = v => !(v.comision > 0);

// Resumen de un periodo para un agente. `facturado` es lo RECAUDADO: para la
// empresa facturar es cobrar, así que no hay dos cifras distintas.
export function resumenVentas(periodo, ownerId) {
  const mias = state.ventas.filter(v => v.owner_id === ownerId);
  const vivas = mias.filter(v => v.estado !== "perdida" && !estaSaldada(v));

  const facturado = mias.reduce((s, v) =>
    s + (v.abonos || []).filter(a => periodoDe(a.fecha) === periodo)
                        .reduce((t, a) => t + a.monto, 0), 0);

  const causada = mias.filter(v => estaSaldada(v) && periodoDe(fechaSaldo(v)) === periodo)
                      .reduce((s, v) => s + v.comision, 0);

  // Pendientes: no son del periodo, son lo que hay vivo ahora mismo.
  const porFacturar = vivas.reduce((s, v) => s + saldo(v), 0);
  const porCausar   = vivas.reduce((s, v) => s + v.comision, 0);
  const sinDefinir  = vivas.filter(comisionSinDefinir).length;

  return { facturado, causada, porFacturar, porCausar, sinDefinir };
}

// FTD del mes. NO se cuentan por `membresia = 'Beca'`: ese es el nivel de HOY, y
// al subir alguien a VIP desaparecería de los meses ya cerrados y pagados. Se
// cuentan por `comunidad_desde`, que no se mueve nunca — todo el que hoy es Oro
// entró en su momento como FTD.
export const ftdDelMes = (periodo, ownerId) =>
  state.clientes.filter(c => c.owner_id === ownerId && periodoDe(c.comunidadDesde) === periodo).length;

// Los FTD no se pagan uno por uno sino por meta mensual alcanzada. Lo que sobra
// de la meta se acumula como "base" y ayuda el mes siguiente.
//
// Hay TRES números distintos y confundirlos fue el defecto original:
//   cargados  → los que están en la plataforma (clientes con comunidad_desde)
//   reales    → los que el agente dice que lleva de verdad (`declarado`)
//   sin subir → la diferencia, o sea su tarea pendiente
//
// El que manda para las metas es `reales`. Se toma el mayor entre lo declarado
// y lo cargado: si sube más de los que declaró, el número lo sigue en vez de
// quedarse corto.
export function comisionFtd(periodo, ownerId) {
  const cargados = ftdDelMes(periodo, ownerId);
  const fila = state.ftdBase[`${ownerId}|${periodo}`] || {};
  const base = fila.base || 0;
  const reales = fila.declarado != null ? Math.max(fila.declarado, cargados) : cargados;
  const efectivos = reales + base;

  const metas = state.metasFtd;
  const alcanzada = [...metas].reverse().find(m => efectivos >= m.ftd) || null;
  const siguiente = metas.find(m => m.ftd > efectivos) || null;

  return {
    cargados, reales, base, efectivos,
    sinSubir: Math.max(0, reales - cargados),
    declaro: fila.declarado != null,
    cerrado: !!fila.cerrado,
    meta: alcanzada ? alcanzada.ftd : 0,
    pago: alcanzada ? Number(alcanzada.pago) : 0,
    siguiente: siguiente ? siguiente.ftd : null,
    faltan: siguiente ? siguiente.ftd - efectivos : 0,
    // Lo que sobra pasa al mes siguiente como base. Se calcula siempre, pero
    // escribirlo es un acto explícito del cierre: lo que se pagó, se pagó.
    sobra: efectivos - (alcanzada ? alcanzada.ftd : 0),
  };
}

// Metas que el agente se puso para el mes. El total NO se guarda: es el pago de
// la meta de FTD más la meta de comisión por ventas, y derivarlo evita que las
// tres cifras se contradigan.
export function metasDe(periodo, ownerId) {
  const m = state.metasAgente[`${ownerId}|${periodo}`];
  if (!m) return null;
  const pagoFtd = Number((state.metasFtd.find(x => x.ftd === m.meta_ftd) || {}).pago || 0);
  const metaVentas = Number(m.meta_ventas) || 0;
  return { metaFtd: m.meta_ftd, metaVentas, pagoFtd, total: pagoFtd + metaVentas };
}

// El mes anterior quedó sin cerrar? Es lo que dispara el ritual del día 1.
export function periodoSinCerrar(ownerId) {
  const hoy = hoyISO().slice(0, 7);
  const ant = periodoAntes(hoy);
  const fila = state.ftdBase[`${ownerId}|${ant}`];
  // Solo tiene sentido cerrar un mes en el que hubo actividad.
  const hubo = ftdDelMes(ant, ownerId) > 0 || (fila && fila.declarado != null);
  return hubo && !(fila && fila.cerrado) ? ant : null;
}
