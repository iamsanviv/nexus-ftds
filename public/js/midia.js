// «Mi día»: la guía personal del agente. Diseño «paso a paso» (alternativa B
// que eligió el usuario el 20/10/2026): arriba los pasos del día en el orden del
// usuario (entrevista del 14/10/2026) —leads de WhatsApp por temperatura (en la
// mira, recuperar tibios, recuperar fríos) → leads de HighLevel → posibles
// ventas → clase de hoy—, cada uno con su avance; abajo solo la lista del paso
// elegido, con la fila de «Ahora» abierta y sus acciones. El repaso de
// asistencias salió de aquí el 16/10/2026 (pedido del usuario): sigue en el
// indicador del encabezado. Interesados y tareas propias llegan en la fase
// siguiente.
//
// No se marca nada a mano: cada paso se da por hecho leyendo datos que ya
// existen (contactos, chats, abonos, seguimientos). La excepción es
// HighLevel: Nexus no ve las llamadas del CRM, así que el agente anota el
// resultado y «Le escribí» en `crm_leads`. Por eso aquí no hay
// reglas propias de leads: categoría y razón salen de leads.js, igual que en el
// panel «Hoy», para que las dos pantallas nunca digan cosas distintas.
//
// Solo ve lo PROPIO: es una lista de trabajo. Un director no recibe aquí a los
// leads de sus agentes aunque pueda verlos.
import { state, esc, hoyISO, esLead, esInactivo, usd, saldo, estaSaldada, toast, telColombia, ICO_TEL } from "./state.js";
import { SB } from "./supabase.js";
import { SUPABASE_URL } from "./config.js";
import { cargarCrm } from "./data.js";
import { NOMBRE_RES, esHoy, accionCrm, accionesCrm, manejarNotas, detectarBajadas, porBajar } from "./crm.js";
import { asegurarEntrantes, entranteDe, claveTel } from "./entrantes.js";
import { categoria, razon, razonCorta, temperatura, contactosDe, esMio, sinHora, horaTxt, dias, form, abiertoAqui, manejarLead } from "./leads.js";
import { irAEtapa } from "./hoy.js";
import { metaHoyDatos } from "./ftd.js";

const HORA_MS = 60 * 60 * 1000;
// Lo que tiene hora sube al frente una hora antes (respuesta del usuario).
const URGENTE_ANTES_MS = HORA_MS;
// A partir de esta hora aparece el cierre del día.
const HORA_CIERRE = 21;
const VIGENCIA_MS = 2 * 60 * 1000;

const BLOQUES = [
  { k: "cal", n: "En la mira" },
  { k: "tib", n: "Recuperar tibios" },
  { k: "fri", n: "Recuperar fríos" },
  { k: "hl", n: "Leads de HighLevel" },
  { k: "ven", n: "Posibles ventas" },
  { k: "cla", n: "Clase de hoy" },
];
// Leads de WhatsApp por temperatura (decisión del usuario, 16/10/2026): los
// calientes entran todos («en la mira»); de tibios y fríos, solo un tope diario,
// primero los ya atendidos hoy (para que el bloque se pueda terminar) y luego
// los de movimiento más reciente, que son los más fáciles de recuperar.
const BLOQUE_T = { caliente: "cal", tibio: "tib", frio: "fri" };
const TOPE_T = { tibio: 10, frio: 5 };
const WHY_T = {
  caliente: "Caliente: está en la mira, atiéndelo hoy.",
  tibio: "Tibio: recupéralo antes de que se enfríe.",
  frio: "Frío: un mensaje a tiempo puede reactivarlo.",
};

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

// «Pasar al siguiente»: aparta el foco un rato (p. ej. mientras el lead está
// depositando) sin darlo por hecho; vuelve solo al cumplirse el plazo. Es una
// comodidad de este navegador, por eso vive en localStorage y no en la base.
const POSPONER_MS = 30 * 60 * 1000;
const CLAVE_POSP = () => `nexus:midia:pospuestos:${state.me.id}`;
function pospuestos() {
  try {
    const m = JSON.parse(localStorage.getItem(CLAVE_POSP()) || "{}"), ahora = Date.now();
    return Object.fromEntries(Object.entries(m).filter(([, t]) => t > ahora));
  } catch { return {}; }
}
function posponer(id, hasta) {
  const m = pospuestos();
  if (hasta) m[id] = hasta; else delete m[id];
  try { localStorage.setItem(CLAVE_POSP(), JSON.stringify(m)); } catch { /* sin almacenamiento: no se recuerda */ }
}

function itemsDelDia() {
  const ahora = Date.now(), me = state.me.id, hoy = hoyISO();
  const items = [];

  // 1 · Leads de WhatsApp, agrupados por temperatura.
  const porTemp = { caliente: [], tibio: [], frio: [] };
  state.clientes
    // Los de HighLevel por bajar van en su propio bloque, no aquí.
    .filter(c => !esInactivo(c) && esMio(c) && (esLead(c) || (c.promesaEn && c.promesaBroker)) && !porBajar(c))
    .forEach(c => {
      const cat = categoria(c), t = temperatura(c);
      const at = cat === "pend" && !sinHora(c.promesaEn) && dias(c.promesaEn) === 0 ? new Date(c.promesaEn).getTime() : null;
      const porWa = escribisteHoy(c), aMano = contactoHoy(c), seg = extra?.seg[c.id];
      // Reciente = su último movimiento: te escribió, lo contactaste, prometió o llegó.
      const rec = Math.max(ts(entranteDe(c)), ts(contactosDe(c)[0]?.en), cat === "pend" ? ts(c.promesaEn) : 0, ts(c.creado && c.creado + "T00:00:00-05:00"));
      porTemp[t].push({ b: BLOQUE_T[t], id: "wa" + c.id, c, cat, at, prog: at, rec, t: c.nombre, s: razon(c), ...razonCorta(c),
        hecho: porWa || aMano || !!seg,
        ok: porWa ? "Le escribiste hoy por WhatsApp" : aMano ? "Contacto registrado hoy"
          : seg === "enviado" ? "Le enviaste un seguimiento" : "Seguimiento en camino",
        acc: "lead", why: WHY_T[t] });
    });
  items.push(...porTemp.caliente);
  for (const t of ["tibio", "frio"])
    items.push(...porTemp[t].sort((a, b) => b.hecho - a.hecho || b.rec - a.rec).slice(0, TOPE_T[t]));

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
        items.push({ b: "ven", id: "v" + v.id, t: c?.nombre || "Venta", acc: "venta", rec: ts(v.fecha_pago + "T00:00:00-05:00"),
          s: `Cobro pendiente · saldo ${usd(saldo(v))}${vencida ? " · vencido" : ""}`,
          tag: vencida ? "Cobro vencido" : "Cobro hoy", tono: vencida ? "bad" : "oro", det: `saldo ${usd(saldo(v))}`,
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
      items.push({ b: "cla", id: "cla" + a.id, at: at > ahora ? at : null, prog: at,
        t: `${a.nombre} · ${horaTxt(a.inicio)}`, s: n ? `${n} invitados tuyos` : "Sin invitados tuyos",
        hecho: n > 0, ok: `${n} invitados programados`, acc: "seg",
        why: "Invita al menos una tanda y los recordatorios salen solos." });
    });
  }
  // Dentro de cada bloque: lo agendado para hoy, el más próximo primero; luego
  // lo demás del más reciente al más antiguo (pedido del usuario, 15/10/2026).
  return items.sort((a, b) => idxBloque(a) - idxBloque(b) || porTiempo(a, b));
}
const ts = x => (x ? new Date(x).getTime() || 0 : 0);
function porTiempo(a, b) {
  const pa = a.prog != null, pb = b.prog != null;
  if (pa !== pb) return pa ? -1 : 1;
  return pa ? a.prog - b.prog : (b.rec || 0) - (a.rec || 0);
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
    const prog = [l.vuelve_en, l.siguiente === "llamada" && l.siguiente_en].filter(x => x && esHoy(x)).map(ts)[0] ?? null;
    const base = { b: "hl", id: "hl" + l.id, l, t, acc: "crm", prog, rec: Math.max(ts(l.asignado_en), ts(l.respondio_en)),
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

// Orden: los leads de HighLevel recién llegados (el más reciente primero),
// después lo urgente (por hora) y al final el orden fijo del usuario.
function cola(items, ahora) {
  const pend = items.filter(i => !i.hecho && !i.espera);
  const n = pend.filter(i => i.nuevo).sort((a, b) => b.rec - a.rec);
  const u = pend.filter(i => !i.nuevo && urgente(i, ahora)).sort((a, b) => a.at - b.at);
  const r = pend.filter(i => !i.nuevo && !urgente(i, ahora)).sort((a, b) => idxBloque(a) - idxBloque(b) || items.indexOf(a) - items.indexOf(b));
  return [...n, ...u, ...r];
}

/* ------------------------------------------------------------------ vista */
// El mismo avión de papel del botón «Enviar seguimiento» de Leads (ui.js).
const ICO_ENV = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>`;
const ICO_WA = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.3-.5 0-1 .3-3.4-.7-2.9-1.2-4.7-4.1-4.9-4.3-.1-.2-1.2-1.6-1.2-3s.8-2.2 1-2.5c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.4c-.1.2-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.7-.1 1.2z"/></svg>';

function accionesHTML(it) {
  if (it.acc === "crm") return accionesCrm(it.l) + siguienteHTML(it);
  if (it.acc === "lead") {
    const tel = digitos(it.c.tel), co = telColombia(it.c.tel);
    // Dos acciones a la vista (las que más se usan); el resto, en la fila de
    // abajo. Llamar, solo con número de Colombia, va de ícono para no quitarles ancho.
    return `${tel ? `<div class="mdprim${co ? " contel" : ""}">
        <a class="btn-oro mdbtn" href="https://wa.me/${tel}" target="_blank" rel="noopener">${ICO_WA}Abrir chat</a>
        <button type="button" class="hsegenv mdbtn" data-md="seglead" data-id="${it.c.id}">${ICO_ENV}Seguimiento</button>
        ${co ? `<a class="lbtn mdbtn mdtel" href="tel:+${co}" title="Llamar al +${co}" aria-label="Llamar al +${co}">${ICO_TEL}</a>` : ""}</div>` : ""}
      ${embudoHTML(it)}`;
  }
  const L = { venta: "Ir a Ventas", seg: it.id === "cla-crear" ? "Crear en Seguimiento" : "Programar invitados" };
  return `<div class="mdacts"><button class="btn-oro mdbtn" data-md="${it.acc}">${L[it.acc]}</button></div>${siguienteHTML(it)}`;
}

// El paso del embudo que toca, como en el panel «Hoy» de Leads: se anota aquí
// mismo, sin salir de la guía (mismo formulario y misma lógica de leads.js).
// Va en la misma fila que «Ver en Leads» y «Pasar» para no apilar botones.
function embudoHTML(it) {
  const c = it.c, cat = it.cat;
  if (!esMio(c)) return `<div class="mdsec">${verLeadsHTML(it)}${pasarHTML(it)}</div>`;
  for (const m of ["registro", "promesa", "deposito"]) if (abiertoAqui(c, m)) return `<div class="mdemb" data-cid="${c.id}">${form(c)}</div>`;
  const b = cat === "pend" ? `<button class="btn-ok mdbtn" data-l="deposito">Depositó</button><button class="lbtn mdbtn" data-l="promesa">Reagendar</button>`
    : cat === "reg" ? `<button class="lbtn mdbtn" data-l="promesa">Prometió depositar</button>`
    : `<button class="lbtn mdbtn" data-l="registro">Creó cuenta</button>`;
  return `<div class="mdemb mdsec" data-cid="${c.id}">${b}${verLeadsHTML(it)}${pasarHTML(it)}</div>`;
}
const verLeadsHTML = it => `<button class="lbtn mdbtn" data-md="lead" data-id="${it.c.id}" data-cat="${it.cat}">Ver en Leads</button>`;
const pasarHTML = it => `<button class="lbtn mdbtn mdpasar" data-md="despues" data-id="${it.id}" title="Pasar al siguiente: vuelve en 30 min" aria-label="Pasar al siguiente, vuelve en 30 minutos">Pasar${ICO_SIG}</button>`;
const siguienteHTML = it => `<div class="mdacts mdsig">${pasarHTML(it)}</div>`;

// «Lo que Nexus hizo»: a la vista solo el total; el detalle, plegado.
function sistemaHTML() {
  if (!extra) return "";
  const cuenta = tipos => extra.msgs.filter(m => tipos.includes(m.tipo)).length;
  const escribieron = state.clientes.filter(c => esMio(c) && esLead(c)
    && entranteDe(c) && dias(entranteDe(c)) === 0).length;
  const auto = [
    [cuenta(["invitacion"]), "Invitaciones a clases"],
    [cuenta(["rec_60", "rec_15", "confirmacion"]), "Recordatorios y confirmaciones"],
    [cuenta(["enlace"]), "Enlaces de clase"],
    [cuenta(["masivo"]), "Mensajes masivos"],
  ];
  const total = auto.reduce((s, [n]) => s + n, 0);
  const filas = [...auto,
    [escribieron, `Lead${escribieron === 1 ? "" : "s"} que te escribi${escribieron === 1 ? "ó" : "eron"} (su temperatura sube un nivel)`],
    [(state.crm || []).filter(l => l.estado === "bajo" && esHoy(l.resultado_en)).length, "Leads de HighLevel que pasaron a WhatsApp"],
  ].filter(([n]) => n > 0);
  return `<details class="mdtile mdsis"><summary>
      <span class="mdtile-l">Nexus hizo hoy</span>
      <b>${total}</b><span class="mdtile-s">mensaje${total === 1 ? "" : "s"} automático${total === 1 ? "" : "s"}</span>
      <span class="mdlink">${filas.length ? "Ver detalle" : ""}</span></summary>
    ${filas.length ? `<ul>${filas.map(([n, t]) => `<li><span>${t}</span><b>${n}</b></li>`).join("")}</ul>`
      : ""}</details>`;
}

function corteHTML(r) {
  if (!r) return "";
  const pc = r.corte.meta ? Math.min(100, Math.round(r.corte.llevas / r.corte.meta * 100)) : 100;
  return `<div class="mdtile"><span class="mdtile-l">Corte día ${r.corte.dia}</span>
    <b>${r.corte.llevas} <em>/ ${r.corte.meta}</em></b>
    <div class="mdbar oro"><i style="width:${pc}%"></i></div>
    <span class="mdtile-s">${r.corte.faltan ? `Faltan ${r.corte.faltan} en ${r.corte.dias} día${r.corte.dias === 1 ? "" : "s"}` : "Corte cumplido ✓"}</span></div>`;
}

// La meta de hoy en una línea: es la cifra que el agente mueve hoy, pero la
// tarjeta grande competía con «Ahora» por la atención.
function metaHTML(r) {
  if (!r) return "";
  const { hechos, meta } = r.hoy;
  return `<div class="mdmeta ${hechos >= meta ? "ok" : ""}">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1" fill="currentColor"/></svg>
    <span class="mdmeta-l">Meta de hoy</span>
    <b>${hechos} de ${meta} FTD</b>
    <span class="mdmeta-s">${hechos >= meta ? "cumplida ✓" : `te faltan ${meta - hechos}`}</span>
    <button type="button" class="infoi" aria-label="Cómo se calcula la meta de hoy"
      data-info="Lo que te falta para el corte, repartido en los días que quedan. El fin de semana pide menos. Si te prometieron depositar hoy, cuenta esas promesas."></button>
  </div>`;
}

function cierreHTML(items) {
  const me = state.me.id, hoy = hoyISO();
  const ftdHoy = state.clientes.filter(c => c.owner_id === me && Object.values(c.ftds || {}).includes(hoy)).length;
  const cobrado = state.ventas.filter(v => v.owner_id === me)
    .flatMap(v => v.abonos || []).filter(a => a.fecha === hoy).reduce((s, a) => s + a.monto, 0);
  const contactos = Object.values(state.contactos || {}).flat().filter(x => dias(x.en) === 0).length;
  const quedan = items.filter(i => !i.hecho);
  return `<div class="mdcierre"><div class="mdeb">Cierre del día</div><h3>Así te fue hoy</h3>
    <div class="mdnums"><div><b>${ftdHoy}</b><small>FTD</small></div><div><b>${contactos}</b><small>contactos</small></div><div><b>${usd(cobrado)}</b><small>cobrado</small></div></div>
    ${quedan.length ? `<div class="mdsubl">Pasa a mañana</div><ul>${quedan.map(i => `<li>${esc(i.t)}</li>`).join("")}</ul>`
      : "<p>No queda nada pendiente para mañana.</p>"}</div>`;
}

// Etiqueta corta + dato de cada fila. Lo hecho y lo que espera mandan sobre la
// razón: es lo primero que el agente necesita saber de esa fila.
function etiqueta(it) {
  if (it.hecho) return { tag: "Listo", tono: "ok", det: it.ok };
  if (it.posp) return { tag: "En espera", tono: "neutro", det: `vuelve a las ${horaTxt(it.posp)}` };
  if (it.espera) return { tag: "En espera", tono: "neutro", det: it.s };
  if (it.nuevo) return { tag: "Nuevo", tono: "oro", det: it.s };
  if (it.tag) return { tag: it.tag, tono: it.tono, det: it.det };
  return { tag: "", tono: "", det: it.s };
}

// En la lista, primero lo que falta, luego lo que espera y al final lo hecho;
// dentro de cada grupo se respeta el orden del día.
const grupo = x => x.hecho ? 2 : x.espera ? 1 : 0;
const porHacer = ls => ls.map((x, i) => [x, i]).sort((a, b) => grupo(a[0]) - grupo(b[0]) || a[1] - b[1]).map(([x]) => x);

// Notas del encabezado de cada paso: de dónde sale la lista.
const NOTA = {
  cal: "Todos los calientes",
  tib: `Hasta ${TOPE_T.tibio} por día`,
  fri: `Hasta ${TOPE_T.frio} por día`,
  ven: "Cobros con fecha de pago hoy o vencida",
  cla: "Invita al menos una tanda",
};

// Qué paso se ve y qué fila está abierta. null = automático: el paso y la fila
// de «Ahora». Al tocar otro paso se queda ahí hasta volver a «Ahora». La fila
// elegida a mano se suelta sola cuando cambia de pendiente a hecha (o al revés),
// para que la guía siga sola al terminar.
let pasoSel = null, filaSel = null;

const ICO_SIG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M13 6l6 6-6 6"/></svg>`;
const ICO_CHEV = `<svg class="mdchev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

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
  if (!reloj) reloj = setInterval(() => {
    const ae = document.activeElement;
    if (state.vista === "midia" && !(ae && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName))) render();
  }, 60 * 1000);

  const ahora = Date.now();
  const items = itemsDelDia(), posp = pospuestos();
  items.forEach(x => { if (!x.hecho && posp[x.id]) { x.espera = true; x.posp = posp[x.id]; } });
  const q = cola(items, ahora), foco = q[0];
  const listos = items.filter(i => i.hecho).length;
  const hora = new Date(ahora).getHours();
  const meta = metaHoyDatos(render);

  // Pasos visibles: los que tienen algo hoy, más HighLevel (se conecta desde
  // ahí) y la clase mientras carga.
  // Se numeran en el orden en que se ven: «Tus 5 pasos» va del 1 al 5.
  const pasos = BLOQUES.map(b => ({ ...b, ls: items.filter(x => x.b === b.k) }))
    .filter(p => p.ls.length || p.k === "hl" || (p.k === "cla" && !extra))
    .map((p, i) => ({ ...p, num: i + 1 }));
  const auto = foco ? foco.b : (pasos.find(p => p.ls.some(x => !x.hecho)) || pasos[0])?.k;
  const paso = pasos.find(p => p.k === pasoSel) || pasos.find(p => p.k === auto);
  if (paso && paso.k !== pasoSel) pasoSel = null;

  let elegida = null;
  if (filaSel) {
    const x = paso?.ls.find(i => i.id === filaSel.id);
    if (x && x.hecho === filaSel.hecho) elegida = x; else filaSel = null;
  }
  const abierta = filaSel ? (filaSel.cerrada ? null : elegida)
    : paso?.ls.includes(foco) ? foco : paso?.ls.find(x => !x.hecho && !x.espera) || null;

  let top = "";
  if (hora >= HORA_CIERRE) top += cierreHTML(items);
  if (!foco && hora < HORA_CIERRE) {
    top += `<div class="mdalday"><b>Estás al día</b><span>No tienes nada pendiente ahora. A las 9 pm verás el cierre del día.</span></div>`;
  }

  const pasosHTML = pasos.map(p => {
    const ok = p.ls.filter(x => x.hecho).length, n = p.ls.length;
    const completo = n > 0 && ok === n, actual = foco && foco.b === p.k;
    const cls = [p === paso ? "on" : "", completo ? "ok" : "", actual ? "ahora" : ""].join(" ");
    return `<button type="button" class="mdpaso-b ${cls}" data-paso-k="${p.k}" aria-pressed="${p === paso}">
      <span class="mdpaso-top"><i>${completo ? "✓" : p.num}</i><em>${n ? `${ok}/${n}` : "—"}</em></span>
      <span class="mdpaso-n">${p.n}</span>
      <span class="mdbar"><i style="width:${n ? Math.round(ok / n * 100) : 0}%"></i></span>
    </button>`;
  }).join("");

  const filaHTML = x => {
    const e = etiqueta(x), abre = x === abierta, u = urgente(x, ahora) || (x.nuevo && !x.hecho);
    const cls = [x.hecho ? "hecho" : "", abre ? "abierta" : "", u ? "urg" : "", x.espera ? "espera" : ""].join(" ");
    let cuerpo = "";
    if (abre) {
      const falta = urgente(x, ahora) ? Math.max(0, Math.round((x.at - ahora) / 60000)) : null;
      const pre = falta == null ? "" : falta > 0 ? `Faltan ${falta} min: por eso subió al frente. ` : "Ya es la hora. ";
      cuerpo = `<div class="mdit-c">
        ${x.why ? `<p class="mdwhy">${pre}${x.why}</p>` : ""}
        ${x.posp ? `<div class="mdacts"><button class="lbtn mdbtn" data-md="retomar" data-id="${x.id}">Atender ahora</button></div>` : accionesHTML(x)}
      </div>`;
    }
    return `<div class="mdit ${cls}" data-paso="${x.id}">
      <button type="button" class="mdit-h" data-fila="${x.id}" aria-expanded="${abre}">
        <span class="mdit-t">
          <span class="mdit-n"><b>${esc(x.t)}</b>${x === foco ? `<span class="mdya">Ahora</span>` : ""}</span>
          <span class="mdit-s">${e.tag ? `<span class="mdtag ${e.tono}">${e.tag}</span>` : ""}<span>${esc(e.det || "")}</span></span>
        </span>
        ${x.at != null && !x.hecho ? `<span class="mdhora">${horaTxt(x.at)}</span>` : ""}
        ${ICO_CHEV}
      </button>${cuerpo}</div>`;
  };

  let lista = "";
  if (paso) {
    const vacioHl = paso.k === "hl" && !paso.ls.length
      ? `<div class="mdvacio">${!extra ? "Cargando…" : state.crm?.length || extra.token ? "Sin leads de HighLevel para hoy." : "Todavía no conectas HighLevel."}</div>` : "";
    const nota = paso.k === "hl"
      ? `<button class="mdlink" data-con="abrir">${extra?.token ? "Enlace del webhook" : "Conectar HighLevel"}</button>`
      : `<span>${NOTA[paso.k] || ""}</span>`;
    const sig = pasos.slice(pasos.indexOf(paso) + 1).find(p => p.ls.some(x => !x.hecho));
    const pend = sig ? sig.ls.filter(x => !x.hecho).length : 0;
    lista = `<section class="mdlista">
      ${foco && foco.b !== paso.k ? `<button type="button" class="mdvolver" data-md="ahora">
        <span><em>Ahora</em> ${esc(foco.t)} · ${BLOQUES[idxBloque(foco)].n}</span>${ICO_SIG}</button>` : ""}
      <div class="mdlista-h"><h2>${paso.n}</h2>${nota}</div>
      ${paso.k === "hl" ? conexionHTML() : ""}${vacioHl}
      ${paso.ls.length ? `<div class="mdits">${porHacer(paso.ls).map(filaHTML).join("")}</div>`
        : paso.k === "hl" ? "" : `<div class="mdvacio">Cargando…</div>`}
      ${sig ? `<button type="button" class="mdluego" data-paso-k="${sig.k}">
        <span><small>Después</small>Paso ${sig.num} · ${sig.n} · ${pend} pendiente${pend === 1 ? "" : "s"}</span>${ICO_SIG}</button>` : ""}
    </section>`;
  }

  cont.innerHTML = `
    ${top}
    ${metaHTML(meta)}
    <div class="mdpasos-h"><span>Tus ${pasos.length} pasos de hoy</span><span><b>${listos}</b> de ${items.length} tareas hechas</span></div>
    <div class="mdpasos" style="--n:${pasos.length}">${pasosHTML}</div>
    <div class="mdgrid"><div class="mdcol">${lista}</div>
      <div class="mdcol mdlado">${corteHTML(meta)}${sistemaHTML()}</div></div>
    ${extra?.error ? `<p class="mderr">Parte de la guía no cargó: ${esc(extra.error.message || String(extra.error))}</p>` : ""}`;

  detectarBajadas(render);
  cont.querySelectorAll("[data-paso-k]").forEach(b => b.onclick = () => {
    pasoSel = b.dataset.pasoK; filaSel = null; render();
    cont.querySelector(".mdlista")?.scrollIntoView({ block: "nearest" });
  });
  cont.querySelectorAll("[data-fila]").forEach(b => b.onclick = () => {
    const it = paso.ls.find(x => x.id === b.dataset.fila);
    // Tocar la fila abierta la cierra; tocar otra la abre en su lugar.
    filaSel = it === abierta ? { id: it.id, hecho: it.hecho, cerrada: true } : { id: it.id, hecho: it.hecho };
    if (paso.k !== auto) pasoSel = paso.k;
    render();
  });
  cont.querySelectorAll("[data-crm]").forEach(b => b.onclick = () => {
    accionCrm(abierta.l, b.dataset.crm, render, cont);
  });
  manejarNotas(cont);
  cont.querySelectorAll("[data-con]").forEach(b => b.onclick = () => {
    const a = b.dataset.con;
    if (a === "abrir") { verConexion = true; render(); asegurarToken(render); return; }
    if (a === "cerrar") { verConexion = false; render(); return; }
    if (a === "copiar") {
      const txt = urlWebhook(extra.token);
      navigator.clipboard?.writeText(txt).then(() => toast("Enlace copiado"), () => toast("Copia el enlace a mano"));
    }
  });
  cont.querySelectorAll(".mdemb").forEach(el => {
    const c = state.clientes.find(x => x.id === el.dataset.cid);
    if (c) manejarLead(el, c, () => render());
  });
  cont.querySelectorAll("[data-md]").forEach(b => b.onclick = async () => {
    const a = b.dataset.md;
    if (a === "ahora") { pasoSel = null; filaSel = null; render(); return; }
    if (a === "despues") {
      const hasta = Date.now() + POSPONER_MS;
      posponer(b.dataset.id, hasta); filaSel = null; toast(`Vuelve a las ${horaTxt(hasta)}`); render(); return;
    }
    if (a === "retomar") { posponer(b.dataset.id, null); render(); return; }
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
export const MI_DIA_USUARIOS = [
  "a70d2670-74b2-4eb7-be6e-ed3c92068c14", // Sanviv
  "85bf65bc-1cf2-4216-ab37-6e9da96cbce3", // Tatiana (19/10/2026)
];
export const tieneMiDia = () => MI_DIA_USUARIOS.includes(state.me?.id);
