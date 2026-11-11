// Editor de mensajes como conversación de WhatsApp. Nació para la invitación
// de una actividad (pedido de Sanviv, 10/11/2026) y desde el 11/11/2026 es el
// editor de TODOS los envíos en serie: masivo, invitación y seguimiento a
// leads. Los mensajes se ven en el orden en que le llegan a la persona y se
// reordenan arrastrando.
//
// Tres reglas que pidió Sanviv y que este archivo sostiene:
//   1. El orden de la lista es el orden de llegada, sea texto, imagen, video o
//      nota de voz.
//   2. Cada mensaje se mueve ENTERO: su imagen o su video viaja con él. La
//      imagen del catálogo deja de estar anclada al primer lugar: al mover ese
//      mensaje queda fijada a él.
//   3. La nota de voz es un mensaje propio, sin texto (WhatsApp no le pone pie
//      a una nota de voz). Texto antes o después = otro mensaje.
//
// No guarda nada propio: es una vista sobre el estado que ya existía (mensaje 1
// + arreglo de los mensajes 2..4). Así el guardado, la programación y la base
// no cambian; `cfg` dice de dónde leer y dónde escribir.
import Sortable from "https://esm.sh/sortablejs@1.15.3";
import { $, esc, toast, ACCEPT_ADJUNTO, validarAdjunto, mensajeErrorAdjunto } from "./state.js";
import { subirImagenMensaje, subirAudioMensaje } from "./data.js";
import { iniciarGrabacion, puedeGrabar, fmtSeg, esAudioUrl } from "./grabadora.js";

const MAX_MENSAJES = 4;
const esVideo = u => /\.(mp4|mov)(\?|$)/i.test(u || "");
const AYUDA_DEF = `Etiquetas: <code>{nombre}</code> <code>{actividad}</code> <code>{hora}</code> <code>{zona}</code>.
  Variantes al azar con <code>{hola|buenas|qué más}</code>.`;

// cfg:
//   leer() → { texto, media, partes, textoFb, etiquetaFb, mediaFb,
//              etiquetaMediaFb, sinTexto, sinMedia }
//     texto/media: lo propio del mensaje 1. Con respaldo (*Fb), vacío = se usa
//       el respaldo, salvo que `sinTexto` / `sinMedia` digan que va sin él.
//     partes: el arreglo VIVO de los mensajes 2..4 ([{ texto, media }]).
//   previa(txt)          → texto con datos de ejemplo
//   setTexto(txt|null)   → texto propio del mensaje 1 (null = sin texto propio)
//   setMedia(url|null)   → adjunto propio del mensaje 1
//   setPartes(arr)       → reemplaza los mensajes 2..4
//   setFlags({ sinTexto, sinMedia })  → SOLO donde el mensaje 1 tiene respaldo
//     (invitación): que el primero vaya sin la plantilla o sin la imagen
//     heredada. Su presencia es lo que le dice al editor que hay respaldos.
//   cambio()             → avisar a quien dependa (botones, conteos, hitos)
//   ayuda                → HTML de ayuda bajo el texto (etiquetas válidas ahí)
export function crearBurbujas(contId, cfg) {
  const b = { editando: -1, eligiendo: false, grab: null, sortable: null };
  const cont = () => $(contId);
  const conRespaldo = () => typeof cfg.setFlags === "function";

  // Lista uniforme. `textoEf` / `mediaEf` es lo que de verdad sale; `hereda*`
  // marca que viene del respaldo y no de algo escrito para este mensaje.
  const items = () => {
    const d = cfg.leer();
    const propio = (d.texto || "").trim() ? d.texto : "";
    const heredaTexto = !propio && !d.sinTexto && !!d.textoFb;
    const heredaMedia = !d.media && !d.sinMedia && !!d.mediaFb;
    return [
      { principal: true, heredaTexto, heredaMedia,
        textoEf: propio || (heredaTexto ? d.textoFb : ""),
        mediaEf: d.media || (heredaMedia ? d.mediaFb : null),
        etiquetaFb: d.etiquetaFb, etiquetaMediaFb: d.etiquetaMediaFb,
        hayMediaFb: !!d.mediaFb, sinMedia: !!d.sinMedia, sinTexto: !!d.sinTexto },
      ...d.partes.map((x, i) => ({ parte: i, textoEf: x.texto || "", mediaEf: x.media || null })),
    ];
  };

  // Escribe la lista entera de vuelta. El primero pasa a ser «el mensaje 1»;
  // los demás quedan con lo que mostraban, texto e imagen incluidos: así es
  // como la imagen heredada viaja con su mensaje en vez de quedarse arriba.
  function guardar(its) {
    const p = its[0];
    if (conRespaldo()) {
      const hT = !!p.principal && p.heredaTexto, hM = !!p.principal && p.heredaMedia;
      const txt = hT ? null : ((p.textoEf || "").trim() ? p.textoEf : null);
      const med = hM ? null : (p.mediaEf || null);
      const d = cfg.leer();
      cfg.setTexto(txt);
      cfg.setMedia(med);
      // La marca solo significa algo si hay un respaldo que evitar.
      cfg.setFlags({ sinTexto: !hT && !txt && !!d.textoFb, sinMedia: !hM && !med && !!d.mediaFb });
    } else {
      cfg.setTexto(p.textoEf || "");
      cfg.setMedia(p.mediaEf || null);
    }
    cfg.setPartes(its.slice(1).map(x => ({ texto: x.textoEf || "", media: x.mediaEf || null })));
  }
  const vacio = it => !(it.textoEf || "").trim() && !it.mediaEf;

  const mediaHTML = (url, cls) => !url ? ""
    : esAudioUrl(url) ? `<audio class="caudio" src="${esc(url)}" controls preload="metadata"></audio>`
    : esVideo(url) ? `<video class="${cls}" src="${esc(url)}" muted playsinline></video>`
    : `<img class="${cls}" src="${esc(url)}" alt="">`;
  const tipoDe = it => esAudioUrl(it.mediaEf) ? "Nota de voz"
    : esVideo(it.mediaEf) ? ((it.textoEf || "").trim() ? "Texto + video" : "Video")
    : it.mediaEf ? ((it.textoEf || "").trim() ? "Texto + imagen" : "Imagen") : "Texto";

  function burbujaVista(it, i, quieta) {
    const origen = !it.principal ? ""
      : [it.heredaTexto ? it.etiquetaFb : "", it.heredaMedia ? it.etiquetaMediaFb : ""].filter(Boolean).join(" · ");
    const txt = (it.textoEf || "").trim();
    return `<div class="cbub" data-i="${i}">
      <button type="button" class="cmover" aria-label="Arrastrar para cambiar el orden" title="Mantén presionado y arrastra">⠿</button>
      <div class="ccuerpo">
        ${mediaHTML(it.mediaEf, "cmedia")}
        ${txt ? `<div class="ctxt">${esc(cfg.previa(it.textoEf))}</div>` : ""}
        ${vacio(it) ? `<div class="ctxt vacio">Mensaje vacío</div>` : ""}
        <div class="cmeta"><span><b>${i + 1}</b> · ${tipoDe(it)}${origen ? " · " + esc(origen) : ""}</span>
          ${quieta ? "" : `<button type="button" class="ced" data-ed="${i}">✎ Editar</button>`}</div>
      </div>
    </div>`;
  }

  function edicionTexto(it, i, n) {
    const propia = it.mediaEf && !it.heredaMedia;
    return `<div class="cbub edit" data-i="${i}">
      <div class="cedhd"><span class="cnum">${i + 1}</span><b>Editando mensaje ${i + 1}</b>
        ${n > 1 ? `<button type="button" class="tbtn cquitar" data-quitar style="color:var(--bad)">Quitar mensaje</button>` : ""}</div>
      <textarea rows="4" data-txt maxlength="4000" placeholder="Escribe el mensaje…">${esc(it.textoEf || "")}</textarea>
      <div class="msgshelp">${cfg.ayuda || AYUDA_DEF}</div>
      ${it.principal && !it.heredaTexto && it.etiquetaFb && (it.textoEf || "").trim()
        ? `<button type="button" class="tbtn" data-fb>↺ Volver a ${esc(it.etiquetaFb)}</button>` : ""}
      <div class="cadj">
        ${mediaHTML(it.mediaEf, "cthumb")}
        <div class="cadjtxt">${propia ? (esVideo(it.mediaEf) ? "Video de este mensaje" : "Imagen de este mensaje")
          : it.heredaMedia ? esc(it.etiquetaMediaFb) + " · se mueve con este mensaje"
          : "Sin imagen ni video"}<span class="imgestado" data-est></span></div>
        <input type="file" data-file accept="${ACCEPT_ADJUNTO}" class="hidden">
        <button type="button" class="tbtn" data-pick>${it.mediaEf ? "Cambiar" : "＋ Imagen o video"}</button>
        ${it.mediaEf ? `<button type="button" class="tbtn" data-delmedia style="color:var(--bad)">Quitar</button>` : ""}
        ${it.principal && it.sinMedia && it.hayMediaFb && !it.mediaEf
          ? `<button type="button" class="tbtn" data-fbmedia>↺ Usar ${esc(it.etiquetaMediaFb)}</button>` : ""}
      </div>
      <div class="clisto"><button type="button" class="tbtn" data-listo>Listo</button></div>
    </div>`;
  }

  function edicionVoz(it, i, n) {
    return `<div class="cbub edit" data-i="${i}">
      <div class="cedhd"><span class="cnum">${i + 1}</span><b>Nota de voz · mensaje ${i + 1}</b>
        ${n > 1 ? `<button type="button" class="tbtn cquitar" data-quitar style="color:var(--bad)">Quitar mensaje</button>` : ""}</div>
      ${mediaHTML(it.mediaEf, "")}
      <div class="msgshelp">Una nota de voz no lleva texto. Si quieres escribir algo antes o después, agrégalo como otro mensaje y arrástralo.</div>
      <div class="clisto">
        <button type="button" class="tbtn" data-regrabar>🎤 Volver a grabar</button>
        <button type="button" class="tbtn" data-listo>Listo</button>
      </div>
    </div>`;
  }

  function burbujaGrabando(i) {
    const g = b.grab;
    return `<div class="cbub edit" data-grab>
      <div class="cedhd"><span class="cnum">${i + 1}</span><b>Nota de voz · mensaje ${i + 1}</b></div>
      ${g.subiendo ? `<div class="cgrab"><span class="imgestado">Subiendo nota de voz…</span></div>`
        : `<div class="cgrab">
            <span class="recdot${g.pausada ? " quieta" : ""}"></span>
            <span class="audtimer" data-timer>${fmtSeg(g.seg)}</span>
            <span class="cgrabest" data-recest>${g.pausada ? "En pausa" : "Grabando…"}</span>
          </div>
          <div class="clisto">
            <button type="button" class="tbtn" data-recpausa>${g.pausada ? "▶ Reanudar" : "⏸ Pausar"}</button>
            <button type="button" class="tbtn" data-recno style="color:var(--bad)">✕ Descartar</button>
            <button type="button" class="tbtn" data-recok>✔ Listo</button>
          </div>`}
    </div>`;
  }

  function pintar() {
    const el = cont();
    if (!el) return;
    const its = items();
    if (b.editando >= its.length) b.editando = -1;
    const g = b.grab;
    // Un envío nuevo arranca con un único mensaje en blanco: se abre ya en
    // edición, en vez de mostrar una burbuja «vacía» que hay que tocar primero.
    if (!g && b.editando < 0 && !b.eligiendo && its.length === 1 && vacio(its[0])) b.editando = 0;
    const cuerpo = its.map((it, i) =>
      g && g.i === i ? burbujaGrabando(i)
      : (!g && i === b.editando) ? (esAudioUrl(it.mediaEf) ? edicionVoz(it, i, its.length) : edicionTexto(it, i, its.length))
      : burbujaVista(it, i, !!g)).join("")
      + (g && g.i === its.length ? burbujaGrabando(its.length) : "");
    const cabe = its.length < MAX_MENSAJES && !g;
    el.innerHTML = `<div class="cchat">${cuerpo}</div>
      ${cabe && b.eligiendo ? `<div class="celige">
          <button type="button" data-nuevo="texto"><b>Texto</b><span>con imagen o video opcional</span></button>
          <button type="button" data-nuevo="voz"><b>🎤 Nota de voz</b><span>la grabas aquí mismo</span></button>
        </div>` : ""}
      ${cabe && !b.eligiendo ? `<button type="button" class="caddmsg">＋ Agregar mensaje</button>` : ""}
      ${its.length > 1 ? `<div class="msgshelp cayuda">Mantén presionado <b>⠿</b> y arrastra para cambiar el orden: lo de arriba llega primero.</div>` : ""}`;
    cablear(el, its);
  }

  function mover(de, a) {
    const its = items();
    const [m] = its.splice(de, 1);
    its.splice(a, 0, m);
    guardar(its);
    pintar();
    cfg.cambio?.();
  }

  function quitar(i) {
    const its = items();
    if (its.length < 2) return;
    its.splice(i, 1);
    guardar(its);
    b.editando = -1;
    pintar();
    cfg.cambio?.();
  }

  // Empieza a grabar el mensaje `i` (uno nuevo si i === cantidad actual).
  async function grabar(i) {
    if (b.grab) return;
    if (!puedeGrabar()) { toast("⚠ Este navegador no soporta grabar audio"); return; }
    b.eligiendo = false; b.editando = -1;
    const g = b.grab = { i, seg: 0, pausada: false, subiendo: false, ctl: null };
    pintar();
    try {
      g.ctl = await iniciarGrabacion((seg, pausada) => {
        g.seg = seg;
        const cambio = g.pausada !== pausada;
        g.pausada = pausada;
        // El segundero no repinta todo: perdería el foco de los botones.
        if (cambio) return pintar();
        const t = cont()?.querySelector("[data-timer]");
        if (t) t.textContent = fmtSeg(seg);
      });
      // Si la cerraron (reset) mientras el navegador pedía el micrófono.
      if (b.grab !== g) g.ctl.descartar();
    } catch (err) {
      if (b.grab === g) { b.grab = null; pintar(); }
      toast("⚠ " + err.message);
    }
  }

  async function terminarGrabacion(guardarla) {
    const g = b.grab;
    if (!g || !g.ctl || g.subiendo) return;
    if (!guardarla) { await g.ctl.descartar(); b.grab = null; return pintar(); }
    const r = await g.ctl.terminar();
    if (b.grab !== g) return;
    if (!r) { b.grab = null; toast("No quedó nada grabado"); return pintar(); }
    g.subiendo = true; pintar();
    try {
      const url = await subirAudioMensaje(r.blob, r.ext);
      if (b.grab !== g) return;
      const its = items();
      const voz = { textoEf: "", mediaEf: url };
      if (g.i < its.length) its[g.i] = voz; else its.push(voz);
      guardar(its);
    } catch (err) {
      toast("⚠ No se pudo subir la nota de voz: " + mensajeErrorAdjunto(err));
    }
    if (b.grab === g) b.grab = null;
    pintar();
    cfg.cambio?.();
  }

  function cablear(el, its) {
    const lista = el.querySelector(".cchat");
    b.sortable?.destroy();
    b.sortable = Sortable.create(lista, {
      handle: ".cmover", animation: 150, ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      // Con un mensaje abierto o grabando no se arrastra: el orden cambiaría
      // debajo de lo que se está haciendo.
      disabled: b.editando >= 0 || !!b.grab || its.length < 2,
      delay: 120, delayOnTouchOnly: true,
      onEnd: ev => { if (ev.oldIndex !== ev.newIndex) mover(ev.oldIndex, ev.newIndex); },
    });
    el.querySelectorAll("[data-ed]").forEach(x => x.onclick = () => {
      b.editando = +x.dataset.ed; b.eligiendo = false; pintar(); enfocar();
    });
    el.querySelector(".caddmsg")?.addEventListener("click", () => { b.eligiendo = true; b.editando = -1; pintar(); });
    el.querySelectorAll("[data-nuevo]").forEach(x => x.onclick = () => {
      if (x.dataset.nuevo === "voz") return grabar(its.length);
      const d = cfg.leer();
      cfg.setPartes([...d.partes.map(p => ({ ...p })), { texto: "", media: null }]);
      b.eligiendo = false; b.editando = its.length;
      pintar(); enfocar();
      cfg.cambio?.();
    });

    if (b.grab) {
      const uno = (sel, fn) => { const e = el.querySelector(sel); if (e) e.onclick = fn; };
      uno("[data-recpausa]", () => b.grab?.ctl?.alternarPausa());
      uno("[data-recok]", () => terminarGrabacion(true));
      uno("[data-recno]", () => terminarGrabacion(false));
      return;
    }

    const ed = el.querySelector(".cbub.edit");
    if (!ed) return;
    const i = +ed.dataset.i, it = its[i];
    const txt = ed.querySelector("[data-txt]");
    // Escribir no repinta: perdería el foco. Vaciar el mensaje 1 lo devuelve a
    // su respaldo (la plantilla), salvo que ya viniera marcado «sin texto».
    if (txt) txt.oninput = () => {
      if (it.principal) {
        const hay = !!txt.value.trim();
        cfg.setTexto(hay ? txt.value : (conRespaldo() ? null : ""));
        if (conRespaldo()) cfg.setFlags({ sinTexto: hay ? false : it.sinTexto, sinMedia: cfg.leer().sinMedia });
      } else { const d = cfg.leer(); d.partes[it.parte].texto = txt.value; }
      cfg.cambio?.();
    };
    ed.querySelector("[data-listo]").onclick = () => {
      // Un mensaje sin texto ni adjunto no es un mensaje: el que no es el
      // primero se quita; el primero, donde hay respaldo, vuelve a él.
      const ahora = items();
      if (vacio(ahora[i])) {
        if (i > 0) return quitar(i);
        if (conRespaldo()) cfg.setFlags({ sinTexto: false, sinMedia: cfg.leer().sinMedia });
      }
      b.editando = -1; pintar(); cfg.cambio?.();
    };
    ed.querySelector("[data-fb]")?.addEventListener("click", () => {
      cfg.setTexto(null);
      cfg.setFlags?.({ sinTexto: false, sinMedia: cfg.leer().sinMedia });
      pintar(); cfg.cambio?.();
    });
    ed.querySelector("[data-fbmedia]")?.addEventListener("click", () => {
      cfg.setFlags({ sinTexto: cfg.leer().sinTexto, sinMedia: false });
      pintar(); cfg.cambio?.();
    });
    ed.querySelector("[data-quitar]")?.addEventListener("click", () => quitar(i));
    ed.querySelector("[data-regrabar]")?.addEventListener("click", () => grabar(i));
    const file = ed.querySelector("[data-file]"), est = ed.querySelector("[data-est]");
    if (!file) return;
    ed.querySelector("[data-pick]").onclick = () => file.click();
    ed.querySelector("[data-delmedia]")?.addEventListener("click", () => ponerMedia(it, null));
    file.onchange = async () => {
      const f = file.files[0]; if (!f) return;
      const v = validarAdjunto(f);
      if (!v.ok) { est.textContent = " ⚠ " + v.error; file.value = ""; return; }
      est.textContent = v.esVideo ? " · Subiendo video…" : " · Subiendo…";
      try { ponerMedia(it, await subirImagenMensaje(f)); }
      catch (err) { est.textContent = " ⚠ " + mensajeErrorAdjunto(err); file.value = ""; }
    };
  }

  // Poner o quitar el adjunto de un mensaje. Quitárselo al primero, cuando lo
  // que se ve es la imagen heredada, es decir «este va sin imagen».
  function ponerMedia(it, url) {
    if (it.principal) {
      const d = cfg.leer();
      cfg.setMedia(url);
      if (conRespaldo()) cfg.setFlags({ sinTexto: d.sinTexto, sinMedia: !url && !!d.mediaFb });
    } else {
      const d = cfg.leer();
      cfg.setPartes(d.partes.map((x, k) => k === it.parte ? { ...x, media: url } : { ...x }));
    }
    pintar(); cfg.cambio?.();
  }

  function enfocar() {
    const t = cont()?.querySelector(".cbub.edit [data-txt]");
    if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  }

  b.pintar = pintar;
  b.grabando = () => !!b.grab;
  // Al cambiar de actividad, abrir otro formulario o cerrar el panel, nada
  // queda abierto ni grabando.
  b.reset = () => {
    const g = b.grab;
    b.grab = null; b.editando = -1; b.eligiendo = false;
    g?.ctl?.descartar();
    pintar();
  };
  return b;
}
