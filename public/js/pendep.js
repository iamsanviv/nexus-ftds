// «+ Pendiente de depósito»: deja a cualquier persona propia (lead o becado)
// pendiente de un depósito en un broker. Es la opción B del mockup aprobado:
// un selector único que llega también a los becados, pensado para el 2º depósito
// de quien ya tiene beca (ya depositó en un broker y puede hacerlo en otro).
//
// Escribe el embudo (promesa_en + promesa_broker) directo, igual que la tarjeta
// del lead; no abre una vía nueva. El depósito luego se registra desde «Hoy»
// («Depositó»), que suma el FTD al broker y limpia la promesa.
import { state, $, esc, toast, BROKERS, nombreBroker, esLead, esInactivo,
  normBusqueda, hoyISO } from "./state.js";
import { dbPatch } from "./data.js";

// La hora es OPCIONAL: sin hora se guarda con segundos :01 como marca, igual que
// la promesa del lead (ver leads.sinHora). Hora Colombia (UTC-5 fijo).
const promesaISO = (f, h) => h ? `${f}T${h}:00-05:00` : `${f}T00:00:01-05:00`;
const primer = n => (n || "").trim().split(/\s+/)[0];

let selId = null, brkSel = null, alTerminar = null;

// Brokers donde la persona AÚN no tiene FTD: son los únicos donde puede quedar
// pendiente de depositar.
const brokersLibres = c => BROKERS.filter(b => !(c.ftds || {})[b.id]);

// Elegibles: propios, activos, con teléfono y con al menos un broker libre.
const elegibles = () => state.clientes.filter(c =>
  !esInactivo(c) && c.owner_id === state.me?.id && c.tel && brokersLibres(c).length);

function pintarLista() {
  const q = normBusqueda($("pdBuscar").value);
  const todos = elegibles();
  const lista = todos.filter(c => !q || normBusqueda(c.nombre).includes(q)).slice(0, 50);
  $("pdLista").innerHTML = lista.length ? lista.map(c => {
    const tiene = BROKERS.filter(b => (c.ftds || {})[b.id]).map(b => b.corto).join(" + ");
    const et = esLead(c) ? "Lead" : (tiene ? `${esc(c.mem)} · ${tiene}` : esc(c.mem));
    return `<button type="button" class="pdrow ${c.id === selId ? "on" : ""}" data-pid="${c.id}">
      <span class="nm">${esc(c.nombre)}</span><span class="meta">${et}</span></button>`;
  }).join("")
    : `<div class="naplica">${todos.length ? "Nadie con ese nombre." : "No tienes personas con teléfono y un broker libre."}</div>`;
  $("pdLista").querySelectorAll("[data-pid]").forEach(b => b.onclick = () => elegir(b.dataset.pid));
}

function elegir(id) {
  selId = id;
  const c = state.clientes.find(x => x.id === id);
  const libres = brokersLibres(c);
  // Preselecciona el broker de una promesa previa si sigue libre; si no, el primero.
  brkSel = (libres.find(b => b.id === c.promesaBroker) || libres[0] || {}).id || null;
  pintarLista(); pintarDetalle();
}

function pintarDetalle() {
  const c = state.clientes.find(x => x.id === selId);
  if (!c) { $("pdDetalle").classList.add("hidden"); $("pdOk").disabled = true; return; }
  $("pdDetalle").classList.remove("hidden");
  const libres = brokersLibres(c);
  const nota = esLead(c) ? "" : `Ya tiene FTD; este es un 2º depósito.`;
  $("pdSel").innerHTML = `<b>${esc(c.nombre)}</b>${nota ? ` <span class="pdnota">${nota}</span>` : ""}`;
  $("pdBrokers").innerHTML = libres.map(b =>
    `<button type="button" class="lchip ${b.id === brkSel ? "on" : ""}" data-brk="${b.id}">${esc(b.n)}</button>`).join("");
  $("pdBrokers").querySelectorAll("[data-brk]").forEach(b =>
    b.onclick = () => { brkSel = b.dataset.brk; pintarDetalle(); });
  $("pdOk").disabled = !brkSel;
}

async function confirmar() {
  const c = state.clientes.find(x => x.id === selId);
  if (!c || !brkSel) return;
  const f = $("pdFecha").value; if (!f) return toast("Falta la fecha");
  const ts = promesaISO(f, $("pdHora").value);
  $("pdOk").disabled = true;
  if (await dbPatch(c, { promesa_en: ts, promesa_broker: brkSel })) {
    Object.assign(c, { promesaEn: ts, promesaBroker: brkSel });
    toast(`✓ ${primer(c.nombre)} quedó pendiente de depósito en ${nombreBroker(brkSel)}`);
    $("pdOverlay").classList.remove("open");
    alTerminar?.();
  } else { $("pdOk").disabled = false; }
}

export function abrirPendienteDep(render) {
  alTerminar = render; selId = null; brkSel = null;
  $("pdBuscar").value = ""; $("pdFecha").value = hoyISO(); $("pdHora").value = "";
  pintarLista(); pintarDetalle();
  $("pdOverlay").classList.add("open");
  $("pdBuscar").focus();
}

$("pdCerrar").onclick = () => $("pdOverlay").classList.remove("open");
$("pdOverlay").onclick = e => { if (e.target.id === "pdOverlay") $("pdOverlay").classList.remove("open"); };
$("pdBuscar").oninput = pintarLista;
$("pdOk").onclick = confirmar;
