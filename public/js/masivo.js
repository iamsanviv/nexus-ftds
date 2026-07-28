// Compositor de mensajes masivos (libres, no atados a una actividad).
// Cada persona recibe un texto ya resuelto: {nombre} + snippets {a|b|c} para
// que no llegue idéntico (más seguro). Crea una "campaña" y N mensajes en cola.
import { SB } from "./supabase.js";
import { state, $, esc, toast, norm, resolverSnippets } from "./state.js";
import { subirImagenMensaje, subirAudioMensaje } from "./data.js";
import { canalVinculado } from "./canal.js";

const MEMS = ["Beca", "VIP", "Platino", "Oro", "Lead"];
let masSel = new Set();     // ids seleccionados
let masFiltro = "todos";    // filtro de membresía
let masImg = null;          // URL de imagen subida (o null)
let masCuando = "ahora";    // ahora | prog
let segmentos = [];         // segmentos guardados

const primerNombre = n => (n || "").trim().split(/\s+/)[0];
// resolverSnippets vive en state.js (lo comparten masivo y las actividades).
const resolverMensaje = (tpl, nombre) => resolverSnippets(tpl).replaceAll("{nombre}", primerNombre(nombre));

// Solo los clientes PROPIOS. Un director ve los de sus agentes para
// supervisar, pero un masivo saldría desde SU WhatsApp a gente que agregó otro:
// cada quien le escribe a los suyos.
const pool = () => state.clientes.filter(c => c.tel && c.owner_id === state.me.id);

/* ---------- render ---------- */
// Vista previa del mensaje ya resuelto: con etiquetas y variantes {a|b|c}, lo
// que se escribe no es lo que llega, así que se muestra el resultado real.
function renderPrev() {
  const t = $("masTexto").value.trim();
  $("masPrevBox").classList.toggle("hidden", !t);
  $("masPrev").textContent = t ? resolverMensaje(t, "Ana Bermúdez") : "";
}

// ¿La persona ya fue invitada a alguna actividad? (tiene al menos un conf)
const yaInvitada = c => c.conf && Object.keys(c.conf).length > 0;

function renderFiltros() {
  const lista = pool();
  const presentes = MEMS.filter(m => lista.some(c => c.mem === m));
  const nInv = lista.filter(yaInvitada).length;
  const chips = [["todos", `Todos (${lista.length})`]]
    .concat(nInv ? [["invitadas", `Ya invitadas (${nInv})`]] : [])
    .concat(presentes.map(m => [m, `${m} (${lista.filter(c => c.mem === m).length})`]));
  $("masFiltros").innerHTML = chips.map(([v, l]) =>
    `<button class="pill ${masFiltro === v ? "on" : ""}" data-fmem="${v}">${l}</button>`).join("");
  $("masFiltros").querySelectorAll("[data-fmem]").forEach(b => b.onclick = () => { masFiltro = b.dataset.fmem; renderLista(); });
}

// Lee los ids de un segmento sin importar el formato: masivo guarda
// { ids:[...] }; el flujo de seguimiento por actividad guarda
// { tipo, cliente_ids:[...] }. Se aceptan ambos.
const idsDeSegmento = s => (s?.definicion?.ids) || (s?.definicion?.cliente_ids) || [];

function renderSegs() {
  if (!segmentos.length) {
    $("masSegs").innerHTML = `<span class="segselcount">Sin segmentos guardados</span>`;
    return;
  }
  const guardados = segmentos.filter(s => s.definicion?.tipo !== "historial");
  const historial = segmentos.filter(s => s.definicion?.tipo === "historial");
  const chip = (s, hist) =>
    `<button class="pill segchip ${hist ? "hist" : ""}" data-seg="${s.id}">${hist ? "🕘" : "◆"} ${esc(s.nombre)} · ${idsDeSegmento(s).length}</button>`;
  $("masSegs").innerHTML =
    guardados.map(s => chip(s, false)).join("") +
    historial.map(s => chip(s, true)).join("");
  $("masSegs").querySelectorAll("[data-seg]").forEach(b => b.onclick = () => {
    const s = segmentos.find(x => x.id === b.dataset.seg);
    const ids = idsDeSegmento(s);
    const enPool = new Set(pool().map(c => c.id));
    masSel = new Set(ids.filter(id => enPool.has(id)));
    masFiltro = "todos";
    renderFiltros(); renderLista();
    const omit = ids.length - masSel.size;
    toast(omit > 0
      ? `Segmento «${s.nombre}»: ${masSel.size} seleccionados · ${omit} ya no aplican`
      : `Segmento «${s.nombre}»: ${masSel.size} seleccionados`);
  });
}

function visibles() {
  const q = norm($("masBuscar").value.trim());
  return pool().filter(c => {
    const okMem = masFiltro === "todos" || (masFiltro === "invitadas" ? yaInvitada(c) : c.mem === masFiltro);
    return okMem && (!q || norm(c.nombre).includes(q));
  });
}

function renderLista() {
  const vis = visibles();
  $("masLista").innerHTML = vis.length
    ? vis.map(c => `
        <label class="seg-row">
          <input type="checkbox" data-cid="${c.id}" ${masSel.has(c.id) ? "checked" : ""}>
          <span class="badge b-${c.mem}">${c.mem}</span>
          <span>${esc(c.nombre)}</span>
        </label>`).join("")
    : `<div class="naplica">Nadie en este filtro.</div>`;
  $("masLista").querySelectorAll("input[data-cid]").forEach(inp => inp.onchange = () => {
    inp.checked ? masSel.add(inp.dataset.cid) : masSel.delete(inp.dataset.cid);
    renderCount();
  });
  renderCount();
}

function renderCount() {
  const total = pool().length;
  $("masCount").textContent = masSel.size ? `${masSel.size} de ${total}` : "";
  // La barra de acción de abajo repite la cifra: es lo último que se mira
  // antes de enviar, y ahí ya no se ve la lista.
  $("masFootN").textContent = masSel.size;
  $("masEnviar").disabled = masSel.size === 0;
}

// Resumen de "cuándo" en la barra de acción, para no tener que subir a mirar.
function renderCuando() {
  const f = $("masFecha").value, h = $("masHora").value;
  $("masFootCuando").textContent = masCuando === "prog"
    ? (f && h ? `Programado para el ${f.slice(8, 10)}/${f.slice(5, 7)} a las ${h}` : "Elige fecha y hora")
    : "Se envía ahora mismo";
}

/* ---------- nota de voz ---------- */
// Graba con MediaRecorder (pausar/reanudar como WhatsApp). El blob se sube al
// enviar; el worker lo convierte a ogg/opus para que llegue como nota de voz.
let masAudio = null;        // { blob, ext } grabado y listo (o null)
let rec = null;             // MediaRecorder activo
let recChunks = [];
let recDescartar = false;
let recTimer = null, recSeg = 0;

const fmtSeg = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

// Chrome/Android graban webm/opus; iOS (Safari) mp4/aac. Cualquiera sirve:
// la conversión a ogg/opus la hace el worker con ffmpeg.
function mimeGrabacion() {
  if (!window.MediaRecorder) return null;
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"])
    if (MediaRecorder.isTypeSupported(m)) return m;
  return "";   // dejar que el navegador elija
}

function audVista(v) {  // idle | live | done
  $("masAudIdle").classList.toggle("hidden", v !== "idle");
  $("masAudLive").classList.toggle("hidden", v !== "live");
  $("masAudDone").classList.toggle("hidden", v !== "done");
}

function pararTimer() { clearInterval(recTimer); recTimer = null; }
function arrancarTimer() {
  pararTimer();
  recTimer = setInterval(() => { recSeg++; $("masAudTimer").textContent = fmtSeg(recSeg); }, 1000);
}

function limpiarAudio() {
  if ($("masAudPlayer").src) { URL.revokeObjectURL($("masAudPlayer").src); $("masAudPlayer").src = ""; }
  masAudio = null;
  audVista("idle");
}

async function audGrabar() {
  if (mimeGrabacion() === null) { toast("⚠ Este navegador no soporta grabar audio"); return; }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast(e.name === "NotAllowedError"
      ? "⚠ Permiso de micrófono denegado: actívalo en el navegador"
      : "⚠ No pude acceder al micrófono: " + e.message);
    return;
  }
  const mime = mimeGrabacion();
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  recChunks = []; recDescartar = false; recSeg = 0;
  $("masAudTimer").textContent = "0:00";
  rec.ondataavailable = e => { if (e.data.size) recChunks.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    pararTimer();
    if (recDescartar || !recChunks.length) { limpiarAudio(); return; }
    const tipo = rec.mimeType || mime || "audio/webm";
    const blob = new Blob(recChunks, { type: tipo.split(";")[0] });
    const ext = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
    masAudio = { blob, ext };
    $("masAudPlayer").src = URL.createObjectURL(blob);
    audVista("done");
  };
  rec.start();
  arrancarTimer();
  $("masAudPause").textContent = "⏸ Pausar";
  audVista("live");
}

function audPausa() {
  if (!rec) return;
  if (rec.state === "recording") { rec.pause(); pararTimer(); $("masAudPause").textContent = "▶ Reanudar"; }
  else if (rec.state === "paused") { rec.resume(); arrancarTimer(); $("masAudPause").textContent = "⏸ Pausar"; }
}

/* ---------- imagen ---------- */
function setImg(url) {
  masImg = url || null;
  const img = $("masImgPrev"), del = $("masImgDel");
  if (url) { img.src = url; img.classList.remove("hidden"); del.classList.remove("hidden"); }
  else { img.src = ""; img.classList.add("hidden"); del.classList.add("hidden"); }
}

/* ---------- abrir / enviar ---------- */
async function abrir() {
  masSel = new Set(); masFiltro = "todos"; masCuando = "ahora";
  $("masTexto").value = ""; $("masBuscar").value = ""; $("masBuscarX").classList.add("hidden");
  setImg(null); $("masImgEstado").textContent = ""; renderPrev();
  if (rec && rec.state !== "inactive") { recDescartar = true; rec.stop(); }
  limpiarAudio(); $("masAudEstado").textContent = "";
  $("masProgRow").classList.add("hidden");
  $("masCuandoSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.cuando === "ahora"));
  renderFiltros(); renderLista(); renderCuando();
  $("masOverlay").classList.add("open");
  const { data } = await SB.from("segmentos").select("id, nombre, definicion").order("created_at", { ascending: false });
  segmentos = data || []; renderSegs();
}

async function enviar() {
  // Un masivo sale por el mismo WhatsApp del agente: sin canal vinculado no
  // se encola nada, porque serían decenas de mensajes fallidos.
  if (!(await canalVinculado())) {
    toast("Vincula tu WhatsApp en «Más → Mi WhatsApp» para poder enviar");
    return;
  }
  const tpl = $("masTexto").value.trim();
  if (rec && rec.state !== "inactive") { toast("Termina la grabación primero (✔ Listo)"); return; }
  if (!tpl && !masImg && !masAudio) { toast("Escribe un mensaje, agrega una imagen o graba una nota de voz"); return; }
  if (masImg && masAudio) { toast("Imagen y nota de voz a la vez no: quita una de las dos"); return; }
  const sel = pool().filter(c => masSel.has(c.id));
  if (!sel.length) { toast("No hay destinatarios seleccionados"); return; }

  let enviarEn = new Date();
  if (masCuando === "prog") {
    const f = $("masFecha").value, h = $("masHora").value;
    if (!f || !h) { toast("Falta la fecha o la hora"); return; }
    enviarEn = new Date(`${f}T${h}:00`);
    if (isNaN(enviarEn) || enviarEn <= new Date()) { toast("Programa una fecha futura"); return; }
  }

  const btn = $("masEnviar");
  btn.disabled = true; btn.textContent = "Enviando…";
  try {
    // La nota de voz se sube recién aquí (no al grabar): si el agente la
    // descarta y regraba tres veces, solo la definitiva llega al Storage.
    let media = masImg || null;
    if (masAudio) {
      $("masAudEstado").textContent = "Subiendo nota de voz…";
      media = await subirAudioMensaje(masAudio.blob, masAudio.ext);
      $("masAudEstado").textContent = "✓ Nota de voz lista";
    }

    const { data: camp, error: e1 } = await SB.from("campanas").insert({
      nombre: (tpl || (masAudio ? "Nota de voz" : "Imagen")).slice(0, 60), texto: tpl || null, media_url: media,
      enviar_en: enviarEn.toISOString(), total: sel.length,
    }).select("id").single();
    if (e1) throw e1;

    const rows = sel.map(c => ({
      campana_id: camp.id, tipo: "masivo", enviar_en: enviarEn.toISOString(),
      telefono: c.tel, texto: tpl ? resolverMensaje(tpl, c.nombre) : null, media_url: media,
    }));
    const { error: e2 } = await SB.from("mensajes_programados").insert(rows);
    if (e2) throw e2;

    toast(`✓ ${sel.length} mensaje(s) ${masCuando === "prog" ? "programado(s)" : "en cola"} · salen en goteo`);
    $("masOverlay").classList.remove("open");
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Enviar mensaje";
  }
}

/* ---------- wiring ---------- */
$("segBtnMasivo").onclick = abrir;
$("masCerrar").onclick = () => $("masOverlay").classList.remove("open");
$("masOverlay").onclick = e => { if (e.target.id === "masOverlay") $("masOverlay").classList.remove("open"); };
$("masTexto").oninput = renderPrev;
$("masBuscar").oninput = () => {
  $("masBuscarX").classList.toggle("hidden", !$("masBuscar").value);
  renderLista();
};
$("masBuscarX").onclick = () => {
  $("masBuscar").value = "";
  $("masBuscarX").classList.add("hidden");
  renderLista();
  $("masBuscar").focus();
};
$("masMarcar").onclick = () => { visibles().forEach(c => masSel.add(c.id)); renderLista(); };
$("masDesmarcar").onclick = () => { visibles().forEach(c => masSel.delete(c.id)); renderLista(); };

$("masCuandoSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
  masCuando = b.dataset.cuando;
  $("masCuandoSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  $("masProgRow").classList.toggle("hidden", masCuando !== "prog");
  renderCuando();
});
$("masFecha").onchange = renderCuando;
$("masHora").onchange = renderCuando;

$("masImgPick").onclick = () => $("masImgFile").click();
$("masImgFile").onchange = async () => {
  const file = $("masImgFile").files[0];
  if (!file) return;
  $("masImgEstado").textContent = "Subiendo…";
  try {
    const url = await subirImagenMensaje(file);
    setImg(url); $("masImgEstado").textContent = "✓ Imagen lista";
  } catch (err) {
    $("masImgEstado").textContent = "⚠ " + err.message;
  } finally { $("masImgFile").value = ""; }
};
$("masImgDel").onclick = () => { setImg(null); $("masImgEstado").textContent = ""; };

$("masAudRec").onclick = audGrabar;
$("masAudPause").onclick = audPausa;
$("masAudStop").onclick = () => { if (rec && rec.state !== "inactive") rec.stop(); };
$("masAudCancel").onclick = () => { if (rec && rec.state !== "inactive") { recDescartar = true; rec.stop(); } };
$("masAudDel").onclick = () => { limpiarAudio(); $("masAudEstado").textContent = ""; };

$("masGuardarSeg").onclick = async () => {
  if (!masSel.size) { toast("Selecciona personas primero"); return; }
  const nombre = prompt("Nombre del segmento (ej: VIP de México):");
  if (!nombre || !nombre.trim()) return;
  const { error } = await SB.from("segmentos").insert({ nombre: nombre.trim(), definicion: { ids: [...masSel] } });
  if (error) { toast("⚠ " + error.message); return; }
  toast(`Segmento «${nombre.trim()}» guardado`);
  const { data } = await SB.from("segmentos").select("id, nombre, definicion").order("created_at", { ascending: false });
  segmentos = data || []; renderSegs();
};

$("masEnviar").onclick = enviar;
