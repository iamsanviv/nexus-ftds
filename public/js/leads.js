// Seguimiento de leads: temperatura, categoría de prioridad, embudo hacia la
// beca (abrió cuenta → prometió depositar → depositó) y registro de contactos.
//
// Las reglas viven aquí y no en la vista porque el panel «Hoy» (F3) las usa
// igual: la lista y el panel tienen que decir la misma temperatura.
import { state, esc, fmtF, hoyISO, fechaCO, toast, BROKERS, nombreBroker } from "./state.js";
import { dbPatch, crearContacto, actualizarContacto, borrarContacto } from "./data.js";

export const TIPOS = [
  ["objecion", "Resolver objeción"], ["prueba_social", "Prueba social"],
  ["valor", "Agregar valor"], ["fidelizacion", "Fidelización"],
  ["novedad", "Por novedad"], ["otro", "Saludar / otro"],
];
const nombreTipo = t => (TIPOS.find(x => x[0] === t) || [, t])[1];
export const TEMP = { caliente: "Caliente", tibio: "Tibio", frio: "Frío" };

/* ---------------------------------------------------------------- fechas */
// Días de calendario (Colombia) entre una fecha y hoy: 0 = hoy, 1 = ayer.
const diaDe = v => !v ? null : (v.length === 10 ? v : fechaCO(new Date(v)));
const dias = v => {
  const d = diaDe(v); if (!d) return null;
  const a = Date.UTC(...d.split("-").map((n, i) => i === 1 ? n - 1 : +n));
  const h = Date.UTC(...hoyISO().split("-").map((n, i) => i === 1 ? n - 1 : +n));
  return Math.round((h - a) / 864e5);
};
const HORA_CO = new Intl.DateTimeFormat("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit", hour12: true });
const horaTxt = ts => HORA_CO.format(new Date(ts)).replace(/\s/g, " ").replace("a. m.", "am").replace("p. m.", "pm");
const cuandoTxt = v => {
  const d = dias(v);
  return d === 0 ? "hoy" : d === 1 ? "ayer" : d === -1 ? "mañana" : d > 1 ? `hace ${d} días` : `el ${fmtF(diaDe(v))}`;
};
// Fecha de llegada: la que puso el agente o, si no la puso, cuándo se creó.
const llegada = c => c.creado || (c.createdAt ? fechaCO(new Date(c.createdAt)) : null);

/* ------------------------------------------------------------- contactos */
export const contactosDe = c => state.contactos?.[c.id] || [];   // más reciente primero
const ultimoSi = c => contactosDe(c).find(x => x.respuesta === "si");

/* ----------------------------------------------------------- temperatura */
// Reglas acordadas con el usuario (05/10/2026):
//  · pendiente con fecha de hoy o futura: caliente; vencido 1–2 días: tibio; 3+: frío
//  · te respondió hoy: caliente; hace 1–2 días: tibio; 3+: frío
//  · sin contactar: según cuándo llegó (hoy caliente, 1–2 tibio, 3+ frío)
//  · contactado y sin respuesta: tibio (aunque haya llegado hoy); 3+ días: frío
//  · abrir cuenta cuenta como una respuesta: un registrado de ayer no es «frío»
//    solo porque llegó hace una semana.
const porDias = (d, hoyEs = "caliente") => d <= 0 ? hoyEs : d <= 2 ? "tibio" : "frio";
export function tempAuto(c) {
  if (c.promesaEn) return porDias(dias(c.promesaEn));
  const si = ultimoSi(c);
  const senal = [si && dias(si.respuesta_en), c.registroEn && dias(c.registroEn)].filter(d => d != null);
  if (senal.length) return porDias(Math.min(...senal));
  const cs = contactosDe(c);
  if (!cs.length) return porDias(dias(llegada(c)) ?? 99);
  return porDias(dias(cs[cs.length - 1].en), "tibio");
}
// La corrección a mano vale hasta el siguiente contacto.
export function manualVigente(c) {
  if (!c.tempManual) return false;
  const ult = contactosDe(c)[0];
  return !ult || new Date(c.tempManualEn) > new Date(ult.en);
}
export const temperatura = c => manualVigente(c) ? c.tempManual : tempAuto(c);

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
  const si = ultimoSi(c);
  if (si && dias(si.respuesta_en) === 0) return "bajo";   // hasta F4: «te respondió hoy»
  if (dl === 1) return "ayer";
  return "resto";
}

// Por qué tiene esa temperatura, en una línea.
export function razon(c) {
  if (c.promesaEn) {
    const d = dias(c.promesaEn);
    return `Prometió <b>${cuandoTxt(c.promesaEn)} ${horaTxt(c.promesaEn)}</b>${d > 0 ? " y no depositó" : ""}`;
  }
  if (c.registroEn) return `Abrió cuenta en ${esc(nombreBroker(c.registroBroker))} <b>${cuandoTxt(c.registroEn)}</b>`;
  const si = ultimoSi(c);
  if (si) return `Te respondió <b>${cuandoTxt(si.respuesta_en)}</b>`;
  const cs = contactosDe(c);
  if (cs.length) return `Sin respuesta desde <b>${cuandoTxt(cs[cs.length - 1].en)}</b>`;
  const l = llegada(c);
  return l ? `Llegó <b>${cuandoTxt(l)}</b> · sin contactar` : "Sin contactar";
}

/* ----------------------------------------------------------------- vista */
export const chipTemp = c => {
  const t = temperatura(c);
  return `<span class="ltemp ${t}"><i></i>${TEMP[t]}${manualVigente(c) ? " · a mano" : ""}</span>`;
};

// Formulario abierto, uno a la vez: { id, modo }.
let abierto = null;
const esMio = c => c.owner_id === state.me?.id;

function form(c) {
  const hoy = hoyISO();
  if (abierto.modo === "registro") {
    const sel = abierto.brk || BROKERS[0].id;
    return `<div class="lform"><div class="lft">¿En qué broker abrió cuenta?</div>
      <div class="lchips">${BROKERS.map(b => `<button class="lchip ${sel === b.id ? "on" : ""}" data-l="brk" data-v="${b.id}">${esc(b.n)}</button>`).join("")}</div>
      <label class="lfl">Fecha <input type="date" id="lFecha" value="${hoy}" max="${hoy}"></label>
      <div class="lacc"><button class="btn-oro" data-l="okRegistro">Confirmar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "promesa") {
    return `<div class="lform"><div class="lft">¿Cuándo dijo que deposita?</div>
      <div class="lfila"><input type="date" id="lFecha" value="${hoy}" min="${hoy}"><input type="time" id="lHora" value="18:00"></div>
      <div class="lacc"><button class="btn-oro" data-l="okPromesa">Confirmar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "deposito") {
    const sel = abierto.brk || c.registroBroker || BROKERS[0].id;
    return `<div class="lform"><div class="lft">Registrar el FTD — pasa a Beca</div>
      <div class="lchips">${BROKERS.map(b => `<button class="lchip ${sel === b.id ? "on" : ""}" data-l="brk" data-v="${b.id}">${esc(b.n)}</button>`).join("")}</div>
      <label class="lfl">Fecha del depósito <input type="date" id="lFecha" value="${hoy}" max="${hoy}"></label>
      <div class="lacc"><button class="btn-oro" data-l="okDeposito">Confirmar depósito</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "contacto") {
    return `<div class="lform"><div class="lft">¿Para qué le escribiste?</div>
      <div class="lchips">${TIPOS.map(([k, n]) => `<button class="lchip ${abierto.tipo === k ? "on" : ""}" data-l="tipo" data-v="${k}">${n}</button>`).join("")}</div>
      <textarea id="lNota" rows="2" maxlength="2000" placeholder="Nota (opcional)">${esc(abierto.nota || "")}</textarea>
      <div class="lacc"><button class="btn-oro" data-l="okContacto" ${abierto.tipo ? "" : "disabled"}>Guardar</button><button class="lbtn" data-l="cancel">Cancelar</button></div></div>`;
  }
  if (abierto.modo === "temp") {
    return `<div class="lform"><div class="lft">Corregir temperatura (vale hasta el próximo contacto)</div>
      <div class="lchips">${Object.entries(TEMP).map(([k, n]) => `<button class="lchip" data-l="setTemp" data-v="${k}">${n}</button>`).join("")}
      <button class="lchip" data-l="setTemp" data-v="">Automática</button></div></div>`;
  }
  return "";
}
const abiertoAqui = (c, modo) => abierto && abierto.id === c.id && abierto.modo === modo;

// Sección «Seguimiento» dentro de la tarjeta abierta del lead.
export function seguimientoHTML(c) {
  const mio = esMio(c);
  const pasos = [];
  if (c.registroEn) pasos.push(`<div class="lpaso ok">✓ Abrió cuenta en <b>${esc(nombreBroker(c.registroBroker))}</b> · ${cuandoTxt(c.registroEn)}
    ${mio && !c.promesaEn ? `<button class="llink" data-l="undoRegistro">Deshacer</button>` : ""}</div>`);
  if (c.promesaEn) pasos.push(`<div class="lpaso ok">✓ Prometió depositar <b>${cuandoTxt(c.promesaEn)} ${horaTxt(c.promesaEn)}</b>
    ${mio ? `<button class="llink" data-l="undoPromesa">Deshacer</button>` : ""}</div>`);

  let accion = "";
  if (mio) {
    if (!c.registroEn) accion = abiertoAqui(c, "registro") ? form(c) : `<button class="btn-oro" data-l="registro">Abrió cuenta en el broker</button>`;
    else if (!c.promesaEn) accion = abiertoAqui(c, "promesa") ? form(c) : `<button class="btn-oro" data-l="promesa">Prometió depositar</button>`;
    else accion = abiertoAqui(c, "deposito") || abiertoAqui(c, "promesa") ? form(c)
      : `<div class="lacc"><button class="btn-oro" data-l="deposito">Depositó</button><button class="lbtn" data-l="promesa">Reagendar</button></div>`;
  }

  const cs = contactosDe(c).slice(0, 4);
  const filas = cs.map((x, i) => `<div class="lcon">
      <div class="lcon1"><b>${nombreTipo(x.tipo)}</b> · ${cuandoTxt(x.en)} ${horaTxt(x.en)}
        ${mio && i === 0 && !x.respuesta ? `<button class="llink" data-l="borrarCon" data-v="${x.id}">Deshacer</button>` : ""}</div>
      ${x.nota ? `<div class="lnota">${esc(x.nota)}</div>` : ""}
      ${x.respuesta ? `<div class="lresp ${x.respuesta}">${x.respuesta === "si" ? "✓ Respondió" : "No respondió"} · ${cuandoTxt(x.respuesta_en)}
          ${mio ? `<button class="llink" data-l="limpiarResp" data-v="${x.id}">Cambiar</button>` : ""}</div>`
        : mio ? `<div class="lacc"><button class="lbtn" data-l="resp" data-v="${x.id}" data-r="si">Me respondió</button><button class="lbtn" data-l="resp" data-v="${x.id}" data-r="no">No respondió</button></div>` : `<div class="lresp">Esperando respuesta</div>`}
    </div>`).join("");

  return `<div class="lseg">
      <div class="lsech"><span class="lsect">Seguimiento</span>${chipTemp(c)}
        ${mio ? `<button class="llink" data-l="temp">Corregir</button>` : ""}</div>
      ${abiertoAqui(c, "temp") ? form(c) : ""}
      <div class="lwhy">${razon(c)}</div>
      ${pasos.join("")}${accion}
      <div class="lsech sub"><span class="lsect">Contactos</span><span class="lcnt">${contactosDe(c).length}</span></div>
      ${mio ? (abiertoAqui(c, "contacto") ? form(c) : `<button class="lbtn ancho" data-l="contacto">+ Registrar contacto</button>`) : ""}
      ${filas || `<div class="lvacio">Todavía no hay contactos.</div>`}
    </div>`;
}

// Promesa en hora Colombia (UTC-5 fijo, sin horario de verano, igual que hoyISO).
const promesaISO = (f, h) => `${f}T${h}:00-05:00`;
const primer = c => c.nombre.split(" ")[0];

export function wireSeguimiento(card, c, rerender) {
  const raiz = card.querySelector(".lseg");
  if (!raiz) return;
  raiz.onclick = async e => {
    const b = e.target.closest("[data-l]"); if (!b) return;
    e.stopPropagation();
    const a = b.dataset.l, v = b.dataset.v;
    const listo = () => rerender(c.id);

    if (["registro", "promesa", "deposito", "contacto", "temp"].includes(a)) {
      abierto = abiertoAqui(c, a) ? null : { id: c.id, modo: a }; return listo();
    }
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
      if (!f || !h) return toast("Falta la fecha o la hora");
      const ts = promesaISO(f, h);
      if (await dbPatch(c, { promesa_en: ts })) {
        c.promesaEn = ts; abierto = null; toast(`✓ ${primer(c)} pasó a Pendientes`);
      }
      return listo();
    }
    if (a === "okDeposito") {
      const f = raiz.querySelector("#lFecha").value; if (!f) return toast("Falta la fecha");
      const brk = abierto.brk || c.registroBroker || BROKERS[0].id;
      const ftds = { [brk]: f };
      if (await dbPatch(c, { membresia: "Beca", ftds })) {
        Object.assign(c, { mem: "Beca", ftds, comunidadDesde: f }); abierto = null;
        // El FTD es nuevo: si el agente declaró sus números del mes, se suman.
        await (await import("./ftd.js")).ajustarDeclarado(c, +1);
        toast(`✓ ${primer(c)}: FTD registrado, pasó a Beca`);
      }
      return listo();
    }
    if (a === "undoRegistro") {
      if (!confirm(`¿Deshacer «abrió cuenta» de ${c.nombre}?`)) return;
      if (await dbPatch(c, { registro_broker: null, registro_en: null })) Object.assign(c, { registroBroker: null, registroEn: null });
      return listo();
    }
    if (a === "undoPromesa") {
      if (!confirm(`¿Deshacer la promesa de depósito de ${c.nombre}?`)) return;
      if (await dbPatch(c, { promesa_en: null })) c.promesaEn = null;
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
