// Mensajes que la gente TE ESCRIBIÓ por WhatsApp (chats_recientes, ~5 min de
// demora). Una sola fuente para Leads, el panel «Hoy» y Seguimiento: las tres
// tienen que decir lo mismo sobre quién respondió.
//
// Se sabe CUÁNDO escribió (el último entrante y el primero de hoy), no QUÉ.
// Por eso «respondió» significa «te escribió después de tu mensaje».
import { state, fechaCO, hoyISO } from "./state.js";
import { cargarEntrantes } from "./data.js";

// El worker publica cada ~5 min: pedir más seguido no trae nada nuevo.
const FRESCO = 5 * 60e3;
let cargadoEn = 0, enCurso = null;

// Carga si nunca se cargó o si ya pasaron 5 min. Devuelve una promesa que
// resuelve true cuando llegaron datos nuevos (para que quien llama re-pinte).
export function asegurarEntrantes() {
  if (enCurso) return enCurso;
  if (state.entrantes !== null && Date.now() - cargadoEn < FRESCO) return Promise.resolve(false);
  if (state.entrantes === null) state.entrantes = {};
  enCurso = cargarEntrantes().then(filas => {
    // Un error deja lo que había y reintenta en el siguiente ciclo.
    cargadoEn = Date.now();
    if (!filas) return false;
    const m = {};
    for (const r of filas) {
      const k = claveTel(r.telefono);
      if (k) m[k] = { en: r.entrante_en, dia: r.primer_entrante_dia || null };
    }
    state.entrantes = m;
    return true;
  }).catch(() => false).finally(() => { enCurso = null; });
  return enCurso;
}

// El mismo número escrito como lo guarda WhatsApp y como lo guarda la ficha.
// México: WhatsApp usa el «1» de móvil viejo (521 + 10 dígitos) y la ficha no
// (52 + 10). Argentina, igual con el 9 (549 / 54). Sin esto, de 74 leads y
// pendientes solo cruzaban 15 en vez de 41 (medido el 14/10/2026).
export const claveTel = t => (t || "").replace(/\D/g, "")
  .replace(/^521(\d{10})$/, "52$1").replace(/^549(\d{10})$/, "54$1");

// Solo personas PROPIAS. RLS ya limita los chats a los tuyos, pero el mismo
// número puede ser cliente de uno de tus agentes: un mensaje a TU WhatsApp no
// dice nada de cómo va el seguimiento de él.
const entradaDe = c => {
  if (!c || c.owner_id !== state.me?.id) return null;
  const k = claveTel(c.tel);
  return (k && state.entrantes?.[k]) || null;
};

// Último mensaje que te escribió (o null).
export const entranteDe = c => entradaDe(c)?.en || null;

// Primer mensaje que te escribió HOY (o null). El worker guarda el del día de
// su última sincronización: si ese bridge dejó de sincronizar, el valor es de
// otro día y no cuenta.
export const primeroHoy = c => {
  const d = entradaDe(c)?.dia;
  return d && fechaCO(new Date(d)) === hoyISO() ? d : null;
};

// ¿Te escribió después de `ts`? Es la definición de «respondió».
export const escribioTras = (c, ts) => {
  const en = entranteDe(c);
  return !!(en && ts && new Date(en) > new Date(ts));
};
