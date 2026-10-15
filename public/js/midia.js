// «Mi día»: la guía personal del agente. Una sola tarjeta «Ahora» con lo que
// toca, y debajo los bloques del día en el orden que eligió el usuario
// (entrevista del 14/10/2026): Repaso → leads de WhatsApp → leads de HighLevel →
// posibles ventas → clase de hoy. Interesados y tareas propias llegan en la
// fase siguiente.
//
// No se marca nada a mano: cada paso se da por hecho leyendo datos que ya
// existen (Repaso, contactos, chats, abonos, seguimientos). La excepción es
// HighLevel: Nexus no ve las llamadas del CRM, así que el agente anota el
// resultado y «Le escribí» en `crm_leads`. Por eso aquí no hay
// reglas propias de leads: categoría y razón salen de leads.js, igual que en el
// panel «Hoy», para que las dos pantallas nunca digan cosas distintas.
//
// Solo ve lo PROPIO: es una lista de trabajo. Un director no recibe aquí a los
// leads de sus agentes aunque pueda verlos.
import { state, esc, hoyISO, esLead, esInactivo, usd, saldo, estaSaldada, toast } from "./state.js";
import { SB } from "./supabase.js";
import { SUPABASE_URL } from "./config.js";
import { cargarCrm } from "./data.js";
import { NOMBRE_RES, esHoy, accionCrm, accionesCrm, detectarBajadas, porBajar } from "./crm.js";
import { asegurarEntrantes, entranteDe, claveTel } from "./entrantes.js";
import { repasoPendientes } from "./repaso.js";
import { categoria, razon, contactosDe, esMio, sinHora, horaTxt, dias } from "./leads.js";
import { irAEtapa } from "./hoy.js";
import { renderMetaHoy } from "./ftd.js";

const HORA_MS = 60 * 60 * 1000;
// Lo que tiene hora sube al frente una hora antes (respuesta del usuario).
const URGENTE_ANTES_MS = HORA_MS;
// A partir de esta hora aparece el cierre del día.
const HORA_CIERRE = 21;
const VIGENCIA_MS = 2 * 60 * 1000;

const BLOQUES = [
  { k: "rep", n: "Repaso" },
  { k: "wa", n: "Leads de WhatsApp" },
  { k: "hl", n: "Leads de HighLevel" },
  { k: "ven", n: "Posibles ventas" },
  { k: "cla", n: "Clase de hoy" },
];
// Etapas del panel «Hoy» que entran a la guía: las urgentes. «Ayer» y «el
// resto» siguen en el panel; meterlas aquí alargaría la guía sin mover FTD hoy.
const ETAPAS_WA = ["pend", "reg", "bajo", "hoy"];

/* ------------------------------------------------------------------ datos */
// Lo que la guía necesita y el resto de la app no carga: actividades y
// seguimientos de hoy, chats y mensajes automáticos de hoy. Se pide al entrar
// y se refresca cada pocos minutos; nunca bloquea el render.
let extra = null, extraEn = 0, cargando = null;

const digitos = t => (t || "").replace(/\D/g, "");
const inicioHoy = () => new Date(hoyISO() + "T00:00:00-05:00");

async function cargarExtra(alTerminar) {
  if (cargando) return;
  cargando = (async () => {
    const me = state.me.id;
    const desde = inicioHoy().toISOString();
    const hasta = new Date(inicioHoy().getTime() + 24 * HORA_MS).toISOString();
    const [acts, chats, msgs, crm, tok, segs] = await Promise.all([
      SB.from("actividades").select("id, nombre, inicio, owner_id, compartida")
        .eq("estado", "activa").gte("inicio", desde).lt("inicio", hasta).order("inicio"),
      SB.from("chats_recientes").select("telefono, ultimo_en, entrante_en")
        .eq("owner_id", me).gte("ultimo_en", desde),
      SB.from("mensajes_programados").select("tipo, telefono, enviado_en")
        .eq("owner_id", me).eq("estado", "enviado").gte("enviado_en", desde),
      // Todos los leads de HighLevel propios: los comparte el panel «Hoy» y
      // deciden quién no recibe envíos automáticos (crm.js).
      cargarCrm().then(data => ({ data }), error => ({ error })),
      SB.from("crm_tokens").select("token").eq("owner_id", me).maybeSingle(),
      // Seguimientos a leads de hoy (mensaje 1 de la serie): cuentan como
      // «le escribiste» desde que se ponen en cola, sin esperar al worker. Si
      // el envío termina en error o cancelado deja de contar y el lead vuelve.
      SB.from("mensajes_programados").select("cliente_id, estado")
        .eq("owner_id", me).eq("tipo", "masivo").not("cliente_id", "is", null)
        .not("estado", "in", "(error,cancelado)")
        .gte("enviar_en", desde).lt("enviar_en", hasta),
    ]);
    // Clases de hoy que el agente puede usar: las suyas y las compartidas por
    // su director. Las de los agentes de un director son supervisión, no suyas.
    const clases = (acts.data || []).filter(a => a.owner_id === me || a.compartida);
    let invitados = {};
    if (clases.length) {
      const { data } = await SB.from("seguimientos").select("actividad_id")
        .eq("owner_id", me).neq("estado", "cancelado").in("actividad_id", clases.map(a => a.id));
      (data || []).forEach(g => { invitados[g.actividad_id] = (invitados[g.actividad_id] || 0) + 1; });
    }
    const auto = {};   // teléfono → envíos automáticos de hoy (ms)
    (msgs.data || []).forEach(m => { const k = claveTel(m.telefono); if (k) (auto[k] ||= []).push(new Date(m.enviado_en).getTime()); });
    const chatsPor = {};
    (chats.data || []).forEach(c => { const k = claveTel(c.telefono); if (k) chatsPor[k] = c; });
    extra = { clases, invitados, msgs: msgs.data || [], auto, chats: chatsPor,
      token: tok.data?.token || null,
      seg: Object.fromEntries((segs.data || []).map(m => [m.cliente_id, m.estado])),
      error: acts.error || chats.error || msgs.error || crm.error };
    extraEn = Date.now();
  })().catch(e => { console.warn("Mi día:", e); extra = extra || { clases: [], invitados: {}, msgs: [], auto: {}, chats: {}, token: null, seg: {}, error: e }; })
    .finally(() => { cargando = null; alTerminar(); });
}

/* ------------------------------------------------------------------ reglas */
// ¿Le escribiste hoy por WhatsApp? `ultimo_en` es el último mensaje en cualquier
// dirección; si es posterior al último entrante, el último lo mandaste tú. Pero
// los envíos automáticos (recordatorios, masivos) también salen por tu número y
// mueven `ultimo_en`: si coincide con uno de ellos (±2 min) no cuenta, porque
// la guía pregunta si TÚ atendiste al lead, no si Nexus le escribió.
function escribisteHoy(c) {
  // claveTel y no dígitos crudos: WhatsApp guarda 521… y la ficha 52… (México).
  const k = claveTel(c.tel), ch = k && extra?.chats[k];
  if (!ch || dias(ch.ultimo_en) !== 0) return false;
  const ult = new Date(ch.ultimo_en).getTime();
  if (ch.entrante_en && new Date(ch.entrante_en).getTime() >= ult) return false;
  return !(extra.auto[k] || []).some(t => Math.abs(t - ult) <= 2 * 60 * 1000);
}
const contactoHoy = c => contactosDe(c).some(x => dias(x.en) === 0);

// El salto vale solo el día en que se hizo: mañana el repaso vuelve al frente.
// En localStorage: es una comodidad del navegador, no un dato del negocio.
const CLAVE_SALTO = () => `nexus:midia:salto-repaso:${state.me.id}`;
function repasoSaltado() {
  try { return localStorage.getItem(CLAVE_SALTO()) === hoyISO(); } catch { return false; }
}
function saltarRepaso(si) {
  try { si ? localStorage.setItem(CLAVE_SALTO(), hoyISO()) : localStorage.removeItem(CLAVE_SALTO()); } catch { /* sin almacenamiento: no se recuerda */ }
}

function itemsDelDia() {
  const ahora = Date.now(), me = state.me.id, hoy = hoyISO();
  const items = [];

  // 0 · Repaso de asistencias: antes de todo.
  // Se puede saltar por hoy: sale de «Ahora» pero sigue en «Pasa a mañana».
  const nRep = repasoPendientes(), salto = nRep > 0 && repasoSaltado();
  items.push({ b: "rep", id: "rep", t: "Repaso de asistencias",
    s: nRep ? `${nRep} invitaci${nRep === 1 ? "ón" : "ones"} sin responder` : "Al día",
    hecho: nRep === 0 || salto, saltado: salto, ok: salto ? "Saltado por hoy" : "Sin invitaciones pendientes", acc: "repaso",
    why: "Va primero: deja al día la asistencia de la clase anterior." });

  // 1 · Leads de WhatsApp en etapas urgentes.
  const ORD = Object.fromEntries(ETAPAS_WA.map((k, i) => [k, i]));
  state.clientes
    // Los de HighLevel por bajar van en su propio bloque (2), no aquí.
    .filter(c => !esInactivo(c) && esMio(c) && (esLead(c) || (c.promesaEn && c.promesaBroker)) && !porBajar(c))
    .map(c => ({ c, cat: categoria(c) }))
    .filter(x => ETAPAS_WA.includes(x.cat))
    .sort((a, b) => ORD[a.cat] - ORD[b.cat]
      || (a.cat === "pend" ? new Date(a.c.promesaEn) - new Date(b.c.promesaEn) : a.c.nombre.localeCompare(b.c.nombre, "es")))
    .forEach(({ c, cat }) => {
      const at = cat === "pend" && !sinHora(c.promesaEn) && dias(c.promesaEn) === 0 ? new Date(c.promesaEn).getTime() : null;
      const porWa = escribisteHoy(c), aMano = contactoHoy(c), seg = extra?.seg[c.id];
      items.push({ b: "wa", id: "wa" + c.id, c, cat, at, t: c.nombre, s: razon(c),
        hecho: porWa || aMano || !!seg,
        ok: porWa ? "Le escribiste hoy por WhatsApp" : aMano ? "Contacto registrado hoy"
          : seg === "enviado" ? "Le enviaste un seguimiento" : "Seguimiento en camino",
        acc: "lead",
        why: { pend: "Prometió depositar: es lo más cerca de un FTD.",
               reg: "Ya abrió cuenta: falta que prometa depositar.",
               bajo: "Te escribió hoy: está caliente.",
               hoy: "Llegó hoy y espera tu primer contacto." }[cat] });
    });

  // 2 · Leads de HighLevel.
  if (extra) itemsCrm(ahora).forEach(it => items.push(it));

  // 3 · Posibles ventas: por ahora, los cobros. Aparece el día de su fecha de
  // pago (o si ya venció) y queda hecho al registrar un abono hoy o al mover la
  // fecha. Sin hora: no sube al frente, respeta el orden del bloque.
  if (state.ventasOk) {
    state.ventas
      .filter(v => v.owner_id === me && v.estado === "abierta" && v.fecha_pago)
      .filter(v => v.fecha_pago <= hoy || (v.abonos || []).some(a => a.fecha === hoy))
      .sort((a, b) => a.fecha_pago.localeCompare(b.fecha_pago))
      .forEach(v => {
        const c = state.clientes.find(x => x.id === v.cliente_id);
        const abonoHoy = (v.abonos || []).filter(a => a.fecha === hoy).reduce((s, a) => s + a.monto, 0);
        const vencida = v.fecha_pago < hoy;
        items.push({ b: "ven", id: "v" + v.id, t: c?.nombre || "Venta", acc: "venta",
          s: `Cobro pendiente · saldo ${usd(saldo(v))}${vencida ? " · vencido" : ""}`,
          hecho: abonoHoy > 0 || estaSaldada(v), ok: `Abono de ${usd(abonoHoy)} registrado hoy`,
          why: vencida ? "Su fecha de pago ya pasó." : "Hoy es su fecha de pago." });
      });
  }

  // 4 · Clase de hoy: todos los días hay clase. Si no hay ninguna (propia ni
  // compartida), se pide crearla; si existe, invitar al menos una tanda.
  if (extra) {
    if (!extra.clases.length) {
      items.push({ b: "cla", id: "cla-crear", t: "Crea la clase de hoy", s: "No tienes ninguna clase para hoy",
        hecho: false, acc: "seg", why: "Todos los días hay clase. Créala y luego invita." });
    }
    extra.clases.forEach(a => {
      const n = extra.invitados[a.id] || 0, at = new Date(a.inicio).getTime();
      items.push({ b: "cla", id: "cla" + a.id, at: at > ahora ? at : null,
        t: `${a.nombre} · ${horaTxt(a.inicio)}`, s: n ? `${n} invitados tuyos` : "Sin invitados tuyos",
        hecho: n > 0, ok: `${n} invitados programados`, acc: "seg",
        why: "Invita al menos una tanda y los recordatorios salen solos." });
    });
  }
  return items;
}


/* ------------------------------------------------------- HighLevel (fase 2) */
// Reglas acordadas con el usuario (14/10/2026):
//  · aparece si se asignó hoy o ayer; «seguir» y «llamada» vuelven en su fecha;
//  · atendido = resultado de la llamada de hoy + «Le escribí»;
//  · No contestó / Buzón: reintento 2 h después, otro mañana y luego sale;
//  · Número equivocado / No le interesa: sale;
//  · bajó a WhatsApp: solo (su número te escribió) o a mano.

function itemsCrm(ahora) {
  const out = [];
  for (const l of state.crm || []) {
    const visibleHoy = dias(l.asignado_en) <= 1
      || (l.siguiente_en && dias(l.siguiente_en) >= 0 && l.estado === "seguir")
      || (l.vuelve_en && dias(l.vuelve_en) >= 0 && l.estado === "pendiente")
      || esHoy(l.resultado_en);
    if (!visibleHoy) continue;
    const t = l.nombre || l.telefono || "Lead sin nombre";
    const base = { b: "hl", id: "hl" + l.id, l, t, acc: "crm",
      why: "Pediste llamar a los de ayer y a los de hoy. Queda listo con el resultado de la llamada y «Le escribí»." };
    if (l.estado === "bajo") { if (esHoy(l.resultado_en) || dias(l.asignado_en) <= 1) out.push({ ...base, hecho: true, ok: "Bajó a WhatsApp" }); continue; }
    if (l.estado === "fuera") { if (esHoy(l.resultado_en)) out.push({ ...base, hecho: true, ok: `${NOMBRE_RES[l.resultado] || "Fuera"} · sale de la guía` }); continue; }
    // Reintento pendiente: hoy más tarde → en espera; mañana → por hoy ya está.
    if (l.vuelve_en && new Date(l.vuelve_en).getTime() > ahora) {
      const hoyMismo = esHoy(l.vuelve_en);
      out.push({ ...base, hecho: !hoyMismo, espera: hoyMismo,
        ok: `${NOMBRE_RES[l.resultado]} · otro intento mañana`, s: `${NOMBRE_RES[l.resultado]} · vuelve a las ${horaTxt(l.vuelve_en)}` });
      continue;
    }
    // Con «seguir en el CRM» o llamada agendada para otro día: hecho por hoy.
    if (l.estado === "seguir" && l.siguiente_en && dias(l.siguiente_en) < 0) {
      out.push({ ...base, hecho: true, ok: l.siguiente === "llamada" ? `Llamada agendada ${fechaCorta(l.siguiente_en)} ${horaTxt(l.siguiente_en)}` : `Sigue en el CRM · vuelve ${fechaCorta(l.siguiente_en)}` });
      continue;
    }
    const llamadaHoy = l.siguiente === "llamada" && esHoy(l.siguiente_en);
    const tLlamada = llamadaHoy ? new Date(l.siguiente_en).getTime() : null;
    // La llamada agendada para hoy cuenta aparte del «Contestó» que la agendó.
    const contestoHoy = esHoy(l.resultado_en) && l.resultado === "contesto"
      && !(llamadaHoy && new Date(l.resultado_en).getTime() < tLlamada);
    if (llamadaHoy && !contestoHoy && ahora < tLlamada - URGENTE_ANTES_MS) {
      out.push({ ...base, hecho: false, espera: true, s: `Llamada agendada a las ${horaTxt(l.siguiente_en)}` });
      continue;
    }
    const listo = contestoHoy && esHoy(l.escribi_en);
    const sub = [
      dias(l.asignado_en) === 0 ? `Asignado hoy ${horaTxt(l.asignado_en)}` : dias(l.asignado_en) === 1 ? "Asignado ayer" : (l.siguiente === "crm" ? "Seguimiento en el CRM para hoy" : "Vuelve hoy"),
      l.intentos ? `${l.intentos}.º intento hecho` : "",
      contestoHoy && !esHoy(l.escribi_en) ? "Contestó · falta «Le escribí»" : "",
    ].filter(Boolean).join(" · ");
    // Recién llegado (hoy, sin ningún intento): se atiende de inmediato, antes
    // que cualquier pendiente (decisión del usuario, 15/10/2026).
    const nuevo = !listo && dias(l.asignado_en) === 0 && !l.intentos && !l.resultado && !l.siguiente;
    out.push({ ...base, s: sub, hecho: listo, nuevo, ok: `Contestó${l.siguiente === "bajara" ? " · bajará a WhatsApp" : ""} · le escribiste`,
      at: llamadaHoy && !contestoHoy ? tLlamada : null,
      ...(nuevo ? { why: "Acaba de llegar de HighLevel: un lead fresco se atiende antes que cualquier pendiente. Queda listo con el resultado de la llamada y «Le escribí»." } : {}) });
  }
  return out;
}
const fechaCorta = ts => new Date(ts).toLocaleDateString("es-CO", { weekday: "short", day: "numeric", timeZone: "America/Bogota" });

/* --------------------------------------------- conectar HighLevel (webhook) */
let verConexion = false;
const urlWebhook = t => `${SUPABASE_URL}/functions/v1/highlevel-lead?t=${t}`;

async function asegurarToken(render) {
  if (extra?.token) return;
  const { data, error } = await SB.from("crm_tokens").insert({}).select("token").single();
  if (error) { toast("⚠ " + error.message); return; }
  extra.token = data.token; render();
}

function conexionHTML() {
  if (!verConexion) return "";
  const t = extra?.token;
  return `<div class="mdcon">
    <b>Conectar HighLevel</b>
    <ol>
      <li>En HighLevel crea un workflow que se active cuando un contacto <b>queda asignado a ti</b>.</li>
      <li>Agrega la acción <b>Webhook</b> con método <b>POST</b> y esta URL:</li>
    </ol>
    ${t ? `<div class="mdurl"><code id="mdUrl">${esc(urlWebhook(t))}</code><button class="lbtn mdbtn" data-con="copiar">Copiar</button></div>
      <p>Es tu enlace privado: quien lo tenga puede cargarte leads. No lo compartas.</p>`
      : `<p>Preparando tu enlace…</p>`}
    <ol start="3"><li>Guarda y publica el workflow. Cuando te asignen un contacto, aparecerá aquí.</li></ol>
    <div class="mdacts"><button class="lbtn mdbtn" data-con="cerrar">Cerrar</button></div>
  </div>`;
}

const urgente = (it, ahora) => !it.hecho && it.at != null && ahora >= it.at - URGENTE_ANTES_MS;
const idxBloque = it => BLOQUES.findIndex(b => b.k === it.b);

// Orden: los leads de HighLevel recién llegados (el que más espera primero),
// después lo urgente (por hora) y al final el orden fijo del usuario.
function cola(items, ahora) {
  const pend = items.filter(i => !i.hecho && !i.espera);
  const n = pend.filter(i => i.nuevo).sort((a, b) => new Date(a.l.asignado_en) - new Date(b.l.asignado_en));
  const u = pend.filter(i => !i.nuevo && urgente(i, ahora)).sort((a, b) => a.at - b.at);
  const r = pend.filter(i => !i.nuevo && !urgente(i, ahora)).sort((a, b) => idxBloque(a) - idxBloque(b) || items.indexOf(a) - items.indexOf(b));
  return [...n, ...u, ...r];
}

/* ------------------------------------------------------------------ vista */
// El mismo avión de papel del botón «Enviar seguimiento» de Leads (ui.js).
const ICO_ENV = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;
const ICO_WA = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.3-.5 0-1 .3-3.4-.7-2.9-1.2-4.7-4.1-4.9-4.3-.1-.2-1.2-1.6-1.2-3s.8-2.2 1-2.5c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg>';

function accionesHTML(it) {
  if (it.acc === "crm") return accionesCrm(it.l);
  if (it.acc === "lead") {
    const tel = digitos(it.c.tel);
    return `<div class="mdacts">
      ${tel ? `<a class="btn-oro mdbtn" href="https://wa.me/${tel}" target="_blank" rel="noopener">${ICO_WA}Abrir chat</a>` : ""}
      ${tel ? `<button type="button" class="hsegenv mdbtn" data-md="seglead" data-id="${it.c.id}">${ICO_ENV}Enviar seguimiento</button>` : ""}
      <button class="lbtn mdbtn" data-md="lead" data-id="${it.c.id}" data-cat="${it.cat}">Ver en Leads</button></div>`;
  }
  const L = { repaso: "Hacer el repaso", venta: "Ir a Ventas", seg: it.id === "cla-crear" ? "Crear en Seguimiento" : "Programar invitados" };
  return `<div class="mdacts"><button class="btn-oro mdbtn" data-md="${it.acc}">${L[it.acc]}</button>${it.acc === "repaso" ? `<button class="lbtn mdbtn" data-md="saltar">Saltar por hoy</button>` : ""}</div>`;
}

function sistemaHTML() {
  if (!extra) return "";
  const cuenta = tipos => extra.msgs.filter(m => tipos.includes(m.tipo)).length;
  const escribieron = state.clientes.filter(c => esMio(c) && esLead(c)
    && entranteDe(c) && dias(entranteDe(c)) === 0).length;
  const filas = [
    [cuenta(["invitacion"]), "invitaciones a clases"],
    [cuenta(["rec_60", "rec_15", "confirmacion"]), "recordatorios y confirmaciones"],
    [cuenta(["enlace"]), "enlaces de clase"],
    [cuenta(["masivo"]), "mensajes masivos"],
    [escribieron, `lead${escribieron === 1 ? "" : "s"} te escribi${escribieron === 1 ? "ó" : "eron"} hoy (su temperatura sube un nivel)`],
    [(state.crm || []).filter(l => l.estado === "bajo" && esHoy(l.resultado_en)).length, "leads de HighLevel pasaron a WhatsApp"],
  ].filter(([n]) => n > 0);
  return `<div class="mdsis"><b>Lo que Nexus hizo por ti hoy</b>
    ${filas.length ? `<ul>${filas.map(([n, t]) => `<li><span>${n}</span> ${t}</li>`).join("")}</ul>`
      : `<p>Todavía nada hoy. Cuando salgan invitaciones o recordatorios, los verás aquí.</p>`}</div>`;
}

function cierreHTML(items) {
  const me = state.me.id, hoy = hoyISO();
  const ftdHoy = state.clientes.filter(c => c.owner_id === me && Object.values(c.ftds || {}).includes(hoy)).length;
  const cobrado = state.ventas.filter(v => v.owner_id === me)
    .flatMap(v => v.abonos || []).filter(a => a.fecha === hoy).reduce((s, a) => s + a.monto, 0);
  const contactos = Object.values(state.contactos || {}).flat().filter(x => dias(x.en) === 0).length;
  const quedan = items.filter(i => !i.hecho || i.saltado);
  return `<div class="mdcierre"><div class="mdeb">Cierre del día</div><h3>Así te fue hoy</h3>
    <div class="mdnums"><div><b>${ftdHoy}</b><small>FTD</small></div><div><b>${contactos}</b><small>contactos</small></div><div><b>${usd(cobrado)}</b><small>cobrado</small></div></div>
    ${quedan.length ? `<div class="mdsubl">Pasa a mañana</div><ul>${quedan.map(i => `<li>${esc(i.t)}</li>`).join("")}</ul>`
      : "<p>No queda nada pendiente para mañana.</p>"}</div>`;
}

let reloj = null;

export function renderMiDia(cont, render) {
  // «Te escribieron» y «le escribiste» necesitan los entrantes, igual que Leads.
  asegurarEntrantes().then(nuevo => {
    const ae = document.activeElement;
    if (nuevo && !(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) render();
  });
  if (!extra || Date.now() - extraEn > VIGENCIA_MS) cargarExtra(render);
  // La urgencia depende de la hora: se repinta cada minuto mientras la vista
  // está abierta, para que lo que entra en su última hora suba solo.
  if (!reloj) reloj = setInterval(() => { if (state.vista === "midia") render(); }, 60 * 1000);

  const ahora = Date.now();
  const items = itemsDelDia();
  const q = cola(items, ahora), foco = q[0];
  const listos = items.filter(i => i.hecho && !i.saltado).length;
  const hora = new Date(ahora).getHours();

  let top = "";
  if (hora >= HORA_CIERRE) top += cierreHTML(items);
  if (foco) {
    const u = urgente(foco, ahora);
    const falta = u ? Math.max(0, Math.round((foco.at - ahora) / 60000)) : null;
    top += `<div class="mdahora ${u || foco.nuevo ? "urg" : ""}">
      <div class="mdeb"><span>${foco.nuevo ? "Nuevo · " : u ? "Urgente · " : ""}Ahora</span><span>${BLOQUES[idxBloque(foco)].n}</span></div>
      <h3>${esc(foco.t)}</h3><p>${foco.s}</p>
      <div class="mdwhy">${u ? (falta > 0 ? `Faltan ${falta} min: por eso subió al frente. ` : "Ya es la hora. ") : ""}${foco.why}</div>
      ${accionesHTML(foco)}</div>`;
  } else if (hora < HORA_CIERRE) {
    top += `<div class="mdahora"><div class="mdeb"><span>Al día</span></div><h3>No tienes nada pendiente ahora</h3>
      <p>A las 9 pm verás el cierre del día.</p></div>`;
  }

  const bloques = BLOQUES.map((b, i) => {
    const ls = items.filter(x => x.b === b.k);
    if (!ls.length && !(b.k === "cla" && !extra) && b.k !== "hl") return "";
    const ok = ls.filter(x => x.hecho && !x.saltado).length;
    const vacioHl = b.k === "hl" && !ls.length
      ? `<div class="mdcarga">${!extra ? "Cargando…" : state.crm?.length || extra.token ? "Sin leads de HighLevel para hoy." : "Todavía no conectas HighLevel."}</div>` : "";
    return `<section class="mdblq"><div class="mdblq-h"><span><i>${i}</i>${b.n}</span><em>${b.k === "hl" ? `<button class="mdlink" data-con="abrir">${extra?.token ? "Enlace del webhook" : "Conectar"}</button> · ` : ""}${ok}/${ls.length}</em></div>
      ${b.k === "hl" ? conexionHTML() : ""}${vacioHl}
      ${ls.length ? ls.map(x => {
        const cls = [x.saltado ? "salt" : x.hecho ? "hecho" : "", x === foco ? "foco" : "", urgente(x, ahora) || (x.nuevo && !x.hecho) ? "urg" : "", x.espera ? "espera" : ""].join(" ");
        return `<div class="mdpaso ${cls}" data-paso="${x.id}"><span class="mddot"></span>
          <div class="mdpaso-t"><b>${esc(x.t)}</b><small>${x.hecho ? x.ok : x.s}${x.saltado ? ` · <button class="mdlink" data-md="retomar">Hacerlo ahora</button>` : x.id === "rep" && !x.hecho && x !== foco ? ` · <button class="mdlink" data-md="saltar">Saltar por hoy</button>` : ""}</small></div>
          ${x.at != null && !x.hecho ? `<span class="mdhora">${horaTxt(x.at)}</span>` : ""}</div>`;
      }).join("") : b.k === "hl" ? "" : `<div class="mdcarga">Cargando…</div>`}</section>`;
  }).join("");

  cont.innerHTML = `
    <div id="mdMeta"></div>
    <div class="mdruta" aria-hidden="true">${items.map(x => `<i class="${x.hecho && !x.saltado ? "on" : ""}"></i>`).join("")}</div>
    <div class="mdruta-t">${listos} de ${items.length} listos</div>
    ${top}
    <div class="mdgrid"><div class="mdcol">${bloques}</div><div class="mdcol">${sistemaHTML()}</div></div>
    ${extra?.error ? `<p class="mderr">Parte de la guía no cargó: ${esc(extra.error.message || String(extra.error))}</p>` : ""}`;

  renderMetaHoy(cont.querySelector("#mdMeta"), render, 0);

  detectarBajadas(render);
  cont.querySelectorAll("[data-crm]").forEach(b => b.onclick = () => {
    accionCrm(foco.l, b.dataset.crm, render, cont);
  });
  cont.querySelectorAll("[data-con]").forEach(b => b.onclick = () => {
    const a = b.dataset.con;
    if (a === "abrir") { verConexion = true; render(); asegurarToken(render); return; }
    if (a === "cerrar") { verConexion = false; render(); return; }
    if (a === "copiar") {
      const txt = urlWebhook(extra.token);
      navigator.clipboard?.writeText(txt).then(() => toast("Enlace copiado"), () => toast("Copia el enlace a mano"));
    }
  });
  cont.querySelectorAll("[data-md]").forEach(b => b.onclick = async () => {
    const a = b.dataset.md;
    if (a === "repaso") { (await import("./repaso.js")).repasoManual(); return; }
    if (a === "saltar" || a === "retomar") { saltarRepaso(a === "saltar"); render(); return; }
    if (a === "venta") { state.vista = "ventas"; render(); return; }
    if (a === "seg") { document.getElementById("btnSeg").click(); return; }
    // Uno de tus seguimientos guardados (plantillas_lead) solo a esta persona.
    // Queda hecho cuando sale el mensaje 1: la base anota el contacto en su ficha.
    if (a === "seglead") { (await import("./envioleads.js")).abrirEnvioLeads(() => { extraEn = 0; render(); }, { soloId: b.dataset.id }); return; }
    if (a === "lead") {
      irAEtapa(b.dataset.cat);
      // Igual que la pestaña Leads: cambiar de módulo limpia los filtros del otro.
      if (state.modulo !== "leads") { state.filtro = "todos"; state.filtroTemp = null; }
      state.modulo = "leads"; state.leadsVista = "hoy"; state.vista = "cliente";
      render();
      document.querySelector(`.hfila[data-id="${b.dataset.id}"]`)?.scrollIntoView({ block: "center" });
    }
  });
}

// La guía se activa primero solo para estos usuarios (decisión del 14/10/2026:
// probarla en el día real antes de pedir a otros agentes que la configuren).
export const MI_DIA_USUARIOS = ["a70d2670-74b2-4eb7-be6e-ed3c92068c14"];
export const tieneMiDia = () => MI_DIA_USUARIOS.includes(state.me?.id);
