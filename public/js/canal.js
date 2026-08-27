// "Mi WhatsApp": el agente ve el estado de su canal y lo vincula escaneando
// un QR. El bridge de cada agente publica su estado/QR en la tabla canales_wa
// (Supabase); aquí solo LEEMOS esa tabla y sondeamos hasta que quede vinculado.
// El QR se dibuja en el navegador a partir del string que dejó el bridge.
import { SB } from "./supabase.js";
import { state, $, esc, toast } from "./state.js";

let poll = null;      // intervalo de sondeo mientras el modal está abierto
let ultimo = null;    // firma del último estado pintado (evita re-render/flicker)
let desvinculando = false;  // esperando que el bridge procese "desvincular"
let relojDesv = null;       // temporizador del intento de desvincular en curso

/* El bridge reescribe `actualizado` cada ~30 s aunque no pase nada: es su
   latido. Si lleva más que esto sin escribir, está caído, y entonces `estado`
   es una foto vieja — no la realidad. Con 90 s caben dos latidos perdidos
   antes de dar a nadie por muerto. */
const LATIDO_VIVO_SEG = 90;
// Cuánto se le concede al bridge para recoger la orden antes de darla por no
// atendida. El bridge sondea su columna cada pocos segundos; 20 s es de sobra.
const ESPERA_DESV_SEG = 20;

const segundosDesde = iso => iso ? (Date.now() - new Date(iso).getTime()) / 1000 : Infinity;
const bridgeVivo = c => segundosDesde(c?.actualizado) < LATIDO_VIVO_SEG;

// estado -> [etiqueta corta para la fila de "Más"]
const ESTADOS = {
  vinculado:    "● Vinculado",
  vinculando:   "◔ Escanea el QR",
  solicitado:   "◌ Preparando…",
  sin_vincular: "○ Sin vincular",
};

async function leerCanal() {
  if (!state.me) return null;
  const { data } = await SB.from("canales_wa")
    .select("estado, qr, telefono, actualizado, comando, comando_en")
    .eq("owner_id", state.me.id)
    .maybeSingle();
  return data;
}

// Refresca solo la etiqueta de la fila "Mi WhatsApp" en la vista Más.
export async function refrescarCanal() {
  const el = $("canalEstado");
  if (!el || !state.me) return;
  const c = await leerCanal();
  el.textContent = ESTADOS[c?.estado] || ESTADOS.sin_vincular;
}

// ¿El WhatsApp de este agente está vinculado? (para habilitar Seguimiento).
export async function canalVinculado() {
  const c = await leerCanal();
  return c?.estado === "vinculado";
}

async function pintarQR(cont, texto) {
  cont.innerHTML = `<div class="naplica">Generando QR…</div>`;
  try {
    const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.4");
    // Nivel L (como WhatsApp) y grande: el código de WA es largo (~250 chars),
    // con nivel M/240px sale demasiado denso y el teléfono no lo escanea bien.
    const url = await QRCode.toDataURL(texto, { errorCorrectionLevel: "L", width: 320, margin: 2 });
    cont.innerHTML = `<img src="${url}" alt="QR" style="width:min(320px,80vw);height:auto;border-radius:12px;background:#fff;padding:10px">`;
  } catch (e) {
    cont.innerHTML = `<div class="naplica">No pude generar el QR. Cierra y vuelve a abrir.</div>`;
  }
}

function renderBody(c) {
  const body = $("canalBody");
  const estado = c?.estado || "sin_vincular";

  if (estado === "vinculado") {
    /* «Vinculado» sale de una fila que escribe el bridge. Si el bridge está
       caído, esa fila se queda congelada diciendo «vinculado» para siempre —
       fue exactamente lo que pasó el 26/08/2026: la fila llevaba un mes sin
       tocarse y el panel la mostraba como verdad mientras TODOS los envíos
       fallaban. Sin latido no afirmamos nada: se avisa. */
    const vivo = bridgeVivo(c);
    body.innerHTML = `
      <div style="text-align:center;padding:18px 0">
        <div style="font-size:2.4rem">${vivo ? "✅" : "⚠️"}</div>
        <div style="margin-top:6px"><b>${vivo ? "WhatsApp vinculado" : "Sin señal de tu WhatsApp"}</b></div>
        ${c.telefono ? `<div class="sfecha">+${esc(c.telefono)}</div>` : ""}
        <div class="naplica" style="margin:10px 0 16px">${vivo
          ? "Tus mensajes programados salen desde este número."
          : "Figura vinculado, pero su servicio lleva rato sin dar señales, "
            + "así que puede que tus mensajes no estén saliendo. Avisa al administrador."}</div>
        <button class="tbtn" id="canalDesv" style="color:#ff6b6b;border-color:#ff6b6b">Desvincular este WhatsApp</button>
      </div>`;
    const b = $("canalDesv");
    if (b) b.onclick = desvincular;
    return;
  }

  if (estado === "vinculando" && c?.qr) {
    body.innerHTML = `
      <div class="authsub">En tu teléfono: WhatsApp › <b>Dispositivos vinculados</b> › Vincular un dispositivo, y escanea:</div>
      <div id="canalQR" style="display:flex;justify-content:center;margin:14px 0"></div>
      <div class="naplica">El código se actualiza solo. No cierres esta ventana.</div>`;
    pintarQR($("canalQR"), c.qr);
    return;
  }

  // Estados transitorios de un canal YA aprovisionado (hay fila): vinculando
  // sin qr, solicitado (reiniciando), o sin_vincular momentáneo → está por salir
  // un QR fresco. Nunca mandamos al admin si el canal ya existe.
  if (c) {
    body.innerHTML = `<div class="naplica" style="padding:26px 0;text-align:center">⏳ Preparando tu código QR…<br>Un momento (se genera solo).</div>`;
    return;
  }

  // Sin fila en canales_wa: el agente nunca fue aprovisionado.
  body.innerHTML = `<div class="naplica" style="padding:22px 0;text-align:center">
    Tu canal de WhatsApp aún no está activo.<br>
    Pídele al administrador que lo active para tu cuenta y vuelve a abrir esta ventana.</div>`;
}

// Pide al bridge cerrar la sesión de WhatsApp (comando en canales_wa que el
// bridge escucha). Tras desvincular, el bridge reinicia y ofrece un QR nuevo,
// así el agente puede re-vincularse solo cuando quiera.
async function desvincular() {
  if (!confirm("¿Desvincular tu WhatsApp? Dejarás de enviar mensajes hasta que vuelvas a escanear el código QR.")) return;

  /* No encolar una orden que nadie va a recoger. Si el bridge está caído, la
     orden se queda guardada y detona cuando vuelva — puede ser DÍAS después,
     cerrando de golpe una sesión recién vinculada. Pasó el 26/08/2026:
     emparejó a las 00:39:34 y a las 00:39:38 se autodesvinculó con una orden
     vieja. Es mejor no aceptar la orden que aceptarla y traicionarla luego. */
  const antes = await leerCanal();
  if (!bridgeVivo(antes)) {
    mensajeDesv("⚠️", "No pude desvincular",
      "El servicio de tu WhatsApp no está respondiendo, así que no hay quien "
      + "atienda la orden. No la dejo encolada a propósito: se ejecutaría sola "
      + "más tarde y cerraría una sesión que para entonces podría estar bien. "
      + "Avisa al administrador.");
    return;
  }

  const { error } = await SB.from("canales_wa").update({ comando: "desvincular" }).eq("owner_id", state.me.id);
  if (error) { toast("⚠ No se pudo: " + error.message); return; }
  desvinculando = true;          // no revertir a "Vinculado" hasta que el estado cambie
  $("canalBody").innerHTML = `<div class="naplica" style="padding:26px 0;text-align:center">⏳ Desvinculando…<br>Espera unos segundos.</div>`;

  clearTimeout(relojDesv);
  relojDesv = setTimeout(rendirseDesvincular, ESPERA_DESV_SEG * 1000);
}

/* Se acabó el plazo. Antes esto solo soltaba la bandera y volvía a pintar, así
   que el panel mostraba «Vinculado» otra vez sin decir nada: el agente pulsaba
   el botón, esperaba, y aparentemente no pasaba nada. Ese era el bug.
   Ahora se distingue qué ocurrió y, si la orden sigue sin recoger, se RETIRA
   para que no detone más tarde. */
async function rendirseDesvincular() {
  desvinculando = false;
  const c = await leerCanal();

  if (c?.estado !== "vinculado") { ultimo = null; return; }   // sí funcionó

  if (c?.comando === "desvincular") {
    // Nadie la recogió. Retirarla es la parte que evita el desvinculado
    // fantasma de días después.
    await SB.from("canales_wa").update({ comando: null }).eq("owner_id", state.me.id);
    mensajeDesv("⚠️", "No se pudo desvincular",
      "Tu WhatsApp sigue vinculado: su servicio no atendió la orden. La retiré "
      + "para que no se ejecute sola más tarde y te cierre la sesión sin aviso. "
      + "Vuelve a intentarlo; si sigue igual, avisa al administrador.");
    return;
  }
  ultimo = null;   // la recogió pero aún no cambia de estado: seguir sondeando
}

function mensajeDesv(icono, titulo, detalle) {
  $("canalBody").innerHTML = `
    <div style="text-align:center;padding:18px 0">
      <div style="font-size:2.4rem">${icono}</div>
      <div style="margin-top:6px"><b>${esc(titulo)}</b></div>
      <div class="naplica" style="margin:10px 0 16px">${esc(detalle)}</div>
      <button class="tbtn" id="canalReintentar">Entendido</button>
    </div>`;
  const b = $("canalReintentar");
  if (b) b.onclick = () => { ultimo = null; tick(); };
}

function detener() {
  if (poll) { clearInterval(poll); poll = null; }
  // Si no, el temporizador dispara con el modal cerrado y escribe sobre un
  // cuerpo que ya no se ve (o sobre el de la próxima apertura).
  clearTimeout(relojDesv); relojDesv = null;
}

// Sondea mientras el modal está abierto (no se detiene en 'vinculado': así la
// desvinculación y la re-vinculación se ven en tiempo real). Solo para al cerrar.
function arrancarPoll() {
  detener();
  tick();
  poll = setInterval(tick, 2500);
}

async function tick() {
  const c = await leerCanal();
  // Tras pulsar "Desvincular", el bridge tarda unos segundos en procesarlo.
  // Mientras siga 'vinculado', no revertir el mensaje de transición; en cuanto
  // el estado cambie, seguir el flujo normal (Preparando… / QR).
  if (desvinculando) {
    if (c?.estado === "vinculado") return;
    desvinculando = false;
    ultimo = null;   // fuerza re-render del nuevo estado
  }
  const sig = (c?.estado || "") + "|" + (c?.qr || "") + "|" + (bridgeVivo(c) ? "1" : "0");
  if (sig !== ultimo) { ultimo = sig; renderBody(c); }
  const el = $("canalEstado");
  if (el) el.textContent = ESTADOS[c?.estado] || ESTADOS.sin_vincular;
}

function abrir() {
  ultimo = null;
  desvinculando = false;
  $("canalBody").innerHTML = `<div class="naplica" style="padding:22px 0;text-align:center">Cargando…</div>`;
  $("canalOverlay").classList.add("open");
  arrancarPoll();
}

function cerrar() { detener(); $("canalOverlay").classList.remove("open"); }

/* ---------- wiring ---------- */
$("btnCanal").onclick = abrir;
$("canalCerrar").onclick = cerrar;
$("canalOverlay").onclick = e => { if (e.target.id === "canalOverlay") cerrar(); };
