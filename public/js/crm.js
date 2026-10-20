// Leads de HighLevel: reglas y acciones compartidas por «Mi día» y el panel
// «Hoy» de Leads, para que las dos pantallas anoten lo mismo de la misma forma.
//
// Un lead de HighLevel es una persona de Nexus (lead) enlazada a su fila de
// `crm_leads` (la crea la Edge Function `highlevel-lead` al llegar). Mientras
// esté «por bajar» su seguimiento es desde el CRM, a mano: no recibe ningún
// envío automático por WhatsApp (decisión del usuario, 14/10/2026).
//
// Reglas de llamada (entrevista del 14/10/2026):
//  · No contestó / Buzón: reintento 2 h después, otro mañana y luego sale;
//  · Número equivocado / No le interesa: sale;
//  · Contestó: el agente elige qué sigue (bajará, seguir en el CRM, llamada);
//  · bajó a WhatsApp: solo (su número te escribió) o a mano.
import { state, toast, hoyISO, esc, telColombia, ICO_TEL } from "./state.js";
import { SB } from "./supabase.js";
import { dbInsert, dbPatch } from "./data.js";
import { entranteDe, claveTel } from "./entrantes.js";
import { dias } from "./leads.js";

const HORA_MS = 60 * 60 * 1000;
export const NOMBRE_RES = { contesto: "Contestó", no_contesto: "No contestó", buzon: "Buzón",
  numero_malo: "Número equivocado", no_interesa: "No le interesa" };
export const esHoy = ts => !!ts && dias(ts) === 0;
const inicioHoy = () => new Date(hoyISO() + "T00:00:00-05:00");
export const mananaInicio = () => new Date(inicioHoy().getTime() + 24 * HORA_MS);
// «YYYY-MM-DDTHH:MM» en hora Colombia, para el valor de un datetime-local.
const fechaCOlocal = d => new Date(d.getTime() - 5 * HORA_MS).toISOString().slice(0, 16);
const digitos = t => (t || "").replace(/\D/g, "");

export const crmDe = c => state.crmPor?.[c.id] || null;

// Ícono de «descargar»: el lead baja del CRM a WhatsApp (pedido del usuario).
export const ICO_BAJAR = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/></svg>`;

// ¿Ya escribió por WhatsApp después de que te lo asignaron? Entonces bajó,
// aunque nadie lo haya marcado todavía.
const bajoSolo = l => {
  const ent = l.cliente_id
    ? entranteDe(state.clientes.find(c => c.id === l.cliente_id) || { tel: l.telefono, owner_id: l.owner_id })
    : entranteDe({ tel: l.telefono, owner_id: l.owner_id });
  return !!ent && new Date(ent) >= new Date(l.asignado_en);
};

// Lead de HighLevel que todavía no baja a WhatsApp. Incluye «fuera» (número
// malo, sin interés): nunca llegó a WhatsApp, así que tampoco se le escribe.
export const porBajarCrm = l => !!l && l.estado !== "bajo" && !bajoSolo(l);
export const porBajar = c => porBajarCrm(crmDe(c));
// Vino de HighLevel y ya bajó: se nota en el grupo de WhatsApp.
export const vinoDeHL = c => { const l = crmDe(c); return !!l && !porBajarCrm(l); };

/* ---------------------------------------------------------------- acciones */
// Formulario «¿Qué sigue?» abierto tras «Contestó»: id del lead o null.
let abierto = null;

async function patch(l, campos, render) {
  const { error } = await SB.from("crm_leads").update(campos).eq("id", l.id);
  if (error) { toast("⚠ " + error.message); return; }
  Object.assign(l, campos);
  render();
}

// Bajó a WhatsApp. La persona ya existe desde que llegó; los leads anteriores a
// eso (sin `cliente_id`) se enlazan con quien tenga el número o se crean.
export async function marcarBajo(l, render) {
  let id = l.cliente_id;
  if (!id) {
    const k = claveTel(l.telefono);
    let c = k ? state.clientes.find(x => x.owner_id === state.me.id && claveTel(x.tel) === k) : null;
    if (!c && (l.nombre || k)) {
      c = await dbInsert({ nombre: l.nombre || l.telefono, tel: l.telefono || null, mem: "Lead", creado: hoyISO(), acc: {}, conf: {} });
      if (c) state.clientes.push(c);
    }
    id = c?.id || null;
    if (id) state.crmPor[id] = l;
  }
  await patch(l, { estado: "bajo", resultado_en: new Date().toISOString(), cliente_id: id }, render);
}

// Si el número ya te escribió por WhatsApp después de asignarse, se deja
// anotado como bajado (una vez por lead y sesión).
const bajandoAuto = new Set();
export function detectarBajadas(render) {
  if (!state.crm?.length || !state.entrantes) return;
  state.crm.filter(l => (l.estado === "pendiente" || l.estado === "seguir") && !bajandoAuto.has(l.id) && bajoSolo(l))
    .forEach(l => { bajandoAuto.add(l.id); marcarBajo(l, render); });
}

export async function accionCrm(l, a, render, raiz) {
  const ahora = new Date(), iso = ahora.toISOString();
  if (a === "cancelar") { abierto = null; render(); return; }
  if (a === "escribi") return patch(l, { escribi_en: esHoy(l.escribi_en) ? null : iso }, render);
  // «Me respondió en el CRM»: Nexus no ve ese chat; lo sube a «Te escribieron».
  if (a === "respondio") return patch(l, { respondio_en: esHoy(l.respondio_en) ? null : iso }, render);
  if (a === "bajo") return marcarBajo(l, render);
  if (a === "contesto") { abierto = l.id; render(); return; }
  if (a === "no_contesto" || a === "buzon") {
    const n = (l.intentos || 0) + 1;
    const campos = { resultado: a, resultado_en: iso, intentos: n };
    if (n === 1) campos.vuelve_en = new Date(ahora.getTime() + 2 * HORA_MS).toISOString();
    else if (n === 2) campos.vuelve_en = mananaInicio().toISOString();
    else { campos.estado = "fuera"; campos.vuelve_en = null; }
    toast(n === 1 ? "Vuelve a aparecer en 2 horas" : n === 2 ? "Otro intento mañana" : "Sale de la guía: ya tuvo sus intentos");
    return patch(l, campos, render);
  }
  if (a === "numero_malo" || a === "no_interesa") return patch(l, { resultado: a, resultado_en: iso, estado: "fuera", vuelve_en: null }, render);
  if (a === "bajara") { abierto = null; return patch(l, { resultado: "contesto", resultado_en: iso, siguiente: "bajara", siguiente_en: null, vuelve_en: null, estado: "pendiente" }, render); }
  if (a === "crm" || a === "llamada") {
    const v = raiz.querySelector(a === "crm" ? "[data-crm-fecha]" : "[data-crm-hora]")?.value;
    if (!v) { toast("Elige la fecha"); return; }
    const cuando = a === "crm" ? new Date(v + "T08:00:00-05:00") : new Date(v + ":00-05:00");
    abierto = null;
    return patch(l, { resultado: "contesto", resultado_en: iso, siguiente: a, siguiente_en: cuando.toISOString(), vuelve_en: null, estado: "seguir" }, render);
  }
}

// Botones del lead de HighLevel, en grupos separados (pedido del usuario,
// 20/10/2026: «demasiadas opciones acumuladas»): la llamada y su resultado,
// el chat en HighLevel, el avance del lead y una nota. `extra`: botones del
// embudo que agrega la pantalla que los muestra (en «Hoy», registro y promesa).
export function accionesCrm(l, extra = "") {
  if (abierto === l.id) {
    const manana = new Date(mananaInicio().getTime() + 5 * HORA_MS);
    return `<div class="mdsubl">¿Qué sigue?</div>
      <div class="mdacts"><button class="btn-oro mdbtn" data-crm="bajara">Bajará a WhatsApp</button></div>
      <div class="mdacts mdfila"><input type="date" data-crm-fecha value="${hoyISO()}" min="${hoyISO()}" aria-label="Fecha del próximo seguimiento"><button class="lbtn mdbtn" data-crm="crm">Seguir en el CRM</button></div>
      <div class="mdacts mdfila"><input type="datetime-local" data-crm-hora value="${fechaCOlocal(manana)}" aria-label="Fecha y hora de la llamada"><button class="lbtn mdbtn" data-crm="llamada">Agendar llamada</button></div>
      <div class="mdacts"><button class="lbtn mdbtn" data-crm="cancelar">Volver</button></div>`;
  }
  const tel = digitos(l.telefono), co = telColombia(l.telefono);
  const res = k => `<button class="lbtn mdbtn" data-crm="${k}">${NOMBRE_RES[k]}</button>`;
  const tog = (k, campo, txt) => `<button class="lbtn mdbtn ${esHoy(l[campo]) ? "mdon" : ""}" data-crm="${k}" aria-pressed="${esHoy(l[campo])}">${esHoy(l[campo]) ? "✓ " : ""}${txt}</button>`;
  const c = l.cliente_id ? state.clientes.find(x => x.id === l.cliente_id) : null;
  return `<div class="crmg">
      <div class="crmg-h"><span class="mdsubl">Llamada</span>${tel ? `<span class="crmnum">+${tel}</span>` : ""}
        ${co ? `<a class="btn-oro mdbtn crmtel" href="tel:+${co}" aria-label="Llamar al +${co}">${ICO_TEL}Llamar</a>` : ""}</div>
      <div class="crmb crm3">${res("contesto")}${res("no_contesto")}${res("buzon")}</div>
      <div class="crmb crmfuera">${res("numero_malo")}${res("no_interesa")}</div>
    </div>
    <div class="crmg">
      <div class="crmg-h"><span class="mdsubl">Chat en HighLevel</span></div>
      <div class="crmb">${tog("escribi", "escribi_en", "Le escribí")}${tog("respondio", "respondio_en", "Me respondió")}</div>
    </div>
    <div class="crmg">
      <div class="crmg-h"><span class="mdsubl">Avance</span></div>
      <div class="crmb"><button class="lbtn mdbtn hbajar" data-crm="bajo">${ICO_BAJAR}Bajado a WA</button>${extra}</div>
    </div>
    ${c ? `<div class="crmg">
      <label class="crmg-h" for="nota-${c.id}"><span class="mdsubl">Nota</span></label>
      <textarea id="nota-${c.id}" class="crmnota" data-nota="${c.id}" rows="2" maxlength="2000" placeholder="Algo que quieras recordar de este lead">${esc(borrador[c.id] ?? c.nota ?? "")}</textarea>
    </div>` : ""}`;
}

// Nota del lead: es la misma `clientes.nota` que muestra su ficha (un solo
// texto, no el historial de `notas_cliente`). Se guarda al salir del campo; lo
// escrito y aún no guardado sobrevive a los re-pintados de la pantalla.
const borrador = {};
export function manejarNotas(raiz) {
  raiz.querySelectorAll("textarea[data-nota]").forEach(el => {
    const c = state.clientes.find(x => x.id === el.dataset.nota);
    if (!c) return;
    el.onclick = e => e.stopPropagation();
    el.oninput = () => { borrador[c.id] = el.value; };
    el.onchange = async () => {
      const v = el.value.trim();
      if (v === (c.nota || "")) { delete borrador[c.id]; return; }
      if (!(await dbPatch(c, { nota: v || null }))) return;
      c.nota = v;
      if (borrador[c.id] === el.value) delete borrador[c.id];
      toast("Nota guardada");
    };
  });
}

// Último resultado anotado, en una línea (para la fila del lead).
export function estadoCrm(l) {
  const partes = [];
  if (l.resultado && esHoy(l.resultado_en)) partes.push(NOMBRE_RES[l.resultado]);
  if (l.vuelve_en && new Date(l.vuelve_en) > new Date()) partes.push(`vuelve ${esHoy(l.vuelve_en) ? "a las " + new Date(l.vuelve_en).toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", timeZone: "America/Bogota" }) : "mañana"}`);
  if (l.intentos) partes.push(`${l.intentos}.º intento`);
  if (esHoy(l.escribi_en)) partes.push("le escribiste");
  if (esHoy(l.respondio_en)) partes.push("te respondió en el CRM");
  return partes.join(" · ");
}
