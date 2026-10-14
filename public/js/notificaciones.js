// «Notificaciones»: activar push en este dispositivo y elegir qué avisos llegan.
//
// La suscripción es POR DISPOSITIVO (cada navegador tiene su endpoint): el
// agente la activa una vez en la PC y otra en el teléfono. Qué genera un aviso
// y cómo se entrega vive en la base y en la Edge Function `enviar-push`
// (sql/2026-10-14_34_notificaciones_push.sql); aquí solo se suscribe, se
// eligen tipos y se manda una prueba.
import { SB } from "./supabase.js";
import { state, $, esc, toast } from "./state.js";

// Orden y textos de los ajustes. Las claves son las de la base
// (notificaciones.tipo / notif_apagadas.tipo).
const TIPOS = [
  ["respondio",    "Te respondió un cliente", "Te escribió después de un mensaje tuyo de seguimiento o masivo."],
  ["escribio_hoy", "Te escribió hoy",         "El primer mensaje del día de un lead o un pendiente de depósito."],
  ["temperatura",  "Subió de temperatura",    "Un lead volvió a escribir y subió de nivel."],
  ["zoom",         "Tu zoom empieza pronto",  "Una hora antes de una actividad tuya o con invitados tuyos."],
  ["canal",        "Problemas con tu WhatsApp", "Se desconectó, dejó de dar señales o los envíos están fallando."],
];

const soporta = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
// iPhone/iPad solo entregan push a la app agregada a la pantalla de inicio.
// iPadOS se presenta como Mac; se distingue por la pantalla táctil.
const esIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const instalada = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

let reg = null;          // ServiceWorkerRegistration
let apagadas = new Set();

const b64aBytes = b64 => {
  const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};
const bytesAb64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function registro() {
  if (reg) return reg;
  reg = await navigator.serviceWorker.register("/sw.js");
  return reg;
}

async function guardar(sub) {
  const k = sub.toJSON().keys || {};
  const disp = `${esIOS() ? "iOS" : /Android/.test(navigator.userAgent) ? "Android" : "PC"} · ${navigator.userAgent}`;
  const { error } = await SB.rpc("registrar_push", {
    p_endpoint: sub.endpoint, p_p256dh: k.p256dh || bytesAb64(sub.getKey("p256dh")),
    p_auth: k.auth || bytesAb64(sub.getKey("auth")), p_dispositivo: disp,
  });
  if (error) throw error;
}

async function suscribir() {
  const { data: clave, error } = await SB.rpc("vapid_publica");
  if (error || !clave) throw error || new Error("El servidor de avisos no está listo.");
  const r = await registro();
  let sub = await r.pushManager.getSubscription();
  // Una suscripción hecha con otra llave no sirve: el servicio push rechaza
  // nuestros envíos. Se rehace.
  if (sub && sub.options?.applicationServerKey
      && bytesAb64(sub.options.applicationServerKey) !== clave.replace(/=+$/, "")) {
    await sub.unsubscribe(); sub = null;
  }
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64aBytes(clave) });
  await guardar(sub);
}

// Al entrar: si este dispositivo ya dio permiso, renueva la suscripción en la
// base (puede haber caducado, o este navegador lo usaba otro agente). Nunca
// pide permiso solo: el navegador lo castiga si no viene de un clic.
export async function iniciarNotificaciones() {
  if (!soporta()) return pintarFila();
  try {
    await registro();
    if (Notification.permission === "granted") await suscribir();
  } catch (e) { console.warn("notificaciones:", e); }
  pintarFila();
}

// Al cerrar sesión: este dispositivo deja de recibir los avisos de quien salió.
export async function olvidarDispositivo() {
  try {
    if (!soporta()) return;
    const r = await navigator.serviceWorker.getRegistration("/");
    const sub = r && await r.pushManager.getSubscription();
    if (sub) { await SB.rpc("quitar_push", { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
  } catch (e) { console.warn("notificaciones:", e); }
}

async function estadoDispositivo() {
  if (!soporta()) return esIOS() && !instalada() ? "ios" : "nosoporta";
  if (esIOS() && !instalada()) return "ios";
  if (Notification.permission === "denied") return "bloqueado";
  const r = await navigator.serviceWorker.getRegistration("/");
  const sub = r && await r.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "activo" : "inactivo";
}

async function pintarFila() {
  const el = $("notifEstado");
  if (!el) return;
  const e = await estadoDispositivo().catch(() => "inactivo");
  el.textContent = e === "activo" ? "● Activadas" : "Apagadas";
  el.classList.toggle("off", e !== "activo");
}

async function cargarApagadas() {
  const { data } = await SB.from("notif_apagadas").select("tipo").eq("owner_id", state.me.id);
  apagadas = new Set((data || []).map(r => r.tipo));
}

const AVISO = {
  ios: `En iPhone los avisos solo llegan si abres el panel desde la pantalla de inicio.
        Toca <b>Compartir</b> › <b>Agregar a inicio</b>, abre <b>Seguimiento</b> desde ese ícono y vuelve aquí.`,
  nosoporta: "Este navegador no puede recibir notificaciones. Usa Chrome, Edge o Firefox en la PC, o Chrome en Android.",
  bloqueado: `Bloqueaste las notificaciones de este sitio. Habilítalas desde el candado de la barra de direcciones
              (<b>Configuración del sitio › Notificaciones › Permitir</b>) y vuelve a abrir esta ventana.`,
};

async function render() {
  const e = await estadoDispositivo();
  const disp = e === "activo"
    ? `<div class="notifok"><b>Activadas en este dispositivo.</b> Actívalas también en tu ${/Android|iPhone|iPad/.test(navigator.userAgent) ? "PC" : "teléfono"} para recibirlas ahí.</div>
       <div class="notifacc">
         <button class="btn-oro" id="notifPrueba">Enviar una prueba</button>
         <button class="tbtn" id="notifQuitar">Desactivar aquí</button>
       </div>`
    : AVISO[e]
      ? `<div class="notifaviso">${AVISO[e]}</div>`
      : `<div class="notifintro">Te avisamos en este dispositivo aunque el panel esté cerrado.</div>
         <div class="notifacc"><button class="btn-oro" id="notifActivar">Activar en este dispositivo</button></div>`;

  const lista = TIPOS.map(([k, n, d]) => `
    <label class="notiftipo"><input type="checkbox" data-tipo="${k}" ${apagadas.has(k) ? "" : "checked"}>
      <span><b>${esc(n)}</b><small>${esc(d)}</small></span></label>`).join("");

  $("notifBody").innerHTML = `${disp}
    <h3 class="notifh">Qué te avisamos<span class="rule"></span></h3>
    <div class="notiftipos">${lista}</div>
    <div class="msgshelp">Los avisos de WhatsApp llegan con unos 5 minutos de demora y solo de tus propios clientes.</div>`;

  const act = $("notifActivar");
  if (act) act.onclick = async () => {
    act.disabled = true; act.textContent = "Activando…";
    try {
      const p = await Notification.requestPermission();
      if (p !== "granted") { render(); return; }
      await suscribir();
      toast("🔔 Notificaciones activadas en este dispositivo");
      await SB.rpc("notificar_prueba");
    } catch (err) { toast("⚠ No se pudieron activar: " + (err.message || err)); }
    render(); pintarFila();
  };
  const pr = $("notifPrueba");
  if (pr) pr.onclick = async () => {
    pr.disabled = true;
    const { error } = await SB.rpc("notificar_prueba");
    toast(error ? "⚠ " + error.message : "Prueba enviada: debería llegarte en unos segundos");
    setTimeout(() => { pr.disabled = false; }, 3000);
  };
  const q = $("notifQuitar");
  if (q) q.onclick = async () => { await olvidarDispositivo(); toast("Notificaciones desactivadas en este dispositivo"); render(); pintarFila(); };

  $("notifBody").querySelectorAll("input[data-tipo]").forEach(i => i.onchange = async () => {
    const tipo = i.dataset.tipo;
    const { error } = i.checked
      ? await SB.from("notif_apagadas").delete().eq("owner_id", state.me.id).eq("tipo", tipo)
      : await SB.from("notif_apagadas").insert({ tipo });
    if (error) { i.checked = !i.checked; toast("⚠ " + error.message); return; }
    i.checked ? apagadas.delete(tipo) : apagadas.add(tipo);
  });
}

async function abrir() {
  $("notifBody").innerHTML = `<div class="naplica" style="padding:22px 0;text-align:center">Cargando…</div>`;
  $("notifOverlay").classList.add("open");
  await cargarApagadas().catch(() => {});
  render();
}
const cerrar = () => $("notifOverlay").classList.remove("open");

$("btnNotif").onclick = abrir;
$("notifCerrar").onclick = cerrar;
$("notifOverlay").onclick = e => { if (e.target.id === "notifOverlay") cerrar(); };
