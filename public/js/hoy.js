// Panel «Hoy» de Leads: qué hacer hoy, en el orden de prioridad del usuario.
// No tiene reglas propias: categoría, temperatura y acciones salen de leads.js,
// para que el panel y la tarjeta del lead nunca digan cosas distintas.
//
// Muestra SOLO los leads propios: es una lista de trabajo, y las acciones
// (registrar contacto, depositó…) son del dueño. Un director supervisa a su
// equipo desde «Todos los leads».
//
// Diseño (validado en mockup, opción D): meta del día arriba, un riel con las
// seis etapas en orden de prioridad y, debajo, los leads de la etapa elegida.
//
// Leads de HighLevel (decisiones del usuario, 14/10/2026): dentro de cada etapa
// van en su propio grupo, antes que los de WhatsApp, mientras no bajen. Su
// seguimiento es desde el CRM (sin «Enviar seguimiento»). Si no bajan, salen de
// «Hoy» después de «Llegaron ayer», salvo que vuelvan por una fecha propia.
// Al bajar pasan al grupo de WhatsApp con la nota «vino de HighLevel».
import { state, esc, esLead, esInactivo, nombreBroker } from "./state.js";
import {
  TEMP, CATEGORIAS, categoria, temperatura, razon, tempAMano, contactosDe,
  form, abiertoAqui, esMio, manejarLead, cuandoTxt, nombreTipo, dias,
  respondioAuto, horaTxt, entranteDe,
} from "./leads.js";
import { primeroHoy } from "./entrantes.js";
import { crmDe, porBajarCrm, vinoDeHL, accionesCrm, accionCrm, estadoCrm, esHoy, detectarBajadas } from "./crm.js";
import { renderMetaHoy } from "./ftd.js";

const ORDEN_T = { caliente: 0, tibio: 1, frio: 2 };

// Etiqueta corta, color e icono de cada etapa en el riel. El orden y las claves
// son los de CATEGORIAS; aquí solo vive lo visual.
const ETAPA = {
  pend:  { n: "Pendientes",     d: "Prometieron depositar",       c: "#E8B84B", ico: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>' },
  reg:   { n: "Registrados",    d: "Abrieron cuenta, sin promesa", c: "#B07CE8", ico: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/>' },
  hoy:   { n: "Llegaron hoy",   d: "Entraron hoy",                 c: "#4ECB8D", ico: '<path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/>' },
  bajo:  { n: "Te escribieron", d: "Te escribieron hoy",           c: "#5B9BD5", ico: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>' },
  ayer:  { n: "Llegaron ayer",  d: "Entraron ayer",                c: "#8E9AA8", ico: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>' },
  resto: { n: "El resto",       d: "En espera",                    c: "#8E9AA8", ico: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>' },
};
const svg = (ico, color, s = 20) =>
  `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ico}</svg>`;

// Etapa elegida en el riel. null = ninguna elegida a mano: se muestra la
// primera con leads, para que el panel abra donde hay trabajo.
let etapaSel = null;
let rielScroll = 0;
// «Mi día» abre Leads directo en la etapa del lead que te pidió atender.
export const irAEtapa = k => { etapaSel = k; };

// Pendientes: primero los de hoy y los próximos (el más cercano arriba), después
// los vencidos (el más reciente arriba: todavía se puede rescatar). Una promesa
// de hoy a las 4 pm sigue siendo «de hoy» a las 6 pm: el día no se ha acabado.
function ordenPend(a, b) {
  const va = dias(a.promesaEn) > 0, vb = dias(b.promesaEn) > 0;
  if (va !== vb) return va ? 1 : -1;
  const d = new Date(a.promesaEn) - new Date(b.promesaEn);
  return va ? -d : d;
}
const ordenResto = (a, b) => ORDEN_T[temperatura(a)] - ORDEN_T[temperatura(b)] || a.nombre.localeCompare(b.nombre, "es");
// «Te escribieron»: por la hora de su PRIMER mensaje de hoy, el más antiguo
// arriba: es quien lleva más rato esperando respuesta.
const primeroDe = c => primeroHoy(c) || entranteDe(c) || "";
const ordenEscribio = (a, b) => primeroDe(a).localeCompare(primeroDe(b)) || ordenResto(a, b);

// Dato corto bajo el número de cada etapa: lo que pide atención dentro de ella.
function subEtapa(k, ls) {
  if (!ls.length) return "nadie";
  if (k === "pend") {
    const hoy = ls.filter(c => dias(c.promesaEn) === 0).length;
    const venc = ls.filter(c => dias(c.promesaEn) > 0).length;
    return hoy ? `${hoy} para hoy` : venc ? `${venc} vencida${venc === 1 ? "" : "s"}` : "próximas";
  }
  const sin = ls.filter(c => !contactosDe(c).length).length;
  if (k === "reg") return "sin promesa";
  if (k === "bajo") return "responde hoy";
  if (k === "resto") return "en espera";
  return sin ? `${sin} sin contactar` : "contactados";
}

const iniciales = n => n.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]).join("").toUpperCase();

const chip = c => {
  const t = temperatura(c);
  return `<button class="ltemp ${t}" data-l="temp" aria-label="Corregir temperatura"><i></i>${TEMP[t]}${tempAMano(c) ? " · a mano" : ""}</button>`;
};

const MAS = '<path d="M12 5v14M5 12h14"/>';
function acciones(c) {
  for (const m of ["registro", "promesa", "deposito", "contacto"]) if (abiertoAqui(c, m)) return form(c);
  const cat = categoria(c);
  const l = crmDe(c);
  if (porBajarCrm(l)) {
    // Lo mismo que en «Mi día» más el embudo: puede registrarse antes de bajar.
    const emb = cat === "pend" ? `<button class="btn-ok mdbtn" data-l="deposito">Depositó</button><button class="lbtn mdbtn" data-l="promesa">Reagendar</button>`
      : cat === "reg" ? `<button class="lbtn mdbtn" data-l="promesa">Prometió depositar</button>`
      : `<button class="lbtn mdbtn" data-l="registro">Abrió cuenta</button>`;
    return `<div class="hcrm">${accionesCrm(l, emb)}</div>`;
  }
  const mas = `<button class="lbtn hico" data-l="contacto" aria-label="Registrar contacto">${svg(MAS, "currentColor", 18)}</button>`;
  if (cat === "pend") return `<div class="hacc"><button class="btn-ok hmain" data-l="deposito">Depositó</button><button class="lbtn" data-l="promesa">Reagendar</button>${mas}</div>`;
  if (cat === "reg") return `<div class="hacc"><button class="btn-oro hmain" data-l="promesa">Prometió depositar</button>${mas}</div>`;
  return `<div class="hacc"><button class="btn-oro hmain" data-l="contacto">Registrar contacto</button><button class="lbtn" data-l="registro">Abrió cuenta</button></div>`;
}

// Si el último contacto no tiene respuesta, se pregunta aquí mismo: es lo que
// más mueve la temperatura y casi siempre se sabe al día siguiente.
function esperando(c) {
  const x = contactosDe(c)[0];
  if (!x || x.respuesta) return "";
  // Si ya te escribió después, no hay nada que preguntar: lo dice WhatsApp.
  const auto = respondioAuto(c, x);
  if (auto) return `<div class="hesp"><span>Le escribiste ${cuandoTxt(x.en)} · ${esc(nombreTipo(x.tipo))} · <b>✓ respondió</b> (automático)</span></div>`;
  return `<div class="hesp"><span>Le escribiste ${cuandoTxt(x.en)} · ${esc(nombreTipo(x.tipo))}</span>
    <span class="lacc"><button class="lbtn mini" data-l="resp" data-v="${x.id}" data-r="si">Respondió</button><button class="lbtn mini" data-l="resp" data-v="${x.id}" data-r="no">No</button></span></div>`;
}

const fila = c => {
  const t = temperatura(c);
  // Quien ya es Beca y está pendiente de otro depósito: se marca como 2º depósito
  // para no confundirlo con un lead en su primer FTD.
  const dep2 = !esLead(c) && c.promesaBroker
    ? `<span class="h2dep">2º depósito · ${esc(nombreBroker(c.promesaBroker))}</span>` : "";
  // Te escribió hoy: se marca en CUALQUIER etapa (un pendiente que escribe
  // sigue en Pendientes, pero hay que verlo). Con la hora de su primer mensaje.
  const ent = entranteDe(c), p = primeroHoy(c);
  const escr = ent && dias(ent) === 0
    ? `<span class="hescr">💬 ${p ? `Primer mensaje de hoy · ${horaTxt(p)}` : "Te escribió hoy"}</span>` : "";
  const l = crmDe(c), hl = porBajarCrm(l);
  const est = hl ? estadoCrm(l) : "";
  const origen = !hl && vinoDeHL(c) ? `<span class="hvino">vino de HighLevel</span>` : "";
  return `<div class="hfila${hl ? " hfhl" : ""}" data-id="${c.id}">
    <div class="hl1">
      <span class="hav ${t}" aria-hidden="true">${esc(iniciales(c.nombre))}</span>
      <div class="hl1t"><button class="hnm" data-ver="${c.id}">${esc(c.nombre)}</button>${dep2}${escr}${origen}<div class="lwhy">${razon(c)}${est ? ` · ${est}` : ""}</div></div>
      ${chip(c)}
    </div>
    ${abiertoAqui(c, "temp") ? form(c) : ""}
    ${hl ? "" : esperando(c)}${acciones(c)}
  </div>`;
};

// Un lead de HighLevel por bajar está en «Hoy» hasta «Llegaron ayer». Después,
// solo el día que vuelve por su fecha (reintento, «seguir en el CRM», llamada)
// o el día en que se anotó que sale. Sigue en «Todos los leads».
function enHoyHL(c) {
  const l = crmDe(c);
  if (!porBajarCrm(l)) return true;
  if (l.estado === "fuera") return esHoy(l.resultado_en);
  if (categoria(c) !== "resto") return true;
  return dias(l.siguiente_en) === 0 || dias(l.vuelve_en) === 0 || esHoy(l.resultado_en);
}

// Lista de la etapa: primero el grupo HighLevel (meta: bajarlos) y después el
// de WhatsApp. Sin leads de HighLevel no hay títulos de grupo.
function lista(ls) {
  const hl = ls.filter(c => porBajarCrm(crmDe(c))), wa = ls.filter(c => !porBajarCrm(crmDe(c)));
  if (!hl.length) return `<div class="hlista">${wa.map(fila).join("")}</div>`;
  const tit = (cls, n, t, d) => `<div class="hgrupo ${cls}"><b>${t}</b><span>${n}</span><em>${d}</em></div>`;
  return tit("hl", hl.length, "HighLevel", "por bajar a WhatsApp")
    + `<div class="hlista">${hl.map(fila).join("")}</div>`
    + (wa.length ? tit("wa", wa.length, "WhatsApp", "ya te escriben") + `<div class="hlista">${wa.map(fila).join("")}</div>` : "");
}

export function renderHoy(cont, render) {
  detectarBajadas(render);
  // Leads propios activos y, además, becados propios pendientes de un 2º depósito
  // (promesa con broker): esos también son trabajo de hoy. Un becado sin promesa
  // no aparece; la categoría los deja en «Pendientes» (categoria() mira promesaEn).
  const mios = state.clientes.filter(c => !esInactivo(c) && esMio(c)
    && (esLead(c) || (c.promesaEn && c.promesaBroker)) && enHoyHL(c));
  const por = Object.fromEntries(CATEGORIAS.map(([k]) => [k, []]));
  mios.forEach(c => por[categoria(c)].push(c));
  por.pend.sort(ordenPend);
  CATEGORIAS.forEach(([k]) => { if (k !== "pend") por[k].sort(k === "bajo" ? ordenEscribio : ordenResto); });

  const sel = etapaSel || (CATEGORIAS.find(([k]) => por[k].length) || ["pend"])[0];
  const prometieronHoy = por.pend.filter(c => dias(c.promesaEn) === 0).length;

  const riel = CATEGORIAS.map(([k]) => {
    const e = ETAPA[k], ls = por[k];
    return `<button type="button" class="hetapa ${k === sel ? "on" : ""} ${ls.length ? "" : "vacia"}" data-etapa="${k}" style="--c:${e.c}" aria-pressed="${k === sel}">
      ${svg(e.ico, e.c)}
      <b>${ls.length}</b>
      <span class="hetn">${e.n}</span>
      <span class="hets">${subEtapa(k, ls)}</span>
    </button>`;
  }).join("");

  const i = CATEGORIAS.findIndex(([k]) => k === sel);
  const sig = CATEGORIAS.slice(i + 1).find(([k]) => por[k].length);
  const ls = por[sel];

  cont.innerHTML = `
    <div id="hoyMeta"></div>
    <div class="hoyadd"><button type="button" id="hoyAddPend" class="tbtn">+ Pendiente de depósito</button></div>
    ${mios.length ? `
    <div class="hrielh"><span>Etapas de hoy</span><span>en orden de prioridad</span></div>
    <div class="hriel" id="hRiel">${riel}</div>
    <div class="hseltit"><h2>${ETAPA[sel].n}</h2><span>${ETAPA[sel].d}</span></div>
    ${ls.length ? lista(ls)
      : `<div class="hvacia">Nadie en esta etapa por ahora.</div>`}
    ${sig ? `<button type="button" class="hsig" data-etapa="${sig[0]}">Siguiente etapa: ${ETAPA[sig[0]].n} (${por[sig[0]].length})
      ${svg('<path d="M9 6l6 6-6 6"/>', "currentColor", 16)}</button>` : ""}`
    : `<div class="vacio"><b>No tienes leads activos</b>Cuando agregues uno, aquí verás qué hacer con él cada día.</div>`}`;

  renderMetaHoy(cont.querySelector("#hoyMeta"), render, prometieronHoy);

  // «+ Pendiente de depósito»: elige a cualquiera (lead o becado) y déjalo
  // pendiente de un depósito en un broker. Carga a demanda para no engordar hoy.js.
  cont.querySelector("#hoyAddPend")?.addEventListener("click", () => {
    import("./pendep.js").then(m => m.abrirPendienteDep(render)).catch(() => {});
  });

  // El riel se redibuja en cada render: se conserva el desplazamiento horizontal
  // para que elegir una etapa no lo devuelva al principio.
  const rielEl = cont.querySelector("#hRiel");
  if (rielEl) {
    rielEl.scrollLeft = rielScroll;
    rielEl.onscroll = () => { rielScroll = rielEl.scrollLeft; };
  }
  cont.querySelectorAll("[data-etapa]").forEach(b => b.onclick = () => {
    etapaSel = b.dataset.etapa;
    render();
    if (b.classList.contains("hsig")) {
      const t = document.querySelector(`.hetapa[data-etapa="${etapaSel}"]`);
      t?.scrollIntoView({ block: "nearest", inline: "center" });
      document.querySelector(".hseltit")?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });

  const mantener = id => {
    const s = `.hfila[data-id="${id}"]`;
    const antes = document.querySelector(s)?.getBoundingClientRect().top;
    render();
    const el = document.querySelector(s);
    if (antes != null && el) window.scrollBy(0, el.getBoundingClientRect().top - antes);
  };
  cont.querySelectorAll(".hfila").forEach(el => {
    const c = state.clientes.find(x => x.id === el.dataset.id);
    manejarLead(el, c, mantener);
    const l = crmDe(c);
    if (l) el.querySelectorAll("[data-crm]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      accionCrm(l, b.dataset.crm, () => mantener(c.id), el);
    });
    // El nombre lleva a su tarjeta completa (historial de contactos y embudo).
    el.querySelector("[data-ver]").onclick = e => {
      e.stopPropagation();
      state.leadsVista = "lista"; state.abiertos.add(c.id); render();
      document.querySelector(`.card[data-id="${c.id}"]`)?.scrollIntoView({ block: "start" });
    };
  });
}
