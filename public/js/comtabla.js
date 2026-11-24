// Vista «Tabla» de Comunidad (23/11/2026, pedido de Sanviv): los mismos
// clientes que la vista de flechas, en filas tipo Excel para recorrerlos y
// anotar. Usa la población, los filtros y la búsqueda de ui.js; aquí solo se
// pinta la tabla, se ordena por columna y se guardan las dos celdas editables.
//
// Necesidad y recomendación se guardan CAMPO POR CAMPO (dbPatch), nunca con
// `mapAEditar`: para los clientes de Sanviv las escribe también la IA que lee
// sus chats, y guardar el perfil no debe pisar lo que ella dejó.
import { state, esc, hoyISO, toast } from "./state.js";
import { dbPatch } from "./data.js";
import { SERVICIOS_OPERATIVA } from "./embudo.js";

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const corta = d => { const [, m, dd] = (d || "").slice(0, 10).split("-"); return m ? `${+dd}/${MESES[+m - 1]}` : ""; };
const dias = iso => iso ? Math.max(0, Math.round((new Date(hoyISO() + "T12:00:00Z") - new Date(iso.slice(0, 10) + "T12:00:00Z")) / 864e5)) : null;
const usd = n => "$" + Math.round(n || 0).toLocaleString("en-US");

// `acc` guarda la ÚLTIMA fecha por servicio, no cada asistencia: se cuentan
// servicios distintos. Las operativas van aparte (pedido: desglosado por tipo).
// Las puntuales sí son una por actividad. Los zooms de venta no se cuentan:
// ya están en las etapas (decisión de Sanviv).
export const clases = c => ({
  srv: Object.entries(c.acc || {}).filter(([k, v]) => v && !SERVICIOS_OPERATIVA.includes(k)).length,
  ops: SERVICIOS_OPERATIVA.filter(k => c.acc?.[k]).length,
  pun: Object.values(c.pun || {}).filter(p => p && p.acc).length,
});

const ultimaNota = c => (state.notas?.[c.id] || [])[0] || null;

/* Recomendación de venta que se deriva de la etapa y del pago. Es la que se ve
   mientras nadie escriba una propia (`recomendacion` NULL). */
export function recomendacionAuto(e) {
  if (!e) return "";
  if (e.oro) return "Nivel máximo: mantener el contacto y pedir referidos.";
  if (e.est.u?.f) {
    const r = e.res;
    if (!r) return "";   // las ventas aún cargan: no se inventa nada
    if (r.r === "agp") return r.venc ? `Pago vencido el ${corta(r.f)}: llamar y acordar una fecha nueva.` : `Paga el ${corta(r.f)}: recordar el pago el día anterior.`;
    if (r.r === "aga") return r.venc ? `Abono vencido el ${corta(r.f)}: llamar y acordar una fecha nueva.` : `Abona el ${corta(r.f)}: recordar el pago el día anterior.`;
    if (r.r === "abo") return `Abonó ${usd(r.ab)}${r.valor ? ` de ${usd(r.valor)}` : ""}: acordar la fecha del saldo.`;
    return "Tuvo el 1 a 1 sin acuerdo: resolver su objeción y proponer un abono.";
  }
  const sig = e.etapas.find(x => !e.est[x.k].f);
  if (!sig) return "";
  if (e.est[sig.k].no) return sig.k === "u" ? "No asistió al 1 a 1: reagendar." : `No asistió a la ${sig.largo || sig.l}: reagendar.`;
  return {
    b: "Invitar a la Básica (Nivel 0 a Avanzado).",
    o: "Invitar a la Operativa en Vivo.",
    a: "Invitar a la próxima clase Avanzada.",
    p: "Invitar a la Presentación de Membresías.",
    u: "Ya vio la Presentación: agendar el 1 a 1 esta semana.",
  }[sig.k];
}

function resultadoCorto(e) {
  if (e.oro) return ["max", "Oro · nivel máximo"];
  const r = e.res;
  if (r) {
    if (r.r === "agp") return [r.venc ? "venc" : "pend", `${r.venc ? "Pago vencido" : "Paga"} ${corta(r.f)}`];
    if (r.r === "aga") return [r.venc ? "venc" : "pend", `${r.venc ? "Abono vencido" : "Abona"} ${corta(r.f)}`];
    if (r.r === "abo") return ["pend", `Abonó ${usd(r.ab)}`];
    return ["sin", "Sin acuerdo"];
  }
  if (e.upgrade) return ["sin", `Upgrade${e.desde ? ` · desde ${corta(e.desde)}` : ""}`];
  return null;
}

// Columnas ordenables. `v` da el valor; los vacíos van siempre al final.
const COLS = {
  nombre: { v: c => c.nombre, txt: true },
  dias:   { v: c => dias(c.comunidadDesde) },
  etapas: { v: (c, E) => E(c).oro ? 6 : E(c).nivel },
  srv:    { v: c => clases(c).srv },
  ops:    { v: c => clases(c).ops },
  pun:    { v: c => clases(c).pun },
  nota:   { v: c => ultimaNota(c)?.creado_en || null, txt: true },
};

export function ordenarTabla(vis, E) {
  const { k, dir } = state.ordTabla;
  const col = COLS[k] || COLS.dias;
  return vis.map(c => [c, col.v(c, E)]).sort(([a, x], [b, y]) => {
    const vx = x == null || x === "", vy = y == null || y === "";
    if (vx !== vy) return vx ? 1 : -1;
    if (!vx && x !== y) return (col.txt ? String(x).localeCompare(String(y), "es") : x - y) * dir;
    return a.nombre.localeCompare(b.nombre, "es");
  }).map(([c]) => c);
}

function th(k, l, cls = "", largo = "") {
  const on = state.ordTabla.k === k;
  const fl = on ? (state.ordTabla.dir > 0 ? "↑" : "↓") : "↕";
  return `<th class="${cls}" ${largo ? `title="${largo}"` : ""} ${on ? `aria-sort="${state.ordTabla.dir > 0 ? "ascending" : "descending"}"` : ""}>`
    + `<button type="button" class="ctord ${on ? "on" : ""}" data-ord="${k}">${l}<span aria-hidden="true">${fl}</span></button></th>`;
}

function etapasMini(c, e) {
  if (e.oro) return "";
  return `<div class="ctetp">${e.etapas.map(x => {
    const st = e.est[x.k];
    const sub = st.f ? corta(st.f) : st.no ? "No asistió" : "Pendiente";
    const letra = x.k === "u" ? "1" : x.l[0];
    return `<button type="button" class="ctest ${st.f ? "ok" : st.no ? "no" : ""}" data-etp="${x.k}" style="--c:var(${x.c})"`
      + ` title="${esc(x.largo || x.l)} · ${sub} · tocar para editar" aria-label="${esc(x.largo || x.l)}: ${sub}. Editar">${letra}</button>`;
  }).join("")}</div>`;
}

export function tablaHTML(vis, E, dir) {
  const filas = vis.map(c => {
    const e = E(c), cl = clases(c), d = dias(c.comunidadDesde), n = ultimaNota(c), res = resultadoCorto(e);
    const auto = recomendacionAuto(e);
    const owner = dir && c.owner_id !== state.me.id ? `<span class="ctown">👤 ${esc(state.perfiles[c.owner_id] || "agente")}</span>` : "";
    return `<tr data-id="${c.id}">
      <td class="ctfija"><button type="button" class="ctnom" data-perfil="${c.id}" title="Abrir el perfil">${esc(c.nombre)}</button>
        <span class="badge b-${c.mem}">${c.mem}</span>${owner}</td>
      <td class="ctnum">${d == null ? `<span class="ctvacio">—</span>` : `${d}<small>desde ${corta(c.comunidadDesde)}</small>`}</td>
      <td>${etapasMini(c, e)}${res ? `<span class="ctres ${res[0]}">${esc(res[1])}</span>` : ""}</td>
      <td class="ctnum ${cl.srv ? "" : "cero"}">${cl.srv}</td>
      <td class="ctnum ${cl.ops ? "" : "cero"}">${cl.ops}</td>
      <td class="ctnum ${cl.pun ? "" : "cero"}">${cl.pun}</td>
      <td class="ctnota">${!state.ventasOk ? `<span class="ctvacio">…</span>` : n
        ? `<span class="ctntxt" title="${esc(n.texto)}">${esc(n.texto)}</span><small>${corta(n.creado_en)}</small>`
        : `<span class="ctvacio">Sin notas</span>`}</td>
      <td class="ctedit"><textarea rows="2" data-campo="necesidad" maxlength="1000" aria-label="Necesidad de ${esc(c.nombre)}"
        placeholder="¿Qué quiere lograr? ¿Qué lo frena?">${esc(c.necesidad || "")}</textarea></td>
      <td class="ctedit">${c.recomendacion ? "" : auto ? `<span class="ctauto">Según etapa</span>` : ""}
        <textarea rows="2" data-campo="recomendacion" maxlength="1000" aria-label="Recomendación de venta para ${esc(c.nombre)}"
        class="${c.recomendacion ? "" : "esauto"}" placeholder="${esc(auto || "Escribe la recomendación")}">${esc(c.recomendacion || "")}</textarea></td>
    </tr>`;
  }).join("");
  return `<div class="ctbox"><table class="cttabla">
    <thead>
      <tr>
        ${th("nombre", "Cliente", "ctfija")}${th("dias", "Días", "ctnum", "Días en Nexus, desde su primer FTD")}${th("etapas", "Etapas")}
        ${th("srv", "Serv.", "ctnum", "Servicios distintos a los que asistió (sin operativas)")}${th("ops", "Oper.", "ctnum", "Operativas con Juan Facundo a las que asistió (de 3)")}${th("pun", "Punt.", "ctnum", "Actividades puntuales a las que asistió")}
        ${th("nota", "Última nota")}<th>Necesidad</th><th>Recomendación de venta</th>
      </tr>
    </thead>
    <tbody>${filas}</tbody>
  </table></div>`;
}

// `alto` ajusta la celda al texto para que se lea entero sin barra propia.
const alto = t => { t.style.height = "auto"; t.style.height = t.scrollHeight + 2 + "px"; };

export function wireTabla(root, { abrirPerfil, editarEtapa, repintar }) {
  root.querySelectorAll(".ctord").forEach(b => b.onclick = () => {
    const k = b.dataset.ord;
    state.ordTabla = state.ordTabla.k === k ? { k, dir: -state.ordTabla.dir } : { k, dir: k === "nombre" ? 1 : -1 };
    try { localStorage.setItem("nx.ordTabla", JSON.stringify(state.ordTabla)); } catch {}
    repintar();
  });
  root.querySelectorAll("tbody tr").forEach(tr => {
    const c = state.clientes.find(x => x.id === tr.dataset.id);
    if (!c) return;
    tr.querySelector(".ctnom").onclick = () => abrirPerfil(c);
    tr.querySelectorAll("[data-etp]").forEach(b => b.onclick = () => editarEtapa(c, b.dataset.etp));
    tr.querySelectorAll("textarea[data-campo]").forEach(t => {
      alto(t);
      t.oninput = () => alto(t);
      // Enter guarda (como una celda de Excel); Shift+Enter hace un salto de línea.
      t.onkeydown = ev => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); t.blur(); } };
      t.onblur = () => guardarCampo(c, t.dataset.campo, t.value, () => {
        if (t.dataset.campo === "recomendacion") {
          t.classList.toggle("esauto", !c.recomendacion);
          const tag = t.parentElement.querySelector(".ctauto");
          if (tag) tag.hidden = !!c.recomendacion;
        }
      });
    });
  });
}

/* Guarda una celda si cambió. Vacío = NULL: en la recomendación, eso devuelve
   la que se deriva de la etapa. */
export async function guardarCampo(c, campo, valor, despues) {
  const v = (valor || "").trim() || null;
  if ((c[campo] || null) === v) return;
  const antes = c[campo];
  c[campo] = v;
  if (await dbPatch(c, { [campo]: v })) { toast("Guardado ✓"); despues?.(); }
  else c[campo] = antes;
}
