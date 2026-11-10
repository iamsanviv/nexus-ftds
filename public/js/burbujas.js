// Editor de la invitación como conversación de WhatsApp (pedido de Sanviv,
// 10/11/2026). Antes el mensaje 1 era «✎ Personalizar la invitación» con su
// imagen en otro bloque, y los adicionales aparecían como «Mensaje 2» en una
// lista aparte: no se entendía que eran la misma secuencia. Aquí se ven todos
// como burbujas, en el orden en que le llegan a la persona, y se reordenan
// arrastrando.
//
// No guarda nada propio: es una vista sobre el estado que ya existía (texto e
// imagen de la invitación + editor de la serie). Así el guardado, la
// programación y la base no cambian; `cfg` dice de dónde leer y dónde escribir.
import Sortable from "https://esm.sh/sortablejs@1.15.3";
import { $, esc, toast, ACCEPT_ADJUNTO, validarAdjunto, mensajeErrorAdjunto } from "./state.js";
import { subirImagenMensaje } from "./data.js";

const MAX_MENSAJES = 4;
const esVideo = u => /\.(mp4|mov)(\?|$)/i.test(u || "");

// cfg:
//   leer() → { texto, textoFb, etiquetaFb, media, mediaFb, etiquetaMediaFb, partes }
//     texto/media: lo propio del mensaje 1 (null = se usa el respaldo *Fb).
//     partes: el arreglo VIVO del editor de la serie ([{ texto, media }]).
//   previa(txt)          → texto con datos de ejemplo
//   setTexto(txt|null)   → mensaje 1 propio (null = vuelve al respaldo)
//   setMedia(url|null)   → adjunto propio del mensaje 1
//   setPartes(arr)       → reemplaza los mensajes 2..4 y repinta la serie
//   cambio()             → avisar a quien dependa (botones, hitos)
export function crearBurbujas(contId, cfg) {
  const b = { editando: -1, sortable: null };
  const cont = () => $(contId);

  // Lista uniforme: el 1 con sus respaldos resueltos, el resto tal cual.
  const items = () => {
    const d = cfg.leer();
    return [
      { principal: true, texto: d.texto, media: d.media, textoFb: d.textoFb, etiquetaFb: d.etiquetaFb,
        mediaFb: d.mediaFb, etiquetaMediaFb: d.etiquetaMediaFb },
      ...d.partes.map((x, i) => ({ parte: i, texto: x.texto || "", media: x.media || null })),
    ];
  };

  const mediaHTML = (url, cls) => !url ? ""
    : esVideo(url) ? `<video class="${cls}" src="${esc(url)}" muted playsinline></video>`
    : `<img class="${cls}" src="${esc(url)}" alt="">`;

  function burbujaVista(it, i) {
    const texto = it.principal ? (it.texto || it.textoFb || "") : it.texto;
    const media = it.principal ? (it.media || it.mediaFb) : it.media;
    const origen = it.principal
      ? [it.texto ? "texto propio" : it.etiquetaFb, !it.media && it.mediaFb ? it.etiquetaMediaFb : ""].filter(Boolean).join(" · ")
      : "";
    return `<div class="cbub" data-i="${i}">
      <button type="button" class="cmover" aria-label="Arrastrar para cambiar el orden" title="Mantén presionado y arrastra">⠿</button>
      <div class="ccuerpo">
        ${mediaHTML(media, "cmedia")}
        ${texto.trim() ? `<div class="ctxt">${esc(cfg.previa(texto))}</div>` : `<div class="ctxt vacio">Solo ${esVideo(media) ? "video" : "imagen"}</div>`}
        <div class="cmeta"><span><b>${i + 1}</b>${origen ? " · " + esc(origen) : ""}</span>
          <button type="button" class="ced" data-ed="${i}">✎ Editar</button></div>
      </div>
    </div>`;
  }

  function burbujaEdicion(it, i) {
    const texto = it.principal ? (it.texto ?? "") : it.texto;
    const valor = it.principal && !it.texto ? (it.textoFb || "") : texto;
    const propia = it.media;
    const fb = it.principal && !propia ? it.mediaFb : null;
    return `<div class="cbub edit" data-i="${i}">
      <div class="cedhd"><span class="cnum">${i + 1}</span><b>Editando mensaje ${i + 1}</b>
        ${it.principal ? "" : `<button type="button" class="tbtn cquitar" data-quitar style="color:var(--bad)">Quitar mensaje</button>`}</div>
      <textarea rows="4" data-txt maxlength="4000" placeholder="Escribe el mensaje…">${esc(valor)}</textarea>
      <div class="msgshelp">Etiquetas: <code>{nombre}</code> <code>{actividad}</code> <code>{hora}</code> <code>{zona}</code>.
        Variantes al azar con <code>{hola|buenas|qué más}</code>.</div>
      ${it.principal && it.texto ? `<button type="button" class="tbtn" data-fb>↺ Volver a ${esc(it.etiquetaFb)}</button>` : ""}
      <div class="cadj">
        ${mediaHTML(propia || fb, "cthumb")}
        <div class="cadjtxt">${propia ? (esVideo(propia) ? "Video de este mensaje" : "Imagen de este mensaje")
          : fb ? esc(it.etiquetaMediaFb) + " · va siempre en el primer mensaje"
          : "Sin imagen ni video"}<span class="imgestado" data-est></span></div>
        <input type="file" data-file accept="${ACCEPT_ADJUNTO}" class="hidden">
        <button type="button" class="tbtn" data-pick>${propia || fb ? "Cambiar" : "＋ Imagen o video"}</button>
        ${propia ? `<button type="button" class="tbtn" data-delmedia style="color:var(--bad)">Quitar</button>` : ""}
      </div>
      <div class="clisto"><button type="button" class="tbtn" data-listo>Listo</button></div>
    </div>`;
  }

  // Mueve el mensaje de `de` a `a`. Si cambia el PRIMERO, el que baja se
  // convierte en un mensaje normal con su texto escrito tal cual (la plantilla
  // no se puede «heredar» en otra posición: solo la invitación la usa), y el
  // que sube pasa a ser la invitación. La imagen del catálogo/actividad no se
  // mueve: es el respaldo del primer mensaje, sea cual sea.
  function mover(de, a) {
    const its = items();
    const [m] = its.splice(de, 1);
    its.splice(a, 0, m);
    const nuevo = its[0];
    if (!nuevo.principal) {
      if (!nuevo.texto.trim()) {
        toast("El primer mensaje necesita texto: ponle uno a ese mensaje antes de subirlo.");
        return pintar();
      }
      const viejo = its.find(x => x.principal);
      viejo.texto = viejo.texto || viejo.textoFb || "";
      cfg.setTexto(nuevo.texto);
      cfg.setMedia(nuevo.media);
    }
    cfg.setPartes(its.slice(1).map(x => ({ texto: x.texto || "", media: x.media || null })));
    pintar();
    cfg.cambio?.();
  }

  function pintar() {
    const el = cont();
    if (!el) return;
    const its = items();
    if (b.editando >= its.length) b.editando = -1;
    el.innerHTML = `<div class="cchat">${its.map((it, i) => i === b.editando ? burbujaEdicion(it, i) : burbujaVista(it, i)).join("")}</div>
      ${its.length < MAX_MENSAJES ? `<button type="button" class="caddmsg">＋ Agregar mensaje</button>` : ""}
      ${its.length > 1 ? `<div class="msgshelp cayuda">Mantén presionado <b>⠿</b> y arrastra para cambiar el orden.</div>` : ""}`;
    cablear(el, its);
  }

  function cablear(el, its) {
    const lista = el.querySelector(".cchat");
    b.sortable?.destroy();
    b.sortable = Sortable.create(lista, {
      handle: ".cmover", animation: 150, ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      // Con un mensaje abierto no se arrastra: el orden cambiaría debajo de lo
      // que se está escribiendo.
      disabled: b.editando >= 0 || its.length < 2,
      delay: 120, delayOnTouchOnly: true,
      onEnd: ev => { if (ev.oldIndex !== ev.newIndex) mover(ev.oldIndex, ev.newIndex); },
    });
    el.querySelectorAll("[data-ed]").forEach(x => x.onclick = () => { b.editando = +x.dataset.ed; pintar(); enfocar(); });
    el.querySelector(".caddmsg")?.addEventListener("click", () => {
      const d = cfg.leer();
      cfg.setPartes([...d.partes.map(x => ({ ...x })), { texto: "", media: null }]);
      b.editando = its.length;
      pintar(); enfocar();
      cfg.cambio?.();
    });
    const ed = el.querySelector(".cbub.edit");
    if (!ed) return;
    const i = +ed.dataset.i, it = its[i];
    const txt = ed.querySelector("[data-txt]");
    // Escribir no repinta: perdería el foco. El mensaje 1 solo se vuelve
    // «propio» cuando de verdad se escribe; abrirlo no cambia nada.
    txt.oninput = () => {
      if (it.principal) cfg.setTexto(txt.value.trim() ? txt.value : null);
      else { const d = cfg.leer(); d.partes[it.parte].texto = txt.value; }
      cfg.cambio?.();
    };
    ed.querySelector("[data-listo]").onclick = () => { b.editando = -1; pintar(); cfg.cambio?.(); };
    ed.querySelector("[data-fb]")?.addEventListener("click", () => { cfg.setTexto(null); pintar(); cfg.cambio?.(); });
    ed.querySelector("[data-quitar]")?.addEventListener("click", () => {
      const d = cfg.leer();
      cfg.setPartes(d.partes.filter((_, k) => k !== it.parte).map(x => ({ ...x })));
      b.editando = -1; pintar(); cfg.cambio?.();
    });
    const file = ed.querySelector("[data-file]"), est = ed.querySelector("[data-est]");
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

  function ponerMedia(it, url) {
    if (it.principal) cfg.setMedia(url);
    else {
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
  // Al cambiar de actividad o abrir otra en el formulario, nada queda abierto.
  b.reset = () => { b.editando = -1; pintar(); };
  return b;
}
