// Ventana con los avisos del administrador que esta cuenta todavía no cerró.
//
// Es el camino que llega a TODOS: el push solo alcanza a quien activó las
// notificaciones. Los avisos los crea y envía Administración › Avisos
// (sql/2026-10-20_44_avisos_administrador.sql). Cerrar la ventana los marca
// vistos en aviso_vistos, por cuenta y no por dispositivo.
import { SB } from "./supabase.js";
import { state, $, esc } from "./state.js";

// Una cuenta nueva no hereda los avisos viejos: solo los de la última semana.
const VIGENCIA_MS = 7 * 24 * 60 * 60 * 1000;
let pendientes = [];
let ultima = 0;

const fechaTxt = t => new Date(t).toLocaleString("es-CO",
  { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

export async function revisarAvisos() {
  if (!state.me || $("avisoOverlay").classList.contains("open")) return;
  ultima = Date.now();
  // El filtro de fecha deja fuera los no enviados (enviado_en nulo). RLS
  // embebe solo las marcas propias: sin marca = esta cuenta no lo cerró.
  const { data, error } = await SB.from("avisos")
    .select("id, titulo, cuerpo, enviado_en, creado_por, aviso_vistos(owner_id)")
    .is("cancelado_en", null)
    .gte("enviado_en", new Date(Date.now() - VIGENCIA_MS).toISOString())
    .order("enviado_en");
  if (error) { console.warn("avisos:", error); return; }
  // Quien lo escribió no necesita que se lo muestren.
  pendientes = (data || []).filter(a => !a.aviso_vistos?.length && a.creado_por !== state.me.id);
  if (!pendientes.length) return;
  $("avisoBody").innerHTML = pendientes.map(a => `<div class="avisoitem">
      <b>${esc(a.titulo)}</b><div class="avisotxt">${esc(a.cuerpo)}</div>
      <small>${esc(fechaTxt(a.enviado_en))}</small></div>`).join("");
  $("avisoOverlay").classList.add("open");
}

$("avisoOk").onclick = async () => {
  $("avisoOverlay").classList.remove("open");
  const filas = pendientes.map(a => ({ aviso_id: a.id }));
  pendientes = [];
  if (filas.length) {
    // upsert: dos pestañas pueden cerrar la misma ventana.
    const { error } = await SB.from("aviso_vistos").upsert(filas, { ignoreDuplicates: true });
    if (error) console.warn("avisos:", error);
  }
};

// Un aviso que sale con el panel abierto aparece al volver a la pestaña.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - ultima > 60000) revisarAvisos();
});
