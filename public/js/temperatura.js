// Temperatura de una persona de la comunidad: qué tan probable es que responda,
// por dos señales: el último mensaje que te escribió por WhatsApp (`entranteDe`,
// solo personas propias: los chats son los de tu WhatsApp) y su última
// asistencia a una actividad. Gana la más reciente.
// No se guarda: se deriva de datos que ya existen y cambiaría con cada mensaje.
//
// La comparten la lista de invitados (seguimiento.js) y Masivo, para que la
// misma persona diga lo mismo en los dos sitios. Los leads tienen otra regla
// (embudo, contactos) que vive en leads.js.
import { hoyISO, fechaCO } from "./state.js";
import { entranteDe } from "./entrantes.js";

const TEMP_CALIENTE_D = 5;   // hasta 5 días desde la última señal (Sanviv)
const TEMP_TIBIO_D = 21;     // de 6 a 21; después (o sin señal), frío
export const TEMP_NOM = { caliente: "Caliente", tibio: "Tibio", frio: "Frío" };
export const TEMP_ORD = { caliente: 2, tibio: 1, frio: 0 };

// Días de calendario en Colombia: «ayer» a las 11 p. m. es ayer, no «hoy».
const diasDesde = f => {
  const dia = f.length <= 10 ? f : fechaCO(new Date(f));
  return Math.max(0, Math.round((Date.parse(hoyISO()) - Date.parse(dia.slice(0, 10))) / 864e5));
};
const haceDias = d => d === 0 ? "hoy" : d === 1 ? "ayer" : `hace ${d} d`;

// La asistencia vive en dos sitios: `acc` por servicio y `pun` por actividad
// puntual. Ambos guardan la fecha (YYYY-MM-DD) de la última vez.
function ultimaAsistencia(c) {
  let max = null;
  const ver = v => { if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) && (!max || v > max)) max = v.slice(0, 10); };
  Object.values(c.acc || {}).forEach(ver);
  Object.values(c.pun || {}).forEach(p => ver(p && p.acc));
  return max;
}

// { t: "caliente"|"tibio"|"frio", d: días desde la última señal, motivo: texto plano }
export function temperaturaInvitado(c) {
  const asis = ultimaAsistencia(c), ent = entranteDe(c);
  const dA = asis ? diasDesde(asis) : null, dE = ent ? diasDesde(ent) : null;
  const ds = [dA, dE].filter(d => d != null);
  const d = ds.length ? Math.min(...ds) : null;
  const t = d == null || d > TEMP_TIBIO_D ? "frio" : d > TEMP_CALIENTE_D ? "tibio" : "caliente";
  const partes = [];
  if (dE != null) partes.push(`te escribió ${haceDias(dE)}`);
  if (dA != null) partes.push(`asistió ${haceDias(dA)}`);
  return { t, d, motivo: partes.join(" · ") || "sin mensajes ni asistencia" };
}
