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
import { state, esc, esLead, esInactivo, nombreBroker, telColombia, ICO_TEL, ICO_ENV, sinSalto, raizScroll } from "./state.js";
import { recibeSegLead } from "./masivo.js";
import {
  TEMP, CATEGORIAS, categoria, temperatura, razon, tempAMano, contactosDe,
  form, abiertoAqui, esMio, manejarLead, cuandoTxt, nombreTipo, dias,
  respondioAuto, horaTxt, entranteDe,
} from "./leads.js";
import { primeroHoy } from "./entrantes.js";
import { crmDe, porBajarCrm, vinoDeHL, accionesCrm, accionCrm, manejarNotas, estadoCrm, esHoy, detectarBajadas } from "./crm.js";
import { renderMetaHoy } from "./ftd.js";

const ORDEN_T = { caliente: 0, tibio: 1, frio: 2 };

// Etiqueta corta, color e icono de cada etapa en el riel. El orden y las claves
// son los de CATEGORIAS; aquí solo vive lo visual.
const ETAPA = {
  pend:  { n: "Pendientes",     d: "Prometieron depositar",       c: "#E8B84B", ico: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.8"/>' },
  reg:   { n: "Registrados",    d: "Crearon cuenta, sin promesa", c: "#B07CE8", ico: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14 10h4M14 14h3"/>' },
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
// Solo el ícono, sin texto, para no quitarle espacio a la acción principal.
const ICO_WA = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.3-.5 0-1 .3-3.4-.7-2.9-1.2-4.7-4.1-4.9-4.3-.1-.2-1.2-1.6-1.2-3s.8-2.2 1-2.5c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg>';
const waBtn = c => {
  const tel = (c.tel || "").replace(/\D/g, "");
  return tel ? `<a class="lbtn hico hwa" href="https://wa.me/${tel}" target="_blank" rel="noopener" title="Abrir chat de WhatsApp" aria-label="Abrir chat de WhatsApp">${ICO_WA}</a>` : "";
};
const telBtn = c => {
  const co = telColombia(c.tel);
  return co ? `<a class="lbtn hico htel" href="tel:+${co}" title="Llamar al +${co}" aria-label="Llamar al +${co}">${ICO_TEL}</a>` : "";
};
function acciones(c) {
  for (const m of ["registro", "promesa", "deposito", "contacto"]) if (abiertoAqui(c, m)) return form(c);
  const cat = categoria(c);
  const l = crmDe(c);
  if (porBajarCrm(l)) {
    // Lo mismo que en «Mi día» más el embudo: puede registrarse antes de bajar.
    const emb = cat === "pend" ? `<button class="btn-ok mdbtn" data-l="deposito">Depositó</button><button class="lbtn mdbtn" data-l="promesa">Reagendar</button>`
      : cat === "reg" ? `<button class="lbtn mdbtn" data-l="promesa">Prometió depositar</button>`
      : `<button class="lbtn mdbtn" data-l="registro">Creó cuenta</button>`;
    return `<div class="hcrm">${accionesCrm(l, emb)}</div>`;
  }
  const mas = `<button class="lbtn hico" data-l="contacto" aria-label="Registrar contacto" title="Registrar contacto">${svg(MAS, "currentColor", 18)}</button>`;
  // Enviar seguimiento: solo ícono, como llamar y WhatsApp, para no quitarle
  // ancho a la acción del embudo.
  const env = recibeSegLead(c) ? `<button type="button" class="lbtn hico hsegico" data-l="enviarSeg" title="Enviar seguimiento" aria-label="Enviar seguimiento">${ICO_ENV}</button>` : "";
  // Los íconos van juntos: si en un celular angosto no caben al lado de las
  // acciones del embudo, bajan en bloque a otra línea en vez de cortar el texto.
  const icos = `<span class="hicos">${mas}${env}${telBtn(c)}${waBtn(c)}</span>`;
  if (cat === "pend") return `<div class="hacc"><button class="btn-ok hmain" data-l="deposito">Depositó</button><button class="lbtn" data-l="promesa">Reagendar</button>${icos}</div>`;
  if (cat === "reg") return `<div class="hacc"><button class="btn-oro hmain" data-l="promesa">Prometió depositar</button>${icos}</div>`;
  return `<div class="hacc"><button class="btn-oro hmain" data-l="registro">Creó cuenta</button>${icos}</div>`;
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

// Tarjetas de HighLevel abiertas a mano; las demás van plegadas.
const hlAbiertos = new Set();
const FORMS = ["temp", "registro", "promesa", "deposito", "contacto"];

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
  // La tarjeta de HighLevel es larga (cuatro grupos): va plegada y se abre al
  // tocarla (pedido del usuario, 20/10/2026). «Llamar» queda a la vista y la
  // temperatura baja junto a la razón para dejarle el ancho al nombre.
  const abierta = !hl || hlAbiertos.has(c.id) || FORMS.some(m => abiertoAqui(c, m));
  const pleg = hl ? `${abierta ? "" : telBtn({ tel: l.telefono || c.tel })}<button type="button" class="lbtn hico hpleg" data-pleg aria-expanded="${abierta}" aria-label="${abierta ? "Plegar" : "Abrir"} la tarjeta">${svg('<path d="M6 9l6 6 6-6"/>', "currentColor", 18)}</button>` : "";
  return `<div class="hfila${hl ? " hfhl" : ""}${abierta ? "" : " plegada"}" data-id="${c.id}">
    <div class="hl1"${hl ? " data-pleg-zona" : ""}>
      <span class="hav ${t}" aria-hidden="true">${esc(iniciales(c.nombre))}</span>
      <div class="hl1t"><button class="hnm" data-ver="${c.id}">${esc(c.nombre)}</button>${dep2}${escr}${origen}<div class="lwhy">${hl ? chip(c) : ""}${razon(c)}${est ? ` · ${est}` : ""}</div></div>
      ${hl ? pleg : chip(c)}
    </div>
    ${abierta ? `${abiertoAqui(c, "temp") ? form(c) : ""}
    ${hl ? "" : esperando(c)}${acciones(c)}` : ""}
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
    // Desde el riel la pantalla se queda quieta; «Siguiente etapa» (al pie) sí
    // sube hasta el título de la etapa nueva.
    if (!b.classList.contains("hsig")) { sinSalto(cont, render); return; }
    render();
    const t = document.querySelector(`.hetapa[data-etapa="${etapaSel}"]`);
    t?.scrollIntoView({ block: "nearest", inline: "center" });
    document.querySelector(".hseltit")?.scrollIntoView({ block: "start", behavior: "smooth" });
  });

  const mantener = id => {
    const s = `.hfila[data-id="${id}"]`;
    const antes = document.querySelector(s)?.getBoundingClientRect().top;
    render();
    const el = document.querySelector(s);
    if (antes != null && el) raizScroll().scrollTop += el.getBoundingClientRect().top - antes;
  };
  cont.querySelectorAll(".hfila").forEach(el => {
    const c = state.clientes.find(x => x.id === el.dataset.id);
    manejarLead(el, c, mantener);
    const l = crmDe(c);
    if (l) el.querySelectorAll("[data-crm]").forEach(b => b.onclick = e => {
      e.stopPropagation();
      accionCrm(l, b.dataset.crm, () => mantener(c.id), el);
    });
    manejarNotas(el);
    // Plegar/abrir: el chevrón o cualquier parte del encabezado que no sea un botón.
    el.querySelector("[data-pleg-zona]")?.addEventListener("click", e => {
      if (e.target.closest("a, button:not([data-pleg]), [data-l]")) return;
      hlAbiertos.has(c.id) ? hlAbiertos.delete(c.id) : hlAbiertos.add(c.id);
      mantener(c.id);
    });
    // El nombre lleva a su tarjeta completa (historial de contactos y embudo).
    el.querySelector("[data-ver]").onclick = e => {
      e.stopPropagation();
      state.leadsVista = "lista"; state.abiertos.add(c.id); render();
      document.querySelector(`.card[data-id="${c.id}"]`)?.scrollIntoView({ block: "start" });
    };
  });
}
