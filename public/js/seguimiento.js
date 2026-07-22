// Seguimiento automatizado (vista propia): se crean "actividades del día"
// (servicio + hora + enlace), se pueden editar/eliminar, y desde cada una
// se programan los mensajes de WhatsApp para quienes les falta.
// Las plantillas de mensajes son editables por agente (tabla plantillas_seguimiento).
// Tablas: actividades, seguimientos, mensajes_programados, plantillas_seguimiento.
import { SB } from "./supabase.js";
import { state, $, esc, toast, todos, hoyISO } from "./state.js";
import { render } from "./ui.js";

/* ---------- plantillas ---------- */
// Tipos de mensaje programado (5 por persona). NO incluye invitacion_extra:
// esa es una variante de texto de la invitación, no un tipo aparte.
const TIPOS = ["invitacion", "rec_60", "rec_15", "enlace", "confirmacion"];
// Claves de plantilla editables (incluye la invitación extra).
const CLAVES_TPL = ["invitacion", "invitacion_extra", "rec_60", "rec_15", "enlace", "confirmacion"];

// Plantillas por defecto. Etiquetas: {nombre} {actividad} {hora} {enlace}
const PLANTILLAS_DEF = {
  invitacion:       `¡Hola {nombre}! 👋 Hoy tenemos *{actividad}* a las {hora} (hora Colombia). ¡Te esperamos! ¿Cuento contigo?`,
  // Se usa cuando la persona YA recibió una invitación hoy (otra actividad): sin saludo.
  invitacion_extra: `Y hoy también tienes *{actividad}* a las {hora} (hora Colombia). ¡Ahí te espero! 🙌`,
  rec_60:           `{nombre}, te recuerdo que en 1 hora empieza *{actividad}* ({hora}). ¡Ve preparándote! 🙌`,
  rec_15:           `¡{nombre}, en 15 minutos arrancamos *{actividad}*! 🔥`,
  enlace:           `¡{nombre}, ya empezamos! Este es el enlace para entrar 👉 {enlace}`,
  confirmacion:     `{nombre}, ¿ya lograste entrar a la sala? Si tuviste algún problema, escríbeme y te ayudo 🙏`,
};

let plantillasUsuario = { ...PLANTILLAS_DEF };  // se sobreescribe al cargar

const horaCO = iso => new Date(iso).toLocaleTimeString("es-CO",
  { hour: "numeric", minute: "2-digit", hour12: true });

const fechaHoraCO = iso => new Date(iso).toLocaleString("es-CO",
  { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });

// Reemplaza las etiquetas de una plantilla con los datos reales.
function aplicar(tpl, { nombre, actividad, hora, enlace }) {
  return (tpl || "")
    .replaceAll("{nombre}", nombre)
    .replaceAll("{actividad}", actividad)
    .replaceAll("{hora}", hora)
    .replaceAll("{enlace}", enlace);
}

// yaInvitado: si la persona ya recibió una invitación hoy, la invitación de
// esta actividad usa la variante "extra" (sin saludo) para no repetir el hola.
// El mensaje de "enlace" conserva el token {enlace} sin resolver: el worker pone
// el enlace vigente al enviar (así se puede agregar/cambiar después de programar).
function plantillas(nombre, actividad, inicioISO, enlace, yaInvitado) {
  const base = { nombre: nombre.trim().split(/\s+/)[0], actividad, hora: horaCO(inicioISO) };
  const out = {};
  for (const t of TIPOS) {
    const clave = (t === "invitacion" && yaInvitado) ? "invitacion_extra" : t;
    const linkVal = t === "enlace" ? "{enlace}" : (enlace || "");   // enlace: token; resto: resuelto
    out[t] = aplicar(plantillasUsuario[clave] || PLANTILLAS_DEF[clave], { ...base, enlace: linkVal });
  }
  return out;
}

/* ---------- estado local de la vista ---------- */
let actividades = [];         // actividades activas cargadas
let actSel = null;            // actividad elegida para programar
let actEdit = null;           // actividad en edición en el formulario
let segSel = new Set();       // ids de clientes seleccionados para programar
let segFiltroMem = "todos";   // filtro de membresía en el selector
let segBuscarTxt = "";        // texto de búsqueda por nombre en el selector
let segIncAsis = false;       // incluir a quienes ya asistieron (para reinvitar)
let segInvitarTarde = null;   // Date para diferir la invitación, o null = ahora
let logFiltro = "todos";      // filtro del registro de envíos

const MEMS = ["Beca", "VIP", "Platino", "Oro", "Lead"];
const esLeadMem = m => m === "Lead";

/* ================= PLANTILLAS (editor) ================= */
async function cargarPlantillas() {
  const { data, error } = await SB.from("plantillas_seguimiento")
    .select("data").eq("owner_id", state.me.id).maybeSingle();
  plantillasUsuario = { ...PLANTILLAS_DEF };
  if (!error && data && data.data) {
    for (const t of CLAVES_TPL) if (typeof data.data[t] === "string" && data.data[t].trim()) plantillasUsuario[t] = data.data[t];
  }
  volcarPlantillasAlForm();
}

function volcarPlantillasAlForm() {
  for (const t of CLAVES_TPL) { const el = $("tpl_" + t); if (el) el.value = plantillasUsuario[t]; }
}

async function guardarPlantillas() {
  const nuevas = {};
  for (const t of CLAVES_TPL) nuevas[t] = ($("tpl_" + t).value || "").trim() || PLANTILLAS_DEF[t];
  const btn = $("segMsgsGuardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const { error } = await SB.from("plantillas_seguimiento")
      .upsert({ owner_id: state.me.id, data: nuevas, updated_at: new Date().toISOString() }, { onConflict: "owner_id" });
    if (error) throw error;
    plantillasUsuario = { ...PLANTILLAS_DEF, ...nuevas };
    volcarPlantillasAlForm();
    toast("✓ Mensajes guardados");
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Guardar mensajes";
  }
}

function resetPlantillas() {
  for (const t of CLAVES_TPL) { const el = $("tpl_" + t); if (el) el.value = PLANTILLAS_DEF[t]; }
  toast("Restaurado. Toca «Guardar mensajes» para aplicar.");
}

/* ================= FORMULARIO crear / editar actividad ================= */
const pad = n => String(n).padStart(2, "0");

function renderForm() {
  const sel = $("segSrv");
  sel.innerHTML = state.catalogo.map(g => `<optgroup label="${esc(g.g)}">` +
    g.items.map(s => `<option value="${s.id}">${esc(s.n)}</option>`).join("") +
    `</optgroup>`).join("");
  $("segFecha").value = hoyISO();
  $("segHora").value = "";
  $("segLink").value = "";
}

function entrarEdicion(a) {
  actEdit = a;
  const d = new Date(a.inicio);
  if ([...$("segSrv").options].some(o => o.value === a.servicio_id)) $("segSrv").value = a.servicio_id;
  $("segFecha").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $("segHora").value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("segLink").value = a.enlace;
  $("segFormTitulo").textContent = `✎ Editando «${a.nombre}»`;
  $("segCrearAct").textContent = "Guardar cambios";
  $("segCancelEdit").classList.remove("hidden");
  $("segFormTitulo").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function salirEdicion() {
  actEdit = null;
  $("segFormTitulo").textContent = "➕ Crear actividad del día";
  $("segCrearAct").textContent = "Guardar actividad";
  $("segCancelEdit").classList.add("hidden");
  renderForm();
}

async function guardarActividad() {
  const sid = $("segSrv").value;
  const srv = todos().find(s => s.id === sid);
  const fecha = $("segFecha").value, hora = $("segHora").value;
  const enlace = $("segLink").value.trim();
  if (!srv) { toast("Elige una actividad"); return; }
  if (!fecha || !hora) { toast("Falta la fecha o la hora"); return; }
  // El enlace es OPCIONAL: se puede agregar/editar después, antes de que salga
  // el mensaje del enlace.

  const inicio = new Date(`${fecha}T${hora}:00`);   // hora local = Colombia
  if (isNaN(inicio)) { toast("Fecha/hora inválida"); return; }
  if (inicio <= new Date()) { toast("La actividad debe ser en el futuro"); return; }

  const btn = $("segCrearAct");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const datos = { servicio_id: sid, nombre: srv.n, inicio: inicio.toISOString(), enlace };
    if (actEdit) {
      const { error } = await SB.from("actividades").update(datos).eq("id", actEdit.id);
      if (error) throw error;
      // Propaga el enlace nuevo a los mensajes de "enlace" aún pendientes de los
      // seguimientos activos de esta actividad (por eso el link no se congela).
      const { data: segs } = await SB.from("seguimientos")
        .select("id").eq("actividad_id", actEdit.id).eq("estado", "activo");
      const ids = (segs || []).map(s => s.id);
      if (ids.length) {
        await SB.from("mensajes_programados")
          .update({ enlace_url: enlace || null })
          .in("seguimiento_id", ids).eq("tipo", "enlace").eq("estado", "pendiente");
      }
      toast(enlace
        ? "✓ Actividad actualizada · enlace aplicado a los mensajes pendientes"
        : "✓ Actividad actualizada");
      if (actSel && actSel.id === actEdit.id) ocultarProg();
      salirEdicion();
    } else {
      const { error } = await SB.from("actividades").insert(datos);
      if (error) throw error;
      toast(`✓ Actividad «${srv.n}» creada`);
      $("segLink").value = "";
    }
    await cargarActividades();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = actEdit ? "Guardar cambios" : "Guardar actividad";
  }
}

/* ================= LISTA de actividades ================= */
async function cargarActividades() {
  const { data, error } = await SB.from("actividades")
    .select("id, servicio_id, nombre, inicio, enlace, estado")
    .eq("estado", "activa")
    .order("inicio", { ascending: true });
  if (error) {
    $("segActividades").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`;
    return;
  }
  // Las actividades de días pasados se cierran y desaparecen de la vista.
  const inicioHoy = new Date(); inicioHoy.setHours(0, 0, 0, 0);
  const pasadas = (data || []).filter(a => new Date(a.inicio) < inicioHoy);
  if (pasadas.length) {
    await SB.from("actividades").update({ estado: "cerrada" }).in("id", pasadas.map(a => a.id));
  }
  actividades = (data || []).filter(a => new Date(a.inicio) >= inicioHoy);
  if (!actividades.length) {
    $("segActividades").innerHTML = `<div class="naplica">No hay actividades para hoy. Crea una arriba.</div>`;
    return;
  }
  $("segActividades").innerHTML = actividades.map(a => `
    <div class="seg-row">
      <span>${esc(a.nombre)}<span class="sfecha">${fechaHoraCO(a.inicio)}</span>${a.enlace ? "" : `<span class="sinlink">⚠ sin enlace</span>`}</span>
      <span class="pr">
        <button class="pmark" data-prog="${a.id}">📨 Programar</button>
        <button class="pmark" data-edit="${a.id}" title="Editar actividad">✎</button>
        <button class="pmark off" data-delact="${a.id}" title="Eliminar actividad">✕</button>
      </span>
    </div>`).join("");

  $("segActividades").querySelectorAll("[data-prog]").forEach(b => b.onclick = () => {
    const a = actividades.find(x => x.id === b.dataset.prog);
    if (a) seleccionarActividad(a);
  });
  $("segActividades").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const a = actividades.find(x => x.id === b.dataset.edit);
    if (a) entrarEdicion(a);
  });
  $("segActividades").querySelectorAll("[data-delact]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Eliminar esta actividad? (no cancela seguimientos ya programados)")) return;
    const { error } = await SB.from("actividades").delete().eq("id", b.dataset.delact);
    if (error) { toast("⚠ " + error.message); return; }
    if (actSel && actSel.id === b.dataset.delact) ocultarProg();
    if (actEdit && actEdit.id === b.dataset.delact) salirEdicion();
    await cargarActividades();
  });
}

/* ================= SELECCIÓN + PROGRAMACIÓN ================= */
// A quienes les falta la actividad (comportamiento original).
function faltantes(sid) {
  return state.clientes.filter(c => !c.acc[sid] && c.tel);
}

// Universo elegible para programar: los que faltan, y —si el toggle está
// activo— también quienes ya asistieron (para reinvitarlos). Siempre exige tel.
function elegibles(sid) {
  return state.clientes.filter(c => c.tel && (!c.acc[sid] || segIncAsis));
}

function seleccionarActividad(a) {
  actSel = a;
  segFiltroMem = "todos";
  segBuscarTxt = "";
  segIncAsis = false;
  segInvitarTarde = null;
  const bs = $("segBuscar"); if (bs) bs.value = "";
  const bx = $("segBuscarX"); if (bx) bx.classList.add("hidden");
  const ia = $("segIncAsis"); if (ia) ia.checked = false;
  const tr = $("segTardeRow"); if (tr) tr.classList.add("hidden");
  const tt = $("segTardeToggle"); if (tt) tt.classList.remove("on");
  // Por defecto: marcar toda la comunidad que le falta la actividad (no Leads).
  segSel = new Set(faltantes(a.servicio_id).filter(c => !esLeadMem(c.mem)).map(c => c.id));
  $("segProgTitulo").innerHTML = `Programar para <b>${esc(a.nombre)}</b> · ${fechaHoraCO(a.inicio)}`;
  $("segProgBloque").classList.remove("hidden");
  renderSegmentos();
  renderFaltan();
  $("segProgBloque").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function ocultarProg() {
  actSel = null;
  segSel = new Set();
  $("segProgBloque").classList.add("hidden");
  $("segFaltan").innerHTML = "";
  $("segFiltros").innerHTML = "";
  $("segSelCount").textContent = "";
  const seg = $("segSegmentos"); if (seg) seg.innerHTML = "";
  const bs = $("segBuscar"); if (bs) bs.value = "";
  segBuscarTxt = "";
}

function renderFaltan() {
  if (!actSel) return;
  const sid = actSel.servicio_id;
  const lista = elegibles(sid);
  const sinTel = state.clientes.filter(c => (!c.acc[sid] || segIncAsis) && !c.tel).length;

  // Chips de filtro: "Todos" + solo las membresías presentes en la lista.
  const presentes = MEMS.filter(m => lista.some(c => c.mem === m));
  const chips = [["todos", `Todos (${lista.length})`]].concat(
    presentes.map(m => [m, `${m} (${lista.filter(c => c.mem === m).length})`]));
  $("segFiltros").innerHTML = chips.map(([v, l]) =>
    `<button class="pill ${segFiltroMem === v ? 'on' : ''}" data-fmem="${v}">${l}</button>`).join("");
  $("segFiltros").querySelectorAll("[data-fmem]").forEach(b => b.onclick = () => {
    segFiltroMem = b.dataset.fmem; renderFaltan();
  });

  // Filtro combinado: membresía + búsqueda por nombre.
  const q = segBuscarTxt.trim().toLowerCase();
  const visibles = lista.filter(c =>
    (segFiltroMem === "todos" || c.mem === segFiltroMem) &&
    (!q || c.nombre.toLowerCase().includes(q)));

  $("segFaltan").innerHTML = visibles.length
    ? visibles.map(c => `
        <label class="seg-row">
          <input type="checkbox" data-cid="${c.id}" ${segSel.has(c.id) ? "checked" : ""}>
          <span class="badge b-${c.mem}">${c.mem}</span>
          <span>${esc(c.nombre)}</span>
          ${c.acc[sid] ? `<span class="yaasis">ya asistió</span>` : ""}
        </label>`).join("")
    : `<div class="naplica">${q ? "Nadie coincide con la búsqueda." : "Nadie en este filtro."}</div>`;
  if (sinTel && segFiltroMem === "todos" && !q) $("segFaltan").insertAdjacentHTML("beforeend",
    `<div class="naplica">${sinTel} persona(s) sin teléfono no aparecen aquí.</div>`);

  $("segFaltan").querySelectorAll("input[data-cid]").forEach(inp => inp.onchange = () => {
    inp.checked ? segSel.add(inp.dataset.cid) : segSel.delete(inp.dataset.cid);
    actualizarConteo();
  });

  // botones marcar/desmarcar actúan sobre lo VISIBLE
  $("segMarcarVis").onclick = () => { visibles.forEach(c => segSel.add(c.id)); renderFaltan(); };
  $("segDesmarcarVis").onclick = () => { visibles.forEach(c => segSel.delete(c.id)); renderFaltan(); };
  actualizarConteo();
}

function actualizarConteo() {
  if (!actSel) return;
  const uni = elegibles(actSel.servicio_id);
  const total = uni.length;
  const sel = uni.filter(c => segSel.has(c.id)).length;
  $("segSelCount").textContent = `${sel} de ${total} seleccionados`;
}

async function programar() {
  if (!actSel) { toast("Elige una actividad primero"); return; }
  const inicio = new Date(actSel.inicio);
  const ahora = new Date();
  if (inicio <= ahora) { toast("Esta actividad ya empezó; crea una nueva"); return; }

  const seleccion = elegibles(actSel.servicio_id).filter(c => segSel.has(c.id));
  if (!seleccion.length) { toast("No hay nadie seleccionado"); return; }

  // Si se difirió la invitación, debe caer entre ahora y el inicio de la actividad.
  if (segInvitarTarde) {
    if (segInvitarTarde <= ahora) { toast("La hora de envío ya pasó; elige una futura"); return; }
    if (segInvitarTarde >= inicio) { toast("La invitación debe salir antes de que empiece la actividad"); return; }
  }

  const btn = $("segProgramar");
  btn.disabled = true; btn.textContent = "Programando…";
  try {
    // 1) un seguimiento por persona (copia los datos de la actividad)
    const segRows = seleccion.map(c => ({
      cliente_id: c.id, actividad_id: actSel.id, actividad: actSel.nombre,
      inicio: actSel.inicio, enlace: actSel.enlace,
    }));
    const { data: segs, error: e1 } = await SB.from("seguimientos").insert(segRows).select("id, cliente_id");
    if (e1) throw e1;

    // ¿Quiénes ya recibieron una invitación HOY (otra actividad)? Para no
    // repetir el saludo, esos usan la invitación "extra" (sin hola).
    const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
    const finDia = new Date(); finDia.setHours(23, 59, 59, 999);
    const tels = [...new Set(seleccion.map(c => c.tel))];
    let yaInvitados = new Set();
    if (tels.length) {
      const { data: previas } = await SB.from("mensajes_programados")
        .select("telefono")
        .eq("tipo", "invitacion")
        .neq("estado", "cancelado")
        .in("telefono", tels)
        .gte("enviar_en", inicioDia.toISOString())
        .lte("enviar_en", finDia.toISOString());
      yaInvitados = new Set((previas || []).map(r => r.telefono));
    }

    // 2) los 5 mensajes por persona (se omiten los que ya quedaron en el pasado)
    // La invitación sale "ahora" salvo que se haya elegido diferirla (más tarde).
    const cuandoInv = (segInvitarTarde && segInvitarTarde > ahora) ? segInvitarTarde : ahora;
    const msgs = [];
    const tiempos = () => ([
      ["invitacion",   cuandoInv],
      ["rec_60",       new Date(inicio.getTime() - 60 * 60000)],
      ["rec_15",       new Date(inicio.getTime() - 15 * 60000)],
      ["enlace",       inicio],
      ["confirmacion", new Date(inicio.getTime() + 10 * 60000)],
    ]);
    for (const seg of segs) {
      const c = seleccion.find(x => x.id === seg.cliente_id);
      const tpl = plantillas(c.nombre, actSel.nombre, actSel.inicio, actSel.enlace, yaInvitados.has(c.tel));
      for (const [tipo, cuando] of tiempos()) {
        if (tipo !== "invitacion" && cuando <= ahora) continue; // ya pasó
        const fila = {
          seguimiento_id: seg.id, tipo, enviar_en: cuando.toISOString(),
          telefono: c.tel, texto: tpl[tipo],
        };
        // La imagen la resuelve el worker al enviar (imagen actual del servicio),
        // así no se congela: solo guardamos de qué servicio es la invitación.
        if (tipo === "invitacion") fila.servicio_id = actSel.servicio_id;
        // El enlace se resuelve al enviar (el texto conserva el token {enlace}).
        if (tipo === "enlace") fila.enlace_url = actSel.enlace || null;
        msgs.push(fila);
      }
    }
    const { error: e2 } = await SB.from("mensajes_programados").insert(msgs);
    if (e2) throw e2;

    // Marca a los seleccionados como "invitados" al servicio (si no lo estaban),
    // así pasan de «por invitar» a «invitados» en la vista por servicio.
    // NO se toca `acc`: quien ya asistió y es reinvitado conserva su asistencia.
    const hoy = hoyISO();
    for (const c of seleccion) {
      if (!(c.conf || {})[actSel.servicio_id]) {
        c.conf = { ...(c.conf || {}), [actSel.servicio_id]: hoy };
        await SB.from("clientes").update({ conf: c.conf }).eq("id", c.id);
      }
    }

    // Guarda la selección en el historial de segmentos (automático).
    await guardarSegmentoHistorial(seleccion.map(c => c.id), actSel.nombre);

    const notaTarde = (segInvitarTarde && segInvitarTarde > ahora)
      ? ` · invitación sale ${fechaHoraCO(cuandoInv.toISOString())}` : "";
    toast(`✓ ${segs.length} seguimiento(s) · ${msgs.length} mensaje(s) programado(s)${notaTarde}`);
    ocultarProg();
    renderActivos();
    renderLogs();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Programar mensajes";
  }
}

/* ================= SEGMENTOS (historial + guardados) ================= */
// Se guardan en la tabla `segmentos` (owner_id, nombre, definicion jsonb).
// definicion = { tipo:"historial"|"guardado", cliente_ids:[...], actividad:"..." }
// El historial es automático y rota (se conservan los N más recientes);
// los "guardados" son permanentes y no rotan.
const MAX_HISTORIAL = 8;
let segmentos = [];   // cache de los segmentos del agente

async function cargarSegmentos() {
  const { data, error } = await SB.from("segmentos")
    .select("id, nombre, definicion, created_at")
    .eq("owner_id", state.me.id)
    .order("created_at", { ascending: false });
  segmentos = error ? [] : (data || []);
}

// Guarda la selección como entrada de historial y poda las más viejas.
async function guardarSegmentoHistorial(clienteIds, actividad) {
  if (!clienteIds.length) return;
  try {
    await SB.from("segmentos").insert({
      owner_id: state.me.id,
      nombre: `${actividad} · ${fechaHoraCO(new Date().toISOString())}`,
      definicion: { tipo: "historial", cliente_ids: clienteIds, actividad },
    });
    await cargarSegmentos();
    // Poda: deja solo los MAX_HISTORIAL más recientes de tipo historial.
    const hist = segmentos.filter(s => s.definicion?.tipo === "historial");
    const sobran = hist.slice(MAX_HISTORIAL);
    if (sobran.length) {
      await SB.from("segmentos").delete().in("id", sobran.map(s => s.id));
      await cargarSegmentos();
    }
  } catch (e) { /* el guardado de historial nunca debe romper la programación */ }
}

// Guarda la selección ACTUAL como segmento permanente, con nombre.
async function guardarSegmentoManual() {
  if (!actSel) return;
  const ids = elegibles(actSel.servicio_id).filter(c => segSel.has(c.id)).map(c => c.id);
  if (!ids.length) { toast("No hay nadie seleccionado para guardar"); return; }
  const nombre = (prompt("Nombre para este segmento:", "") || "").trim();
  if (!nombre) return;
  try {
    await SB.from("segmentos").insert({
      owner_id: state.me.id, nombre,
      definicion: { tipo: "guardado", cliente_ids: ids, actividad: actSel.nombre },
    });
    await cargarSegmentos();
    renderSegmentos();
    toast(`✓ Segmento «${nombre}» guardado`);
  } catch (err) { toast("⚠ " + err.message); }
}

// Aplica un segmento a la selección actual: marca solo a las personas que
// siguen siendo elegibles (les falta el servicio o el toggle lo permite, y
// tienen teléfono). Avisa cuántas se omitieron.
function aplicarSegmento(seg) {
  if (!actSel) return;
  const guardados = new Set(seg.definicion?.cliente_ids || []);
  const uni = elegibles(actSel.servicio_id);
  const validos = uni.filter(c => guardados.has(c.id));
  segSel = new Set(validos.map(c => c.id));
  const omitidos = guardados.size - validos.length;
  renderFaltan();
  toast(omitidos > 0
    ? `Segmento aplicado · ${validos.length} marcados, ${omitidos} ya no aplican`
    : `Segmento aplicado · ${validos.length} marcados`);
}

async function eliminarSegmento(id) {
  try {
    await SB.from("segmentos").delete().eq("id", id);
    await cargarSegmentos();
    renderSegmentos();
  } catch (err) { toast("⚠ " + err.message); }
}

function renderSegmentos() {
  const cont = $("segSegmentos");
  if (!cont) return;
  if (!segmentos.length) { cont.innerHTML = ""; return; }
  const guardados = segmentos.filter(s => s.definicion?.tipo === "guardado");
  const historial = segmentos.filter(s => s.definicion?.tipo === "historial");

  const chip = (s, esHist) => {
    const n = (s.definicion?.cliente_ids || []).length;
    const et = esHist ? "hist" : "";
    const star = esHist ? "" : `<span class="star">★</span>`;
    return `<span class="segchip ${et}">
      ${star}<span data-seg="${s.id}">${esc(s.nombre)} · ${n}</span>
      <span class="x" data-segdel="${s.id}" title="Eliminar">✕</span>
    </span>`;
  };

  cont.innerHTML =
    (guardados.length ? `<div class="pstitle" style="margin:0 0 4px">⭐ Segmentos guardados</div>` : "") +
    guardados.map(s => chip(s, false)).join("") +
    (historial.length ? `<div class="pstitle" style="margin:8px 0 4px">🕘 Recientes</div>` : "") +
    historial.map(s => chip(s, true)).join("");

  cont.querySelectorAll("[data-seg]").forEach(el => el.onclick = () => {
    const s = segmentos.find(x => x.id === el.dataset.seg);
    if (s) aplicarSegmento(s);
  });
  cont.querySelectorAll("[data-segdel]").forEach(el => el.onclick = () => {
    if (confirm("¿Eliminar este segmento?")) eliminarSegmento(el.dataset.segdel);
  });
}

/* ================= SEGUIMIENTOS ACTIVOS ================= */
async function renderActivos() {
  const { data, error } = await SB.from("seguimientos")
    .select("id, cliente_id, actividad_id, actividad, inicio, estado, clientes(nombre)")
    .eq("estado", "activo")
    .order("inicio", { ascending: true });
  if (error) { $("segActivos").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }

  // Un seguimiento deja de estar "activo" pasada su hora de confirmación
  // (inicio + 10 min). Si el mensaje de confirmación falló, el worker no lo
  // completó; aquí lo cerramos igual para que no quede colgado.
  const ahora = Date.now();
  const finConf = s => new Date(s.inicio).getTime() + 10 * 60000;
  const vencidos = (data || []).filter(s => finConf(s) <= ahora);
  if (vencidos.length) {
    await SB.from("seguimientos").update({ estado: "completado" }).in("id", vencidos.map(s => s.id));
  }
  const activos = (data || []).filter(s => finConf(s) > ahora);
  if (!activos.length) { $("segActivos").innerHTML = `<div class="naplica">No hay seguimientos activos.</div>`; return; }

  $("segActivos").innerHTML = activos.map(s => `
    <div class="seg-row">
      <span>${esc(s.clientes?.nombre || "(cliente)")} · <b>${esc(s.actividad)}</b>
        <span class="sfecha">${fechaHoraCO(s.inicio)}</span>
      </span>
      <button class="pmark off" data-cancel="${s.id}">✕ Cancelar</button>
    </div>`).join("");

  $("segActivos").querySelectorAll("[data-cancel]").forEach(b => b.onclick = () => {
    const s = activos.find(x => x.id === b.dataset.cancel);
    if (s) abrirCancelar(s);
  });
}

// Diálogo de cancelación: además de cancelar los mensajes pendientes, deja
// elegir si la persona queda "invitada" (conserva conf) o vuelve a "por
// invitar" (se borra conf de ese servicio).
function abrirCancelar(s) {
  const nombre = s.clientes?.nombre || "esta persona";
  $("repSub").textContent = "Cancelar seguimiento";
  $("repBody").innerHTML = `
    <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
      <div style="font-size:.95rem">Vas a cancelar el seguimiento de <b>${esc(nombre)}</b>
        para <b>${esc(s.actividad)}</b>. No se enviarán los mensajes pendientes.
        <span class="sfecha">¿En qué estado dejas a la persona?</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="pmark" data-cx="invitado">Dejarla como «invitada»</button>
        <button class="pmark off" data-cx="porinvitar">Volver a «por invitar»</button>
        <button class="tbtn" data-cx="nada">No cancelar</button>
      </div>
    </div>`;
  const cerrar = () => { $("repOverlay").classList.remove("open"); };
  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };
  $("repBody").querySelectorAll("[data-cx]").forEach(btn => btn.onclick = async () => {
    const modo = btn.dataset.cx;
    if (modo === "nada") { cerrar(); return; }
    btn.disabled = true;
    try {
      // 1) cancelar mensajes pendientes y el seguimiento
      const r1 = await SB.from("mensajes_programados")
        .update({ estado: "cancelado" }).eq("seguimiento_id", s.id).eq("estado", "pendiente");
      const r2 = await SB.from("seguimientos")
        .update({ estado: "cancelado" }).eq("id", s.id);
      if (r1.error || r2.error) throw (r1.error || r2.error);

      // 2) si se elige "por invitar", quitar conf de ese servicio a la persona
      if (modo === "porinvitar" && s.actividad_id) {
        const { data: act } = await SB.from("actividades")
          .select("servicio_id").eq("id", s.actividad_id).maybeSingle();
        const sid = act?.servicio_id;
        const c = state.clientes.find(x => x.id === s.cliente_id);
        if (sid && c && (c.conf || {})[sid]) {
          delete c.conf[sid];
          await SB.from("clientes").update({ conf: c.conf }).eq("id", c.id);
        }
      }
      cerrar();
      toast(modo === "porinvitar"
        ? "Seguimiento cancelado · persona vuelve a «por invitar» ✓"
        : "Seguimiento cancelado · persona queda «invitada» ✓");
      renderActivos();
    } catch (err) {
      toast("⚠ " + err.message);
      btn.disabled = false;
    }
  });
  $("repOverlay").classList.add("open");
}

/* ================= REGISTRO DE ENVÍOS (logs) ================= */
const LOG_TIPO = {
  invitacion: "Invitación", rec_60: "Recordatorio 1 h", rec_15: "Recordatorio 10 min",
  enlace: "Enlace", confirmacion: "Confirmación",
};
const LOG_BADGE = {
  enviado:   ["ok",   "✓ Enviado"],
  error:     ["err",  "⚠ Error"],
  pendiente: ["pend", "⏳ Pendiente"],
  cancelado: ["can",  "✕ Cancelado"],
};

async function renderLogs() {
  const { data, error } = await SB.from("mensajes_programados")
    .select("tipo, telefono, estado, enviar_en, enviado_en, error, seguimientos(clientes(nombre))")
    .order("enviar_en", { ascending: false })
    .limit(60);
  if (error) { $("segLogs").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }
  const todas = data || [];

  // Chips de filtro con conteos.
  const n = e => todas.filter(m => m.estado === e).length;
  const chips = [
    ["todos", `Todos (${todas.length})`],
    ["enviado", `✓ ${n("enviado")}`],
    ["error", `⚠ ${n("error")}`],
    ["pendiente", `⏳ ${n("pendiente")}`],
  ];
  $("segLogsFiltros").innerHTML = chips.map(([v, l]) =>
    `<button class="pill ${logFiltro === v ? "on" : ""}" data-flog="${v}">${l}</button>`).join("");
  $("segLogsFiltros").querySelectorAll("[data-flog]").forEach(b => b.onclick = () => {
    logFiltro = b.dataset.flog; renderLogs();
  });

  const filas = logFiltro === "todos" ? todas : todas.filter(m => m.estado === logFiltro);
  if (!filas.length) { $("segLogs").innerHTML = `<div class="naplica">Sin mensajes en este filtro.</div>`; return; }

  $("segLogs").innerHTML = filas.map(m => {
    const nombre = m.seguimientos?.clientes?.nombre || m.telefono;
    const cuando = m.enviado_en || m.enviar_en;
    const [cls, txt] = LOG_BADGE[m.estado] || ["pend", m.estado];
    const err = (m.estado === "error" && m.error)
      ? `<div class="logerr" title="${esc(m.error)}">${esc(m.error.slice(0, 90))}</div>` : "";
    return `<div class="logrow">
      <div class="logtop">
        <span class="logbadge ${cls}">${txt}</span>
        <span class="logname">${esc(nombre)}</span>
        <span class="logtipo">${LOG_TIPO[m.tipo] || m.tipo}</span>
        <span class="logtime">${fechaHoraCO(cuando)}</span>
      </div>${err}
    </div>`;
  }).join("");
}

/* ================= WIRING ================= */
const EMAIL_SEG = "santiagoviveros18@gmail.com";
$("btnSeg").onclick = () => {
  if ((state.me?.email || "").toLowerCase() !== EMAIL_SEG) {
    toast("Seguimiento Automatizado. En fase de prueba…");
    return;
  }
  state.vista = "seguimiento";
  render();
  $("segMsgsPanel").classList.add("hidden");
  salirEdicion(); ocultarProg(); cargarPlantillas(); cargarActividades();
  cargarSegmentos(); renderActivos(); renderLogs();
};

// Búsqueda por nombre (Req 2): filtra en vivo la lista de selección.
$("segBuscar").oninput = e => {
  segBuscarTxt = e.target.value;
  $("segBuscarX").classList.toggle("hidden", !e.target.value);
  if (actSel) renderFaltan();
};
$("segBuscarX").onclick = () => {
  $("segBuscar").value = ""; segBuscarTxt = "";
  $("segBuscarX").classList.add("hidden");
  if (actSel) renderFaltan();
  $("segBuscar").focus();
};

// Toggle "enviar la invitación más tarde": despliega el campo de hora.
$("segTardeToggle").onclick = () => {
  const activo = $("segTardeRow").classList.toggle("hidden") === false;
  $("segTardeToggle").classList.toggle("on", activo);
  if (activo) {
    // valor por defecto: dentro de 1 hora, redondeado
    const d = new Date(Date.now() + 60 * 60000);
    const p = n => String(n).padStart(2, "0");
    $("segTardeCuando").value = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
    segInvitarTarde = new Date($("segTardeCuando").value);
  } else {
    segInvitarTarde = null;   // vuelve a "ahora"
  }
};
$("segTardeCuando").onchange = e => {
  segInvitarTarde = e.target.value ? new Date(e.target.value) : null;
};

// Toggle "incluir a quienes ya asistieron" (Req 2).
$("segIncAsis").onchange = e => { segIncAsis = e.target.checked; if (actSel) renderFaltan(); };

// Guardar la selección actual como segmento permanente (Req 3).
$("segGuardarSeg").onclick = guardarSegmentoManual;

$("segVolver").onclick = () => { state.vista = "cliente"; render(); };
$("segCancelEdit").onclick = salirEdicion;
$("segCrearAct").onclick = guardarActividad;
$("segProgramar").onclick = programar;
$("segBtnMsgs").onclick = () => $("segMsgsPanel").classList.toggle("hidden");
$("segMsgsGuardar").onclick = guardarPlantillas;
$("segMsgsReset").onclick = resetPlantillas;
