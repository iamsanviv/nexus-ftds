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
  // Solo escritorio: filtro por membresía (Beca/VIP/Platino/Oro) que se COMBINA
  // con `filtro` (todos/incompletos/completos). En móvil no se usa (allá la
  // membresía sigue siendo una píldora más dentro de `filtro`). null = sin filtro.
  filtroMem: null,
  filtroDefDesk: false,  // ¿ya se aplicó el defecto "En progreso" de escritorio?
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
  parametros: {},        // config global (hoy vacío; el upgrade ya no usa parámetro)
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

/* ---------- bandera del país ----------
   En la lista se muestra SOLO el emoji de la bandera. El «📍 Colombia» anterior
   repetía en cada fila la misma palabra (209 de 293 personas son de Colombia) y
   le comía sitio al dato que sí cambia.
   `pais` es texto libre —lo escribe el agente o llega del CSV—, así que el
   nombre se normaliza antes de buscarlo; si no se reconoce, se deduce del
   prefijo del teléfono antes de darse por vencido. Devolver "" es una respuesta
   válida: quien la llama muestra entonces el texto tal cual, sin inventar. */
const PAIS_ISO = {
  colombia: "CO", mexico: "MX", ecuador: "EC", venezuela: "VE", peru: "PE",
  chile: "CL", argentina: "AR", bolivia: "BO", paraguay: "PY", uruguay: "UY",
  brasil: "BR", brazil: "BR", panama: "PA", "costa rica": "CR", cuba: "CU",
  "el salvador": "SV", salvador: "SV", guatemala: "GT", honduras: "HN",
  nicaragua: "NI", "republica dominicana": "DO", "rep dominicana": "DO",
  dominicana: "DO", "puerto rico": "PR", haiti: "HT", belice: "BZ",
  espana: "ES", portugal: "PT", italia: "IT", francia: "FR", alemania: "DE",
  "reino unido": "GB", inglaterra: "GB", canada: "CA",
  "estados unidos": "US", eeuu: "US", "ee uu": "US", eua: "US", usa: "US",
  "united states": "US",
};
// De más largo a más corto: "1809" (Rep. Dominicana) tiene que ganarle a "1".
const PREFIJO_ISO = [
  ["1809", "DO"], ["1829", "DO"], ["1849", "DO"], ["1787", "PR"], ["1939", "PR"],
  ["501", "BZ"], ["502", "GT"], ["503", "SV"], ["504", "HN"], ["505", "NI"],
  ["506", "CR"], ["507", "PA"], ["509", "HT"], ["591", "BO"], ["593", "EC"],
  ["595", "PY"], ["598", "UY"], ["351", "PT"],
  ["33", "FR"], ["34", "ES"], ["39", "IT"], ["44", "GB"], ["49", "DE"],
  ["51", "PE"], ["52", "MX"], ["53", "CU"], ["54", "AR"], ["55", "BR"],
  ["56", "CL"], ["57", "CO"], ["58", "VE"], ["1", "US"],
];
// ISO-3166 → emoji: cada letra a su indicador regional (A = U+1F1E6).
const emojiISO = iso => [...iso].map(c => String.fromCodePoint(c.codePointAt(0) + 127397)).join("");

export function bandera(pais, tel) {
  const n = norm(pais).replace(/[.,]/g, "").replace(/\s+/g, " ").trim();
  if (PAIS_ISO[n]) return emojiISO(PAIS_ISO[n]);
  const d = (tel || "").replace(/\D/g, "");
  if (d) { for (const [p, iso] of PREFIJO_ISO) if (d.startsWith(p)) return emojiISO(iso); }
  return "";
}

/* ---------- desfase horario del cliente ----------
   `tzOff` es la diferencia con Colombia en MINUTOS. Positivo = la persona va
   adelantada (allá es más tarde). null = sin definir, y entonces el mensaje
   anuncia hora Colombia, igual que antes de existir esta columna.

   Lo pone el agente a mano, siempre. NO se deduce del país: dentro de un mismo
   país puede haber varios husos —México tiene tres— así que adivinar acierta a
   veces y falla en silencio el resto, que es la peor de las dos.

   Se guardan minutos y no horas porque hay husos a la media hora. Es un desfase
   FIJO, no un huso: los países con horario de verano hay que corregirlos dos
   veces al año. */

// De -3 h a +12 h en saltos de media hora: cubre todo lo que aparece desde
// Colombia, incluidos los husos a la media hora.
export const OPCIONES_TZ =
  Array.from({ length: 31 }, (_, i) => (i - 6) * 30);

// "+1 h 30 min" antes que "+1,5 h": se lee sin traducir.
export function etiquetaOffset(min) {
  if (min === 0) return "Igual que Colombia";
  const a = Math.abs(min), h = Math.floor(a / 60), m = a % 60, partes = [];
  if (h) partes.push(h + " h");
  if (m) partes.push(m + " min");
  return (min > 0 ? "+" : "−") + partes.join(" ");
}

// La app asume que el agente trabaja en hora Colombia (ver `inicio` al crear la
// actividad). Por eso basta con CORRER el instante el desfase y formatear como
// siempre: lo que sale es la hora de pared del cliente.
export const horaDeCliente = (iso, tzOff) =>
  new Date(new Date(iso).getTime() + (tzOff || 0) * 60000)
    .toLocaleTimeString("es-CO", { hour: "numeric", minute: "2-digit", hour12: true });

// Qué se pone junto a la hora, y CUÁNDO no se pone nada.
//
// Si la persona tiene la misma hora que Colombia —o no se sabe, que es el caso
// de casi todos— la hora del mensaje ya es la suya: aclarar «hora Colombia» es
// ruido en todos los mensajes para que lo aproveche casi nadie.
//
// Solo hay algo que decir cuando la hora viene convertida: ahí «(tu hora)»
// evita que la persona la convierta otra vez y llegue tarde.
export const etiquetaZona = tzOff =>
  (tzOff === null || tzOff === undefined || tzOff === 0) ? "" : "(tu hora)";

/* ---------- persona inactiva ----------
   Dejó de responder, pidió no seguir o su número ya no sirve. No se borra:
   conserva asistencia, ventas e historial. Solo deja de recibir mensajes.

   `inactivoDesde` nulo = activa. Membresía y estado son ejes independientes:
   alguien puede ser Oro e inactivo, por eso esto NO es un nivel más.

   El motivo es solo un dato. Los cuatro excluyen igual y reactivar es un clic
   en todos los casos; se guarda para poder distinguir después «se enfrió» de
   «pidió que no le escriba» si esa diferencia llega a pesar. */
// Dos textos por motivo: el largo explica en el perfil, donde hay sitio; el
// corto va en la insignia de una fila. Con el largo, «Número equivocado o dado
// de baja» junto a un nombre largo se cortaba a la mitad en un celular, y un
// motivo cortado no sirve para decidir a quién escribirle.
export const MOTIVOS_INACTIVO = [
  ["no_responde", "No responde",                      "No responde"],
  ["no_quiere",   "No quiere continuar",              "No quiere continuar"],
  ["numero_malo", "Número equivocado o dado de baja", "Número inválido"],
  ["otro",        "Otra razón",                       "Otra razón"],
];
export const esInactivo = c => !!(c && c.inactivoDesde);
export const nombreMotivo = m => (MOTIVOS_INACTIVO.find(([v]) => v === m) || [, "Inactiva"])[1];
export const motivoCorto  = m => (MOTIVOS_INACTIVO.find(([v]) => v === m) || [, , "Inactiva"])[2];

/* ---------- embudo de venta: los tres zooms ----------
   Viven en el CLIENTE, no en la venta: la presentación pasa ANTES de que haya
   una venta que apuntarla, y una persona con upgrade tenía dos filas de venta
   repitiendo el mismo embudo. La venta los lee de aquí. */
export const ZOOMS = [
  ["pres",   "Presentación"],
  ["uno",    "1 a 1"],
  ["cierre", "Cierre"],
];
export const nombreZoom = k => (ZOOMS.find(([v]) => v === k) || [, ""])[1];

/* Refleja en el embudo lo que pasó con una actividad puntual marcada como zoom.
   La actividad y el zoom son el MISMO hecho, así que se marca solo: asistió →
   la etapa queda «hecha»; no asistió → queda «no asistió», que sirve para saber
   a quién hay que reagendar.

   La fecha la pone quien llama, y es la de la ACTIVIDAD, no la de hoy:
   corregir el lunes un zoom del viernes tiene que anotar el viernes.

   Nunca BORRA una etapa: quitar la asistencia deja el embudo como estaba. La
   etapa pudo haberse puesto a mano desde Ventas antes de que la actividad
   existiera, y ahí sí manda lo que escribió el agente. Para vaciarla está el
   propio embudo, en el perfil.

   Devuelve si cambió algo, para que quien llama sepa si tiene que guardar. */
export function syncZoom(c, actId, estado, fecha) {
  const p = ((c || {}).pun || {})[actId];
  if (!p || !p.z || !fecha) return false;
  const prev = (c.zooms || {})[p.z];
  if (prev && prev.f === fecha && prev.e === estado) return false;
  c.zooms = { ...(c.zooms || {}), [p.z]: { f: fecha, e: estado } };
  return true;
}

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

// EXCEPCIÓN DE FACTURACIÓN (regla del dueño, agosto 2026 — para todos los meses).
//
// Regla base: facturar es cobrar, así que `facturado` de un mes son los abonos
// que ENTRARON ese mes. La empresa cambió esto: cuando una venta se termina de
// pagar (se SALDA) en un mes, ese mes cuenta el VALOR COMPLETO de la venta, no
// solo el abono que la completó. Los abonos de meses anteriores SIGUEN contados
// en sus meses —no se les quita nada—, así que la parte ya abonada se cuenta dos
// veces a propósito: en el mes que entró y otra vez en el mes que se saldó.
//
// Ejemplo (César, VIP 300): abonó 200 en julio y los 100 finales en agosto.
//   julio  = 200 (el abono que entró, como siempre)
//   agosto = 300 (el valor completo, porque se saldó en agosto)
//
// Se deja detrás de este flag para poder revertirla a la regla base sin buscar
// la lógica: `FACTURA_VALOR_AL_SALDAR = false` y vuelve a ser "abonos del mes".
// Solo afecta a `facturado` (la plata); la comisión no se toca, se causa igual.
const FACTURA_VALOR_AL_SALDAR = true;

// Resumen de un periodo para un agente.
export function resumenVentas(periodo, ownerId) {
  const mias = state.ventas.filter(v => v.owner_id === ownerId);
  const vivas = mias.filter(v => v.estado !== "perdida" && !estaSaldada(v));

  const abonosDelMes = v => (v.abonos || [])
    .filter(a => periodoDe(a.fecha) === periodo)
    .reduce((t, a) => t + a.monto, 0);

  const facturado = mias.reduce((s, v) => {
    // Si se saldó en ESTE periodo, cuenta el valor completo en vez de los abonos
    // del mes (que sería solo el que la completó). Los de meses previos ya se
    // contaron en su momento y no se tocan.
    if (FACTURA_VALOR_AL_SALDAR && estaSaldada(v) && periodoDe(fechaSaldo(v)) === periodo)
      return s + v.valor;
    return s + abonosDelMes(v);
  }, 0);

  const causada = mias.filter(v => estaSaldada(v) && periodoDe(fechaSaldo(v)) === periodo)
                      .reduce((s, v) => s + v.comision, 0);

  // Pendientes: no son del periodo, son lo que hay vivo ahora mismo.
  const porFacturar = vivas.reduce((s, v) => s + saldo(v), 0);
  const porCausar   = vivas.reduce((s, v) => s + v.comision, 0);
  const sinDefinir  = vivas.filter(comisionSinDefinir).length;

  return { facturado, causada, porFacturar, porCausar, sinDefinir };
}

/* ---------- alertas por fecha de pago ---------- */
// Días entre dos fechas ISO. Se hace en UTC a propósito: `new Date("2026-08-01")`
// se interpreta como medianoche UTC y en Colombia (UTC−5) restar con fechas
// locales daba un día de diferencia según la hora a la que se mirara.
const dias = (desde, hasta) => {
  const d = new Date(desde + "T00:00:00Z"), h = new Date(hasta + "T00:00:00Z");
  return Math.round((h - d) / 86400000);
};

// Umbrales del sistema de alertas. Están aquí y no repartidos por el render
// para poder moverlos en un solo sitio.
export const ALERTA_PRONTO = 3;   // días para considerar que "vence pronto"

// Una venta viva con fecha de pago genera alerta. `orden` es la prioridad de
// cobro: lo vencido primero, lo que no tiene fecha al final.
export function alertaPago(v, hoy = hoyISO()) {
  if (v.estado === "perdida" || estaSaldada(v)) return null;
  if (!v.fecha_pago) return { nivel: "sinfecha", texto: "Sin fecha de pago", orden: 4 };

  const d = dias(hoy, v.fecha_pago);
  if (d < 0)  return { nivel: "vencida", orden: 0,
    texto: `Vencida hace ${-d} ${-d === 1 ? "día" : "días"}` };
  if (d === 0) return { nivel: "hoy", orden: 1, texto: "Vence hoy" };
  if (d <= ALERTA_PRONTO) return { nivel: "pronto", orden: 2,
    texto: `Vence en ${d} ${d === 1 ? "día" : "días"}` };
  return { nivel: "ok", orden: 3, texto: `Vence el ${fmtF(v.fecha_pago)}` };
}

// Resumen para el aviso de arriba: cuántas y cuánto hay que perseguir.
export function alertasDelMes(ownerId) {
  const vivas = state.ventas.filter(v =>
    v.owner_id === ownerId && v.estado === "abierta" && !estaSaldada(v));
  const con = n => vivas.filter(v => alertaPago(v)?.nivel === n);
  const vencidas = con("vencida"), hoyv = con("hoy"), pronto = con("pronto");
  const monto = [...vencidas, ...hoyv].reduce((s, v) => s + saldo(v), 0);
  return { vencidas: vencidas.length, hoy: hoyv.length, pronto: pronto.length, monto };
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

// Progreso hacia la META QUE EL AGENTE SE PUSO. Se mide SOLO con los FTD de
// este mes: la base NO cuenta.
//
// Es deliberado y no es lo mismo que la comisión. La base sí sirve para cobrar
// —para eso se acumula—, pero si además contara para la meta personal, alguien
// que llegó con 31 de base vería «meta cumplida» sin haber hecho nada este mes,
// y eso lo desactiva justo de lo que la meta pretende activarlo.
export function progresoMeta(periodo, ownerId) {
  const f = comisionFtd(periodo, ownerId);
  const m = metasDe(periodo, ownerId);
  // Sin meta propia se usa la siguiente de comisión, solo como referencia.
  const meta = m?.metaFtd || f.siguiente || 0;
  return {
    meta,
    hechos: f.reales,                                  // sin base, a propósito
    faltan: Math.max(0, meta - f.reales),
    cumplida: meta > 0 && f.reales >= meta,
    pct: meta ? Math.min(100, Math.round(f.reales / meta * 100)) : 0,
    pctCargados: meta ? Math.min(100, Math.round(f.cargados / meta * 100)) : 0,
    propia: !!m?.metaFtd,
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
