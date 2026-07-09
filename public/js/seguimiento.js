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
function plantillas(nombre, actividad, inicioISO, enlace, yaInvitado) {
  const datos = { nombre: nombre.trim().split(/\s+/)[0], actividad, hora: horaCO(inicioISO), enlace };
  const out = {};
  for (const t of TIPOS) {
    const clave = (t === "invitacion" && yaInvitado) ? "invitacion_extra" : t;
    out[t] = aplicar(plantillasUsuario[clave] || PLANTILLAS_DEF[clave], datos);
  }
  return out;
}

/* ---------- estado local de la vista ---------- */
let actividades = [];         // actividades activas cargadas
let actSel = null;            // actividad elegida para programar
let actEdit = null;           // actividad en edición en el formulario
let segSel = new Set();       // ids de clientes seleccionados para programar
let segFiltroMem = "todos";   // filtro de membresía en el selector

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
  if (!enlace) { toast("Falta el enlace de la sala"); return; }

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
      toast("✓ Actividad actualizada (los mensajes ya programados no cambian)");
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
  actividades = data || [];
  if (!actividades.length) {
    $("segActividades").innerHTML = `<div class="naplica">Aún no has creado actividades. Crea una arriba.</div>`;
    return;
  }
  $("segActividades").innerHTML = actividades.map(a => `
    <div class="seg-row">
      <span>${esc(a.nombre)}<span class="sfecha">${fechaHoraCO(a.inicio)}</span></span>
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
function faltantes(sid) {
  return state.clientes.filter(c => !c.acc[sid] && c.tel);
}

function seleccionarActividad(a) {
  actSel = a;
  segFiltroMem = "todos";
  // Por defecto: marcar toda la comunidad (no Leads).
  segSel = new Set(faltantes(a.servicio_id).filter(c => !esLeadMem(c.mem)).map(c => c.id));
  $("segProgTitulo").innerHTML = `Programar para <b>${esc(a.nombre)}</b> · ${fechaHoraCO(a.inicio)}`;
  $("segProgBloque").classList.remove("hidden");
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
}

function renderFaltan() {
  if (!actSel) return;
  const sid = actSel.servicio_id;
  const lista = faltantes(sid);
  const sinTel = state.clientes.filter(c => !c.acc[sid] && !c.tel).length;

  // Chips de filtro: "Todos" + solo las membresías presentes en la lista.
  const presentes = MEMS.filter(m => lista.some(c => c.mem === m));
  const chips = [["todos", `Todos (${lista.length})`]].concat(
    presentes.map(m => [m, `${m} (${lista.filter(c => c.mem === m).length})`]));
  $("segFiltros").innerHTML = chips.map(([v, l]) =>
    `<button class="pill ${segFiltroMem === v ? 'on' : ''}" data-fmem="${v}">${l}</button>`).join("");
  $("segFiltros").querySelectorAll("[data-fmem]").forEach(b => b.onclick = () => {
    segFiltroMem = b.dataset.fmem; renderFaltan();
  });

  const visibles = lista.filter(c => segFiltroMem === "todos" || c.mem === segFiltroMem);
  $("segFaltan").innerHTML = visibles.length
    ? visibles.map(c => `
        <label class="seg-row">
          <input type="checkbox" data-cid="${c.id}" ${segSel.has(c.id) ? "checked" : ""}>
          <span class="badge b-${c.mem}">${c.mem}</span>
          <span>${esc(c.nombre)}</span>
        </label>`).join("")
    : `<div class="naplica">Nadie en este filtro.</div>`;
  if (sinTel && segFiltroMem === "todos") $("segFaltan").insertAdjacentHTML("beforeend",
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
  const total = faltantes(actSel.servicio_id).length;
  const sel = faltantes(actSel.servicio_id).filter(c => segSel.has(c.id)).length;
  $("segSelCount").textContent = `${sel} de ${total} seleccionados`;
}

async function programar() {
  if (!actSel) { toast("Elige una actividad primero"); return; }
  const inicio = new Date(actSel.inicio);
  const ahora = new Date();
  if (inicio <= ahora) { toast("Esta actividad ya empezó; crea una nueva"); return; }

  const seleccion = faltantes(actSel.servicio_id).filter(c => segSel.has(c.id));
  if (!seleccion.length) { toast("No hay nadie seleccionado"); return; }

  const btn = $("segProgramar");
  btn.disabled = true; btn.textContent = "Programando…";
  try {
    // 1) un seguimiento por persona (copia los datos de la actividad)
    const segRows = seleccion.map(c => ({
      cliente_id: c.id, actividad: actSel.nombre, inicio: actSel.inicio, enlace: actSel.enlace,
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
    const msgs = [];
    const tiempos = () => ([
      ["invitacion",   ahora],
      ["rec_60",       new Date(inicio.getTime() - 60 * 60000)],
      ["rec_15",       new Date(inicio.getTime() - 15 * 60000)],
      ["enlace",       inicio],
      ["confirmacion", new Date(inicio.getTime() + 15 * 60000)],
    ]);
    for (const seg of segs) {
      const c = seleccion.find(x => x.id === seg.cliente_id);
      const tpl = plantillas(c.nombre, actSel.nombre, actSel.inicio, actSel.enlace, yaInvitados.has(c.tel));
      for (const [tipo, cuando] of tiempos()) {
        if (tipo !== "invitacion" && cuando <= ahora) continue; // ya pasó
        msgs.push({
          seguimiento_id: seg.id, tipo, enviar_en: cuando.toISOString(),
          telefono: c.tel, texto: tpl[tipo],
        });
      }
    }
    const { error: e2 } = await SB.from("mensajes_programados").insert(msgs);
    if (e2) throw e2;

    toast(`✓ ${segs.length} seguimiento(s) · ${msgs.length} mensaje(s) programado(s)`);
    ocultarProg();
    renderActivos();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Programar mensajes";
  }
}

/* ================= SEGUIMIENTOS ACTIVOS ================= */
async function renderActivos() {
  const { data, error } = await SB.from("seguimientos")
    .select("id, actividad, inicio, estado, clientes(nombre)")
    .eq("estado", "activo")
    .order("inicio", { ascending: true });
  if (error) { $("segActivos").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }
  if (!data.length) { $("segActivos").innerHTML = `<div class="naplica">No hay seguimientos activos.</div>`; return; }

  $("segActivos").innerHTML = data.map(s => `
    <div class="seg-row">
      <span>${esc(s.clientes?.nombre || "(cliente)")} · <b>${esc(s.actividad)}</b>
        <span class="sfecha">${fechaHoraCO(s.inicio)}</span>
      </span>
      <button class="pmark off" data-cancel="${s.id}">✕ Cancelar</button>
    </div>`).join("");

  $("segActivos").querySelectorAll("[data-cancel]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Cancelar este seguimiento? No se enviarán los mensajes pendientes.")) return;
    const id = b.dataset.cancel;
    const r1 = await SB.from("mensajes_programados")
      .update({ estado: "cancelado" }).eq("seguimiento_id", id).eq("estado", "pendiente");
    const r2 = await SB.from("seguimientos")
      .update({ estado: "cancelado" }).eq("id", id);
    if (r1.error || r2.error) toast("⚠ " + (r1.error || r2.error).message);
    else { toast("Seguimiento cancelado ✓"); renderActivos(); }
  });
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
  salirEdicion(); ocultarProg(); cargarPlantillas(); cargarActividades(); renderActivos();
};

$("segVolver").onclick = () => { state.vista = "cliente"; render(); };
$("segCancelEdit").onclick = salirEdicion;
$("segCrearAct").onclick = guardarActividad;
$("segProgramar").onclick = programar;
$("segBtnMsgs").onclick = () => $("segMsgsPanel").classList.toggle("hidden");
$("segMsgsGuardar").onclick = guardarPlantillas;
$("segMsgsReset").onclick = resetPlantillas;
