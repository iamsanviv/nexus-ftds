// Seguimiento de actividades: programa mensajes de WhatsApp (vía worker local)
// para quienes les falta una actividad, y permite cancelarlos.
// Tablas: seguimientos, mensajes_programados (RLS: cada agente lo suyo).
import { SB } from "./supabase.js";
import { state, $, esc, toast, todos, hoyISO } from "./state.js";

/* ---------- plantillas (usa el primer nombre) ---------- */
const horaCO = iso => new Date(iso).toLocaleTimeString("es-CO",
  { hour: "numeric", minute: "2-digit", hour12: true });

function plantillas(nombre, actividad, inicioISO, enlace) {
  const n = nombre.trim().split(/\s+/)[0];
  const h = horaCO(inicioISO);
  return {
    invitacion:   `¡Hola ${n}! 👋 Hoy tenemos *${actividad}* a las ${h} (hora Colombia). ¡Te esperamos! ¿Cuento contigo?`,
    rec_60:       `${n}, te recuerdo que en 1 hora empieza *${actividad}* (${h}). ¡Ve preparándote! 🙌`,
    rec_15:       `¡${n}, en 15 minutos arrancamos *${actividad}*! 🔥`,
    enlace:       `¡${n}, ya empezamos! Este es el enlace para entrar 👉 ${enlace}`,
    confirmacion: `${n}, ¿ya lograste entrar a la sala? Si tuviste algún problema, escríbeme y te ayudo 🙏`,
  };
}

/* ---------- render del modal ---------- */
function renderForm() {
  const sel = $("segSrv");
  sel.innerHTML = state.catalogo.map(g => `<optgroup label="${esc(g.g)}">` +
    g.items.map(s => `<option value="${s.id}">${esc(s.n)}</option>`).join("") +
    `</optgroup>`).join("");
  $("segFecha").value = hoyISO();
  sel.onchange = renderFaltan;
  renderFaltan();
}

function faltantes(sid) {
  return state.clientes.filter(c => !c.acc[sid] && c.tel);
}

function renderFaltan() {
  const sid = $("segSrv").value;
  const sinTel = state.clientes.filter(c => !c.acc[sid] && !c.tel).length;
  const lista = faltantes(sid);
  $("segFaltan").innerHTML = lista.length
    ? lista.map(c => `
        <label class="seg-row">
          <input type="checkbox" data-cid="${c.id}" checked>
          <span class="badge b-${c.mem}">${c.mem}</span>
          <span>${esc(c.nombre)}</span>
        </label>`).join("") +
      (sinTel ? `<div class="naplica">${sinTel} persona(s) sin teléfono no aparecen aquí.</div>` : "")
    : `<div class="naplica">🎉 Todos (con teléfono) ya tienen esta actividad.</div>`;
}

async function renderActivos() {
  const { data, error } = await SB.from("seguimientos")
    .select("id, actividad, inicio, estado, clientes(nombre)")
    .eq("estado", "activo")
    .order("inicio", { ascending: true });
  if (error) { $("segActivos").innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }
  if (!data.length) { $("segActivos").innerHTML = `<div class="naplica">No hay seguimientos activos.</div>`; return; }

  $("segActivos").innerHTML = data.map(s => `
    <div class="seg-row">
      <span>${esc(s.clientes?.nombre || "(cliente)")} · <b>${esc(s.actividad)}</b>
        <span class="sfecha">${new Date(s.inicio).toLocaleString("es-CO", { day: "2-digit", month: "2-digit", hour: "numeric", minute: "2-digit", hour12: true })}</span>
      </span>
      <button class="pmark off" data-cancel="${s.id}">✕ Cancelar</button>
    </div>`).join("");

  $("segActivos").querySelectorAll("[data-cancel]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Cancelar este seguimiento? No se enviarán los mensajes pendientes.")) return;
    const id = b.dataset.cancel;
    const r1 = await SB.from("mensajes_programados")
      .update({ estado: "cancelado" }).eq("seguimiento_id", id).eq("estado", "pendiente");
    const r2 = await SB.from("seguimientos")
      .update({ estado: "cancelado" }).eq("id", id);
    if (r1.error || r2.error) toast("⚠ " + (r1.error || r2.error).message);
    else { toast("Seguimiento cancelado ✓"); renderActivos(); }
  });
}

/* ---------- programar ---------- */
async function programar() {
  const sid = $("segSrv").value;
  const srv = todos().find(s => s.id === sid);
  const fecha = $("segFecha").value, hora = $("segHora").value;
  const enlace = $("segLink").value.trim();
  if (!srv) { toast("Elige una actividad"); return; }
  if (!fecha || !hora) { toast("Falta la fecha o la hora"); return; }
  if (!enlace) { toast("Falta el enlace de la sala"); return; }

  const inicio = new Date(`${fecha}T${hora}:00`);   // hora local = Colombia
  if (isNaN(inicio)) { toast("Fecha/hora inválida"); return; }
  const ahora = new Date();
  if (inicio <= ahora) { toast("La actividad debe ser en el futuro"); return; }

  const seleccion = [...$("segFaltan").querySelectorAll("input[data-cid]:checked")]
    .map(i => state.clientes.find(c => c.id === i.dataset.cid)).filter(Boolean);
  if (!seleccion.length) { toast("No hay nadie seleccionado"); return; }

  const btn = $("segProgramar");
  btn.disabled = true; btn.textContent = "Programando…";
  try {
    // 1) un seguimiento por persona
    const segRows = seleccion.map(c => ({
      cliente_id: c.id, actividad: srv.n, inicio: inicio.toISOString(), enlace,
    }));
    const { data: segs, error: e1 } = await SB.from("seguimientos").insert(segRows).select("id, cliente_id");
    if (e1) throw e1;

    // 2) los 5 mensajes por persona (se omiten los que ya quedaron en el pasado)
    const msgs = [];
    const tiempos = inicioISO => ([
      ["invitacion",   ahora],
      ["rec_60",       new Date(inicio.getTime() - 60 * 60000)],
      ["rec_15",       new Date(inicio.getTime() - 15 * 60000)],
      ["enlace",       inicio],
      ["confirmacion", new Date(inicio.getTime() + 15 * 60000)],
    ]);
    for (const seg of segs) {
      const c = seleccion.find(x => x.id === seg.cliente_id);
      const tpl = plantillas(c.nombre, srv.n, inicio.toISOString(), enlace);
      for (const [tipo, cuando] of tiempos()) {
        if (tipo !== "invitacion" && cuando <= ahora) continue; // ya pasó
        msgs.push({
          seguimiento_id: seg.id, tipo, enviar_en: cuando.toISOString(),
          telefono: c.tel, texto: tpl[tipo],
        });
      }
    }
    const { error: e2 } = await SB.from("mensajes_programados").insert(msgs);
    if (e2) throw e2;

    toast(`✓ ${segs.length} seguimiento(s) · ${msgs.length} mensaje(s) programado(s)`);
    renderFaltan(); renderActivos();
  } catch (err) {
    toast("⚠ " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Programar seguimiento";
  }
}

/* ---------- wiring ---------- */
const EMAIL_SEG = "santiagoviveros18@gmail.com";
$("btnSeg").onclick = () => {
  if ((state.me?.email || "").toLowerCase() !== EMAIL_SEG) {
    toast("Seguimiento Automatizado. En fase de prueba…");
    return;
  }
  renderForm(); renderActivos(); $("segOverlay").classList.add("open");
};

$("segCerrar").onclick = () => $("segOverlay").classList.remove("open");
$("segOverlay").onclick = e => { if (e.target.id === "segOverlay") $("segOverlay").classList.remove("open"); };
$("segProgramar").onclick = programar;