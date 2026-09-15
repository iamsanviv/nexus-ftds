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
import { state, $, esc, toast, norm } from "./state.js";

// La vista puede no existir todavía (si aún no se corrió el SQL). En ese caso
// no rompemos nada: simplemente no hay aviso.
const CAMPOS_BASE = "owner_id, nombre, rol, estado_canal, telefono, enviados_24h, fallidos_24h, atascados, ultimo_envio_ok, ultimo_error, salud";

async function leerSalud() {
  // Si todavía no se corrió la migración de alertas acusables, las columnas
  // nuevas no existen y la consulta falla entera. En ese caso se reintenta sin
  // ellas: el panel sigue funcionando (sin el botón «Ya lo vi») en vez de
  // romperse, así el orden entre desplegar y correr el SQL deja de importar.
  let { data, error } = await SB.from("salud_canales")
    .select(CAMPOS_BASE + ", alertar, alerta_vista_en, ultimo_fallo_en, baja_en, puerto");
  if (error) {
    ({ data, error } = await SB.from("salud_canales").select(CAMPOS_BASE));
    if (error) return null;
    // Sin la columna, se alerta como antes: todo lo roto suena siempre.
    (data || []).forEach(f => f.alertar = f.salud !== "ok" && f.salud !== "sin_uso");
  }
  return data || [];
}

// Dar por vista una alerta: guarda cuándo se revisó. No "resuelve" nada — el
// estado sigue siendo el que es —, solo deja de sonar. Si esa persona vuelve a
// fallar después de esta marca, la alerta reaparece sola.
async function marcarVisto(ownerId) {
  const { error } = await SB.from("profiles")
    .update({ alerta_vista_en: new Date().toISOString() }).eq("id", ownerId);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
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
  // Retirado a propósito. Tampoco es una avería, y va después de todo.
  baja:      ["gris", "Retirado"],
};

// Orden: primero lo que necesita atención, al final lo que nunca arrancó o
// lo que ya se retiró.
const PRIORIDAD = { fallando: 0, sin_canal: 1, atascado: 2, degradado: 3, ok: 4, sin_uso: 5, baja: 6 };
// Lo ya revisado baja, aunque siga roto: arriba va lo que aún no has visto.
const orden = (a, b) =>
  (b.alertar === true) - (a.alertar === true) ||
  (PRIORIDAD[a.salud] ?? 9) - (PRIORIDAD[b.salud] ?? 9) ||
  (a.nombre || "").localeCompare(b.nombre || "", "es");

/* ================= BAJA DE CANAL (solo admin) =================
   Retirar a alguien que dejó la empresa. NO borra nada suyo: sus clientes,
   ventas e historial siguen intactos y puede seguir entrando al panel. Lo
   único que se apaga es su bridge en la VM, para que su puerto vuelva a
   estar disponible — son menos de veinte repartidos entre dos máquinas y
   `provisionar.sh` se niega a repetir uno.

   El panel no alcanza la VM, así que esto solo deja la señal en la base;
   el ejecutor de la máquina la recoge cada dos minutos y hace el apagado.
   Mientras tanto el puerto sigue en la fila, y por eso la baja se puede
   deshacer: en cuanto el servidor la toma, ya no. */

async function renderAgentes() {
  const body = $("agentesBody");
  const filas = await leerSalud();
  if (!filas) {
    body.innerHTML = `<div class="naplica">Falta correr <code>sql/2026-07-27_02_salud_canales.sql</code> en Supabase.</div>`;
    return;
  }
  const soyAdmin = state.me?.role === "admin";
  body.innerHTML = [...filas].sort(orden).map(f => {
    const [cls, txt] = SALUD_ETIQUETA[f.salud] || ["ojo", f.salud];
    const roto = f.salud !== "ok" && f.salud !== "sin_uso" && f.salud !== "baja";
    const dado = !!f.baja_en;
    // El puerto es justamente lo que está en juego: si la fila ya no tiene,
    // no hay nada que liberar y el botón sobra. Sirve igual para el caso de
    // quien nunca fue aprovisionado (sin fila en canales_wa).
    const ofrecerBaja = soyAdmin && !dado && f.puerto != null && f.owner_id !== state.me?.id;
    return `
      <div class="agrow${roto && !f.alertar ? " visto" : ""}">
        <div class="agtop">
          <span class="agchip ${cls}">${txt}</span>
          <span class="agname">${esc(f.nombre || "(sin nombre)")}</span>
          ${f.rol === "director" ? `<span class="agrol">director</span>` : ""}
          ${roto && !f.alertar ? `<span class="agvisto">revisado</span>` : ""}
          ${f.alertar ? `<button class="pmark agok" data-visto="${f.owner_id}">Ya lo vi</button>` : ""}
        </div>
        <div class="agmeta">
          ${dado
            ? `<span>Retirado el ${fechaCorta(f.baja_en)}</span>
               ${f.puerto != null
                 // El ejecutor corre cada dos minutos. Si lleva mucho más que
                 // eso sin cerrar, es que nadie tomó la fila —la máquina de
                 // ese bridge está caída, o el bridge nunca existió en disco—
                 // y hay que decirlo en vez de dejar un «⏳» eterno.
                 ? (Date.now() - new Date(f.baja_en).getTime() > 15 * 60 * 1000
                     ? `<span class="agbad">⚠ El servidor no ha liberado el puerto ${f.puerto}</span>`
                     : `<span>⏳ Liberando el puerto ${f.puerto}…</span>`)
                 : `<span>✓ Bridge apagado y puerto liberado</span>`}`
            : f.salud === "sin_uso"
            ? `<span>Nunca ha enviado mensajes</span>`
            : `<span>✓ ${f.enviados_24h} enviados · 24 h</span>
               <span class="${f.fallidos_24h > 0 ? "agbad" : ""}">⚠ ${f.fallidos_24h} fallidos · 24 h</span>
               <span class="${f.fallidos_u10 > 0 ? "agbad" : ""}">${f.fallidos_u10}/${f.intentos_u10} últimos fallaron</span>
               ${f.atascados > 0 ? `<span class="agbad">⏳ ${f.atascados} atascados</span>` : ""}
               <span>Último OK: ${fechaCorta(f.ultimo_envio_ok)}</span>`}
        </div>
        ${f.ultimo_error && roto
          ? `<div class="agerr">${esc(String(f.ultimo_error).slice(0, 120))}</div>` : ""}
        ${ofrecerBaja
          ? `<div class="agacc fin"><button class="pmark off" data-baja="${f.owner_id}"
               data-nombre="${esc(f.nombre || "esta persona")}" data-puerto="${f.puerto}">Dar de baja</button></div>`
          : ""}
        ${soyAdmin && dado && f.puerto != null
          ? `<div class="agacc fin"><button class="pmark" data-desbaja="${f.owner_id}">Deshacer</button></div>`
          : ""}
      </div>`;
  }).join("");

  body.querySelectorAll("[data-visto]").forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = "…";
    if (!(await marcarVisto(b.dataset.visto))) { b.disabled = false; b.textContent = "Ya lo vi"; return; }
    toast("Alerta silenciada · vuelve si falla otra vez");
    renderAgentes(); refrescarIndicadorAgentes();
  });

  body.querySelectorAll("[data-baja]").forEach(b => b.onclick = async () => {
    const { baja, nombre, puerto } = b.dataset;
    if (!confirm(
      `¿Dar de baja el canal de ${nombre}?\n\n` +
      `• Se apaga su WhatsApp en el servidor y el puerto ${puerto} queda libre para otra persona.\n` +
      `• Se cancela lo que tenga en cola sin enviar.\n` +
      `• NO se borra nada: sus clientes, ventas e historial siguen igual, y puede seguir entrando al panel.\n\n` +
      `El servidor lo ejecuta en un par de minutos. Hasta entonces puedes deshacerlo.`
    )) return;
    b.disabled = true; b.textContent = "…";
    const { data, error } = await SB.rpc("dar_de_baja_canal", { p_owner: baja });
    if (error) { toast("⚠ " + error.message); b.disabled = false; b.textContent = "Dar de baja"; return; }
    const n = data?.cancelados || 0;
    toast(`Canal dado de baja${n ? ` · ${n} mensaje(s) cancelados` : ""}`);
    renderAgentes(); refrescarIndicadorAgentes();
  });

  body.querySelectorAll("[data-desbaja]").forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = "…";
    const { error } = await SB.rpc("deshacer_baja_canal", { p_owner: b.dataset.desbaja });
    // El error esperado aquí es «ya se está ejecutando»: el servidor ganó la
    // carrera. No es un fallo, es la respuesta correcta, y hay que mostrarla.
    if (error) { toast("⚠ " + error.message); }
    else toast("Baja deshecha · los mensajes cancelados no se reviven");
    renderAgentes(); refrescarIndicadorAgentes();
  });
}

// Indicador en la fila de «Más»: cuántos agentes necesitan atención.
export async function refrescarIndicadorAgentes() {
  const el = $("agentesEstado");
  if (!el || !["admin", "director"].includes(state.me?.role)) return;
  // Las aprobaciones pendientes mandan sobre el estado de los canales: es lo
  // único que exige una acción de quien mira.
  const { count } = await SB.from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("aprobado", false).is("rechazado_en", null);
  if (count) {
    el.textContent = `${count} por aprobar`;
    el.className = "agstate pend";
    return;
  }
  const filas = await leerSalud();
  if (!filas) { el.textContent = ""; return; }
  // Solo cuenta lo que NO se ha revisado. Lo ya visto sigue roto, pero deja de
  // gritar: si volviera a fallar, `alertar` se pone en true solo y reaparece.
  const mal = filas.filter(f => f.alertar).length;
  el.textContent = mal ? `${mal} sin revisar` : "todo al día";
  el.className = "agstate " + (mal ? "mal" : "ok");
}

/* ================= APROBAR CUENTAS NUEVAS ================= */
// El RLS ya decide a quién puede aprobar cada quien: el admin ve todos los
// perfiles, un director solo los de su equipo. Aquí no hace falta filtrar.
async function renderPendientes() {
  const bloque = $("agPendBloque"), cont = $("agPendientes");
  const { data, error } = await SB.from("profiles")
    .select("id, full_name, email, director_id, aprobado")
    .eq("aprobado", false)
    .is("rechazado_en", null)          // los rechazados no vuelven a la bandeja
    .order("full_name");
  if (error) { bloque.classList.add("hidden"); return; }

  const pend = data || [];
  $("agPendCnt").textContent = pend.length;
  bloque.classList.toggle("hidden", pend.length === 0);
  if (!pend.length) return;

  cont.innerHTML = pend.map(p => `
    <div class="agrow pend">
      <div class="agtop">
        <span class="agchip ojo">Pendiente</span>
        <span class="agname">${esc(p.full_name || "(sin nombre)")}</span>
      </div>
      <div class="agmeta"><span>${esc(p.email || "")}</span></div>
      <div class="agacc">
        <button class="pmark" data-aprobar="${p.id}">✓ Aprobar</button>
        <button class="pmark off" data-rechazar="${p.id}">✕ Rechazar</button>
      </div>
    </div>`).join("");

  cont.querySelectorAll("[data-aprobar]").forEach(b => b.onclick = async () => {
    b.disabled = true;
    const { error } = await SB.from("profiles")
      .update({ aprobado: true, rechazado_en: null }).eq("id", b.dataset.aprobar);
    if (error) { toast("⚠ " + error.message); b.disabled = false; return; }
    toast("✓ Cuenta aprobada");
    renderPendientes(); renderAgentes(); refrescarIndicadorAgentes();
  });

  // Rechazar deja constancia (rechazado_en) en vez de romper el vínculo con el
  // director. Quitar el director haría que la fila dejara de ser visible para
  // él, y Postgres impide actualizar una fila hasta sacarla de tu propia vista.
  // Además así queda rastro de quién quedó fuera y cuándo.
  cont.querySelectorAll("[data-rechazar]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Rechazar esta cuenta? No podrá usar el sistema.")) return;
    b.disabled = true;
    const { error } = await SB.from("profiles")
      .update({ aprobado: false, rechazado_en: new Date().toISOString() })
      .eq("id", b.dataset.rechazar);
    if (error) { toast("⚠ " + error.message); b.disabled = false; return; }
    toast("Cuenta rechazada");
    renderPendientes(); refrescarIndicadorAgentes();
  });
}

/* ================= DIRECTORIO DE CLIENTES (solo admin) ================= */
// Vista `clientes_directorio`: nombre y de quién es, nada más. Si quien mira
// no es admin, la consulta devuelve 0 filas y el bloque no se muestra.
let dirCache = [];
async function renderDirectorio() {
  const bloque = $("agDirBloque");
  if (state.me?.role !== "admin") { bloque.classList.add("hidden"); return; }
  const { data, error } = await SB.from("clientes_directorio")
    .select("id, nombre, agente").order("nombre");
  if (error) { bloque.classList.add("hidden"); return; }
  dirCache = data || [];
  bloque.classList.remove("hidden");
  $("agDirCnt").textContent = dirCache.length;
  pintarDirectorio("");
}

function pintarDirectorio(q) {
  const t = norm(q.trim());
  const vis = t ? dirCache.filter(c => norm(c.nombre).includes(t)) : dirCache;
  $("agDirLista").innerHTML = vis.length
    ? vis.slice(0, 200).map(c => `
        <div class="dirrow">
          <span class="dirn">${esc(c.nombre)}</span>
          <span class="dira">${esc(c.agente || "—")}</span>
        </div>`).join("") +
      (vis.length > 200 ? `<div class="naplica">…y ${vis.length - 200} más. Afina la búsqueda.</div>` : "")
    : `<div class="naplica">Nadie coincide.</div>`;
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
  renderPendientes(); renderAgentes(); renderDirectorio(); renderAutorizados();
}
const cerrar = () => $("agentesOverlay").classList.remove("open");

$("btnAgentes").onclick = abrir;
$("agentesCerrar").onclick = cerrar;
$("agentesOverlay").onclick = e => { if (e.target.id === "agentesOverlay") cerrar(); };
$("agAutBtn").onclick = autorizar;
$("agAutEmail").onkeydown = e => { if (e.key === "Enter") autorizar(); };
$("agDirBuscar").oninput = e => pintarDirectorio(e.target.value);
