// Editor de una etapa de venta, al tocar su flecha en la tarjeta de Comunidad
// (pedido de Sanviv, 13/11/2026). Antes las flechas solo se miraban y había
// que abrir el perfil para corregir una.
//
// Escribe en el MISMO sitio que el resto del panel, para que nada se
// contradiga (las etapas se derivan, ver embudo.js):
//   · Básica y Operativa: asistencia a un servicio del catálogo (`acc`). Solo
//     «Asistió» o «Pendiente».
//   · Avanzada, Presentación y 1 a 1: zooms (`zooms`). «Asistió», «No asistió»
//     o «Pendiente». Pendiente BORRA el zoom, igual que en el perfil.
import { state, $, esc, toast, hoyISO } from "./state.js";
import { dbPatch } from "./data.js";
import { ETAPAS, SERVICIOS_DE, SERVICIOS_OPERATIVA, zoomDe, fechaServicio } from "./embudo.js";

let ctx = null;   // { c, k, alGuardar, estado }

const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const fechaTxt = d => { const [y, m, dd] = d.slice(0, 10).split("-"); return `${+dd} de ${MESES[+m - 1]} de ${y}`; };
const diasAtras = n => { const d = new Date(hoyISO() + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const nombreServicio = id => {
  for (const g of state.catalogo || []) for (const s of g.items || []) if (s.id === id) return s.n;
  return id;
};

// Lo que hay hoy guardado para esa etapa.
function leer(c, k) {
  if (SERVICIOS_DE[k]) {
    const f = fechaServicio(c, k);
    const de = f ? SERVICIOS_DE[k].find(s => c.acc?.[s] === f) : null;
    return { e: f ? "hecha" : "", f: f || "", de };
  }
  const z = (c.zooms || {})[zoomDe(k)] || {};
  return { e: z.e === "hecha" || z.e === "no_asistio" ? z.e : "", f: z.f || "" };
}

const OPCIONES = k => SERVICIOS_DE[k]
  ? [["hecha", "Asistió", "ok"], ["", "Pendiente", "pend"]]
  : [["hecha", "Asistió", "ok"], ["no_asistio", "No asistió", "no"], ["", "Pendiente", "pend"]];

function pintar() {
  const { c, k, estado } = ctx;
  const et = ETAPAS.find(e => e.k === k);
  $("etpOpts").innerHTML = OPCIONES(k).map(([v, l, cls]) =>
    `<button type="button" role="radio" class="etpopt ${cls}" data-v="${v}" aria-checked="${estado.e === v}">
      <span class="etpdot" aria-hidden="true"></span>${l}</button>`).join("");
  $("etpOpts").querySelectorAll(".etpopt").forEach(b => b.onclick = () => {
    estado.e = b.dataset.v;
    // Marcar sin fecha la deja en hoy: casi siempre se anota el mismo día.
    if (estado.e && !$("etpFecha").value) $("etpFecha").value = hoyISO();
    pintar();
  });
  // La fecha solo tiene sentido si pasó algo (asistió o no asistió).
  $("etpFechaRow").classList.toggle("hidden", !estado.e);
  $("etpFecha").max = hoyISO();

  const ayuda = [];
  if (k === "o") {
    ayuda.push(estado.e === "hecha" && ctx.antes.de && ctx.antes.de !== SERVICIOS_OPERATIVA[0]
      ? `Viene de «${esc(nombreServicio(ctx.antes.de))}». Cuenta cualquiera de las operativas con Juan Facundo: en Vivo, VIP u Oro.`
      : "Cuenta cualquiera de las operativas con Juan Facundo: en Vivo, VIP u Oro.");
    if (!estado.e && ctx.antes.e) ayuda.push("Pendiente quita su asistencia a las tres operativas.");
  }
  if (k === "b") ayuda.push(`Es la asistencia a «${esc(nombreServicio(SERVICIOS_DE.b[0]))}».`);
  // En el ciclo de upgrade solo cuenta lo de después del último pago.
  const desde = ctx.desde;
  const f = $("etpFecha").value;
  if (estado.e && desde && f && f <= desde)
    ayuda.push(`<b class="etpaviso">Esa fecha es anterior a su último pago (${esc(fechaTxt(desde))}): no cuenta para este ciclo.</b>`);
  $("etpAyuda").innerHTML = ayuda.join(" ");
  $("etpAyuda").classList.toggle("hidden", !ayuda.length);

  const cambio = estado.e !== ctx.antes.e || (estado.e && f !== ctx.antes.f);
  $("etpGuardar").disabled = !cambio || (!!estado.e && !f);
}

export function abrirEditorEtapa(c, k, desde, alGuardar) {
  const et = ETAPAS.find(e => e.k === k);
  if (!et) return;
  const antes = leer(c, k);
  ctx = { c, k, alGuardar, desde, antes, estado: { e: antes.e } };
  $("etpHead").style.setProperty("--c", `var(${et.c})`);
  $("etpBadge").textContent = ETAPAS.indexOf(et) + 1;
  $("etpTit").textContent = et.largo || et.l;
  $("etpQuien").textContent = c.nombre;
  $("etpFecha").value = antes.f || "";
  pintar();
  $("etpOverlay").classList.add("open");
  $("etpOpts").querySelector('[aria-checked="true"]')?.focus();
}

function cerrar() { $("etpOverlay").classList.remove("open"); ctx = null; }

async function guardar() {
  if (!ctx) return;
  const { c, k, estado, alGuardar } = ctx;
  const f = $("etpFecha").value;
  if (estado.e && !f) { toast("Elige la fecha"); return; }
  const btn = $("etpGuardar");
  btn.disabled = true;
  let campos;
  if (SERVICIOS_DE[k]) {
    const acc = { ...(c.acc || {}) };
    if (estado.e) {
      // Se corrige la operativa de la que venía la fecha; si no había ninguna,
      // se marca la «en Vivo».
      acc[ctx.antes.de || SERVICIOS_DE[k][0]] = f;
    } else {
      SERVICIOS_DE[k].forEach(s => delete acc[s]);
    }
    campos = { acc };
  } else {
    const zooms = { ...(c.zooms || {}) };
    if (estado.e) zooms[zoomDe(k)] = { f, e: estado.e };
    else delete zooms[zoomDe(k)];
    campos = { zooms };
  }
  const ok = await dbPatch(c, campos);
  btn.disabled = false;
  if (!ok) return;
  Object.assign(c, campos);
  const et = ETAPAS.find(e => e.k === k);
  toast(estado.e === "hecha" ? `✓ ${et.largo || et.l}: asistió` : estado.e ? `${et.largo || et.l}: no asistió` : `${et.largo || et.l}: pendiente`);
  cerrar();
  alGuardar?.();
}

$("etpGuardar").onclick = guardar;
$("etpCancelar").onclick = cerrar;
$("etpCerrar").onclick = cerrar;
$("etpOverlay").onclick = e => { if (e.target.id === "etpOverlay") cerrar(); };
$("etpFecha").oninput = () => ctx && pintar();
document.querySelectorAll("#etpFechaRow .etpquick").forEach(b => b.onclick = () => {
  $("etpFecha").value = diasAtras(+b.dataset.dia);
  if (ctx) pintar();
});
document.addEventListener("keydown", e => {
  if (!$("etpOverlay").classList.contains("open")) return;
  if (e.key === "Escape") cerrar();
});
