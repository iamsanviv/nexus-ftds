// Panel «Hoy» de Leads: qué hacer hoy, en el orden de prioridad del usuario.
// No tiene reglas propias: categoría, temperatura y acciones salen de leads.js,
// para que el panel y la tarjeta del lead nunca digan cosas distintas.
//
// Muestra SOLO los leads propios: es una lista de trabajo, y las acciones
// (registrar contacto, depositó…) son del dueño. Un director supervisa a su
// equipo desde «Todos los leads».
import { state, esc, esLead, esInactivo } from "./state.js";
import {
  TEMP, CATEGORIAS, categoria, temperatura, razon, manualVigente, contactosDe,
  form, abiertoAqui, esMio, manejarLead, cuandoTxt, nombreTipo, dias,
} from "./leads.js";
import { renderRitmoEn } from "./ftd.js";

let filtroT = "todos", restoAbierto = false;
const ORDEN_T = { caliente: 0, tibio: 1, frio: 2 };

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

const chip = (c, mio) => {
  const t = temperatura(c);
  const txt = `<i></i>${TEMP[t]}${manualVigente(c) ? " · a mano" : ""}`;
  return mio ? `<button class="ltemp ${t}" data-l="temp" aria-label="Corregir temperatura">${txt}</button>`
             : `<span class="ltemp ${t}">${txt}</span>`;
};

function acciones(c) {
  for (const m of ["registro", "promesa", "deposito", "contacto"]) if (abiertoAqui(c, m)) return form(c);
  const cat = categoria(c);
  const con = `<button class="lbtn" data-l="contacto">Registrar contacto</button>`;
  if (cat === "pend") return `<div class="lacc"><button class="btn-ok" data-l="deposito">Depositó</button><button class="lbtn" data-l="promesa">Reagendar</button>${con}</div>`;
  if (cat === "reg") return `<div class="lacc"><button class="btn-oro" data-l="promesa">Prometió depositar</button>${con}</div>`;
  return `<div class="lacc">${con}<button class="lbtn" data-l="registro">Abrió cuenta</button></div>`;
}

// Si el último contacto no tiene respuesta, se pregunta aquí mismo: es lo que
// más mueve la temperatura y casi siempre se sabe al día siguiente.
function esperando(c) {
  const x = contactosDe(c)[0];
  if (!x || x.respuesta) return "";
  return `<div class="hesp"><span>Le escribiste ${cuandoTxt(x.en)} · ${esc(nombreTipo(x.tipo))}</span>
    <span class="lacc"><button class="lbtn mini" data-l="resp" data-v="${x.id}" data-r="si">Respondió</button><button class="lbtn mini" data-l="resp" data-v="${x.id}" data-r="no">No</button></span></div>`;
}

const fila = c => `<div class="hfila" data-id="${c.id}">
    <div class="hl1"><button class="hnm" data-ver="${c.id}">${esc(c.nombre)}</button>${chip(c, true)}</div>
    ${abiertoAqui(c, "temp") ? form(c) : ""}
    <div class="lwhy">${razon(c)}</div>
    ${esperando(c)}${acciones(c)}
  </div>`;

export function renderHoy(cont, render) {
  const mios = state.clientes.filter(c => esLead(c) && !esInactivo(c) && esMio(c));
  const n = t => mios.filter(c => temperatura(c) === t).length;
  const vis = filtroT === "todos" ? mios : mios.filter(c => temperatura(c) === filtroT);

  const filtros = [["todos", "Todos"], ["caliente", "Calientes"], ["tibio", "Tibios"], ["frio", "Fríos"]]
    .map(([k, l]) => `<button class="hf ${k} ${filtroT === k ? "on" : ""}" data-t="${k}">${k === "todos" ? "" : "<i></i>"}${l}${k === "todos" ? "" : ` <b>${n(k)}</b>`}</button>`).join("");

  const secs = CATEGORIAS.map(([k, t], i) => {
    const ls = vis.filter(c => categoria(c) === k).sort(k === "pend" ? ordenPend : ordenResto);
    const cab = `<span class="prio">${i + 1}</span><span class="hsect">${t}</span><span class="lcnt">${ls.length}</span>`;
    if (!ls.length) return `<div class="hsec vacia"><div class="hsech">${cab}</div></div>`;
    // «El resto» va plegado, salvo que se esté filtrando: un filtro que no
    // muestra a quien coincide parece roto.
    if (k === "resto" && !restoAbierto && filtroT === "todos")
      return `<div class="hsec"><button class="hplegado" data-resto>${cab}<span class="hver">Ver</span></button></div>`;
    return `<div class="hsec ${k}"><div class="hsech">${cab}</div>${ls.map(fila).join("")}</div>`;
  }).join("");

  cont.innerHTML = `
    <div id="hoyMeta"></div>
    <div class="hfiltros">${filtros}</div>
    ${mios.length ? secs : `<div class="vacio"><b>No tienes leads activos</b>Cuando agregues uno, aquí verás qué hacer con él cada día.</div>`}
    <div class="hleyenda"><b>Cómo se calcula la temperatura</b><br>
      Promesa de hoy o futura: caliente · vencida 1–2 días: tibio · 3 o más: frío.<br>
      Te respondió o abrió cuenta hoy: caliente · hace 1–2 días: tibio · 3 o más: frío.<br>
      Sin respuesta: tibio, y frío a los 3 días. Corregirla a mano vale hasta el próximo contacto.</div>`;

  renderRitmoEn(cont.querySelector("#hoyMeta"), render);

  cont.querySelectorAll("[data-t]").forEach(b => b.onclick = () => { filtroT = b.dataset.t; render(); });
  const pl = cont.querySelector("[data-resto]"); if (pl) pl.onclick = () => { restoAbierto = true; render(); };
  const mantener = id => {
    const sel = `.hfila[data-id="${id}"]`;
    const antes = document.querySelector(sel)?.getBoundingClientRect().top;
    render();
    const el = document.querySelector(sel);
    if (antes != null && el) window.scrollBy(0, el.getBoundingClientRect().top - antes);
  };
  cont.querySelectorAll(".hfila").forEach(el => {
    const c = state.clientes.find(x => x.id === el.dataset.id);
    manejarLead(el, c, mantener);
    // El nombre lleva a su tarjeta completa (historial de contactos y embudo).
    el.querySelector("[data-ver]").onclick = e => {
      e.stopPropagation();
      state.leadsVista = "lista"; state.abiertos.add(c.id); render();
      document.querySelector(`.card[data-id="${c.id}"]`)?.scrollIntoView({ block: "start" });
    };
  });
}
