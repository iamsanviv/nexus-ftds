// Seguimiento automatizado (vista propia): se crean "actividades del día"
// (servicio + hora + enlace), se pueden editar/eliminar, y desde cada una
// se programan los mensajes de WhatsApp para quienes les falta.
// Las plantillas de mensajes son editables por agente (tabla plantillas_seguimiento).
// Tablas: actividades, seguimientos, mensajes_programados, plantillas_seguimiento.
import { SB } from "./supabase.js";
import { state, $, esc, toast, todos, hoyISO, resolverSnippets } from "./state.js";
import { render } from "./ui.js";
import { canalVinculado } from "./canal.js";
import { avisarSiCanalCaido } from "./salud.js";
import { subirImagenMensaje } from "./data.js";

/* ---------- plantillas ---------- */
// Tipos de mensaje programado (5 por persona). NO incluye invitacion_extra:
// esa es una variante de texto de la invitación, no un tipo aparte.
const TIPOS = ["invitacion", "rec_60", "rec_15", "enlace", "confirmacion"];
// Claves de plantilla editables (incluye la invitación extra).
const CLAVES_TPL = ["invitacion", "invitacion_extra", "rec_60", "rec_15", "enlace", "confirmacion"];

// Plantillas por defecto. Etiquetas: {nombre} {actividad} {hora} {enlace}
// Además admiten snippets {a|b|c}: se elige una opción al azar POR PERSONA,
// así no salen 50 mensajes con el texto idéntico. No anidar llaves dentro de
// un snippet, y no meter datos clave (hora, enlace) dentro de las variantes.
const PLANTILLAS_DEF = {
  invitacion:       `{¡Hola|¡Buenas|¡Qué más} {nombre}! 👋 {Hoy tenemos|Hoy nos vemos en|Hoy está} *{actividad}* a las {hora} (hora Colombia). {¡Te esperamos!|¡Ahí te espero!|¡No te la pierdas!} {¿Cuento contigo?|¿Te veo por allá?|¿Vienes?}`,
  // Se usa cuando la persona YA recibió una invitación hoy (otra actividad): sin saludo.
  invitacion_extra: `{Y hoy también tienes|Y ojo, hoy también está|Ah, y hoy además tenemos} *{actividad}* a las {hora} (hora Colombia). {¡Ahí te espero!|¡Te esperamos!|¡No te la pierdas!} {🙌|💪|✨}`,
  rec_60:           `{nombre}, {te recuerdo que|recuerda que|ojo que} en 1 hora empieza *{actividad}* ({hora}). {¡Ve preparándote!|¡Alístate!|¡Que no se te pase!} {🙌|⏰|💪}`,
  rec_15:           `¡{nombre}, en 15 minutos {arrancamos|empezamos|comenzamos} *{actividad}*! {🔥|🚀|⚡}`,
  enlace:           `¡{nombre}, {ya empezamos|ya arrancamos|estamos en vivo}! {Este es el enlace para entrar|Entra por aquí|Aquí tienes el enlace} 👉 {enlace}`,
  confirmacion:     `{nombre}, ¿{ya lograste entrar a la sala|pudiste entrar|lograste conectarte}? {Si tuviste algún problema, escríbeme y te ayudo|Cualquier cosa me escribes y te ayudo|Si algo falla, dime y lo resolvemos} 🙏`,
};

let plantillasUsuario = { ...PLANTILLAS_DEF };  // se sobreescribe al cargar

const horaCO = iso => new Date(iso).toLocaleTimeString("es-CO",
  { hour: "numeric", minute: "2-digit", hour12: true });

const fechaHoraCO = iso => new Date(iso).toLocaleString("es-CO",
  { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", hour12: true });

// Reemplaza las etiquetas de una plantilla con los datos reales.
// Primero resuelve los snippets {a|b|c} (al azar, por persona: como `aplicar`
// se llama una vez por contacto, cada quien recibe una redacción distinta) y
// luego sustituye las etiquetas. El token {enlace} no tiene "|", así que los
// snippets no lo tocan y el worker lo resuelve al enviar.
function aplicar(tpl, { nombre, actividad, hora, enlace }) {
  return resolverSnippets(tpl)
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
// Programar el seguimiento SIN mandar la invitación: para gente que ya se
// invitó por llamada o por otro mensaje. Los recordatorios, el enlace y la
// confirmación salen igual.
let segSinInvitacion = false;
// Quiénes YA tienen seguimiento para la actividad elegida. Sin esto, al volver
// a programar la misma actividad aparecían igual que el resto y era fácil
// duplicarles los mensajes sin darse cuenta.
let segYaProg = new Set();
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
  renderPrevPlantillas();
}

// Vista previa de cada plantilla ya resuelta: los snippets {a|b|c} se eligen al
// azar (como al enviar) y las etiquetas se llenan con datos de ejemplo. Así el
// agente ve el mensaje tal como le llegará a una persona antes de guardar.
function renderPrevPlantillas() {
  const ej = { nombre: "Ana", actividad: "Operativa", hora: "7:00 p. m.", enlace: "https://…" };
  for (const t of CLAVES_TPL) {
    const ta = $("tpl_" + t), prev = $("prev_" + t);
    if (!ta || !prev) continue;
    const txt = (ta.value || "").trim();
    prev.textContent = txt ? aplicar(txt, ej) : "";
  }
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
  renderPrevPlantillas();
  toast("Restaurado. Toca «Guardar mensajes» para aplicar.");
}

/* ================= FORMULARIO crear / editar actividad ================= */
const pad = n => String(n).padStart(2, "0");

// Una actividad puntual (lanzamiento, clase única) NO es un servicio: no se le
// marca asistencia ni cuenta para el progreso de nadie.
const esLibre = a => !a || !a.servicio_id;

let segTipoAct = "cat";   // "cat" (del catálogo) | "libre" (puntual)
let segImg = null;        // URL de la imagen subida para esta actividad

/* ---------- enlace rastreado ("trigger link") ---------- */
// Cada seguimiento lleva un token propio. El mensaje del enlace no manda la URL
// de Zoom sino `/i.html?t=<token>`: al abrirla se registra el clic, se marca la
// asistencia y se redirige a la sala. Así se sabe quién entró sin preguntárselo
// a cincuenta personas una por una.
//
// El token va en el SEGUIMIENTO y no en el mensaje porque identifica a la
// persona en esta actividad: sobrevive a que los mensajes se reprogramen si
// cambia la hora.
//
// Alfabeto sin los caracteres que se confunden al dictar un enlace por teléfono
// (l, o, 0, 1). 16 caracteres de 32 posibles = 80 bits: no se adivina.
const ALF_TOKEN = "abcdefghijkmnpqrstuvwxyz23456789";
const nuevoToken = () => {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  // 256 es múltiplo exacto de 32, así que el módulo no introduce sesgo.
  return [...b].map(x => ALF_TOKEN[x % ALF_TOKEN.length]).join("");
};

// `/i.html` y no `/i`: el worker sirve con `not_found_handling` en modo SPA, así
// que si Cloudflare no resolviera la extensión por su cuenta, `/i` devolvería el
// index.html y la persona vería la app en vez de la sala, sin ningún error a la
// vista. Con la extensión explícita no hay ambigüedad.
const urlRastreada = tok => `${location.origin}/i.html?t=${tok}`;

// El rastreo es lo predeterminado; las actividades creadas antes de esta función
// tienen la columna en nulo y también cuentan como encendidas (la base pone
// `true` por defecto, pero no se asume que el select la trajo).
const rastreaEnlace = a => !!a && a.rastrear !== false;

function renderForm() {
  $("segSrv").innerHTML = state.catalogo.map(g => `<optgroup label="${esc(g.g)}">` +
    g.items.map(s => `<option value="${s.id}">${esc(s.n)}</option>`).join("") +
    `</optgroup>`).join("");
  $("segFecha").value = hoyISO();
  $("segHora").value = "";
  $("segLink").value = "";
  $("segLibre").value = "";
  setImgActividad(null);
  $("segImgEstado").textContent = "";
  // Compartir solo aplica si hay a quién: es cosa de directores.
  $("segCompartirRow").classList.toggle("hidden", state.me.role !== "director");
  $("segCompartir").checked = true;
  $("segRastrear").checked = true;
  setTipoActividad("cat");
}

// Se separan dos preguntas que antes se confundían en una:
//   · esMia      → ¿puedo editarla o borrarla?
//   · deMiDirector → ¿la puso mi director para el equipo? (solo para etiquetar)
// Usar «no es mía» como sinónimo de «es de mi director» era el error: para un
// director, «no es mía» incluía las de sus propios agentes.
const esMia = a => !a.owner_id || a.owner_id === state.me.id;
const deMiDirector = a => !!state.me.directorId && a.owner_id === state.me.directorId;

// Alterna entre «del catálogo» y «puntual»: cambia qué campo se pide y el
// texto de ayuda de la imagen, porque una puntual no tiene servicio del que
// heredarla.
function setTipoActividad(tipo) {
  segTipoAct = tipo;
  $("segTipoAct").querySelectorAll("[data-tipo]").forEach(b =>
    b.classList.toggle("on", b.dataset.tipo === tipo));
  $("segSrvRow").classList.toggle("hidden", tipo !== "cat");
  $("segLibreRow").classList.toggle("hidden", tipo !== "libre");
  $("segImgAyuda").textContent = tipo === "libre"
    ? "Una actividad puntual no tiene servicio del cual heredar imagen: si no subes una, la invitación va sin imagen."
    : "Si no subes ninguna, se usa la del servicio del catálogo.";
}

function setImgActividad(url) {
  segImg = url || null;
  const img = $("segImgPrev"), del = $("segImgDel");
  if (url) { img.src = url; img.classList.remove("hidden"); del.classList.remove("hidden"); }
  else { img.src = ""; img.classList.add("hidden"); del.classList.add("hidden"); }
}

// El formulario vive plegado: crear una actividad se hace 1–2 veces al día,
// mientras que la lista y el registro se consultan todo el tiempo.
const abrirForm = () => $("segFormPanel").classList.remove("hidden");
const cerrarForm = () => $("segFormPanel").classList.add("hidden");

function entrarEdicion(a) {
  actEdit = a;
  const d = new Date(a.inicio);
  if (esLibre(a)) {
    setTipoActividad("libre");
    $("segLibre").value = a.nombre;
  } else {
    setTipoActividad("cat");
    if ([...$("segSrv").options].some(o => o.value === a.servicio_id)) $("segSrv").value = a.servicio_id;
  }
  setImgActividad(a.imagen);
  $("segImgEstado").textContent = "";
  $("segCompartirRow").classList.toggle("hidden", state.me.role !== "director");
  $("segCompartir").checked = !!a.compartida;
  $("segRastrear").checked = rastreaEnlace(a);
  $("segFecha").value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $("segHora").value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $("segLink").value = a.enlace;
  $("segFormTitulo").textContent = `Editando «${a.nombre}»`;
  $("segCrearAct").textContent = "Guardar cambios";
  $("segCancelEdit").classList.remove("hidden");
  abrirForm();
  $("segFormPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Sale del modo edición y deja el formulario limpio y plegado.
function salirEdicion() {
  actEdit = null;
  $("segFormTitulo").textContent = "Nueva actividad del día";
  $("segCrearAct").textContent = "Guardar actividad";
  $("segCancelEdit").classList.add("hidden");
  cerrarForm();
  renderForm();
}

// Tira de estado: pinta una cifra y su color según lo que significa.
// tono: "acc" (hay algo que atender), "good" (todo salió), "alert" (falló algo).
function setTile(tileId, numId, valor, tono) {
  const tile = $(tileId), num = $(numId);
  if (!tile || !num) return;
  num.textContent = valor;
  tile.classList.remove("acc", "good", "alert");
  if (valor > 0 && tono) tile.classList.add(tono);
}

async function guardarActividad() {
  const sel = $("segSrv").value;
  const libre = segTipoAct === "libre";
  const srv = libre ? null : todos().find(s => s.id === sel);
  const nombreLibre = $("segLibre").value.trim();
  const fecha = $("segFecha").value, hora = $("segHora").value;
  const enlace = $("segLink").value.trim();
  if (libre && !nombreLibre) { toast("Escribe el nombre de la actividad"); return; }
  if (!libre && !srv) { toast("Elige una actividad"); return; }
  if (!fecha || !hora) { toast("Falta la fecha o la hora"); return; }
  // El enlace es OPCIONAL: se puede agregar/editar después, antes de que salga
  // el mensaje del enlace.

  const inicio = new Date(`${fecha}T${hora}:00`);   // hora local = Colombia
  if (isNaN(inicio)) { toast("Fecha/hora inválida"); return; }
  if (inicio <= new Date()) { toast("La actividad debe ser en el futuro"); return; }

  const btn = $("segCrearAct");
  btn.disabled = true; btn.textContent = "Guardando…";
  try {
    const nombreAct = libre ? nombreLibre : srv.n;
    const datos = {
      servicio_id: libre ? null : sel,
      nombre: nombreAct,
      inicio: inicio.toISOString(), enlace,
      imagen: segImg,
      compartida: state.me.role === "director" && $("segCompartir").checked,
      rastrear: $("segRastrear").checked,
    };
    if (actEdit) {
      const cambioHora = new Date(actEdit.inicio).getTime() !== inicio.getTime();
      const { error } = await SB.from("actividades").update(datos).eq("id", actEdit.id);
      if (error) throw error;
      let reprog = null;
      if (cambioHora) {
        reprog = await reprogramarPorHora(actEdit.id, inicio.toISOString(), nombreAct, enlace);
      }
      // Propaga el enlace nuevo a los mensajes de "enlace" aún pendientes de los
      // seguimientos activos de esta actividad (por eso el link no se congela).
      //
      // OJO: los seguimientos CON token llevan su propia URL rastreada, y
      // pisarla con el enlace crudo apagaría el rastreo en silencio. Se decide
      // por seguimiento, lo que además resuelve el caso contrario: apagar el
      // rastreo de una actividad ya programada devuelve los pendientes al
      // enlace de siempre.
      const { data: segs } = await SB.from("seguimientos")
        .select("id, clic_token").eq("actividad_id", actEdit.id).eq("estado", "activo");
      const conTok = (segs || []).filter(s => s.clic_token);
      const sinTok = (segs || []).filter(s => !s.clic_token);
      const ponerEnlace = async (lista, valor) => {
        if (!lista.length) return;
        await SB.from("mensajes_programados")
          .update({ enlace_url: valor })
          .in("seguimiento_id", lista.map(s => s.id))
          .eq("tipo", "enlace").eq("estado", "pendiente");
      };
      await ponerEnlace(sinTok, enlace || null);
      // Con token y rastreo encendido NO se toca nada: su URL puente resuelve el
      // enlace vigente al abrirse, o sea justo el que se acaba de guardar.
      if (!datos.rastrear) await ponerEnlace(conTok, enlace || null);

      const notas = [];
      if (enlace && sinTok.length) notas.push("enlace aplicado a los pendientes");
      if (enlace && conTok.length) notas.push(datos.rastrear
        ? `${conTok.length} enlace(s) rastreado(s) ya apuntan al nuevo`
        : `${conTok.length} seguimiento(s) quedaron sin rastreo`);
      if (reprog && reprog.movidos) notas.push(`${reprog.movidos} mensaje(s) reprogramado(s)`);
      if (reprog && reprog.cancelados) notas.push(`${reprog.cancelados} ya no alcanzaban y se cancelaron`);
      toast("✓ Actividad actualizada" + (notas.length ? " · " + notas.join(" · ") : ""));
      if (actSel && actSel.id === actEdit.id) ocultarProg();
      salirEdicion();
    } else {
      const { error } = await SB.from("actividades").insert(datos);
      if (error) throw error;
      toast(`✓ Actividad «${nombreAct}» creada`);
      salirEdicion();   // deja el formulario limpio y plegado
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
    .select("id, servicio_id, nombre, inicio, enlace, estado, imagen, compartida, rastrear, owner_id")
    .eq("estado", "activa")
    .order("inicio", { ascending: true });
  if (error) {
    $("segActividades").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`;
    return;
  }
  // Las actividades de días pasados se cierran y desaparecen de la vista.
  const inicioHoy = new Date(); inicioHoy.setHours(0, 0, 0, 0);
  // Solo se cierran las propias: sobre las del director no hay permiso de
  // escritura, y pedirlo sería un update que no hace nada.
  const pasadas = (data || []).filter(a =>
    new Date(a.inicio) < inicioHoy && esMia(a));
  if (pasadas.length) {
    await SB.from("actividades").update({ estado: "cerrada" }).in("id", pasadas.map(a => a.id));
  }
  actividades = (data || []).filter(a => new Date(a.inicio) >= inicioHoy);
  $("segActsCnt").textContent = actividades.length;
  setTile("segTileActs", "segTActs", actividades.length, "acc");
  if (!actividades.length) {
    $("segActividades").innerHTML = `<div class="segempty">
      <div class="eh">Todavía no hay actividades</div>
      <p>Crea una con «＋ Nueva actividad» y desde ahí programas los mensajes.</p>
    </div>`;
    return;
  }
  // Cuántos de los que se programaron ya abrieron su enlace. Es la razón de ser
  // del rastreo, así que va en la tarjeta y no escondido en el registro.
  // Solo cuentan los seguimientos CON token: los de antes del rastreo (o de una
  // actividad con el rastreo apagado) no tienen nada que informar, y meterlos en
  // el denominador diría «0 de 30 entraron» de algo que nunca se midió.
  const entradas = new Map();   // actividad_id → { n, entraron, tarde }
  {
    const { data: segs } = await SB.from("seguimientos")
      .select("actividad_id, clic_token, clic_en, clics")
      .in("actividad_id", actividades.map(a => a.id))
      .neq("estado", "cancelado");
    for (const s of segs || []) {
      if (!s.clic_token) continue;
      const e = entradas.get(s.actividad_id) || { n: 0, entraron: 0, tarde: 0 };
      e.n++;
      // «Tarde» se cuenta aparte y NO suma a los que entraron: abrir el mensaje
      // al otro día no es haber asistido, pero sí dice que el mensaje llegó.
      if (s.clic_en) e.entraron++;
      else if (s.clics) e.tarde++;
      entradas.set(s.actividad_id, e);
    }
  }

  $("segActividades").innerHTML = actividades.map(a => {
    const mia = esMia(a);
    const ent = entradas.get(a.id);
    return `
    <article class="actcard">
      <div class="am">
        <h4>${esc(a.nombre)}</h4>
        <div class="ameta">
          <span class="atime">${fechaHoraCO(a.inicio)}</span>
          ${esLibre(a) ? `<span class="achip suelta" title="No está en el catálogo">✦ Puntual</span>` : ""}
          ${deMiDirector(a) ? `<span class="achip equipo" title="La creó tu director: puedes programar, no editar">👥 De tu director</span>` : ""}
          ${a.enlace
            ? `<span class="achip ok">Enlace listo</span>`
            : `<span class="achip miss">Falta el enlace</span>`}
          ${ent ? `<span class="achip ${ent.entraron ? "ok" : ""}"
            title="Abrieron su enlace dentro de la hora siguiente al inicio. Un clic dice que entró, no que se quedó."
            >👆 ${ent.entraron}/${ent.n} entraron</span>` : ""}
          ${ent && ent.tarde ? `<span class="achip"
            title="Abrieron el enlace más de una hora después: no cuenta como asistencia"
            >${ent.tarde} tarde</span>` : ""}
        </div>
      </div>
      <div class="ab">
        <button class="pmark" data-prog="${a.id}">📨 Programar</button>
        ${mia ? `
        <button class="pmark" data-edit="${a.id}" title="Editar actividad">✎</button>
        <button class="pmark off" data-delact="${a.id}" title="Eliminar actividad">✕</button>`
        : `<button class="pmark off" data-cancelact="${a.id}" title="Cancelar los seguimientos que tú programaste">✕ Mis seguimientos</button>`}
      </div>
    </article>`; }).join("");

  $("segActividades").querySelectorAll("[data-prog]").forEach(b => b.onclick = () => {
    const a = actividades.find(x => x.id === b.dataset.prog);
    if (a) seleccionarActividad(a);
  });
  $("segActividades").querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const a = actividades.find(x => x.id === b.dataset.edit);
    if (a) entrarEdicion(a);
  });
  // En una actividad compartida no se puede borrar la actividad (es del
  // director), pero sí desmontar lo que uno mismo programó sobre ella.
  $("segActividades").querySelectorAll("[data-cancelact]").forEach(b => b.onclick = async () => {
    const id = b.dataset.cancelact;
    const n = await contarSeguimientosDe(id);
    if (!n) { toast("No tienes seguimientos activos en esta actividad"); return; }
    if (!confirm(`¿Cancelar tus ${n} seguimiento(s) de esta actividad?\n\n`
               + `No se enviarán los mensajes pendientes. La actividad sigue ahí.`)) return;
    b.disabled = true;
    const cancelados = await cancelarSeguimientosDe(id);
    toast(`${cancelados} seguimiento(s) cancelado(s)`);
    renderActivos(); renderLogs();
    b.disabled = false;
  });

  $("segActividades").querySelectorAll("[data-delact]").forEach(b => b.onclick = async () => {
    const id = b.dataset.delact;
    // Se cancela ANTES de borrar: si se borra primero, los seguimientos
    // quedan huérfanos y ya no hay por dónde alcanzarlos.
    const n = await contarSeguimientosDe(id);
    const aviso = n
      ? `¿Eliminar esta actividad?\n\nSe cancelarán también ${n} seguimiento(s) activo(s) y sus mensajes pendientes.`
      : "¿Eliminar esta actividad?";
    if (!confirm(aviso)) return;
    b.disabled = true;
    const cancelados = await cancelarSeguimientosDe(id);
    const { error } = await SB.from("actividades").delete().eq("id", id);
    if (error) { toast("⚠ " + error.message); b.disabled = false; return; }
    if (cancelados) toast(`Actividad eliminada · ${cancelados} seguimiento(s) cancelado(s)`);
    if (actSel && actSel.id === b.dataset.delact) ocultarProg();
    if (actEdit && actEdit.id === b.dataset.delact) salirEdicion();
    await cargarActividades();
  });
}

/* ================= SELECCIÓN + PROGRAMACIÓN ================= */
// Solo se le escribe a los clientes PROPIOS. Un director ve los de sus agentes
// para supervisar, pero los mensajes saldrían desde SU WhatsApp a gente que no
// lo agregó: eso no se hace. Cada quien escribe a los suyos.
const mios = () => state.clientes.filter(c => c.tel && c.owner_id === state.me.id);

// A quienes les falta la actividad. Sin servicio (actividad puntual) no hay
// asistencia que consultar: entran todos los que tengan teléfono.
function faltantes(sid) {
  return mios().filter(c => !sid || !c.acc[sid]);
}

// Universo elegible para programar: los que faltan, y —si el toggle está
// activo— también quienes ya asistieron (para reinvitarlos).
function elegibles(sid) {
  if (!sid) return mios();
  return mios().filter(c => !c.acc[sid] || segIncAsis);
}

// Un seguimiento cancelado NO cuenta: se deshizo a propósito, así que volver a
// programarlo es legítimo.
async function cargarYaProgramados(actividadId) {
  segYaProg = new Set();
  const { data } = await SB.from("seguimientos")
    .select("cliente_id").eq("actividad_id", actividadId).neq("estado", "cancelado");
  (data || []).forEach(s => segYaProg.add(s.cliente_id));
}

async function seleccionarActividad(a) {
  actSel = a;
  segFiltroMem = "todos";
  segBuscarTxt = "";
  segIncAsis = false;
  segInvitarTarde = null;
  segSinInvitacion = false;
  const bs = $("segBuscar"); if (bs) bs.value = "";
  const bx = $("segBuscarX"); if (bx) bx.classList.add("hidden");
  const ia = $("segIncAsis"); if (ia) ia.checked = false;
  // Sin servicio no hay asistencia, así que «incluir a quienes ya asistieron»
  // no significa nada: se esconde en vez de dejar un control muerto.
  const iaRow = $("segIncAsis").closest("label");
  if (iaRow) iaRow.classList.toggle("hidden", esLibre(a));
  const si = $("segSinInv"); if (si) si.checked = false;
  const tr = $("segTardeRow"); if (tr) tr.classList.add("hidden");
  const tt = $("segTardeToggle"); if (tt) { tt.classList.remove("on"); tt.classList.remove("hidden"); }
  $("segProgTitulo").innerHTML = `Programar para <b>${esc(a.nombre)}</b> · ${fechaHoraCO(a.inicio)}`;
  refrescarBotonProgramar();
  $("segProgBloque").classList.remove("hidden");
  $("segFaltan").innerHTML = `<div class="naplica">Cargando…</div>`;
  renderSegmentos();

  await cargarYaProgramados(a.id);
  // Por defecto: la comunidad que le falta la actividad (no Leads) y a la que
  // NO se le haya programado ya. Repetir sería mandarle todo dos veces.
  segSel = new Set(faltantes(a.servicio_id)
    .filter(c => !esLeadMem(c.mem) && !segYaProg.has(c.id))
    .map(c => c.id));
  renderFaltan();
  $("segProgBloque").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function ocultarProg() {
  actSel = null;
  segSel = new Set();
  segYaProg = new Set();
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
  const sid = actSel.servicio_id;          // null si es una actividad puntual
  const lista = elegibles(sid);
  const sinTel = state.clientes.filter(c =>
    c.owner_id === state.me.id && (!sid || !c.acc[sid] || segIncAsis) && !c.tel).length;

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
    ? visibles.map(c => {
        const prog = segYaProg.has(c.id);
        return `
        <label class="seg-row${prog ? " yaprogfila" : ""}">
          <input type="checkbox" data-cid="${c.id}" ${segSel.has(c.id) ? "checked" : ""}>
          <span class="badge b-${c.mem}">${c.mem}</span>
          <span>${esc(c.nombre)}</span>
          ${prog ? `<span class="yaprog" title="Ya tiene los mensajes programados para esta actividad">✓ ya programado</span>` : ""}
          ${sid && c.acc[sid] ? `<span class="yaasis">ya asistió</span>` : ""}
        </label>`; }).join("")
    : `<div class="naplica">${q ? "Nadie coincide con la búsqueda." : "Nadie en este filtro."}</div>`;
  if (sinTel && segFiltroMem === "todos" && !q) $("segFaltan").insertAdjacentHTML("beforeend",
    `<div class="naplica">${sinTel} persona(s) sin teléfono no aparecen aquí.</div>`);

  $("segFaltan").querySelectorAll("input[data-cid]").forEach(inp => inp.onchange = () => {
    inp.checked ? segSel.add(inp.dataset.cid) : segSel.delete(inp.dataset.cid);
    actualizarConteo();
  });

  // botones marcar/desmarcar actúan sobre lo VISIBLE. «Marcar» salta a los que
  // ya tienen seguimiento: marcar de golpe es justo donde se cuelan los
  // duplicados. Si quieres uno de esos, lo marcas a mano.
  $("segMarcarVis").onclick = () => {
    const nuevos = visibles.filter(c => !segYaProg.has(c.id));
    nuevos.forEach(c => segSel.add(c.id));
    const omitidos = visibles.length - nuevos.length;
    renderFaltan();
    if (omitidos) toast(`${omitidos} ya tenían seguimiento · no se marcaron`);
  };
  $("segDesmarcarVis").onclick = () => { visibles.forEach(c => segSel.delete(c.id)); renderFaltan(); };
  actualizarConteo();
}

// ¿Hay WhatsApp vinculado? Sin él se puede usar todo el módulo —crear
// actividades, organizar, ver el registro— salvo poner mensajes en cola, que
// solo produciría envíos fallidos.
let canalListo = true;

async function revisarCanal() {
  canalListo = await canalVinculado();
  const cont = $("segSinCanal");
  if (canalListo) { cont.classList.add("hidden"); cont.innerHTML = ""; }
  else {
    cont.innerHTML = `
      <div class="alerta ojo">
        <div class="at">Tu WhatsApp no está vinculado</div>
        <div class="ax">Puedes crear actividades, organizar tu lista y revisar el registro,
          pero no programar envíos: saldrían todos con error. Vincúlalo en
          «Más → Mi WhatsApp» y vuelve.</div>
      </div>`;
    cont.classList.remove("hidden");
  }
  refrescarBotonProgramar();
}

// El botón dice lo que va a pasar: es el último punto donde el agente puede
// darse cuenta de que olvidó (o dejó puesto) el modo «sin invitación».
const etiquetaProgramar = () =>
  !canalListo ? "Vincula tu WhatsApp para programar"
  : segSinInvitacion ? "Programar sin invitación" : "Programar mensajes";
const refrescarBotonProgramar = () => {
  const b = $("segProgramar");
  b.textContent = etiquetaProgramar();
  b.disabled = !canalListo;
};

function actualizarConteo() {
  if (!actSel) return;
  const uni = elegibles(actSel.servicio_id);
  const total = uni.length;
  const sel = uni.filter(c => segSel.has(c.id)).length;
  const yaProg = uni.filter(c => segYaProg.has(c.id)).length;
  $("segSelCount").textContent = `${sel} de ${total} seleccionados`
    + (yaProg ? ` · ${yaProg} ya programado${yaProg === 1 ? "" : "s"}` : "");
}

async function programar() {
  if (!actSel) { toast("Elige una actividad primero"); return; }
  // Se vuelve a comprobar aquí (no solo al entrar): el canal pudo caerse
  // mientras el agente armaba la selección, y encolar sin canal solo genera
  // errores.
  if (!(await canalVinculado())) {
    await revisarCanal();
    toast("Vincula tu WhatsApp en «Más → Mi WhatsApp» para poder programar");
    return;
  }
  const inicio = new Date(actSel.inicio);
  const ahora = new Date();
  if (inicio <= ahora) { toast("Esta actividad ya empezó; crea una nueva"); return; }

  const seleccion = elegibles(actSel.servicio_id).filter(c => segSel.has(c.id));
  if (!seleccion.length) { toast("No hay nadie seleccionado"); return; }

  // Última red antes de duplicar: si alguien marcado ya tiene seguimiento para
  // esta actividad, recibiría todo dos veces.
  const repetidos = seleccion.filter(c => segYaProg.has(c.id));
  if (repetidos.length) {
    const quienes = repetidos.slice(0, 3).map(c => c.nombre.split(" ")[0]).join(", ");
    const resto = repetidos.length > 3 ? ` y ${repetidos.length - 3} más` : "";
    if (!confirm(`${repetidos.length} persona(s) ya tienen seguimiento para esta actividad (${quienes}${resto}).\n\n`
               + `Si continúas les llegarán los mensajes DOS veces. ¿Programar de todas formas?`)) return;
  }

  // Si se difirió la invitación, debe caer entre ahora y el inicio de la actividad.
  // (No aplica si no se va a enviar invitación.)
  if (!segSinInvitacion && segInvitarTarde) {
    if (segInvitarTarde <= ahora) { toast("La hora de envío ya pasó; elige una futura"); return; }
    if (segInvitarTarde >= inicio) { toast("La invitación debe salir antes de que empiece la actividad"); return; }
  }

  const btn = $("segProgramar");
  btn.disabled = true; btn.textContent = "Programando…";
  try {
    // 1) un seguimiento por persona (copia los datos de la actividad).
    // Si la actividad rastrea, cada uno nace con su token: es lo que después
    // permite decir QUIÉN entró, y no solo cuántos.
    const rastrear = rastreaEnlace(actSel);
    const segRows = seleccion.map(c => ({
      cliente_id: c.id, actividad_id: actSel.id, actividad: actSel.nombre,
      inicio: actSel.inicio, enlace: actSel.enlace,
      clic_token: rastrear ? nuevoToken() : null,
    }));
    const { data: segs, error: e1 } = await SB.from("seguimientos")
      .insert(segRows).select("id, cliente_id, clic_token");
    if (e1) throw e1;

    // ¿Quiénes ya recibieron una invitación HOY (otra actividad)? Para no
    // repetir el saludo, esos usan la invitación "extra" (sin hola).
    // Si no se va a invitar, esta consulta no hace falta.
    const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
    const finDia = new Date(); finDia.setHours(23, 59, 59, 999);
    const tels = [...new Set(seleccion.map(c => c.tel))];
    let yaInvitados = new Set();
    if (tels.length && !segSinInvitacion) {
      const { data: previas } = await SB.from("mensajes_programados")
        .select("telefono")
        .eq("tipo", "invitacion")
        .neq("estado", "cancelado")
        .in("telefono", tels)
        .gte("enviar_en", inicioDia.toISOString())
        .lte("enviar_en", finDia.toISOString());
      yaInvitados = new Set((previas || []).map(r => r.telefono));
    }

    // 2) los mensajes por persona (se omiten los que ya quedaron en el pasado).
    // La invitación sale "ahora" salvo que se haya elegido diferirla, y se
    // omite del todo si el agente ya invitó por fuera: en ese caso el
    // seguimiento arranca directo en los recordatorios.
    const cuandoInv = (segInvitarTarde && segInvitarTarde > ahora) ? segInvitarTarde : ahora;
    const msgs = [];
    const tiempos = () => {
      const t = [
        ["rec_60",       new Date(inicio.getTime() - 60 * 60000)],
        ["rec_15",       new Date(inicio.getTime() - 15 * 60000)],
        ["enlace",       inicio],
        ["confirmacion", new Date(inicio.getTime() + 10 * 60000)],
      ];
      if (!segSinInvitacion) t.unshift(["invitacion", cuandoInv]);
      return t;
    };
    for (const seg of segs) {
      const c = seleccion.find(x => x.id === seg.cliente_id);
      const tpl = plantillas(c.nombre, actSel.nombre, actSel.inicio, actSel.enlace, yaInvitados.has(c.tel));
      for (const [tipo, cuando] of tiempos()) {
        if (tipo !== "invitacion" && cuando <= ahora) continue; // ya pasó
        const fila = {
          seguimiento_id: seg.id, tipo, enviar_en: cuando.toISOString(),
          telefono: c.tel, texto: tpl[tipo],
        };
        // Imagen de la invitación, por orden de precedencia:
        //   1. la subida para ESTA actividad → media_url (vía ya probada: hay
        //      invitaciones enviadas con media_url y sin servicio_id).
        //   2. si no hay, y la actividad es de un servicio, se manda el
        //      servicio_id y el worker resuelve la imagen vigente al enviar,
        //      así no se congela si se cambia después.
        // Se manda UNA sola de las dos, para que no haya ambigüedad.
        if (tipo === "invitacion") {
          if (actSel.imagen) fila.media_url = actSel.imagen;
          else if (actSel.servicio_id) fila.servicio_id = actSel.servicio_id;
        }
        // El enlace se resuelve al enviar (el texto conserva el token {enlace}).
        // Con rastreo, cada persona recibe SU url puente en vez de la de Zoom:
        // el clic queda a su nombre y el destino se resuelve vigente al abrirlo,
        // así que da igual que la sala todavía no esté puesta.
        if (tipo === "enlace") {
          fila.enlace_url = seg.clic_token
            ? urlRastreada(seg.clic_token)
            : (actSel.enlace || null);
        }
        msgs.push(fila);
      }
    }
    const { error: e2 } = await SB.from("mensajes_programados").insert(msgs);
    if (e2) throw e2;

    // Marca a los seleccionados como "invitados" al servicio (si no lo estaban),
    // así pasan de «por invitar» a «invitados» en la vista por servicio.
    // NO se toca `acc`: quien ya asistió y es reinvitado conserva su asistencia.
    const hoy = hoyISO();
    if (actSel.servicio_id) {
      // Actividad del catálogo: `conf` va indexado por servicio.
      for (const c of seleccion) {
        if (!(c.conf || {})[actSel.servicio_id]) {
          c.conf = { ...(c.conf || {}), [actSel.servicio_id]: hoy };
          await SB.from("clientes").update({ conf: c.conf }).eq("id", c.id);
        }
      }
    } else {
      // Actividad puntual: se guarda en su propio mapa, con el nombre y la
      // hora copiados, para que el perfil y el repaso no dependan de que la
      // actividad siga existiendo.
      for (const c of seleccion) {
        if (!(c.pun || {})[actSel.id]) {
          c.pun = { ...(c.pun || {}),
            [actSel.id]: { n: actSel.nombre, i: actSel.inicio, conf: hoy } };
          await SB.from("clientes").update({ puntuales: c.pun }).eq("id", c.id);
        }
      }
    }

    // Guarda la selección en el historial de segmentos (automático).
    await guardarSegmentoHistorial(seleccion.map(c => c.id), actSel.nombre);

    const nota = segSinInvitacion
      ? " · sin invitación (empieza en los recordatorios)"
      : (segInvitarTarde && segInvitarTarde > ahora)
        ? ` · invitación sale ${fechaHoraCO(cuandoInv.toISOString())}` : "";
    toast(`✓ ${segs.length} seguimiento(s) · ${msgs.length} mensaje(s) programado(s)${nota}`
        + (rastrear ? " · enlace rastreado" : ""));
    ocultarProg();
    renderActivos();
    renderLogs();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    // No se re-habilita a ciegas: si el canal se cayó mientras tanto, el botón
    // debe quedar deshabilitado.
    refrescarBotonProgramar();
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

/* ================= CANCELAR EN BLOQUE ================= */
// Cancela los seguimientos activos de una actividad y sus mensajes pendientes.
// El RLS decide el alcance solo: un agente cancela los suyos; un director,
// además, los de sus agentes. No hace falta filtrar aquí por dueño.
// Devuelve cuántos seguimientos se cancelaron.
async function cancelarSeguimientosDe(actividadId) {
  const { data: segs } = await SB.from("seguimientos")
    .select("id").eq("actividad_id", actividadId).eq("estado", "activo");
  const ids = (segs || []).map(s => s.id);
  if (!ids.length) return 0;
  await SB.from("mensajes_programados")
    .update({ estado: "cancelado" }).in("seguimiento_id", ids).eq("estado", "pendiente");
  await SB.from("seguimientos").update({ estado: "cancelado" }).in("id", ids);
  return ids.length;
}

// Cuántos seguimientos activos tiene una actividad, dentro de lo que quien
// pregunta puede ver. Sirve para decir en el aviso qué se va a cancelar.
async function contarSeguimientosDe(actividadId) {
  const { count } = await SB.from("seguimientos")
    .select("id", { count: "exact", head: true })
    .eq("actividad_id", actividadId).eq("estado", "activo");
  return count || 0;
}

/* ================= CAMBIO DE HORA ================= */
// Si se mueve la hora de una actividad, los mensajes pendientes quedan mal en
// dos sentidos: saldrían a la hora vieja Y el texto anunciaría una hora que ya
// no es («en 1 hora empieza X (7:00 p. m.)»). Se corrigen ambos.
//
// La invitación no se re-temporiza —su hora es cuándo invitas, no cuándo
// empieza— pero su texto sí menciona la hora, así que se regenera igual.
//
// El texto solo se regenera en los seguimientos PROPIOS: los de un agente se
// escribieron con SUS plantillas, y sobreescribirlos con las del director le
// cambiaría la redacción a alguien más. A esos solo se les corrige la hora.
async function reprogramarPorHora(actividadId, nuevoInicioISO, nombreAct, enlace) {
  const { data: segs } = await SB.from("seguimientos")
    .select("id, owner_id, clientes(nombre)")
    .eq("actividad_id", actividadId).eq("estado", "activo");
  if (!segs || !segs.length) return { movidos: 0, cancelados: 0 };

  const info = new Map(segs.map(s =>
    [s.id, { mio: s.owner_id === state.me.id, nombre: s.clientes?.nombre || "" }]));

  const { data: msgs } = await SB.from("mensajes_programados")
    .select("id, tipo, seguimiento_id")
    .in("seguimiento_id", [...info.keys()]).eq("estado", "pendiente");
  if (!msgs || !msgs.length) return { movidos: 0, cancelados: 0 };

  const t = new Date(nuevoInicioISO).getTime();
  const nuevaHora = {
    rec_60:       new Date(t - 60 * 60000),
    rec_15:       new Date(t - 15 * 60000),
    enlace:       new Date(t),
    confirmacion: new Date(t + 10 * 60000),
  };
  const ahora = Date.now();

  // Un texto por seguimiento (no por mensaje): así el sorteo de snippets sale
  // una sola vez por persona, igual que al programar.
  const textos = new Map();
  for (const [id, d] of info) {
    if (d.mio && d.nombre) textos.set(id, plantillas(d.nombre, nombreAct, nuevoInicioISO, enlace, false));
  }

  const aCancelar = [];
  const tareas = [];
  for (const m of msgs) {
    const tpl = textos.get(m.seguimiento_id);
    const cuando = nuevaHora[m.tipo];
    const campos = {};
    if (tpl && tpl[m.tipo]) campos.texto = tpl[m.tipo];
    if (cuando) {
      // Si con la hora nueva ese recordatorio ya quedó en el pasado, no se
      // programa hacia atrás: se cancela.
      if (cuando.getTime() <= ahora) { aCancelar.push(m.id); continue; }
      campos.enviar_en = cuando.toISOString();
    }
    if (Object.keys(campos).length)
      tareas.push(SB.from("mensajes_programados").update(campos).eq("id", m.id));
  }

  // En tandas para no abrir cien peticiones a la vez.
  for (let i = 0; i < tareas.length; i += 20) await Promise.all(tareas.slice(i, i + 20));
  if (aCancelar.length) {
    await SB.from("mensajes_programados").update({ estado: "cancelado" }).in("id", aCancelar);
  }
  return { movidos: tareas.length, cancelados: aCancelar.length };
}

/* ================= SEGUIMIENTOS ACTIVOS ================= */
// La ventana de asistencia (una hora desde el inicio) la decide la base, no
// esta función: `clic_en` es el primer clic QUE CONTÓ, así que tener `clics`
// con `clic_en` en nulo significa exactamente «abrió, pero ya tardísimo». Aquí
// solo se traduce a palabras, sin repetir el cálculo.
//
// «Aún no entra» solo se dice DESPUÉS de la hora de inicio: antes de empezar no
// es una noticia, es lo normal, y el aviso solo pondría nervioso al agente.
function entradaChip(s) {
  if (s.clic_en) return `<span class="achip ok" title="Abrió su enlace el ${
    esc(fechaHoraCO(s.clic_en))}">👆 Entró</span>`;
  if (s.clics) return `<span class="achip" title="Abrió su enlace más de una hora
    después de que empezó: no cuenta como asistencia">👆 Abrió tarde</span>`;
  if (!s.clic_token || new Date(s.inicio) > new Date()) return "";
  return `<span class="achip miss" title="No ha abierto su enlace">Aún no entra</span>`;
}

async function renderActivos() {
  const { data, error } = await SB.from("seguimientos")
    .select("id, cliente_id, actividad_id, actividad, inicio, estado, clic_token, clic_en, clics, clientes(nombre)")
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
  setTile("segTileActivos", "segTActivos", activos.length, "acc");
  if (!activos.length) {
    $("segActivos").innerHTML = `<div class="segempty">
      <div class="eh">Nada en curso ahora mismo</div>
      <p>Cuando programes mensajes para una actividad, aquí ves a quién le están saliendo y puedes cancelar.</p>
    </div>`;
    return;
  }

  $("segActivos").innerHTML = activos.map(s => `
    <article class="actcard">
      <div class="am">
        <h4>${esc(s.clientes?.nombre || "(cliente)")}</h4>
        <div class="ameta">
          <span class="atime">${esc(s.actividad)} · <b>${fechaHoraCO(s.inicio)}</b></span>
          ${entradaChip(s)}
        </div>
      </div>
      <div class="ab">
        <button class="pmark off" data-cancel="${s.id}">✕ Cancelar</button>
      </div>
    </article>`).join("");

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
  // «Volver a por invitar» solo tiene sentido si la actividad es de un
  // servicio: en una puntual no hay `conf` que quitar. Si la actividad ya no
  // está cargada no se asume nada y se deja el botón (la acción es null-safe).
  const act = actividades.find(x => x.id === s.actividad_id);
  const sinServicio = !!act && esLibre(act);
  $("repSub").textContent = "Cancelar seguimiento";
  $("repBody").innerHTML = `
    <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
      <div style="font-size:.95rem">Vas a cancelar el seguimiento de <b>${esc(nombre)}</b>
        para <b>${esc(s.actividad)}</b>. No se enviarán los mensajes pendientes.
        <span class="sfecha">¿En qué estado dejas a la persona?</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="pmark" data-cx="invitado">Dejarla como «invitada»</button>
        ${sinServicio ? "" : `<button class="pmark off" data-cx="porinvitar">Volver a «por invitar»</button>`}
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
  // Las etiquetas deben coincidir con los tiempos reales de `tiempos()`:
  // rec_15 sale 15 min ANTES; confirmacion, 10 min DESPUÉS del inicio.
  invitacion: "Invitación", rec_60: "Recordatorio 1 h", rec_15: "Recordatorio 15 min",
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

  // Chips de filtro con conteos. Las cifras de la tira de estado salen de esta
  // misma ventana de 60 mensajes, así chip y tira siempre concuerdan.
  const n = e => todas.filter(m => m.estado === e).length;
  $("segLogsCnt").textContent = todas.length;
  setTile("segTileEnv", "segTEnv", n("enviado"), "good");
  setTile("segTileErr", "segTErr", n("error"), "alert");
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

  // Mapa teléfono → nombre, para resolver el nombre en mensajes masivos
  // (que no tienen seguimiento_id → clientes asociados).
  const porTel = new Map();
  for (const c of state.clientes) if (c.tel) porTel.set(c.tel, c.nombre);

  $("segLogs").innerHTML = filas.map(m => {
    const nombre = m.seguimientos?.clientes?.nombre || porTel.get(m.telefono) || m.telefono;
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
// Seguimiento disponible para todos los agentes, con la condición de tener el
// WhatsApp vinculado (si no, los mensajes no podrían salir desde su número).
// Seguimiento está abierto a todos. Tener el WhatsApp vinculado solo hace falta
// para poner mensajes en cola; el resto del módulo funciona igual.
$("btnSeg").onclick = async () => {
  state.vista = "seguimiento";
  render();
  $("segMsgsPanel").classList.add("hidden");
  // El registro es consulta, no acción: en celular arranca plegado para no
  // llenar la pantalla; en escritorio va desplegado en su propio riel.
  $("segLogSec").open = window.matchMedia("(min-width:900px)").matches;
  salirEdicion(); ocultarProg(); cargarPlantillas(); cargarActividades();
  cargarSegmentos(); renderActivos(); renderLogs();
  // Si el canal está caído o los mensajes vienen fallando, avisarlo arriba
  // en vez de dejar que el agente lo descubra días después.
  avisarSiCanalCaido();
  revisarCanal();
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

// Toggle "sin invitación": si no se manda invitación, diferirla no significa
// nada, así que se esconde ese botón y se descarta la hora elegida.
$("segSinInv").onchange = e => {
  segSinInvitacion = e.target.checked;
  $("segTardeToggle").classList.toggle("hidden", segSinInvitacion);
  if (segSinInvitacion) {
    segInvitarTarde = null;
    $("segTardeRow").classList.add("hidden");
    $("segTardeToggle").classList.remove("on");
  }
  refrescarBotonProgramar();
};

// Guardar la selección actual como segmento permanente (Req 3).
$("segGuardarSeg").onclick = guardarSegmentoManual;

$("segVolver").onclick = () => { state.vista = "cliente"; render(); };
$("segCancelEdit").onclick = salirEdicion;
$("segCrearAct").onclick = guardarActividad;
$("segTipoAct").querySelectorAll("[data-tipo]").forEach(b =>
  b.onclick = () => setTipoActividad(b.dataset.tipo));

/* ---------- imagen de la actividad ---------- */
// Se sube al bucket `mensajes` con nombre único: es de esta actividad, no del
// catálogo, así que no debe pisar la imagen de ningún servicio.
$("segImgPick").onclick = () => $("segImgFile").click();
$("segImgFile").onchange = async () => {
  const file = $("segImgFile").files[0];
  if (!file) return;
  $("segImgEstado").textContent = "Subiendo…";
  try {
    setImgActividad(await subirImagenMensaje(file));
    $("segImgEstado").textContent = "✓ Imagen lista";
  } catch (err) {
    $("segImgEstado").textContent = "⚠ " + err.message;
  } finally { $("segImgFile").value = ""; }
};
$("segImgDel").onclick = () => { setImgActividad(null); $("segImgEstado").textContent = ""; };
// ＋ Nueva actividad: abre el formulario plegado (o lo cierra si ya estaba).
$("segNuevaAct").onclick = () => {
  if (!$("segFormPanel").classList.contains("hidden")) { salirEdicion(); return; }
  salirEdicion();      // limpia cualquier edición previa
  abrirForm();
  $("segFormPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
};
$("segFormCerrar").onclick = salirEdicion;
$("segProgramar").onclick = programar;
$("segBtnMsgs").onclick = () => $("segMsgsPanel").classList.toggle("hidden");
$("segMsgsGuardar").onclick = guardarPlantillas;
$("segMsgsReset").onclick = resetPlantillas;
// La vista previa se recalcula al escribir y al pedir "otro ejemplo" (vuelve a
// sortear los snippets, para comprobar que todas las variantes suenan bien).
$("segMsgsDado").onclick = renderPrevPlantillas;
for (const t of CLAVES_TPL) { const el = $("tpl_" + t); if (el) el.oninput = renderPrevPlantillas; }
