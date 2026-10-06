// Seguimiento a leads: una serie de hasta 4 mensajes (saludo, video, pregunta…)
// a los leads elegidos, con TIPO de seguimiento y plantillas reutilizables.
//
// Es un masivo a leads, no una vía nueva de envío: los destinatarios salen de
// `destinatariosMasivo()` (el cuello del masivo) y la campaña va a la misma
// cola. Lo propio de esto:
//   · `campanas.lead_tipo` marca la campaña como seguimiento;
//   · cada fila lleva `cliente_id`, y la base anota el contacto en la ficha del
//     lead cuando el mensaje 1 SALE (trigger), no al programar;
//   · el mensaje 1 va como `masivo` (el tope diario lo frena) y del 2 al 4 como
//     `masivo_parte` (el tope no los corta). Si uno no sale, la base cancela
//     los siguientes de ese lead: o llega la serie entera o nada.
import { SB } from "./supabase.js";
import { state, $, esc, toast, normBusqueda, esLead, componerMensaje,
  ACCEPT_ADJUNTO, validarAdjunto, mensajeErrorAdjunto, cuandoParte } from "./state.js";
import { subirImagenMensaje, guardarHistorialSegmento } from "./data.js";
import { canalVinculado } from "./canal.js";
import { destinatariosMasivo } from "./masivo.js";
import { TIPOS, TEMP, CATEGORIAS, categoria, temperatura } from "./leads.js";

const MAX_MSGS = 4;
const nuevoBorrador = () => ({ id: null, nombre: "", tipo: null, modo: "usuario", espera_min: 0,
  mensajes: [{ texto: "", media: null }] });

let plantillas = [];
let bor = nuevoBorrador();      // lo que se está editando
let sel = new Set();            // leads elegidos: SIEMPRE arranca vacía
let fEtapa = "todas", fTemp = "todas";
let cuando = "ahora";
let alTerminar = null;

const primerNombre = n => (n || "").trim().split(/\s+/)[0];
const esVideo = u => /\.(mp4|mov)(\?|$)/i.test(u || "");
const nombreTipo = t => (TIPOS.find(x => x[0] === t) || [, t])[1];
// Etiqueta corta de cada etapa en la lista (la del riel de «Hoy»).
const ETQ = { pend: "Pendiente", reg: "Registrado", hoy: "Llegó hoy", bajo: "Te escribió", ayer: "Llegó ayer", resto: "En espera" };

// Los leads a los que se les puede escribir: el cuello del masivo (propios, con
// teléfono, activos) y además que sigan siendo leads.
const universo = () => destinatariosMasivo(false).filter(esLead);
const visibles = () => {
  const q = normBusqueda($("ldBuscar").value);
  return universo().filter(c =>
    (fEtapa === "todas" || categoria(c) === fEtapa) &&
    (fTemp === "todas" || temperatura(c) === fTemp) &&
    (!q || normBusqueda(c.nombre).includes(q)));
};

/* ---------- plantillas ---------- */
async function cargarPlantillas() {
  const { data, error } = await SB.from("plantillas_lead")
    .select("id, nombre, tipo, mensajes, modo, espera_min").order("actualizado_en", { ascending: false });
  plantillas = error ? [] : (data || []);
  pintarPlantillas();
}
function pintarPlantillas() {
  $("ldPlant").innerHTML = `<option value="">＋ Nueva (sin guardar)</option>`
    + plantillas.map(p => `<option value="${p.id}" ${p.id === bor.id ? "selected" : ""}>${esc(p.nombre)} · ${esc(nombreTipo(p.tipo))}</option>`).join("");
  $("ldPlantBorrar").classList.toggle("hidden", !bor.id);
  $("ldPlantGuardar").textContent = bor.id ? "Guardar cambios en la plantilla" : "Guardar como plantilla";
}
function usarPlantilla(id) {
  const p = plantillas.find(x => x.id === id);
  bor = p ? { id: p.id, nombre: p.nombre, tipo: p.tipo, modo: p.modo, espera_min: p.espera_min || 0,
              mensajes: p.mensajes.map(m => ({ texto: m.texto || "", media: m.media || null })) }
          : nuevoBorrador();
  $("ldNombre").value = bor.nombre;
  pintarPlantillas(); pintarTipos(); pintarMsgs();
}

// Lo que se guarda o se envía. null = algo incompleto (ya se avisó).
function leerBorrador({ paraEnviar } = {}) {
  bor.nombre = $("ldNombre").value.trim();
  const mensajes = bor.mensajes.map(m => ({ texto: (m.texto || "").trim(), media: m.media || null }))
    .filter(m => m.texto || m.media);
  if (!mensajes.length) { toast("Escribe al menos un mensaje o adjunta un video"); return null; }
  if (!bor.tipo) { toast("Elige el tipo de seguimiento"); return null; }
  if (!paraEnviar && !bor.nombre) { toast("Ponle un nombre a la plantilla"); $("ldNombre").focus(); return null; }
  if (mensajes.some(m => /\{hora\}|\{zona\}|\{dia\}/.test(m.texto))) {
    // Un seguimiento no cuelga de ningún evento: no hay hora que anunciar.
    toast("Un seguimiento no tiene hora de evento: quita {hora}, {zona} o {dia}"); return null;
  }
  return { nombre: bor.nombre, tipo: bor.tipo, modo: bor.modo, espera_min: bor.espera_min || 0, mensajes };
}

async function guardarPlantilla() {
  const d = leerBorrador(); if (!d) return;
  const campos = { ...d, actualizado_en: new Date().toISOString() };
  const q = bor.id
    ? SB.from("plantillas_lead").update(campos).eq("id", bor.id).select("id").single()
    : SB.from("plantillas_lead").insert(campos).select("id").single();
  const { data, error } = await q;
  if (error) { toast("⚠ " + error.message); return; }
  bor.id = data?.id || bor.id;
  toast(`✓ Plantilla «${d.nombre}» guardada`);
  await cargarPlantillas();
}
async function borrarPlantilla() {
  if (!bor.id || !confirm(`¿Borrar la plantilla «${bor.nombre}»? Los envíos ya programados no cambian.`)) return;
  const { error } = await SB.from("plantillas_lead").delete().eq("id", bor.id);
  if (error) { toast("⚠ " + error.message); return; }
  usarPlantilla(""); await cargarPlantillas();
}

/* ---------- editor ---------- */
function pintarTipos() {
  $("ldTipos").innerHTML = TIPOS.map(([k, n]) =>
    `<button type="button" class="lchip ${bor.tipo === k ? "on" : ""}" data-tipo="${k}">${n}</button>`).join("");
  $("ldTipos").querySelectorAll("[data-tipo]").forEach(b => b.onclick = () => { bor.tipo = b.dataset.tipo; pintarTipos(); });
}

const prev = t => componerMensaje(t, { nombre: "Ana" });

function pintarMsgs() {
  const cont = $("ldMsgs");
  cont.innerHTML = bor.mensajes.map((m, i) => `
    <div class="seriep" data-i="${i}">
      <div class="seriehd"><b>Mensaje ${i + 1}</b>
        ${bor.mensajes.length > 1 ? `<button type="button" class="tbtn" data-quitar style="color:var(--bad)">Quitar</button>` : ""}</div>
      <textarea rows="3" data-txt maxlength="4000" placeholder="${i === 0 ? "¡Hola {nombre}! …" : `Texto del mensaje ${i + 1}… (opcional si adjuntas un video)`}">${esc(m.texto)}</textarea>
      <div class="imgfield">
        ${m.media ? (esVideo(m.media) ? `<video class="imgprev" src="${esc(m.media)}" muted controls></video>`
                                      : `<img class="imgprev" src="${esc(m.media)}" alt="">`) : ""}
        <div class="imgbtns">
          <input type="file" data-file accept="${ACCEPT_ADJUNTO}" class="hidden">
          <button type="button" class="tbtn" data-pick>${m.media ? "Cambiar adjunto" : "Adjuntar imagen o video"}</button>
          ${m.media ? `<button type="button" class="tbtn" data-delmedia style="color:var(--bad)">Quitar adjunto</button>` : ""}
          <span class="imgestado" data-est></span>
        </div>
      </div>
      <div class="prevmsg" data-prev></div>
    </div>`).join("");

  $("ldMsgAdd").classList.toggle("hidden", bor.mensajes.length >= MAX_MSGS);
  const varios = bor.mensajes.length > 1;
  $("ldOpts").classList.toggle("hidden", !varios);
  $("ldModo").querySelectorAll("[data-modo]").forEach(b => b.classList.toggle("on", b.dataset.modo === bor.modo));
  const conMin = (bor.espera_min || 0) > 0;
  $("ldEsp").querySelectorAll("[data-esp]").forEach(b => b.classList.toggle("on", (b.dataset.esp === "min") === conMin));
  $("ldMinWrap").classList.toggle("hidden", !conMin);
  if (conMin) $("ldMin").value = bor.espera_min;

  cont.querySelectorAll(".seriep").forEach(el => {
    const i = +el.dataset.i, m = bor.mensajes[i];
    const txt = el.querySelector("[data-txt]"), pv = el.querySelector("[data-prev]");
    const pintarPrev = () => { pv.textContent = m.texto.trim() ? prev(m.texto) : ""; };
    pintarPrev();
    txt.oninput = () => { m.texto = txt.value; pintarPrev(); };
    const q = el.querySelector("[data-quitar]");
    if (q) q.onclick = () => { bor.mensajes.splice(i, 1); pintarMsgs(); };
    const file = el.querySelector("[data-file]"), est = el.querySelector("[data-est]");
    el.querySelector("[data-pick]").onclick = () => file.click();
    const del = el.querySelector("[data-delmedia]");
    if (del) del.onclick = () => { m.media = null; pintarMsgs(); };
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      const v = validarAdjunto(f);
      if (!v.ok) { est.textContent = "⚠ " + v.error; file.value = ""; return; }
      est.textContent = v.esVideo ? "Subiendo video…" : "Subiendo…";
      try { m.media = await subirImagenMensaje(f); pintarMsgs(); }
      catch (err) { est.textContent = "⚠ " + mensajeErrorAdjunto(err); file.value = ""; }
    };
  });
}

/* ---------- destinatarios ---------- */
function pintarFiltros() {
  const u = universo();
  const chip = (attr, v, l, on, n) => `<button class="pill ${on ? "on" : ""}" ${attr}="${v}">${l}${n != null ? ` · ${n}` : ""}</button>`;
  $("ldEtapas").innerHTML = chip("data-et", "todas", "Todas las etapas", fEtapa === "todas")
    + CATEGORIAS.map(([k]) => chip("data-et", k, ETQ[k], fEtapa === k, u.filter(c => categoria(c) === k).length)).join("");
  $("ldTemps").innerHTML = chip("data-te", "todas", "Toda temperatura", fTemp === "todas")
    + Object.entries(TEMP).map(([k, l]) => chip("data-te", k, l, fTemp === k, u.filter(c => temperatura(c) === k).length)).join("");
  $("ldEtapas").querySelectorAll("[data-et]").forEach(b => b.onclick = () => { fEtapa = b.dataset.et; pintarFiltros(); pintarLista(); });
  $("ldTemps").querySelectorAll("[data-te]").forEach(b => b.onclick = () => { fTemp = b.dataset.te; pintarFiltros(); pintarLista(); });
}

function pintarLista() {
  const vis = visibles();
  $("ldLista").innerHTML = vis.length
    ? vis.map(c => { const t = temperatura(c); return `
        <label class="seg-row">
          <input type="checkbox" data-cid="${c.id}" ${sel.has(c.id) ? "checked" : ""}>
          <span class="nm">${esc(c.nombre)}</span>
          <span class="ldetq">${ETQ[categoria(c)]}</span>
          <span class="ltemp ${t}"><i></i>${TEMP[t]}</span>
        </label>`; }).join("")
    : `<div class="naplica">${universo().length ? "Ningún lead en este filtro." : "No tienes leads con teléfono para escribirles."}</div>`;
  $("ldLista").querySelectorAll("input[data-cid]").forEach(inp => inp.onchange = () => {
    inp.checked ? sel.add(inp.dataset.cid) : sel.delete(inp.dataset.cid);
    pintarConteo();
  });
  pintarConteo();
}

// La selección cuenta solo a quien sigue en el universo: un lead que pasó a
// Beca o se marcó inactivo mientras el modal estaba abierto no se envía.
const elegidos = () => universo().filter(c => sel.has(c.id));
function pintarConteo() {
  const n = elegidos().length;
  $("ldCount").textContent = n ? `${n} de ${universo().length}` : "";
  $("ldFootN").textContent = n;
  $("ldEnviar").disabled = n === 0;
}
function pintarCuando() {
  $("ldProgRow").classList.toggle("hidden", cuando !== "prog");
  $("ldCuando").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.cuando === cuando));
  const f = $("ldFecha").value, h = $("ldHora").value;
  $("ldFootCuando").textContent = cuando === "prog"
    ? (f && h ? `Programado para el ${f.slice(8, 10)}/${f.slice(5, 7)} a las ${h}` : "Elige fecha y hora")
    : "Se envía ahora mismo";
  $("ldEnviar").textContent = cuando === "prog" ? "Programar seguimiento" : "Enviar seguimiento";
}

/* ---------- enviar ---------- */
async function enviar() {
  if (!(await canalVinculado())) { toast("Vincula tu WhatsApp en «Más → Mi WhatsApp» para poder enviar"); return; }
  const d = leerBorrador({ paraEnviar: true }); if (!d) return;
  const lista = elegidos();
  if (!lista.length) { toast("No hay leads seleccionados"); return; }

  let base = new Date();
  if (cuando === "prog") {
    const f = $("ldFecha").value, h = $("ldHora").value;
    if (!f || !h) { toast("Falta la fecha o la hora"); return; }
    base = new Date(`${f}T${h}:00`);   // hora local = Colombia
    if (isNaN(base) || base <= new Date()) { toast("Programa una fecha futura"); return; }
  }

  const serie = { modo: d.modo, espera_min: d.espera_min, partes: d.mensajes.slice(1) };
  const n = lista.length;
  const nombres = lista.slice(0, 8).map(c => primerNombre(c.nombre)).join(", ") + (n > 8 ? ` y ${n - 8} más` : "");
  const como = d.mensajes.length > 1
    ? `\n${d.mensajes.length} mensajes por lead, ${d.modo === "mensaje" ? "por mensaje" : "por usuario"}, ${d.espera_min ? `${d.espera_min} min entre cada uno` : "con pausa natural"}.`
    : "";
  if (!confirm(`Vas a ${cuando === "prog" ? "programar" : "enviar"} «${d.nombre || nombreTipo(d.tipo)}» (${nombreTipo(d.tipo)}) a ${n} lead${n === 1 ? "" : "s"}:\n${nombres}.${como}\n\nCuando salga el primer mensaje se anota el contacto en la ficha de cada lead.\n\n¿Continuar?`)) return;

  const btn = $("ldEnviar");
  btn.disabled = true; btn.textContent = "Enviando…";
  try {
    const nombreCamp = (d.nombre || `Seguimiento · ${nombreTipo(d.tipo)}`).slice(0, 60);
    const { data: camp, error: e1 } = await SB.from("campanas").insert({
      nombre: nombreCamp, texto: d.mensajes[0].texto || null, media_url: d.mensajes[0].media,
      enviar_en: base.toISOString(), total: n, lead_tipo: d.tipo,
    }).select("id").single();
    if (e1) throw e1;

    const rows = [];
    lista.forEach((c, i) => d.mensajes.forEach((m, k) => {
      rows.push({
        campana_id: camp.id, cliente_id: c.id, telefono: c.tel,
        tipo: k === 0 ? "masivo" : "masivo_parte",
        enviar_en: new Date(cuandoParte(serie, base.getTime(), i, k, n)).toISOString(),
        // Cada lead recibe su propia redacción: las variantes se sortean por persona.
        texto: m.texto ? componerMensaje(m.texto, { nombre: primerNombre(c.nombre) }) : null,
        media_url: m.media,
      });
    }));
    const { error: e2 } = await SB.from("mensajes_programados").insert(rows);
    if (e2) throw e2;

    await guardarHistorialSegmento({ clienteIds: lista.map(c => c.id), nombre: `✉ ${nombreCamp}`, clave: `cam:${camp.id}` });
    toast(`✓ Seguimiento ${cuando === "prog" ? "programado" : "en cola"} para ${n} lead${n === 1 ? "" : "s"}`);
    $("ldOverlay").classList.remove("open");
    alTerminar?.();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; pintarCuando(); pintarConteo();
  }
}

/* ---------- abrir ---------- */
export async function abrirEnvioLeads(render) {
  alTerminar = render;
  sel = new Set(); fEtapa = "todas"; fTemp = "todas"; cuando = "ahora";
  bor = nuevoBorrador();
  $("ldNombre").value = ""; $("ldBuscar").value = "";
  $("ldFecha").value = ""; $("ldHora").value = "";
  pintarTipos(); pintarMsgs(); pintarFiltros(); pintarLista(); pintarCuando(); pintarPlantillas();
  $("ldOverlay").classList.add("open");
  await cargarPlantillas();
}

$("ldCerrar").onclick = () => $("ldOverlay").classList.remove("open");
$("ldOverlay").onclick = e => { if (e.target.id === "ldOverlay") $("ldOverlay").classList.remove("open"); };
$("ldPlant").onchange = e => usarPlantilla(e.target.value);
$("ldPlantGuardar").onclick = guardarPlantilla;
$("ldPlantBorrar").onclick = borrarPlantilla;
$("ldMsgAdd").onclick = () => {
  if (bor.mensajes.length >= MAX_MSGS) return;
  bor.mensajes.push({ texto: "", media: null }); pintarMsgs();
  $("ldMsgs").querySelector(".seriep:last-child [data-txt]")?.focus();
};
$("ldModo").querySelectorAll("[data-modo]").forEach(b => b.onclick = () => { bor.modo = b.dataset.modo; pintarMsgs(); });
$("ldEsp").querySelectorAll("[data-esp]").forEach(b => b.onclick = () => {
  bor.espera_min = b.dataset.esp === "min" ? (bor.espera_min || 5) : 0; pintarMsgs();
});
$("ldMin").oninput = () => { const v = parseInt($("ldMin").value, 10); if (v >= 1 && v <= 120) bor.espera_min = v; };
$("ldMin").onchange = pintarMsgs;
$("ldBuscar").oninput = pintarLista;
// «Marcar» solo toca lo que se ve: un filtro nunca se convierte en selección
// silenciosa, y desmarcar quita solo lo visible.
$("ldMarcar").onclick = () => { visibles().forEach(c => sel.add(c.id)); pintarLista(); };
$("ldDesmarcar").onclick = () => { visibles().forEach(c => sel.delete(c.id)); pintarLista(); };
$("ldCuando").querySelectorAll("button").forEach(b => b.onclick = () => { cuando = b.dataset.cuando; pintarCuando(); });
$("ldFecha").onchange = pintarCuando; $("ldHora").onchange = pintarCuando;
$("ldEnviar").onclick = enviar;
