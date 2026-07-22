// "Mi WhatsApp": el agente ve el estado de su canal y lo vincula escaneando
// un QR. El bridge de cada agente publica su estado/QR en la tabla canales_wa
// (Supabase); aquí solo LEEMOS esa tabla y sondeamos hasta que quede vinculado.
// El QR se dibuja en el navegador a partir del string que dejó el bridge.
import { SB } from "./supabase.js";
import { state, $, esc } from "./state.js";

let poll = null;      // intervalo de sondeo mientras el modal está abierto
let ultimo = null;    // firma del último estado pintado (evita re-render/flicker)

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
    .select("estado, qr, telefono")
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

async function pintarQR(cont, texto) {
  cont.innerHTML = `<div class="naplica">Generando QR…</div>`;
  try {
    const { default: QRCode } = await import("https://esm.sh/qrcode@1.5.4");
    const url = await QRCode.toDataURL(texto, { width: 240, margin: 1 });
    cont.innerHTML = `<img src="${url}" alt="QR" style="width:240px;height:240px;border-radius:12px;background:#fff;padding:8px">`;
  } catch (e) {
    cont.innerHTML = `<div class="naplica">No pude generar el QR. Cierra y vuelve a abrir.</div>`;
  }
}

function renderBody(c) {
  const body = $("canalBody");
  const estado = c?.estado || "sin_vincular";

  if (estado === "vinculado") {
    body.innerHTML = `
      <div style="text-align:center;padding:18px 0">
        <div style="font-size:2.4rem">✅</div>
        <div style="margin-top:6px"><b>WhatsApp vinculado</b></div>
        ${c.telefono ? `<div class="sfecha">+${esc(c.telefono)}</div>` : ""}
        <div class="naplica" style="margin-top:10px">Tus mensajes programados salen desde este número.</div>
      </div>`;
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

  if (estado === "vinculando" || estado === "solicitado") {
    body.innerHTML = `<div class="naplica" style="padding:26px 0;text-align:center">⏳ Preparando tu código QR…<br>Un momento.</div>`;
    return;
  }

  // sin_vincular / sin fila todavía
  body.innerHTML = `<div class="naplica" style="padding:22px 0;text-align:center">
    Tu canal de WhatsApp aún no está activo.<br>
    Pídele al administrador que lo active para tu cuenta y vuelve a abrir esta ventana.</div>`;
}

function detener() { if (poll) { clearInterval(poll); poll = null; } }

async function tick() {
  const c = await leerCanal();
  const sig = (c?.estado || "") + "|" + (c?.qr || "");
  if (sig !== ultimo) { ultimo = sig; renderBody(c); }
  const el = $("canalEstado");
  if (el) el.textContent = ESTADOS[c?.estado] || ESTADOS.sin_vincular;
  if (c?.estado === "vinculado") detener();   // estado final: dejar de sondear
}

function abrir() {
  ultimo = null;
  $("canalBody").innerHTML = `<div class="naplica" style="padding:22px 0;text-align:center">Cargando…</div>`;
  $("canalOverlay").classList.add("open");
  tick();
  poll = setInterval(tick, 3500);
}

function cerrar() { detener(); $("canalOverlay").classList.remove("open"); }

/* ---------- wiring ---------- */
$("btnCanal").onclick = abrir;
$("canalCerrar").onclick = cerrar;
$("canalOverlay").onclick = e => { if (e.target.id === "canalOverlay") cerrar(); };
