// Seguimiento de leads: temperatura, categoría de prioridad, embudo hacia la
// beca (abrió cuenta → prometió depositar → depositó) y registro de contactos.
//
// Las reglas viven aquí y no en la vista porque el panel «Hoy» (F3) las usa
// igual: la lista y el panel tienen que decir la misma temperatura.
import { state, esc, fmtF, hoyISO, fechaCO, toast, BROKERS, nombreBroker, diaMesCorto, ICO_ENV } from "./state.js";
import { dbPatch, crearContacto, actualizarContacto, borrarContacto } from "./data.js";
import { entranteDe } from "./entrantes.js";

export const TIPOS = [
  ["objecion", "Resolver objeción"], ["prueba_social", "Prueba social"],
  ["valor", "Agregar valor"], ["fidelizacion", "Fidelización"],
  ["novedad", "Por novedad"], ["urgencia", "Urgencia"],
  ["deposito", "Depósito"], ["otro", "Saludar / otro"],
];
export const nombreTipo = t => (TIPOS.find(x => x[0] === t) || [, t])[1];
export const TEMP = { caliente: "Caliente", tibio: "Tibio", frio: "Frío" };

/* ---------------------------------------------------------------- fechas */
// Días de calendario (Colombia) entre una fecha y hoy: 0 = hoy, 1 = ayer.
const diaDe = v => !v ? null : (v.length === 10 ? v : fechaCO(new Date(v)));
export const dias = v => {
  const d = diaDe(v); if (!d) return null;
  const a = Date.UTC(...d.split("-").map((n, i) => i === 1 ? n - 1 : +n));
  const h = Date.UTC(...hoyISO().split("-").map((n, i) => i === 1 ? n - 1 : +n));
  return Math.round((h - a) / 864e5);
};
const HORA_CO = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true });
export const horaTxt = ts => HORA_CO.format(new Date(ts)).replace(/\s/g, " ").replace("a. m.", "am").replace("p. m.", "pm");
export const cuandoTxt = v => {
  const d = dias(v);
  return d === 0 ? "hoy" : d === 1 ? "ayer" : d === -1 ? "mañana" : d > 1 ? `hace ${d} días` : `el ${fmtF(diaDe(v))}`;
};
// La hora de la promesa es OPCIONAL. Sin hora se guarda con segundos `:01` como
// marca: un <input type=time> solo produce `:00`, así que la marca no choca con
// ninguna hora elegible y evita una columna aparte para «sin hora».
export const sinHora = ts => { const d = new Date(ts); return !isNaN(d) && d.getUTCSeconds() === 1; };
const cuandoHora = ts => sinHora(ts) ? cuandoTxt(ts) : `${cuandoTxt(ts)} ${horaTxt(ts)}`;
// Fecha de llegada: la que puso el agente o, si no la puso, cuándo se creó.
export const llegada = c => c.creado || (c.createdAt ? fechaCO(new Date(c.createdAt)) : null);
// Fecha de una fila en las listas para elegir a quién escribir: la de llegada
// si es lead; la de entrada a la comunidad si no. El filtro «Llegó» filtra por
// esta misma fecha, para que lo que se ve y lo que se filtra no difieran.
export const fechaFila = c => c.mem === "Lead" ? llegada(c) : (c.comunidadDesde || null);
export const fechaFilaHTML = c => {
  const t = diaMesCorto(fechaFila(c));
  return t ? `<span class="segmes" title="${c.mem === "Lead" ? "Llegó como lead" : "Entró a la comunidad"}">${esc(t)}</span>` : "";
};

// Filtro «Llegó»: hoy, ayer, esta semana (desde el lunes), este mes o entre
// fechas. Lo comparten la lista de Leads y las de seguimiento (leads, masivo,
// actividad); `r` = { modo, desde, hasta } o null.
const menosDias = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
const rangoLleg = modo => {
  const hoy = hoyISO();
  if (modo === "hoy") return { desde: hoy, hasta: hoy };
  if (modo === "ayer") { const a = menosDias(hoy, 1); return { desde: a, hasta: a }; }
  if (modo === "sem") return { desde: menosDias(hoy, (new Date(hoy + "T12:00:00Z").getUTCDay() + 6) % 7), hasta: hoy };
  if (modo === "mes") return { desde: hoy.slice(0, 7) + "-01", hasta: hoy };
  return { desde: menosDias(hoy, 6), hasta: hoy };
};
export const enRangoLleg = (f, r) => !r || (!!f && (!r.desde || f >= r.desde) && (!r.hasta || f <= r.hasta));
export function filtroLlegada(fila, r, cambio) {
  const modo = r?.modo || "";
  const op = (v, t) => `<option value="${v}" ${modo === v ? "selected" : ""}>${t}</option>`;
  fila.innerHTML = `<span class="ejelbl">Llegó</span>
    <select class="brksel" data-lleg aria-label="Filtrar por fecha de llegada">
      <option value="">Cualquier fecha</option>
      ${op("hoy", "Hoy")}${op("ayer", "Ayer")}${op("sem", "Esta semana")}${op("mes", "Este mes")}${op("rango", "Entre fechas…")}
    </select>
    ${modo === "rango" ? `<input type="date" class="depfecha" data-desde value="${r.desde || ""}" aria-label="Llegó desde">
      <span class="ejelbl">a</span>
      <input type="date" class="depfecha" data-hasta value="${r.hasta || ""}" aria-label="Llegó hasta">` : ""}`;
  fila.querySelector("[data-lleg]").onchange = e => {
    const v = e.target.value;
    cambio(v ? { modo: v, ...rangoLleg(v) } : null);
  };
  const de = fila.querySelector("[data-desde]"), ha = fila.querySelector("[data-hasta]");
  if (de) de.onchange = ha.onchange = () => {
    let d = de.value || null, h = ha.value || null;
    if (d && h && d > h) [d, h] = [h, d];
    cambio({ modo: "rango", desde: d, hasta: h });
  };
}

/* ------------------------------------------------------------- contactos */
export const contactosDe = c => state.contactos?.[c.id] || [];   // más reciente primero

/* ------------------------------------------------- plantillas enviadas */
// Una entrada por plantilla (la más reciente gana, con cuántas veces se mandó),
// para saber cuál NO repetir. Se agrupa por `plantillaId`; un envío sin
// plantilla guardada solo tiene el nombre de la campaña y se agrupa por él.
export function plantillasDe(c) {
  const por = new Map();
  for (const x of state.plantillasEnviadas?.[c.id] || []) {   // más reciente primero
    const k = x.plantillaId || "n:" + x.nombre;
    const g = por.get(k);
    if (g) { g.veces++; if (x.estado === "enviado") g.recibida = true; }
    else por.set(k, { ...x, veces: 1, recibida: x.estado === "enviado" });
  }
  return [...por.values()];
}
// Lo que la plantilla `id` ya le hizo a este lead: la recibió o está programada.
export const plantillaPara = (c, id) => id ? plantillasDe(c).find(x => x.plantillaId === id) : null;
// Texto corto de la marca. Agrupado, lo último puede estar programado aunque
// ya la haya recibido antes: se dicen las dos cosas.
export const marcaPlantilla = x => x.estado === "pendiente"
  ? (x.recibida ? `ya la recibió · otra programada ${cuandoTxt(x.en)}` : `programada ${cuandoTxt(x.en)} ${horaTxt(x.en)}`)
  : `recibida ${cuandoTxt(x.en)}`;
const ultimoSi = c => contactosDe(c).find(x => x.respuesta === "si");

// Lo que el lead te ESCRIBIÓ sale de entrantes.js (automático, ~5 min de
// demora): no depende de que marques «Me respondió» a mano.
export { entranteDe };

// «Respondió» automático a un contacto: el lead te escribió DESPUÉS de ese
// contacto y ANTES del siguiente. Se marca solo el contacto inmediatamente
// anterior a su mensaje: si le escribiste dos veces y contestó una, no se sabe
// si contestó al primero, pero sí que el segundo tuvo respuesta.
// Contactos más recientes primero, así que es el primero anterior al mensaje.
export function respondioAuto(c, x) {
  const ent = entranteDe(c);
  if (!ent || x.respuesta) return null;
  const previo = contactosDe(c).find(y => new Date(y.en) < new Date(ent));
  return previo && previo.id === x.id ? ent : null;
}

/* ----------------------------------------------------------- temperatura */
// Reglas acordadas con el usuario (05/10/2026):
//  · pendiente con fecha de hoy o futura: caliente; vencido 1–2 días: tibio; 3+: frío
//  · respondió («Me respondió») hoy: caliente; hace 1–2 días: tibio; 3+: frío
//  · sin contactar: según cuándo llegó (hoy caliente, 1–2 tibio, 3+ frío)
//  · contactado y sin respuesta: tibio (aunque haya llegado hoy); 3+ días: frío
//  · abrir cuenta cuenta como una señal: un registrado de ayer no es «frío»
//    solo porque llegó hace una semana.
// Y desde el 14/10/2026: cuando el lead VUELVE A ESCRIBIR, la temperatura SUBE
// UN NIVEL sobre la que tenía (frío → tibio → caliente), no salta a caliente.
// También sube la corrección a mano: un mensaje suyo es información nueva.
const porDias = (d, hoyEs = "caliente") => d <= 0 ? hoyEs : d <= 2 ? "tibio" : "frio";
const NIVEL = ["frio", "tibio", "caliente"];
const subir = t => NIVEL[Math.min(NIVEL.indexOf(t) + 1, 2)];
const masFria = (a, b) => NIVEL[Math.min(NIVEL.indexOf(a), NIVEL.indexOf(b))];

// Señal del lead aparte de la promesa: el «Me respondió» a mano o el registro
// en el broker. Gana la más nueva. El mensaje entrante NO entra aquí: es lo que
// hace subir un nivel sobre esto.
function senalBase(c) {
  const cand = [];
  const si = ultimoSi(c);
  if (si) cand.push({ tipo: "resp", en: si.respuesta_en });
  if (c.registroEn) cand.push({ tipo: "reg", en: c.registroEn });
  return cand.length ? cand.reduce((a, b) => new Date(b.en) > new Date(a.en) ? b : a) : null;
}

// La corrección a mano vale hasta el siguiente contacto.
export function manualVigente(c) {
  if (!c.tempManual) return false;
  const ult = contactosDe(c)[0];
  return !ult || new Date(c.tempManualEn) > new Date(ult.en);
}

// La temperatura SIN contar lo que te escribió, y desde cuándo vale (`en`):
// solo un mensaje POSTERIOR a ese momento la hace subir. Si escribió y después
// le volviste a escribir sin respuesta, manda tu último contacto.
function base(c) {
  if (manualVigente(c)) return { t: c.tempManual, en: c.tempManualEn };
  if (c.promesaEn) return { t: porDias(dias(c.promesaEn)), en: c.promesaEn };
  const s = senalBase(c);
  if (s) return { t: porDias(dias(s.en)), en: s.en, s };
  const cs = contactosDe(c);
  if (!cs.length) return { t: porDias(dias(llegada(c)) ?? 99), en: llegada(c) };
  return { t: porDias(dias(cs[cs.length - 1].en), "tibio"), en: cs[0].en };
}

// Temperatura final y, si subió por un mensaje suyo, desde cuál (`antes`) y
// cuándo escribió (`ent`). El nivel ganado envejece como cualquier señal: un
// mensaje de hace 3+ días ya no sostiene nada por encima de frío.
function calcTemp(c) {
  const b = base(c), ent = entranteDe(c);
  if (ent && b.en && new Date(ent) > new Date(b.en)) {
    return { ...b, t: masFria(subir(b.t), porDias(dias(ent))), antes: b.t, ent };
  }
  return b;
}
export const temperatura = c => calcTemp(c).t;
// «· a mano» solo mientras manda la corrección: si después te escribió, ya no.
export const tempAMano = c => manualVigente(c) && !calcTemp(c).ent;

/* ------------------------------------------------------------- categoría */
// Orden de prioridad del usuario. Un lead está SOLO en su categoría más alta.
export const CATEGORIAS = [
  ["pend", "Pendientes"], ["reg", "Registrados"], ["hoy", "Llegaron hoy"],
  ["bajo", "Bajaron hoy a tu WhatsApp"], ["ayer", "Llegaron ayer"], ["resto", "El resto"],
];
export function categoria(c) {
  if (c.promesaEn) return "pend";
  if (c.registroEn) return "reg";
  const dl = dias(llegada(c));
  if (dl === 0) return "hoy";
  // «Bajó hoy» = el lead te escribió hoy. La señal real es el mensaje entrante
  // (automático); el «Me respondió» a mano cuenta igual porque también dice que
  // escribió hoy.
  const ent = entranteDe(c), si = ultimoSi(c);
  if ((ent && dias(ent) === 0) || (si && dias(si.respuesta_en) === 0)) return "bajo";
  // Lead de HighLevel que te respondió en el CRM (marcado a mano en crm.js):
  // también te escribió hoy, aunque no por WhatsApp. Se lee de state y no de
  // crm.js para no crear un import circular (crm.js usa leads.js).
  const rc = state.crmPor?.[c.id]?.respondio_en;
  if (rc && dias(rc) === 0) return "bajo";
  if (dl === 1) return "ayer";
  return "resto";
}

// Por qué tiene esa temperatura, en una línea. Si subió por un mensaje suyo,
// se dice encima del motivo de base (la promesa o el registro siguen siendo lo
// importante); el «sin respuesta» se reemplaza, porque ya no es verdad.
export function razon(c) {
  const r = calcTemp(c);
  const escribio = r.ent
    ? `Te escribió <b>${cuandoTxt(r.ent)}</b>${r.t !== r.antes ? ` · subió de ${TEMP[r.antes]} a ${TEMP[r.t]}` : ""}`
    : "";
  if (c.promesaEn) {
    const d = dias(c.promesaEn);
    const br = c.promesaBroker ? ` en <b>${esc(nombreBroker(c.promesaBroker))}</b>` : "";
    const txt = `Prometió depositar${br} <b>${cuandoHora(c.promesaEn)}</b>${d > 0 ? " y no depositó" : ""}`;
    return escribio ? `${txt} · ${escribio.replace("Te", "te")}` : txt;
  }
  if (escribio) return escribio;
  const s = senalBase(c);
  if (s) {
    if (s.tipo === "reg") return `Creó cuenta en ${esc(nombreBroker(c.registroBroker))} <b>${cuandoTxt(c.registroEn)}</b>`;
    return `Te respondió <b>${cuandoTxt(s.en)}</b>`;
  }
  const cs = contactosDe(c);
  if (cs.length) return `Sin respuesta desde <b>${cuandoTxt(cs[cs.length - 1].en)}</b>`;
  const l = llegada(c);
  return l ? `Llegó <b>${cuandoTxt(l)}</b> · sin contactar` : "Sin contactar";
}

// La misma razón partida en etiqueta + dato corto, para las filas de «Mi día»
// (una etiqueta de color se lee de un vistazo; la frase larga, no). Sale de las
// mismas reglas que `razon` para que las dos nunca digan cosas distintas.
// `det` es texto plano (sin HTML).
export function razonCorta(c) {
  const r = calcTemp(c);
  const subio = r.ent && r.t !== r.antes ? `antes ${TEMP[r.antes].toLowerCase()}` : "";
  if (c.promesaEn) {
    const vencida = dias(c.promesaEn) > 0;
    const det = [cuandoHora(c.promesaEn), c.promesaBroker ? nombreBroker(c.promesaBroker) : "",
      r.ent ? `te escribió ${cuandoTxt(r.ent)}` : ""].filter(Boolean).join(" · ");
    return { tag: vencida ? "Promesa vencida" : "Prometió depositar", tono: vencida ? "bad" : "oro", det };
  }
  if (r.ent) return { tag: "Te escribió", tono: "ok", det: [cuandoTxt(r.ent), subio].filter(Boolean).join(" · ") };
  const s = senalBase(c);
  if (s) {
    if (s.tipo === "reg") return { tag: "Creó cuenta", tono: "ok", det: `${nombreBroker(c.registroBroker)} · ${cuandoTxt(c.registroEn)}` };
    return { tag: "Te respondió", tono: "ok", det: cuandoTxt(s.en) };
  }
  const cs = contactosDe(c);
  if (cs.length) return { tag: "Sin respuesta", tono: "neutro", det: `desde ${cuandoTxt(cs[cs.length - 1].en)}` };
  const l = llegada(c);
  return { tag: "Sin contactar", tono: "neutro", det: l ? `llegó ${cuandoTxt(l)}` : "" };
}

/* ----------------------------------------------------------------- vista */
export const chipTemp = c => {
  const t = temperatura(c);
  return `<span class="ltemp ${t}"><i></i>${TEMP[t]}${tempAMano(c) ? " · a mano" : ""}</span>`;
};

// Formulario abierto, uno a la vez: { id, modo }.
let abierto = null;
export const esMio = c => c.owner_id === state.me?.id;

export function form(c) {
  const hoy = hoyISO();
  if (abierto.modo === "registro") {
    const sel = abierto.brk || BROKERS[0].id;
    return `<div class="lform"><div class="lft">¿En qué broker creó cuenta?</div>
      <div class="lchips">${BROKERS.map(b => `<button class="lchip ${sel === b.id ? "on" : ""}" data-l="brk" data-v="${b.id}">${esc(b.n)}</button>`).join("")}</div>
      <label class="lfl">Fecha <input type="date" id="lFecha" value="${hoy}" max="${hoy}"></label>
      <div class="lacc"><button class="btn-oro" data-l="okRegistro">Confirmar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "promesa") {
    return `<div class="lform"><div class="lft">¿Cuándo dijo que deposita?</div>
      <div class="lfila"><input type="date" id="lFecha" value="${hoy}" min="${hoy}"><input type="time" id="lHora" value=""></div>
      <div class="lfl2">La hora es opcional</div>
      <div class="lacc"><button class="btn-oro" data-l="okPromesa">Confirmar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "deposito") {
    // Para un 2º depósito (ya es Beca) el broker objetivo es el de la promesa.
    const sel = abierto.brk || c.promesaBroker || c.registroBroker || BROKERS[0].id;
    const nuevo = c.mem === "Lead";
    return `<div class="lform"><div class="lft">${nuevo ? "Registrar el FTD — pasa a Beca" : "Registrar 2º FTD"}</div>
      <div class="lchips">${BROKERS.map(b => `<button class="lchip ${sel === b.id ? "on" : ""}" data-l="brk" data-v="${b.id}">${esc(b.n)}</button>`).join("")}</div>
      <label class="lfl">Fecha del depósito <input type="date" id="lFecha" value="${hoy}" max="${hoy}"></label>
      <div class="lacc"><button class="btn-oro" data-l="okDeposito">${nuevo ? "Confirmar depósito" : "Confirmar 2º depósito"}</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "contacto") {
    return `<div class="lform"><div class="lft">¿Para qué le escribiste?</div>
      <div class="lchips">${TIPOS.map(([k, n]) => `<button class="lchip ${abierto.tipo === k ? "on" : ""}" data-l="tipo" data-v="${k}">${n}</button>`).join("")}</div>
      <textarea id="lNota" rows="2" maxlength="2000" placeholder="Nota (opcional)">${esc(abierto.nota || "")}</textarea>
      <div class="lacc"><button class="btn-oro" data-l="okContacto" ${abierto.tipo ? "" : "disabled"}>Guardar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "temp") {
    return `<div class="lform"><div class="lft">Corregir temperatura (vale hasta tu próximo contacto; si te escribe, sube un nivel)</div>
      <div class="lchips">${Object.entries(TEMP).map(([k, n]) => `<button class="lchip" data-l="setTemp" data-v="${k}">${n}</button>`).join("")}
      <button class="lchip" data-l="setTemp" data-v="">Automática</button></div></div>`;
  }
  return "";
}
export const abiertoAqui = (c, modo) => abierto && abierto.id === c.id && abierto.modo === modo;

// Abre «Enviar seguimiento» con ESTE lead ya marcado (lo eligió con el clic).
// Lo usan la tarjeta, «Hoy» y el Perfil; `enviar` lo decide quien pinta
// (masivo.recibeSegLead), porque leads.js no importa masivo.js: ya va al revés.
export const btnEnviarSeg = (clase = "lbtn") =>
  `<button type="button" class="${clase} lsegenv" data-l="enviarSeg">${ICO_ENV}<span>Enviar seguimiento</span></button>`;
export const abrirSegDe = (c, rerender) =>
  import("./envioleads.js").then(m => m.abrirEnvioLeads(rerender, { soloId: c.id }));

// Sección «Seguimiento» dentro de la tarjeta abierta del lead.
export function seguimientoHTML(c, { enviar = false } = {}) {
  const mio = esMio(c);
  const pasos = [];
  if (c.registroEn) pasos.push(`<div class="lpaso ok">✓ Creó cuenta en <b>${esc(nombreBroker(c.registroBroker))}</b> · ${cuandoTxt(c.registroEn)}
    ${mio && !c.promesaEn ? `<button class="llink" data-l="undoRegistro">Deshacer</button>` : ""}</div>`);
  if (c.promesaEn) pasos.push(`<div class="lpaso ok">✓ Prometió depositar <b>${cuandoHora(c.promesaEn)}</b>
    ${mio ? `<button class="llink" data-l="undoPromesa">Deshacer</button>` : ""}</div>`);

  let accion = "";
  if (mio) {
    if (!c.registroEn) accion = abiertoAqui(c, "registro") ? form(c) : `<button class="btn-oro" data-l="registro">Creó cuenta en el broker</button>`;
    else if (!c.promesaEn) accion = abiertoAqui(c, "promesa") ? form(c) : `<button class="btn-oro" data-l="promesa">Prometió depositar</button>`;
    else accion = abiertoAqui(c, "deposito") || abiertoAqui(c, "promesa") ? form(c)
      : `<div class="lacc"><button class="btn-oro" data-l="deposito">Depositó</button><button class="lbtn" data-l="promesa">Reagendar</button></div>`;
  }

  const cs = contactosDe(c).slice(0, 4);
  const pls = plantillasDe(c);
  const filas = cs.map((x, i) => `<div class="lcon">
      <div class="lcon1"><b>${nombreTipo(x.tipo)}</b> · ${cuandoTxt(x.en)} ${horaTxt(x.en)}
        ${mio && i === 0 && !x.respuesta ? `<button class="llink" data-l="borrarCon" data-v="${x.id}">Deshacer</button>` : ""}</div>
      ${x.nota ? `<div class="lnota">${esc(x.nota)}</div>` : ""}
      ${x.respuesta ? `<div class="lresp ${x.respuesta}">${x.respuesta === "si" ? "✓ Respondió" : "No respondió"} · ${cuandoTxt(x.respuesta_en)}
          ${mio ? `<button class="llink" data-l="limpiarResp" data-v="${x.id}">Cambiar</button>` : ""}</div>`
        : respondioAuto(c, x) ? `<div class="lresp si" title="Te escribió por WhatsApp después de este contacto">✓ Respondió · ${cuandoTxt(respondioAuto(c, x))} ${horaTxt(respondioAuto(c, x))} · automático</div>`
        : mio ? `<div class="lacc"><button class="lbtn" data-l="resp" data-v="${x.id}" data-r="si">Me respondió</button><button class="lbtn" data-l="resp" data-v="${x.id}" data-r="no">No respondió</button></div>` : `<div class="lresp">Esperando respuesta</div>`}
    </div>`).join("");

  return `<div class="lseg">
      <div class="lsech"><span class="lsect">Seguimiento</span>${chipTemp(c)}
        ${mio ? `<button class="llink" data-l="temp">Corregir</button>` : ""}</div>
      ${abiertoAqui(c, "temp") ? form(c) : ""}
      <div class="lwhy">${razon(c)}</div>
      ${pasos.join("")}${accion}
      ${pls.length ? `<div class="lsech sub"><span class="lsect">Plantillas enviadas</span><span class="lcnt">${pls.length}</span></div>
      <div class="lplants">${pls.map(x => `<span class="lplant ${x.recibida ? "" : "prog"}"><span>${x.recibida ? "✓" : "⏱"}</span><span><b>${esc(x.nombre)}</b>${x.veces > 1 ? ` ×${x.veces}` : ""} <i>${marcaPlantilla(x)}</i></span></span>`).join("")}</div>` : ""}
      <div class="lsech sub"><span class="lsect">Contactos</span><span class="lcnt">${contactosDe(c).length}</span></div>
      ${mio ? (abiertoAqui(c, "contacto") ? form(c) : `<div class="lacc">${enviar ? btnEnviarSeg() : ""}<button class="lbtn" data-l="contacto">+ Registrar contacto</button></div>`) : ""}
      ${filas || `<div class="lvacio">Todavía no hay contactos.</div>`}
    </div>`;
}

// Promesa en hora Colombia (UTC-5 fijo, sin horario de verano, igual que hoyISO).
const promesaISO = (f, h) => h ? `${f}T${h}:00-05:00` : `${f}T00:00:01-05:00`;
const primer = c => c.nombre.split(" ")[0];

export function wireSeguimiento(card, c, rerender) {
  const raiz = card.querySelector(".lseg");
  if (raiz) manejarLead(raiz, c, rerender);
}

// Las acciones son las mismas en la tarjeta y en el panel «Hoy»: un solo
// manejador para que las dos vistas no puedan comportarse distinto.
export function manejarLead(raiz, c, rerender) {
  raiz.onclick = async e => {
    const b = e.target.closest("[data-l]"); if (!b) return;
    e.stopPropagation();
    const a = b.dataset.l, v = b.dataset.v;
    const listo = () => rerender(c.id);

    if (["registro", "promesa", "deposito", "contacto", "temp"].includes(a)) {
      abierto = abiertoAqui(c, a) ? null : { id: c.id, modo: a }; return listo();
    }
    if (a === "enviarSeg") return abrirSegDe(c, listo);
    if (a === "cancel") { abierto = null; return listo(); }
    if (a === "brk") { abierto.brk = v; return listo(); }
    if (a === "tipo") { abierto.tipo = v; abierto.nota = raiz.querySelector("#lNota")?.value || ""; return listo(); }

    if (a === "okRegistro") {
      const f = raiz.querySelector("#lFecha").value; if (!f) return toast("Falta la fecha");
      const brk = abierto.brk || BROKERS[0].id;
      if (await dbPatch(c, { registro_broker: brk, registro_en: f })) {
        Object.assign(c, { registroBroker: brk, registroEn: f }); abierto = null;
        toast(`✓ ${primer(c)} pasó a Registrados`);
      }
      return listo();
    }
    if (a === "okPromesa") {
      const f = raiz.querySelector("#lFecha").value, h = raiz.querySelector("#lHora").value;
      if (!f) return toast("Falta la fecha");
      const ts = promesaISO(f, h);
      if (await dbPatch(c, { promesa_en: ts })) {
        c.promesaEn = ts; abierto = null; toast(`✓ ${primer(c)} pasó a Pendientes`);
      }
      return listo();
    }
    if (a === "okDeposito") {
      const f = raiz.querySelector("#lFecha").value; if (!f) return toast("Falta la fecha");
      const brk = abierto.brk || c.promesaBroker || c.registroBroker || BROKERS[0].id;
      const nuevo = c.mem === "Lead";
      // El FTD se SUMA al mapa (no se reemplaza): quien ya es Beca puede depositar
      // en un 2º broker sin perder el primero. Y la promesa se limpia (con su
      // broker) para que salga de Pendientes. Un lead, además, pasa a Beca.
      const ftds = { ...c.ftds, [brk]: f };
      const campos = { ftds, promesa_en: null, promesa_broker: null };
      if (nuevo) campos.membresia = "Beca";
      if (await dbPatch(c, campos)) {
        // comunidad_desde lo recalcula el trigger (FTD más antiguo): en un 2º
        // depósito no cambia; en el 1º es la fecha nueva. Se replica local.
        const comunidadDesde = Object.values(ftds).filter(Boolean).sort()[0] || f;
        Object.assign(c, { mem: nuevo ? "Beca" : c.mem, ftds, comunidadDesde,
          promesaEn: null, promesaBroker: null });
        abierto = null;
        // FTD nuevo: si el agente declaró sus números del mes, se suma (sea 1º o 2º).
        await (await import("./ftd.js")).ajustarDeclarado(c, +1);
        toast(nuevo ? `✓ ${primer(c)}: FTD registrado, pasó a Beca`
                    : `✓ ${primer(c)}: 2º FTD en ${nombreBroker(brk)} registrado`);
      }
      return listo();
    }
    if (a === "undoRegistro") {
      if (!confirm(`¿Deshacer «creó cuenta» de ${c.nombre}?`)) return;
      if (await dbPatch(c, { registro_broker: null, registro_en: null })) Object.assign(c, { registroBroker: null, registroEn: null });
      return listo();
    }
    if (a === "undoPromesa") {
      if (!confirm(`¿Deshacer la promesa de depósito de ${c.nombre}?`)) return;
      if (await dbPatch(c, { promesa_en: null, promesa_broker: null }))
        Object.assign(c, { promesaEn: null, promesaBroker: null });
      return listo();
    }
    if (a === "setTemp") {
      const ts = new Date().toISOString();
      const campos = v ? { temp_manual: v, temp_manual_en: ts } : { temp_manual: null, temp_manual_en: null };
      if (await dbPatch(c, campos)) { c.tempManual = v || null; c.tempManualEn = v ? ts : null; abierto = null; }
      toast(v ? `✓ ${primer(c)}: ${TEMP[v].toLowerCase()} a mano` : `✓ ${primer(c)}: temperatura automática`);
      return listo();
    }
    if (a === "okContacto") {
      const nota = raiz.querySelector("#lNota").value.trim();
      const nuevo = await crearContacto(c.id, abierto.tipo, nota);
      if (nuevo) { (state.contactos[c.id] ||= []).unshift(nuevo); abierto = null; toast(`✓ Contacto con ${primer(c)} registrado`); }
      return listo();
    }
    if (a === "resp") {
      const ts = new Date().toISOString();
      const x = contactosDe(c).find(y => y.id === v);
      if (x && await actualizarContacto(v, { respuesta: b.dataset.r, respuesta_en: ts })) {
        x.respuesta = b.dataset.r; x.respuesta_en = ts;
        toast(b.dataset.r === "si" ? `✓ ${primer(c)} te respondió` : `✓ Anotado: ${primer(c)} no respondió`);
      }
      return listo();
    }
    if (a === "limpiarResp") {
      const x = contactosDe(c).find(y => y.id === v);
      if (x && await actualizarContacto(v, { respuesta: null, respuesta_en: null })) { x.respuesta = null; x.respuesta_en = null; }
      return listo();
    }
    if (a === "borrarCon") {
      if (!confirm("¿Borrar este contacto?")) return;
      if (await borrarContacto(v)) state.contactos[c.id] = contactosDe(c).filter(y => y.id !== v);
      return listo();
    }
  };
  // Escribir la nota no debe re-pintar ni cerrar la tarjeta.
  raiz.querySelectorAll("input, textarea").forEach(el => el.onclick = e => e.stopPropagation());
}
