// Seguimiento automatizado (vista propia): se crean "actividades del día"
// (servicio + hora + enlace), se pueden editar/eliminar, y desde cada una
// se programan los mensajes de WhatsApp para quienes les falta.
// Las plantillas de mensajes son editables por agente (tabla plantillas_seguimiento).
// Tablas: actividades, seguimientos, mensajes_programados, plantillas_seguimiento.
import { SB } from "./supabase.js";
import { state, $, esc, toast, todos, hoyISO, resolverSnippets, syncZoom,
  horaDeCliente, etiquetaZona } from "./state.js";
import { render } from "./ui.js";
import { canalVinculado } from "./canal.js";
import { avisarSiCanalCaido } from "./salud.js";
import { subirImagenMensaje, guardarHistorialSegmento } from "./data.js";
import { BASE_URL } from "./config.js";

/* ---------- plantillas ---------- */
// Tipos de mensaje programado (5 por persona). NO incluye invitacion_extra:
// esa es una variante de texto de la invitación, no un tipo aparte.
const TIPOS = ["invitacion", "rec_60", "rec_15", "enlace", "confirmacion"];
// Claves de plantilla editables (incluye la invitación extra).
const CLAVES_TPL = ["invitacion", "invitacion_extra", "rec_60", "rec_15", "enlace", "confirmacion"];

// Plantillas por defecto. Etiquetas: {nombre} {actividad} {hora} {zona} {enlace}
// {hora} sale en la hora de pared de cada persona si su perfil tiene desfase.
// {zona} solo escribe algo cuando esa hora vino convertida —«(tu hora)»— y se
// va vacía, con su espacio, cuando la persona tiene la misma hora que Colombia.
// Van juntas: una hora convertida sin avisar hace que la persona la convierta
// otra vez y llegue tarde.
// Además admiten snippets {a|b|c}: se elige una opción al azar POR PERSONA,
// así no salen 50 mensajes con el texto idéntico. No anidar llaves dentro de
// un snippet, y no meter datos clave (hora, enlace) dentro de las variantes.
const PLANTILLAS_DEF = {
  invitacion:       `{¡Hola|¡Buenas|¡Qué más} {nombre}! 👋 {Hoy tenemos|Hoy nos vemos en|Hoy está} *{actividad}* a las {hora} {zona}. {¡Te esperamos!|¡Ahí te espero!|¡No te la pierdas!} {¿Cuento contigo?|¿Te veo por allá?|¿Vienes?}`,
  // Se usa cuando la persona YA recibió una invitación hoy (otra actividad): sin saludo.
  invitacion_extra: `{Y hoy también tienes|Y ojo, hoy también está|Ah, y hoy además tenemos} *{actividad}* a las {hora} {zona}. {¡Ahí te espero!|¡Te esperamos!|¡No te la pierdas!} {🙌|💪|✨}`,
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
//
// {zona} se va VACÍA la mayor parte del tiempo (ver etiquetaZona), y la
// plantilla la escribe pegada a un espacio: «a las {hora} {zona}.». Si solo se
// sustituyera el token quedaría «a las 7:00 p. m. .» —espacio suelto y punto
// separado— en casi todos los mensajes. Por eso se consume también el espacio
// vecino: primero el de delante, después el de detrás (para un {zona} que abra
// la frase) y al final un {zona} pegado a otra cosa.
function aplicar(tpl, { nombre, actividad, hora, zona, enlace }) {
  const z = zona || "";
  const txt = resolverSnippets(tpl)
    .replaceAll("{nombre}", nombre)
    .replaceAll("{actividad}", actividad)
    .replaceAll("{hora}", hora)
    .replaceAll(" {zona}", z ? " " + z : "")
    .replaceAll("{zona} ", z ? z + " " : "")
    .replaceAll("{zona}", z)
    .replaceAll("{enlace}", enlace);
  // Segundo arreglo del mismo hueco: la hora en español TERMINA en punto
  // («7:00 p. m.»), así que «{hora} {zona}.» con la zona vacía dejaba
  // «7:00 p. m..». Se colapsan solo los pares de puntos —el lookbehind y el
  // lookahead dejan intactos los suspensivos— y solo cuando la zona se fue
  // vacía: con etiqueta el punto de la plantilla es el único que hay.
  return z ? txt : txt.replace(/(?<!\.)\.\.(?!\.)/g, ".");
}

// yaInvitado: si la persona ya recibió una invitación hoy, la invitación de
// esta actividad usa la variante "extra" (sin saludo) para no repetir el hola.
// El mensaje de "enlace" conserva el token {enlace} sin resolver: el worker pone
// el enlace vigente al enviar (así se puede agregar/cambiar después de programar).
//
// msgInv: texto propio de la actividad. Si viene, MANDA sobre la plantilla del
// agente y también sobre la variante "extra" — quien escribió una invitación a
// mano para un lanzamiento quiere que salga esa, no otra.
function plantillas(nombre, actividad, inicioISO, enlace, yaInvitado, msgInv, tzOff) {
  // La hora se calcula POR PERSONA: es el único dato del mensaje que depende de
  // dónde vive quien lo recibe. `tzOff` nulo = se anuncia hora Colombia, que es
  // lo que hacía el sistema antes de existir esta columna.
  const base = {
    nombre: nombre.trim().split(/\s+/)[0], actividad,
    hora: horaDeCliente(inicioISO, tzOff),
    zona: etiquetaZona(tzOff),
  };
  const out = {};
  for (const t of TIPOS) {
    const clave = (t === "invitacion" && yaInvitado) ? "invitacion_extra" : t;
    const linkVal = t === "enlace" ? "{enlace}" : (enlace || "");   // enlace: token; resto: resuelto
    const tpl = (t === "invitacion" && msgInv && msgInv.trim())
      ? msgInv
      : (plantillasUsuario[clave] || PLANTILLAS_DEF[clave]);
    out[t] = aplicar(tpl, { ...base, enlace: linkVal });
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
// Invitación propia del agente para la actividad elegida (tabla
// `invitaciones_agente`). Solo aplica a actividades que NO son suyas: las que
// le comparte su director y por tanto no puede editar. Se guarda por actividad
// para que sobreviva entre tandas — el agente programa de a poquitos y volver a
// escribir el texto en cada tanda acabaría con versiones distintas del mismo
// mensaje. `miInvOrig` recuerda lo que había al abrir, para saber si cambió.
let miInvitacion = "";
let miInvOrig = "";
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
  // El ejemplo usa una persona SIN desfase: es el caso mayoritario y así la
  // vista previa muestra el mismo texto que verá casi todo el mundo.
  const ej = { nombre: "Ana", actividad: "Operativa", hora: "7:00 p. m.",
    zona: etiquetaZona(null), enlace: "https://…" };
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

/* ================= AVISO DE NOVEDAD ================= */
// Un aviso que NO se puede cerrar termina como el de Majo: se queda ahí para
// siempre y deja de mirarse, y de paso tapa los avisos que sí importan (canal
// caído, mensajes fallando). Este se cierra y no vuelve.
//
// La marca va en localStorage y no en la base: es una preferencia de lectura,
// no un dato del negocio. No merece una tabla, ni una migración, ni RLS. Lo
// peor que pasa si alguien entra desde otro navegador es que lo lea dos veces.
//
// La clave lleva versión: para anunciar lo siguiente se sube el número y el
// aviso reaparece, sin tocar nada más.
const NOVEDAD = "enlace-rastreado-v1";
const claveNovedad = () => `nexus.novedad.${state.me.id}.${NOVEDAD}`;

function renderNovedad() {
  const cont = $("segNovedad");
  if (localStorage.getItem(claveNovedad())) {
    cont.classList.add("hidden"); cont.innerHTML = ""; return;
  }
  cont.innerHTML = `
    <div class="alerta nueva">
      <button class="alertax" id="segNovedadX" title="Entendido, no mostrar más">✕</button>
      <div class="at">✨ Nuevo: sabes quién entró, sin preguntar</div>
      <div class="ax">
        Al programar los mensajes verás la casilla <b>«Saber quién entra al
        enlace»</b>, ya encendida. Cada quien recibe un enlace propio a la misma
        sala, y <b>quien lo abra queda marcado como asistente</b>.
        <div class="axnota">
          Verán un enlace nuestro, no el de Zoom — apaga la casilla si prefieres
          el de Zoom. Solo cuenta <b>dentro de la hora</b> siguiente al inicio.
          Un clic dice que entró, no que se quedó. Y si abres el enlace de
          alguien para probar, <b>le marcas su asistencia</b>.
        </div>
      </div>
    </div>`;
  cont.classList.remove("hidden");
  $("segNovedadX").onclick = () => {
    localStorage.setItem(claveNovedad(), new Date().toISOString());
    renderNovedad();
  };
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
// EL LARGO IMPORTA: este enlace se ve entero en el mensaje de WhatsApp, y uno
// largo y raro parece spam. El total queda en 53 caracteres:
//
//   https://nexus-ftds.nexus-pro.workers.dev / i ? 4k7mqx2rvb
//   └──── 40, fijo, es el dominio ─────────┘ └─ 13 nuestros ─┘
//
// De ahí salen las tres decisiones de abajo. Lo único que queda por recortar es
// el dominio, y eso ya no es código: sería comprar uno corto.
//
// Alfabeto sin los caracteres que se confunden al dictar un enlace por teléfono
// (l, o, 0, 1).
const ALF_TOKEN = "abcdefghijkmnpqrstuvwxyz23456789";

// 10 caracteres de 32 posibles = 50 bits. Adivinar uno es ~1 en mil billones,
// de sobra para lo poco que se gana (una asistencia falsa y un enlace de Zoom
// que de todos modos va en el mensaje).
//
// El piso no lo pone la seguridad sino las COLISIONES: `clic_token` es único, y
// dos iguales tumbarían el lote entero de `programar()` con un error que no
// dice nada. Con 8 caracteres, a ~100 mil enlaces al año, eso pasaría como una
// vez cada dos años. Con 10 no pasa nunca. Los 2 caracteres extra son ruido al
// lado del dominio; el error misterioso no lo sería.
const LARGO_TOKEN = 10;
const nuevoToken = () => {
  const b = new Uint8Array(LARGO_TOKEN);
  crypto.getRandomValues(b);
  // 256 es múltiplo exacto de 32, así que el módulo no introduce sesgo.
  return [...b].map(x => ALF_TOKEN[x % ALF_TOKEN.length]).join("");
};

// Dos recortes más, de 3 caracteres cada uno:
//   · `/i` en vez de `/i.html` — Cloudflare resuelve la extensión sola
//     (`html_handling` en wrangler.toml lo deja explícito, no implícito).
//   · `?token` en vez de `?t=token` — el token es lo único que viaja, así que
//     no necesita nombre.
const urlRastreada = tok => `${BASE_URL}/i?${tok}`;

// El rastreo es una decisión DE ESTA TANDA, no de la actividad: a una lista de
// confianza se le rastrea y a un público frío se le manda el zoom.us tal cual,
// y la misma actividad puede querer las dos cosas en momentos distintos.
// Quién lleva enlace rastreado y quién no queda escrito, persona por persona,
// en si su seguimiento tiene `clic_token`.
let segRastrear = true;

function renderForm() {
  $("segSrv").innerHTML = state.catalogo.map(g => `<optgroup label="${esc(g.g)}">` +
    g.items.map(s => `<option value="${s.id}">${esc(s.n)}</option>`).join("") +
    `</optgroup>`).join("");
  $("segFecha").value = hoyISO();
  $("segHora").value = "";
  $("segLink").value = "";
  $("segLibre").value = "";
  setImgActividad(null);
  setMsgInvitacion(null);
  $("segImgEstado").textContent = "";
  // Compartir solo aplica si hay a quién: es cosa de directores.
  $("segCompartirRow").classList.toggle("hidden", state.me.role !== "director");
  $("segCompartir").checked = true;
  $("segZoom").value = "";
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
  // Solo en las puntuales: una del catálogo es recurrente y su invitación es
  // justo la que el agente ya dejó escrita en sus plantillas.
  $("segMsgInvRow").classList.toggle("hidden", tipo !== "libre");
  // El embudo de venta le pasa a la persona una sola vez; una actividad del
  // catálogo es recurrente, así que marcarla como zoom no tendría sentido.
  $("segZoomRow").classList.toggle("hidden", tipo !== "libre");
  $("segImgAyuda").textContent = tipo === "libre"
    ? "Una actividad puntual no tiene servicio del cual heredar imagen: si no subes una, la invitación va sin imagen."
    : "Si no subes ninguna, se usa la del servicio del catálogo.";
}

// Invitación propia de la actividad. `null` = usar la plantilla del agente.
// El editor arranca plegado y solo se despliega al tocarlo: la mayoría de las
// veces no se toca, y desplegado se come el formulario.
function setMsgInvitacion(texto) {
  const hay = !!(texto && texto.trim());
  $("segMsgInv").value = texto || "";
  $("segMsgInvBox").classList.toggle("hidden", !hay);
  $("segMsgInvBtn").textContent = hay ? "✎ Editando la invitación" : "✎ Personalizar la invitación";
  $("segMsgInvBtn").classList.toggle("on", hay);
  renderPrevInvitacion();
}

// Vista previa con datos de ejemplo, igual que el editor de plantillas: los
// snippets se sortean y las etiquetas se llenan, así el agente ve el mensaje
// como le va a llegar a alguien antes de guardar.
function renderPrevInvitacion() {
  const prev = $("segMsgInvPrev");
  if (!prev) return;
  const txt = ($("segMsgInv").value || "").trim();
  const nombreAct = $("segLibre").value.trim() || "la actividad";
  const hora = $("segHora").value
    ? horaCO(new Date(`2026-01-01T${$("segHora").value}:00`).toISOString())
    : "7:00 p. m.";
  prev.textContent = txt
    ? aplicar(txt, { nombre: "Ana", actividad: nombreAct, hora, zona: etiquetaZona(null), enlace: "" })
    : "";
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
    $("segZoom").value = a.zoom_tipo || "";
  } else {
    setTipoActividad("cat");
    $("segZoom").value = "";
    if ([...$("segSrv").options].some(o => o.value === a.servicio_id)) $("segSrv").value = a.servicio_id;
  }
  setImgActividad(a.imagen);
  setMsgInvitacion(a.msg_invitacion);
  $("segImgEstado").textContent = "";
  $("segCompartirRow").classList.toggle("hidden", state.me.role !== "director");
  $("segCompartir").checked = !!a.compartida;
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
      // Solo las puntuales llevan invitación propia; si se cambia de tipo, se
      // limpia en vez de arrastrar un texto que ya no se ve en pantalla.
      msg_invitacion: libre ? (($("segMsgInv").value || "").trim() || null) : null,
      // Igual que la invitación propia: solo en las puntuales, y se limpia al
      // cambiar de tipo para no dejar una del catálogo marcada como zoom.
      zoom_tipo: libre ? ($("segZoom").value || null) : null,
      compartida: state.me.role === "director" && $("segCompartir").checked,
    };
    if (actEdit) {
      const cambioHora = new Date(actEdit.inicio).getTime() !== inicio.getTime();
      const { error } = await SB.from("actividades").update(datos).eq("id", actEdit.id);
      if (error) throw error;
      let reprog = null;
      if (cambioHora) {
        reprog = await reprogramarPorHora(actEdit.id, inicio.toISOString(), nombreAct, enlace, datos.msg_invitacion);
      }
      // Propaga el enlace nuevo a los mensajes de "enlace" aún pendientes de los
      // seguimientos activos de esta actividad (por eso el link no se congela).
      //
      // OJO: a los seguimientos CON token no se les toca el `enlace_url`. Su URL
      // puente resuelve el enlace VIGENTE al abrirse —o sea el que se acaba de
      // guardar—, así que ya apunta bien; pisarla con el enlace crudo apagaría
      // el rastreo de esa persona en silencio.
      //
      // Desde que el rastreo se decide al programar y no en la actividad, tener
      // token ES la respuesta: no hay que consultar ninguna otra bandera.
      const { data: segs } = await SB.from("seguimientos")
        .select("id, clic_token").eq("actividad_id", actEdit.id).eq("estado", "activo");
      const conTok = (segs || []).filter(s => s.clic_token);
      const sinTok = (segs || []).filter(s => !s.clic_token);
      if (sinTok.length) {
        await SB.from("mensajes_programados")
          .update({ enlace_url: enlace || null })
          .in("seguimiento_id", sinTok.map(s => s.id))
          .eq("tipo", "enlace").eq("estado", "pendiente");
      }

      const notas = [];
      if (enlace && sinTok.length) notas.push("enlace aplicado a los pendientes");
      if (enlace && conTok.length)
        notas.push(`${conTok.length} enlace(s) rastreado(s) ya apuntan al nuevo`);
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
// Cuántos de los que se programaron abrieron su enlace. Es la razón de ser del
// rastreo, así que va en la tarjeta y no escondido en el registro.
//
// Solo cuentan los seguimientos CON token: los de antes del rastreo (o de una
// tanda con el rastreo apagado) no tienen nada que informar, y meterlos en el
// denominador diría «0 de 30 entraron» de algo que nunca se midió.
// `prog` cuenta a TODOS los programados y `n` solo a los que llevan token. Son
// dos cifras distintas desde que el rastreo se decide por tanda: una misma
// actividad puede tener gente rastreada y gente sin rastrear.
async function contarEntradas(ids) {
  const entradas = new Map();   // actividad_id → { prog, n, entraron, tarde }
  if (!ids.length) return entradas;
  const { data: segs } = await SB.from("seguimientos")
    .select("actividad_id, clic_token, clic_en, clics")
    .in("actividad_id", ids)
    .neq("estado", "cancelado");
  for (const s of segs || []) {
    const e = entradas.get(s.actividad_id) || { prog: 0, n: 0, entraron: 0, tarde: 0 };
    e.prog++;
    if (s.clic_token) {
      e.n++;
      // «Tarde» se cuenta aparte y NO suma a los que entraron: abrir el mensaje
      // al otro día no es haber asistido, pero sí dice que el mensaje llegó.
      if (s.clic_en) e.entraron++;
      else if (s.clics) e.tarde++;
    }
    entradas.set(s.actividad_id, e);
  }
  return entradas;
}

/* ---------- actividades ya pasadas ---------- */
// Al cambiar el día, una actividad se marca `cerrada` y sale de la lista. El
// dato de quién entró NO se pierde —vive en `seguimientos`— pero se quedaba sin
// ninguna puerta por donde consultarlo, y el repaso de asistencias se hace justo
// al día siguiente. Esta sección es esa puerta.
//
// Van 7 días y no solo el anterior: cuesta lo mismo, y quien se ausenta un fin
// de semana vuelve el lunes queriendo cuadrar el viernes.
const DIAS_PASADAS = 7;

async function renderPasadas() {
  const cont = $("segPasadas");
  if (!cont) return;
  const desde = new Date(Date.now() - DIAS_PASADAS * 86400000).toISOString();

  const { data, error } = await SB.from("actividades")
    .select("id, servicio_id, nombre, inicio, enlace, owner_id")
    .eq("estado", "cerrada")
    .gte("inicio", desde)
    .order("inicio", { ascending: false })
    .limit(15);
  if (error) { cont.innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }

  const pasadas = data || [];
  const entradas = await contarEntradas(pasadas.map(a => a.id));
  // Entra si tiene rastreo (hay algo que informar) o si es PUNTUAL con gente
  // programada: la asistencia a una puntual solo se puede revisar acá, mientras
  // que la de una del catálogo además vive en la vista por servicio.
  //
  // En los dos casos hace falta al menos una persona programada: una actividad
  // a la que nunca se le programó nada no tiene nada que mostrar.
  const conDatos = pasadas.filter(a => {
    const e = entradas.get(a.id);
    return !!e && e.prog > 0 && (e.n > 0 || esLibre(a));
  });

  $("segPasadasCnt").textContent = conDatos.length;
  if (!conDatos.length) {
    cont.innerHTML = `<div class="segempty">
      <div class="eh">Nada de los últimos ${DIAS_PASADAS} días</div>
      <p>Cuando una actividad con enlace rastreado termine, aquí sigues viendo quién entró.</p>
    </div>`;
    return;
  }

  cont.innerHTML = conDatos.map(a => {
    const ent = entradas.get(a.id);
    return `
    <article class="actcard">
      <div class="am campclic" data-pasada="${a.id}" title="Ver quiénes entraron">
        <h4>${esc(a.nombre)} <span class="campver">›</span></h4>
        <div class="ameta">
          <span class="atime">${fechaHoraCO(a.inicio)}</span>
          ${esLibre(a) ? `<span class="achip suelta">✦ Puntual</span>` : ""}
          ${ent.n
            ? `<span class="achip ok ${ent.entraron ? "" : "vacio"}">👆 ${ent.entraron}/${ent.n} entraron</span>`
            : `<span class="achip">${ent.prog} invitado${ent.prog === 1 ? "" : "s"} · sin rastreo</span>`}
          ${ent.tarde ? `<span class="achip">${ent.tarde} tarde</span>` : ""}
          ${ent.n && ent.n < ent.prog
            ? `<span class="achip">${ent.prog - ent.n} sin rastreo</span>` : ""}
        </div>
      </div>
    </article>`;
  }).join("");

  cont.querySelectorAll("[data-pasada]").forEach(el => el.onclick = () => {
    const a = pasadas.find(x => x.id === el.dataset.pasada);
    if (a) abrirEntradas(a);
  });
}

async function cargarActividades() {
  const { data, error } = await SB.from("actividades")
    .select("id, servicio_id, nombre, inicio, enlace, estado, imagen, compartida, msg_invitacion, zoom_tipo, owner_id")
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
  const entradas = await contarEntradas(actividades.map(a => a.id));

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
          ${ent && ent.n ? `<button class="achip ok clicable ${ent.entraron ? "" : "vacio"}"
            data-entradas="${a.id}"
            title="Ver quiénes entraron y quiénes no"
            >👆 ${ent.entraron}/${ent.n} entraron ›</button>`
           : ent && ent.prog ? `<button class="achip clicable vacio" data-entradas="${a.id}"
            title="Esta tanda salió sin rastreo: marca la asistencia a mano"
            >${ent.prog} invitado${ent.prog === 1 ? "" : "s"} · marcar a mano ›</button>` : ""}
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

  $("segActividades").querySelectorAll("[data-entradas]").forEach(b => b.onclick = () => {
    const a = actividades.find(x => x.id === b.dataset.entradas);
    if (a) abrirEntradas(a);
  });
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

/* ---------- invitación propia del agente para una actividad ajena ---------- */

// Solo tiene sentido en una actividad que el agente NO puede editar: si es
// suya, ya tiene el editor dentro del formulario de la actividad y ofrecer dos
// sitios para lo mismo solo confunde.
const puedoPersonalizarInvitacion = a => !!a && !!state.me && a.owner_id !== state.me.id;

async function cargarMiInvitacion(a) {
  miInvitacion = "";
  miInvOrig = "";
  const row = $("segMiInvRow");
  if (!row) return;
  row.classList.toggle("hidden", !puedoPersonalizarInvitacion(a));
  $("segMiInvBox").classList.add("hidden");
  if (!puedoPersonalizarInvitacion(a)) return;

  const { data } = await SB.from("invitaciones_agente")
    .select("texto").eq("actividad_id", a.id).eq("owner_id", state.me.id).maybeSingle();
  miInvitacion = (data?.texto || "").trim();
  miInvOrig = miInvitacion;
  pintarMiInvitacion();
}

function pintarMiInvitacion() {
  const hay = !!miInvitacion.trim();
  $("segMiInv").value = miInvitacion;
  $("segMiInvBtn").textContent = hay ? "✎ Editando mi invitación" : "✎ Personalizar mi invitación";
  $("segMiInvBtn").classList.toggle("on", hay);
  renderPrevMiInvitacion();
}

// Vista previa con datos de ejemplo, con el nombre y la hora REALES de la
// actividad elegida (no los del formulario, que acá no existe).
function renderPrevMiInvitacion() {
  const prev = $("segMiInvPrev");
  if (!prev || !actSel) return;
  const txt = ($("segMiInv").value || "").trim();
  prev.textContent = txt
    ? aplicar(txt, { nombre: "Ana", actividad: actSel.nombre, hora: horaCO(actSel.inicio),
        zona: etiquetaZona(null), enlace: "" })
    : "";
}

// Se guarda al PROGRAMAR, no al escribir: así lo que queda guardado es
// exactamente el texto con el que salieron los mensajes. Vaciarlo borra la fila
// —volver a la invitación de la actividad— en vez de dejar un texto vacío que
// no significa nada.
async function guardarMiInvitacion(actividadId) {
  const txt = miInvitacion.trim();
  if (txt === miInvOrig.trim()) return;          // no cambió: no se toca la base
  if (!txt) {
    await SB.from("invitaciones_agente").delete()
      .eq("actividad_id", actividadId).eq("owner_id", state.me.id);
  } else {
    await SB.from("invitaciones_agente")
      .upsert({ actividad_id: actividadId, owner_id: state.me.id, texto: txt,
                actualizado: new Date().toISOString() },
              { onConflict: "actividad_id,owner_id" });
  }
  miInvOrig = txt;
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
  // Vuelve a encendido en cada actividad: es lo que se quiere casi siempre, y
  // dejarlo apagado de la tanda anterior significaría perder el rastreo sin
  // que nadie lo pidiera.
  segRastrear = true;
  const ra = $("segRastrear"); if (ra) ra.checked = true;
  const tr = $("segTardeRow"); if (tr) tr.classList.add("hidden");
  const tt = $("segTardeToggle"); if (tt) { tt.classList.remove("on"); tt.classList.remove("hidden"); }
  await cargarMiInvitacion(a);
  $("segProgTitulo").innerHTML = `Programar para <b>${esc(a.nombre)}</b> · ${fechaHoraCO(a.inicio)}`;
  refrescarBotonProgramar();
  $("segProgBloque").classList.remove("hidden");
  $("segFaltan").innerHTML = `<div class="naplica">Cargando…</div>`;
  renderSegmentos();

  await cargarYaProgramados(a.id);
  // NADIE marcado por defecto. Antes se pre-marcaban todos los que faltaban, y
  // eso —combinado con que el buscador oculta pero no desmarca— hacía que
  // buscar un nombre y darle «Programar» encolara a TODA la selección oculta,
  // no a quien se veía. Dos veces se programó a 40+ personas de un clic sin
  // querer. Para invitar a todos está «Marcar visibles»; el masivo silencioso
  // ya no es el camino por defecto.
  segSel = new Set();
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
  : segSinInvitacion ? "Programar sin invitación"
  : !segRastrear ? "Programar sin rastrear el enlace" : "Programar mensajes";
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

  const marcados = elegibles(actSel.servicio_id).filter(c => segSel.has(c.id));
  if (!marcados.length) { toast("No hay nadie seleccionado"); return; }

  // A quien ya tiene seguimiento vivo para esta actividad se le OMITE, no se le
  // avisa y se sigue. Antes esto era una advertencia dentro del confirm y se
  // podía pasar por encima: el 11/08 un agente programó tres tandas seguidas y
  // 48 clientes acabaron con tres seguimientos cada uno — 12 mensajes por
  // persona esa noche, en cuatro ráfagas de tres idénticos. Nadie quiere eso
  // nunca, así que dejó de ser una decisión del que programa.
  //
  // La regla de verdad vive en el índice `seguimientos_uno_activo_por_actividad`
  // (Postgres). Esto de aquí es para que el agente vea lo que va a pasar antes
  // de darle, no el límite: el límite tiene que estar donde no se pueda saltar.
  const repetidos = marcados.filter(c => segYaProg.has(c.id));
  const seleccion = marcados.filter(c => !segYaProg.has(c.id));
  const omitidos = repetidos.length
    ? `\n\n(${repetidos.length} ya ten${repetidos.length === 1 ? "ía" : "ían"} seguimiento `
      + `para esta actividad y se om${repetidos.length === 1 ? "ite" : "iten"}.)`
    : "";

  if (!seleccion.length) {
    toast(repetidos.length === 1
      ? "Esa persona ya tiene seguimiento para esta actividad"
      : "Todas ya tienen seguimiento para esta actividad");
    return;
  }

  // Confirmación SIEMPRE, con el número y algunos nombres. Es la red que faltó:
  // el buscador oculta a los seleccionados que no coinciden, así que la única
  // forma de saber a cuántos se les va a escribir de verdad es contar la
  // selección entera aquí y decírselo antes de encolar nada.
  const n = seleccion.length;
  const primeros = seleccion.slice(0, 8).map(c => c.nombre.split(" ")[0]).join(", ");
  const mas = n > 8 ? ` y ${n - 8} más` : "";
  const aviso = `Vas a programar los mensajes de «${actSel.nombre}» para ${n} persona${n === 1 ? "" : "s"}:\n${primeros}${mas}.${omitidos}`;
  if (!confirm(aviso + `\n\n¿Programar?`)) return;

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
    const rastrear = segRastrear;
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
    // Qué invitación sale, de más específica a más general: la que el agente
    // escribió para ESTA actividad → la que puso el dueño de la actividad → su
    // plantilla de siempre. Gana la más específica porque es la que alguien se
    // tomó el trabajo de escribir para este caso.
    const invEfectiva = (puedoPersonalizarInvitacion(actSel) && miInvitacion.trim())
      ? miInvitacion.trim()
      : actSel.msg_invitacion;

    for (const seg of segs) {
      const c = seleccion.find(x => x.id === seg.cliente_id);
      const tpl = plantillas(c.nombre, actSel.nombre, actSel.inicio, actSel.enlace,
        yaInvitados.has(c.tel), invEfectiva, c.tzOff);
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

    // Marca a los seleccionados como "invitados" al servicio, así pasan de
    // «por invitar» a «invitados» en la vista por servicio.
    //
    // REGLA DE ORO: a quien YA ASISTIÓ no se le toca nada. Ni `acc` ni `conf`.
    // Reinvitar a alguien no puede moverle el estado hacia atrás por ningún
    // motivo — se queda en «asistió» y el repaso no vuelve a preguntar por él.
    //
    // Y a quien todavía no ha asistido se le REFRESCA la fecha de invitación.
    // Antes solo se escribía si estaba vacía, y esa fecha vieja era el problema:
    // el repaso preguntaba por la invitación de hace tres semanas y, al
    // responder «no asistió», borraba la invitación que se acababa de hacer hoy.
    const hoy = hoyISO();
    if (actSel.servicio_id) {
      // Actividad del catálogo: `acc` y `conf` van indexados por servicio.
      const sid = actSel.servicio_id;
      for (const c of seleccion) {
        if ((c.acc || {})[sid]) continue;            // ya asistió: intocable
        if ((c.conf || {})[sid] === hoy) continue;   // ya está al día
        c.conf = { ...(c.conf || {}), [sid]: hoy };
        await SB.from("clientes").update({ conf: c.conf }).eq("id", c.id);
      }
    } else {
      // Actividad puntual: se guarda en su propio mapa, con el nombre y la
      // hora copiados, para que el perfil y el repaso no dependan de que la
      // actividad siga existiendo.
      // `z` (tipo de zoom) se copia acá para que el registro siga siendo
      // auto-contenido: los cuatro sitios que tocan la asistencia no tienen que
      // ir a buscar la actividad, que además puede estar cerrada o borrada.
      for (const c of seleccion) {
        const prev = (c.pun || {})[actSel.id];
        if (!prev || (actSel.zoom_tipo || null) !== (prev.z || null)) {
          c.pun = { ...(c.pun || {}),
            [actSel.id]: { n: actSel.nombre, i: actSel.inicio, conf: prev?.conf || hoy,
                           ...(prev || {}),
                           ...(actSel.zoom_tipo ? { z: actSel.zoom_tipo } : {}) } };
          await SB.from("clientes").update({ puntuales: c.pun }).eq("id", c.id);
        }
      }
    }

    // Guarda la selección en el historial de segmentos (automático).
    await guardarSegmentoHistorial(seleccion.map(c => c.id), actSel.id, actSel.nombre);

    // El texto se guarda DESPUÉS de encolar, y solo si se encoló: lo que queda
    // guardado es exactamente el que salió. Si falla, no se pierde nada —
    // los mensajes ya llevan el texto resuelto adentro.
    if (puedoPersonalizarInvitacion(actSel)) await guardarMiInvitacion(actSel.id);

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
    // 23505 = índice único. El único que puede saltar aquí es el de «un
    // seguimiento activo por persona y actividad», y salta cuando la pantalla
    // tenía datos viejos: dos pestañas abiertas, o alguien programando lo mismo
    // desde otro sitio. El mensaje crudo de Postgres no le dice nada a nadie.
    if (err.code === "23505" && (err.message || "").includes("uno_activo_por_actividad")) {
      toast("⚠ Alguien de esa lista ya tenía seguimiento para esta actividad. "
          + "No se duplicó nada; vuelve a abrir la actividad para ver el estado real.");
      await cargarYaProgramados(actSel.id);
      renderFaltan();
      actualizarConteo();
    } else {
      toast("⚠ " + err.message);
    }
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
let segmentos = [];   // cache de los segmentos del agente

async function cargarSegmentos() {
  const { data, error } = await SB.from("segmentos")
    .select("id, nombre, definicion, created_at")
    .eq("owner_id", state.me.id)
    .order("created_at", { ascending: false });
  segmentos = error ? [] : (data || []);
}

// La entrada del historial se unifica POR ACTIVIDAD (`clave`), no por tanda: el
// agente programa de a poquitos según le van confirmando, y una entrada por
// tanda llenaba el historial de versiones incompletas de la misma lista.
async function guardarSegmentoHistorial(clienteIds, actividadId, actividadNombre) {
  await guardarHistorialSegmento({
    clienteIds,
    nombre: actividadNombre,
    clave: `act:${actividadId}`,
  });
  await cargarSegmentos();
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

  // Los recientes van plegados: son ocho chips con nombre largo que empujaban
  // la lista de personas —lo que el agente vino a hacer— fuera de la pantalla.
  cont.innerHTML =
    (guardados.length ? `<div class="pstitle" style="margin:0 0 4px">⭐ Segmentos guardados</div>` : "") +
    guardados.map(s => chip(s, false)).join("") +
    (historial.length ? `<details class="segacc">
      <summary>Invitados recientes<span class="pcn">${historial.length}</span></summary>
      <div class="segaccbody">${historial.map(s => chip(s, true)).join("")}</div>
    </details>` : "");

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
async function reprogramarPorHora(actividadId, nuevoInicioISO, nombreAct, enlace, msgInv) {
  const { data: segs } = await SB.from("seguimientos")
    .select("id, owner_id, clientes(nombre, tz_offset_min)")
    .eq("actividad_id", actividadId).eq("estado", "activo");
  if (!segs || !segs.length) return { movidos: 0, cancelados: 0 };

  const info = new Map(segs.map(s =>
    [s.id, { mio: s.owner_id === state.me.id, nombre: s.clientes?.nombre || "",
             tzOff: s.clientes?.tz_offset_min ?? null }]));

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
    if (d.mio && d.nombre) textos.set(id, plantillas(d.nombre, nombreAct, nuevoInicioISO, enlace, false, msgInv, d.tzOff));
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

// ¿Está marcada la asistencia de esta persona a ESTA actividad? La asistencia
// vive en dos sitios según el tipo —`acc[servicio]` las del catálogo,
// `puntuales[actividad].acc` las puntuales— y la regla va en un solo lugar
// porque la usan el panel de entradas y el diálogo de cancelar.
const asistioA = (c, actividadId, servicioId) => !c ? false
  : servicioId ? !!(c.acc || {})[servicioId]
               : !!((c.pun || {})[actividadId] || {}).acc;

/* ================= QUIÉNES ENTRARON ================= */
// Panel de la actividad: quién abrió su enlace y quién no, con la asistencia
// editable a mano. El clic es una señal muy buena pero no infalible —quien ya
// tenía el enlace de antes entra sin generar clic, y quien abre desde otro
// teléfono aparece como que no entró—, así que el agente tiene que poder
// corregir en los dos sentidos sin salir de aquí.
//
// La asistencia se escribe donde le corresponde a cada tipo de actividad: en
// `acc[servicio]` las del catálogo, en `puntuales[actividad].acc` las puntuales.
async function abrirEntradas(a) {
  const sid = a.servicio_id;
  $("repSub").textContent = "Cargando…";
  $("repBody").innerHTML = `<div class="naplica">Un momento…</div>`;
  $("repOverlay").classList.add("open");

  const { data, error } = await SB.from("seguimientos")
    .select("id, cliente_id, clic_token, clic_en, clics, clientes(nombre)")
    .eq("actividad_id", a.id).neq("estado", "cancelado");
  if (error) { $("repBody").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }

  // NO se filtra por token. Desde que el rastreo se decide por tanda, una misma
  // actividad puede tener gente rastreada y gente sin rastrear, y a los segundos
  // igual hay que poder marcarles la asistencia a mano — en una puntual este
  // panel es el único sitio donde se puede.
  const filas = data || [];
  const cerrar = () => $("repOverlay").classList.remove("open");
  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };

  const asistio = c => asistioA(c, a.id, sid);

  const pintar = () => {
    const conCli = filas.map(s => ({ s, c: state.clientes.find(x => x.id === s.cliente_id) }));
    const rastreados = conCli.filter(({ s }) => s.clic_token);
    const entraron = rastreados.filter(({ s }) => s.clic_en);
    const tarde    = rastreados.filter(({ s }) => !s.clic_en && s.clics);
    const nada     = rastreados.filter(({ s }) => !s.clic_en && !s.clics);
    // Sin token no hay nada que informar sobre ellos: se listan aparte, con su
    // botón de marcar, y sin fingir que «no entraron».
    const sinTok   = conCli.filter(({ s }) => !s.clic_token);

    const fila = ({ s, c }) => {
      const nombre = s.clientes?.nombre || "(cliente)";
      const marcada = asistio(c);
      return `<div class="prow">
        <div class="pl"><span class="pn">${esc(nombre)}</span>
          ${s.clic_en ? `<span class="sfecha">abrió ${esc(fechaHoraCO(s.clic_en))}</span>`
           : s.clics ? `<span class="pdate">abrió tarde · no cuenta</span>` : ""}
        </div>
        <div class="pr">
          ${marcada
            ? `<span class="pdate">✓ asistió</span>
               <button class="pmark off" data-quitar="${s.cliente_id}" title="Quitar asistencia">✕</button>`
            : `<button class="pmark" data-marcar="${s.cliente_id}">✓ Marcar asistencia</button>`}
        </div></div>`;
    };

    const grupo = (titulo, lista, vacio) =>
      `<div class="pstitle">${titulo} (${lista.length})</div>` +
      (lista.length ? lista.map(fila).join("") : `<div class="naplica">${vacio}</div>`);

    $("repSub").textContent = a.nombre;
    $("repBody").innerHTML = (!filas.length
        ? `<div class="naplica">A esta actividad no le programaste a nadie.</div>`
        : (rastreados.length
            ? grupo("👆 Entraron", entraron, "Nadie ha abierto su enlace todavía.")
              + (tarde.length ? grupo("Abrieron tarde · no cuenta como asistencia", tarde, "") : "")
              + grupo("Sin abrir", nada, "Todos abrieron su enlace 🎉")
            : "")
          + (sinTok.length
              ? grupo(rastreados.length ? "Sin enlace rastreado · márcalos a mano" : "Invitados",
                      sinTok, "")
              : ""))
      + (rastreados.length
          ? `<div class="msgshelp" style="margin-top:12px">Un clic dice que abrió el enlace,
              no que se quedó. Quien ya tenía el enlace de antes puede haber entrado sin
              aparecer aquí: por eso puedes marcar y quitar la asistencia a mano.</div>`
          : filas.length
            ? `<div class="msgshelp" style="margin-top:12px">Esta tanda salió sin enlace
                rastreado, así que no hay forma de saber quién entró: la asistencia se
                marca a mano.</div>`
            : "");

    $("repBody").querySelectorAll("[data-marcar]").forEach(b => b.onclick = () => cambiar(b.dataset.marcar, true, b));
    $("repBody").querySelectorAll("[data-quitar]").forEach(b => b.onclick = () => cambiar(b.dataset.quitar, false, b));
  };

  // Escribe la asistencia. La fecha es la del INICIO de la actividad, no la de
  // hoy: si el agente corrige el lunes una clase del viernes, la asistencia es
  // del viernes.
  const fechaAct = () => {
    const d = new Date(a.inicio);
    const p = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  const cambiar = async (clienteId, marcar, btn) => {
    const c = state.clientes.find(x => x.id === clienteId);
    if (!c) { toast("Ese cliente ya no está en tu lista"); return; }
    btn.disabled = true;
    const campos = {};
    if (sid) {
      c.acc = { ...(c.acc || {}) };
      if (marcar) c.acc[sid] = fechaAct(); else delete c.acc[sid];
      campos.acc = c.acc;
    } else {
      c.pun = { ...(c.pun || {}) };
      const prev = c.pun[a.id] || { n: a.nombre, i: a.inicio, ...(a.zoom_tipo ? { z: a.zoom_tipo } : {}) };
      if (marcar) c.pun[a.id] = { ...prev, acc: fechaAct() };
      else { const { acc, ...resto } = prev; c.pun[a.id] = resto; }
      campos.puntuales = c.pun;
      // Si la actividad ES un zoom de venta, marcar la asistencia marca la
      // etapa. Solo al marcar: quitar la asistencia no deshace el embudo.
      if (marcar && syncZoom(c, a.id, "hecha", fechaAct())) campos.zooms = c.zooms;
    }
    const { error } = await SB.from("clientes").update(campos).eq("id", c.id);
    if (error) { toast("⚠ " + error.message); btn.disabled = false; return; }
    toast(marcar ? `✓ ${c.nombre.split(" ")[0]} asistió` : `Asistencia quitada a ${c.nombre.split(" ")[0]}`);
    pintar();
  };

  pintar();
}

/* ================= ENVÍOS MASIVOS ================= */
// Se exporta para que masivo.js lo refresque justo después de encolar: el
// agente acaba de mandar y espera ver el envío ahí, no al recargar la página.
// `campanas` se escribía y nunca se leía: un masivo salía y desaparecía de la
// vista. El agente no tenía cómo saber cómo iba ni cómo pararlo, y son decenas
// de mensajes saliendo desde su WhatsApp personal — justo donde más falta hace
// poder frenar.
//
// El progreso NO se guarda en `campanas`: se cuenta desde `mensajes_programados`
// al pintar. `campanas.total` es lo que se encoló, y el estado real de cada
// mensaje lo mueve el worker. Guardar un contador aparte sería una segunda
// verdad que se desincroniza en cuanto un envío falle.
const CAMP_BADGE = {
  enviado:   ["ok",   "✓"],
  error:     ["err",  "⚠"],
  pendiente: ["pend", "⏳"],
  cancelado: ["can",  "✕"],
};

export async function renderCampanas(abrir) {
  const cont = $("segCampanas");
  if (!cont) return;
  // Se despliega solo cuando se acaba de enviar algo. El resto del tiempo queda
  // plegado: son diez tarjetas con barra y nombre largo, y empujaban fuera de
  // pantalla el registro, que es lo que se consulta a diario.
  if (abrir) $("segCampSec").open = true;

  // Solo las propias: un director ve las campañas de sus agentes por RLS, pero
  // cancelar el envío de otro desde acá sería meterse en su trabajo.
  const { data: camps, error } = await SB.from("campanas")
    .select("id, nombre, enviar_en, total, created_at")
    .eq("owner_id", state.me.id)
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) { cont.innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }
  if (!camps || !camps.length) {
    $("segCampCnt").textContent = 0;
    cont.innerHTML = `<div class="segempty">
      <div class="eh">Todavía no has enviado masivos</div>
      <p>Cuando envíes uno con «✉ Masivo», aquí ves cómo va y puedes cancelarlo.</p>
    </div>`;
    return;
  }

  // Un solo viaje para todas: traer los estados y contarlos acá sale más barato
  // que una consulta de conteo por campaña.
  const { data: msgs } = await SB.from("mensajes_programados")
    .select("campana_id, estado")
    .in("campana_id", camps.map(c => c.id));
  const cuenta = new Map();
  for (const m of msgs || []) {
    const e = cuenta.get(m.campana_id) || {};
    e[m.estado] = (e[m.estado] || 0) + 1;
    cuenta.set(m.campana_id, e);
  }

  const vivas = camps.filter(c => (cuenta.get(c.id) || {}).pendiente > 0);
  $("segCampCnt").textContent = vivas.length;

  cont.innerHTML = camps.map(c => {
    const n = cuenta.get(c.id) || {};
    const pend = n.pendiente || 0;
    const hechos = (n.enviado || 0) + (n.error || 0) + (n.cancelado || 0);
    const total = hechos + pend || c.total || 0;
    const pct = total ? Math.round(((n.enviado || 0) / total) * 100) : 0;
    // Se reusa `.logbadge`, que ya tiene los cuatro estados con sus colores:
    // el registro y esto hablan de lo mismo y deben verse igual.
    const chips = ["enviado", "error", "pendiente", "cancelado"]
      .filter(e => n[e])
      .map(e => `<span class="logbadge ${CAMP_BADGE[e][0]}">${CAMP_BADGE[e][1]} ${n[e]}</span>`)
      .join("");
    return `
    <article class="actcard">
      <div class="am campclic" data-campver="${c.id}" title="Ver a quién le llegó">
        <h4>${esc(c.nombre || "(sin texto)")} <span class="campver">›</span></h4>
        <div class="ameta">
          <span class="atime">${fechaHoraCO(c.enviar_en)}</span>
          ${chips}
        </div>
        <div class="campbarra"><i style="width:${pct}%"></i></div>
        <div class="camppie">${n.enviado || 0} de ${total} enviados${
          pend ? ` · <b>${pend} en cola</b>` : " · terminado"}</div>
      </div>
      <div class="ab">
        ${pend ? `<button class="pmark off" data-campx="${c.id}">✕ Cancelar los ${pend}</button>` : ""}
      </div>
    </article>`;
  }).join("");

  cont.querySelectorAll("[data-campver]").forEach(el => el.onclick = () => {
    const c = camps.find(x => x.id === el.dataset.campver);
    if (c) abrirCampana(c);
  });

  cont.querySelectorAll("[data-campx]").forEach(b => b.onclick = async () => {
    const c = camps.find(x => x.id === b.dataset.campx);
    const pend = (cuenta.get(b.dataset.campx) || {}).pendiente || 0;
    // Se dice que lo YA enviado no se puede recoger: es lo que la gente asume
    // mal de un botón de cancelar, y aquí son mensajes que ya llegaron.
    if (!confirm(`¿Cancelar los ${pend} mensaje(s) que faltan por salir de «${c?.nombre || "este envío"}»?\n\n`
               + `Los que ya se enviaron no se pueden recoger.`)) return;
    b.disabled = true;
    const { error } = await SB.from("mensajes_programados")
      .update({ estado: "cancelado" })
      .eq("campana_id", b.dataset.campx).eq("estado", "pendiente");
    if (error) { toast("⚠ " + error.message); b.disabled = false; return; }
    toast(`${pend} mensaje(s) cancelado(s)`);
    renderCampanas(); renderLogs();
  });
}

// Detalle de una campaña: el texto que salió y persona por persona en qué
// quedó. Sin esto, «19 de 23 enviados» no dice a QUIÉN le llegó ni por qué
// fallaron los otros cuatro — que es lo único accionable de un envío fallido.
async function abrirCampana(c) {
  $("repSub").textContent = "Cargando…";
  $("repBody").innerHTML = `<div class="naplica">Un momento…</div>`;
  $("repOverlay").classList.add("open");
  const cerrar = () => $("repOverlay").classList.remove("open");
  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };

  // El texto se trae de la campaña, no de los mensajes: cada mensaje lleva su
  // versión ya resuelta (nombre y snippets), y mostrar una al azar haría creer
  // que a todos les llegó exactamente esa.
  const [{ data: camp }, { data: msgs, error }] = await Promise.all([
    SB.from("campanas").select("texto, media_url, total, enviar_en").eq("id", c.id).maybeSingle(),
    SB.from("mensajes_programados")
      .select("id, telefono, estado, texto, error, enviado_en, enviar_en")
      .eq("campana_id", c.id).order("estado"),
  ]);
  if (error) { $("repBody").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }

  const porTel = new Map();
  for (const cl of state.clientes) if (cl.tel) porTel.set(cl.tel, cl.nombre);

  const pintar = (filas) => {
    // Primero lo que pide acción y último lo que ya es historia: los que
    // fallaron hay que recuperarlos a mano, y los que están en cola todavía se
    // pueden parar. Con «les llegó» arriba, los cuatro fallidos quedaban
    // enterrados debajo de diecinueve exitosos.
    const grupos = [
      ["error",     "⚠ Fallaron — hay que escribirles a mano"],
      ["pendiente", "En cola"],
      ["enviado",   "✓ Les llegó"],
      ["cancelado", "Cancelados"],
    ];
    const fila = m => {
      const nombre = porTel.get(m.telefono) || m.telefono;
      const cuando = m.enviado_en || m.enviar_en;
      return `<div class="prow">
        <div class="pl"><span class="pn">${esc(nombre)}</span>
          <span class="sfecha">${esc(fechaHoraCO(cuando))}</span></div>
        ${m.estado === "error" && m.error
          ? `<div class="logerr" title="${esc(m.error)}">${esc(m.error.slice(0, 90))}</div>` : ""}
      </div>`;
    };
    const cuerpo = grupos.map(([e, titulo]) => {
      const lista = filas.filter(m => m.estado === e);
      if (!lista.length) return "";
      return `<div class="pstitle">${titulo} (${lista.length})</div>` + lista.map(fila).join("");
    }).join("");

    const pend = filas.filter(m => m.estado === "pendiente").length;
    $("repSub").textContent = c.nombre || "Envío masivo";
    $("repBody").innerHTML = `
      ${camp?.texto ? `<div class="pstitle">Mensaje que salió</div>
        <div class="campmsg">${esc(camp.texto)}</div>
        <div class="msgshelp">A cada persona le llegó con su nombre y con las
          variantes <code>{a|b|c}</code> resueltas, así que el texto exacto
          cambia de una a otra.</div>` : ""}
      ${camp?.media_url ? `<div class="pstitle">Adjunto</div>
        <img class="imgprev" src="${esc(camp.media_url)}" alt="">` : ""}
      ${pend ? `<button class="pmark off campcancel" data-cancelar="1">✕ Cancelar los ${pend} que faltan</button>` : ""}
      ${cuerpo || `<div class="naplica">Este envío no tiene mensajes.</div>`}`;

    const btn = $("repBody").querySelector("[data-cancelar]");
    if (btn) btn.onclick = async () => {
      if (!confirm(`¿Cancelar los ${pend} mensaje(s) que faltan por salir?\n\n`
                 + `Los que ya se enviaron no se pueden recoger.`)) return;
      btn.disabled = true;
      const { error: e2 } = await SB.from("mensajes_programados")
        .update({ estado: "cancelado" }).eq("campana_id", c.id).eq("estado", "pendiente");
      if (e2) { toast("⚠ " + e2.message); btn.disabled = false; return; }
      toast(`${pend} mensaje(s) cancelado(s)`);
      pintar(filas.map(m => m.estado === "pendiente" ? { ...m, estado: "cancelado" } : m));
      renderCampanas(); renderLogs();
    };
  };

  pintar(msgs || []);
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
//
// A QUIEN YA ASISTIÓ NO SE LE PREGUNTA. Reinvitar a alguien que ya asistió es
// normal (una clase que se repite, un lanzamiento al que vuelve), y al cancelar
// ese seguimiento nuevo las dos opciones mienten: «dejarla como invitada» la
// nombra por un estado que ya superó, y «volver a por invitar» insinúa que se
// le puede deshacer la asistencia. Es la misma invariante de `programar()`
// —nada automático mueve `acc` hacia atrás—, aplicada al diálogo.
async function abrirCancelar(s) {
  const nombre = s.clientes?.nombre || "esta persona";
  const c = state.clientes.find(x => x.id === s.cliente_id);

  // `servicio_id` decide dos cosas —si «volver a por invitar» aplica (en una
  // puntual no hay `conf` que quitar) y dónde está anotada la asistencia—, así
  // que se resuelve UNA vez: de la lista si está cargada, y si no, de la base.
  // Antes solo se miraba la lista, y un seguimiento de una actividad ya cerrada
  // caía siempre en el caso "no sé".
  let act = actividades.find(x => x.id === s.actividad_id) || null;
  if (!act && s.actividad_id) {
    const { data } = await SB.from("actividades")
      .select("servicio_id").eq("id", s.actividad_id).maybeSingle();
    act = data || null;
  }
  const sid = act?.servicio_id || null;
  const sinServicio = !!act && esLibre(act);
  const yaAsistio = asistioA(c, s.actividad_id, sid);

  $("repSub").textContent = "Cancelar seguimiento";
  $("repBody").innerHTML = `
    <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
      <div style="font-size:.95rem">Vas a cancelar el seguimiento de <b>${esc(nombre)}</b>
        para <b>${esc(s.actividad)}</b>. No se enviarán los mensajes pendientes.
        <span class="sfecha">${yaAsistio
          ? "Su asistencia no se toca: ya quedó registrada."
          : "¿En qué estado dejas a la persona?"}</span>
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        ${yaAsistio
          ? `<button class="pmark off" data-cx="solo">Sí, cancelar el seguimiento</button>`
          : `<button class="pmark" data-cx="invitado">Dejarla como «invitada»</button>
             ${sinServicio ? "" : `<button class="pmark off" data-cx="porinvitar">Volver a «por invitar»</button>`}`}
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

      // 2) si se elige "por invitar", quitar conf de ese servicio a la persona.
      // `sid` y `c` ya vienen resueltos de arriba: antes se volvía a consultar
      // la actividad aquí, con las mismas dos líneas.
      if (modo === "porinvitar" && sid && c && (c.conf || {})[sid]) {
        delete c.conf[sid];
        await SB.from("clientes").update({ conf: c.conf }).eq("id", c.id);
      }
      cerrar();
      toast(modo === "porinvitar" ? "Seguimiento cancelado · persona vuelve a «por invitar» ✓"
          : modo === "solo"       ? "Seguimiento cancelado ✓"
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
  renderNovedad();
  salirEdicion(); ocultarProg(); cargarPlantillas();
  // `renderPasadas` va DESPUÉS a propósito: es `cargarActividades` quien marca
  // `cerrada` a las de ayer. Lanzadas a la vez, la actividad de anoche todavía
  // figuraría como activa y no aparecería en ninguna de las dos listas — el
  // primer día que se abre el panel, justo cuando más se necesita.
  cargarActividades().then(renderPasadas);
  cargarSegmentos(); renderActivos(); renderCampanas(); renderLogs();
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
  // Sin invitación no hay invitación que personalizar: se esconde el editor (y
  // su caja abierta) en vez de dejar un control que no haría nada.
  const mostrarMiInv = !segSinInvitacion && puedoPersonalizarInvitacion(actSel);
  $("segMiInvRow").classList.toggle("hidden", !mostrarMiInv);
  if (!mostrarMiInv) $("segMiInvBox").classList.add("hidden");
  refrescarBotonProgramar();
};

$("segRastrear").onchange = e => { segRastrear = e.target.checked; refrescarBotonProgramar(); };

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

/* ---------- invitación propia de la actividad ---------- */
// Al abrirlo vacío se siembra con la plantilla del agente: es más fácil retocar
// un texto que ya existe que escribir uno desde cero mirando una caja en blanco.
$("segMsgInvBtn").onclick = () => {
  const box = $("segMsgInvBox");
  const abrir = box.classList.contains("hidden");
  box.classList.toggle("hidden", !abrir);
  if (abrir && !$("segMsgInv").value.trim()) {
    $("segMsgInv").value = plantillasUsuario.invitacion || PLANTILLAS_DEF.invitacion;
    renderPrevInvitacion();
  }
  if (abrir) $("segMsgInv").focus();
};
$("segMsgInv").oninput = renderPrevInvitacion;

// --- invitación propia del agente (panel de programación) ---
$("segMiInvBtn").onclick = () => {
  const box = $("segMiInvBox");
  const abrir = box.classList.contains("hidden");
  box.classList.toggle("hidden", !abrir);
  // Al abrirlo vacío se siembra con lo que HOY saldría: la invitación de la
  // actividad si el director escribió una, o la plantilla propia. Retocar un
  // texto existente es mucho más fácil que escribir mirando una caja en blanco.
  if (abrir && !$("segMiInv").value.trim()) {
    $("segMiInv").value = (actSel?.msg_invitacion || "").trim()
      || plantillasUsuario.invitacion || PLANTILLAS_DEF.invitacion;
    miInvitacion = $("segMiInv").value;
    renderPrevMiInvitacion();
  }
  if (abrir) $("segMiInv").focus();
};
$("segMiInv").oninput = () => {
  miInvitacion = $("segMiInv").value;
  renderPrevMiInvitacion();
};
$("segMiInvQuitar").onclick = () => {
  miInvitacion = "";
  pintarMiInvitacion();
  $("segMiInvBox").classList.add("hidden");
};
$("segHora").addEventListener("change", renderPrevInvitacion);
$("segLibre").addEventListener("input", renderPrevInvitacion);
$("segMsgInvQuitar").onclick = () => setMsgInvitacion(null);
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
