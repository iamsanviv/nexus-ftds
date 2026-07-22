// Compositor de mensajes masivos (libres, no atados a una actividad).
// Cada persona recibe un texto ya resuelto: {nombre} + snippets {a|b|c} para
// que no llegue idéntico (más seguro). Crea una "campaña" y N mensajes en cola.
import { SB } from "./supabase.js";
import { state, $, esc, toast, norm } from "./state.js";
import { subirImagenMensaje } from "./data.js";

const MEMS = ["Beca", "VIP", "Platino", "Oro", "Lead"];
let masSel = new Set();     // ids seleccionados
let masFiltro = "todos";    // filtro de membresía
let masImg = null;          // URL de imagen subida (o null)
let masCuando = "ahora";    // ahora | prog
let segmentos = [];         // segmentos guardados

const primerNombre = n => (n || "").trim().split(/\s+/)[0];
// Reemplaza cada {a|b|c} por una opción al azar (solo grupos con "|").
const resolverSnippets = t => (t || "").replace(/\{([^{}]*\|[^{}]*)\}/g,
  (m, g) => { const o = g.split("|"); return o[Math.floor(Math.random() * o.length)].trim(); });
const resolverMensaje = (tpl, nombre) => resolverSnippets(tpl).replaceAll("{nombre}", primerNombre(nombre));

const pool = () => state.clientes.filter(c => c.tel);

/* ---------- render ---------- */
function renderPrev() {
  const t = $("masTexto").value.trim();
  $("masPrev").textContent = t ? "Ej.: " + resolverMensaje(t, "Ana Bermúdez").slice(0, 90) : "";
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
  $("masCount").textContent = masSel.size ? `${masSel.size} seleccionados` : "";
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
  $("masProgRow").classList.add("hidden");
  $("masCuandoSeg").querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.cuando === "ahora"));
  renderFiltros(); renderLista();
  $("masOverlay").classList.add("open");
  const { data } = await SB.from("segmentos").select("id, nombre, definicion").order("created_at", { ascending: false });
  segmentos = data || []; renderSegs();
}

async function enviar() {
  const tpl = $("masTexto").value.trim();
  if (!tpl && !masImg) { toast("Escribe un mensaje o agrega una imagen"); return; }
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
    const { data: camp, error: e1 } = await SB.from("campanas").insert({
      nombre: (tpl || "Imagen").slice(0, 60), texto: tpl || null, media_url: masImg || null,
      enviar_en: enviarEn.toISOString(), total: sel.length,
    }).select("id").single();
    if (e1) throw e1;

    const rows = sel.map(c => ({
      campana_id: camp.id, tipo: "masivo", enviar_en: enviarEn.toISOString(),
      telefono: c.tel, texto: tpl ? resolverMensaje(tpl, c.nombre) : null, media_url: masImg || null,
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
});

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
