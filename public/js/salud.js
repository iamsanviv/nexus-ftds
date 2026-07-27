// Salud de canales: avisa cuando los mensajes de un agente están fallando.
//
// Nació de un caso real: a una agente le restringieron el WhatsApp, sus
// mensajes empezaron a fallar y nadie se enteró en tres días. La detección
// pasiva (mirar el registro) no sirve — el aviso tiene que salir solo.
//
// Dos frentes, misma fuente (la vista `salud_canales`, que ya filtra por RLS):
//   · el agente ve un aviso en su pantalla de Seguimiento;
//   · el director ve el estado de todos en «Más → Agentes y canales».
import { SB } from "./supabase.js";
import { state, $, esc, toast } from "./state.js";

// La vista puede no existir todavía (si aún no se corrió el SQL). En ese caso
// no rompemos nada: simplemente no hay aviso.
async function leerSalud() {
  const { data, error } = await SB.from("salud_canales")
    .select("owner_id, nombre, rol, estado_canal, telefono, enviados_24h, fallidos_24h, atascados, ultimo_envio_ok, ultimo_error, salud");
  if (error) return null;
  return data || [];
}

const fechaCorta = iso => iso
  ? new Date(iso).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })
  : "—";

/* ================= AVISO PARA EL AGENTE ================= */
// Se muestra arriba de Seguimiento. El texto dice qué pasó y qué hacer;
// en el caso de «fallando» nombra explícitamente la causa más probable,
// que es que WhatsApp haya restringido el número.
const AVISOS = {
  sin_canal: f => ({
    tono: "mal",
    titulo: "Tu WhatsApp no está vinculado",
    texto: "Mientras siga así, nada de lo que programes va a salir. Vincúlalo en «Más → Mi WhatsApp».",
  }),
  fallando: f => ({
    tono: "mal",
    // La cifra de 24 h se queda corta si el agente lleva días sin intentar:
    // en ese caso se habla de los últimos intentos, que es lo que de verdad
    // describe el problema.
    titulo: f.fallidos_24h >= 3
      ? `Tus mensajes están fallando (${f.fallidos_24h} en 24 h)`
      : `Tus mensajes están fallando (${f.fallidos_u10} de los últimos ${f.intentos_u10})`,
    texto: "Casi todo lo que intentaste enviar falló. La causa más común es que WhatsApp haya restringido tu número por envíos masivos, " +
           "lo que además tumba la sesión vinculada. Revisa si te llegó un aviso en la app de WhatsApp y no programes más envíos hasta " +
           "resolverlo: insistir empeora la restricción.",
  }),
  degradado: f => ({
    tono: "ojo",
    titulo: `${f.fallidos_24h} mensajes fallaron en las últimas 24 h`,
    texto: "Algunos salieron bien, así que el canal sigue vivo. Vale la pena mirar el registro de envíos para ver el patrón.",
  }),
  atascado: f => ({
    tono: "ojo",
    titulo: `${f.atascados} mensajes llevan rato sin salir`,
    texto: "Están en cola con la hora ya pasada. Si en un rato siguen igual, avísale al administrador.",
  }),
};

export async function avisarSiCanalCaido() {
  const cont = $("segAlerta");
  if (!cont || !state.me) return;
  cont.classList.add("hidden");
  cont.innerHTML = "";

  const filas = await leerSalud();
  if (!filas) return;                                   // vista aún no creada
  const mia = filas.find(f => f.owner_id === state.me.id);
  if (!mia || mia.salud === "ok") return;

  const a = (AVISOS[mia.salud] || (() => null))(mia);
  if (!a) return;

  cont.innerHTML = `
    <div class="alerta ${a.tono}">
      <div class="at">${esc(a.titulo)}</div>
      <div class="ax">${esc(a.texto)}</div>
      ${mia.ultimo_error ? `<div class="ae">Último error: ${esc(String(mia.ultimo_error).slice(0, 140))}</div>` : ""}
    </div>`;
  cont.classList.remove("hidden");
}

/* ================= PANEL DEL DIRECTOR ================= */
const SALUD_ETIQUETA = {
  ok:        ["ok",  "Operando"],
  degradado: ["ojo", "Con fallos"],
  atascado:  ["ojo", "Atascado"],
  fallando:  ["mal", "Fallando"],
  sin_canal: ["mal", "Sin canal"],
  // Nunca envió nada: es un pendiente de activación, no una avería. Va en
  // gris y al final, para no competir con los problemas de verdad.
  sin_uso:   ["gris", "Sin estrenar"],
};

// Orden: primero lo que necesita atención, al final lo que nunca arrancó.
const PRIORIDAD = { fallando: 0, sin_canal: 1, atascado: 2, degradado: 3, ok: 4, sin_uso: 5 };

async function renderAgentes() {
  const body = $("agentesBody");
  const filas = await leerSalud();
  if (!filas) {
    body.innerHTML = `<div class="naplica">Falta correr <code>sql/2026-07-27_02_salud_canales.sql</code> en Supabase.</div>`;
    return;
  }
  const orden = [...filas].sort((a, b) =>
    (PRIORIDAD[a.salud] ?? 9) - (PRIORIDAD[b.salud] ?? 9) || (a.nombre || "").localeCompare(b.nombre || ""));

  body.innerHTML = orden.map(f => {
    const [cls, txt] = SALUD_ETIQUETA[f.salud] || ["ojo", f.salud];
    return `
      <div class="agrow">
        <div class="agtop">
          <span class="agchip ${cls}">${txt}</span>
          <span class="agname">${esc(f.nombre || "(sin nombre)")}</span>
          ${f.rol === "director" ? `<span class="agrol">director</span>` : ""}
        </div>
        <div class="agmeta">
          ${f.salud === "sin_uso"
            ? `<span>Nunca ha enviado mensajes</span>`
            : `<span>✓ ${f.enviados_24h} enviados · 24 h</span>
               <span class="${f.fallidos_24h > 0 ? "agbad" : ""}">⚠ ${f.fallidos_24h} fallidos · 24 h</span>
               <span class="${f.fallidos_u10 > 0 ? "agbad" : ""}">${f.fallidos_u10}/${f.intentos_u10} últimos fallaron</span>
               ${f.atascados > 0 ? `<span class="agbad">⏳ ${f.atascados} atascados</span>` : ""}
               <span>Último OK: ${fechaCorta(f.ultimo_envio_ok)}</span>`}
        </div>
        ${f.ultimo_error && f.salud !== "ok" && f.salud !== "sin_uso"
          ? `<div class="agerr">${esc(String(f.ultimo_error).slice(0, 120))}</div>` : ""}
      </div>`;
  }).join("");
}

// Indicador en la fila de «Más»: cuántos agentes necesitan atención.
export async function refrescarIndicadorAgentes() {
  const el = $("agentesEstado");
  if (!el || state.me?.role !== "director") return;
  const filas = await leerSalud();
  if (!filas) { el.textContent = ""; return; }
  const mal = filas.filter(f => f.salud === "fallando" || f.salud === "sin_canal").length;
  el.textContent = mal ? `${mal} con problemas` : "todo bien";
  el.className = "agstate " + (mal ? "mal" : "ok");
}

/* ---------- autorizar correos ---------- */
async function renderAutorizados() {
  const cont = $("agAutLista");
  const { data, error } = await SB.from("agentes_autorizados")
    .select("email, creado_en, usado_en").order("creado_en", { ascending: false }).limit(20);
  if (error) {
    cont.innerHTML = `<div class="naplica">Falta correr <code>sql/2026-07-27_01_seguridad.sql</code> en Supabase.</div>`;
    return;
  }
  const pend = (data || []).filter(a => !a.usado_en);
  cont.innerHTML = pend.length
    ? pend.map(a => `
        <div class="agrow autor">
          <span class="agname">${esc(a.email)}</span>
          <span class="agmeta">pendiente de registro</span>
          <button class="pmark off" data-delaut="${esc(a.email)}" title="Quitar">✕</button>
        </div>`).join("")
    : `<div class="naplica">No hay correos pendientes.</div>`;

  cont.querySelectorAll("[data-delaut]").forEach(b => b.onclick = async () => {
    const { error } = await SB.from("agentes_autorizados").delete().eq("email", b.dataset.delaut);
    if (error) { toast("⚠ " + error.message); return; }
    renderAutorizados();
  });
}

async function autorizar() {
  const email = ($("agAutEmail").value || "").trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { toast("Escribe un correo válido"); return; }
  const btn = $("agAutBtn");
  btn.disabled = true; btn.textContent = "Autorizando…";
  try {
    const { error } = await SB.from("agentes_autorizados")
      .insert({ email, creado_por: state.me.id });
    if (error) throw error;
    $("agAutEmail").value = "";
    toast(`✓ ${email} ya puede crear su cuenta`);
    renderAutorizados();
  } catch (err) {
    toast(/duplicate key/i.test(err.message) ? "Ese correo ya estaba autorizado" : "⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Autorizar";
  }
}

/* ---------- wiring ---------- */
function abrir() {
  $("agentesBody").innerHTML = `<div class="naplica">Cargando…</div>`;
  $("agentesOverlay").classList.add("open");
  renderAgentes(); renderAutorizados();
}
const cerrar = () => $("agentesOverlay").classList.remove("open");

$("btnAgentes").onclick = abrir;
$("agentesCerrar").onclick = cerrar;
$("agentesOverlay").onclick = e => { if (e.target.id === "agentesOverlay") cerrar(); };
$("agAutBtn").onclick = autorizar;
$("agAutEmail").onkeydown = e => { if (e.key === "Enter") autorizar(); };
