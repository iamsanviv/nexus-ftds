// Etapas de venta de la lista de Comunidad: qué tan cerca está cada persona del
// cierre. Todo se DERIVA de datos que ya existen (asistencia, embudo del perfil,
// ventas y abonos); no hay columna propia, para que no pueda contradecirlos.
//
// Etapas (decisión de Sanviv, 12/11/2026):
//   Básica       = asistencia al servicio «Nivel 0 a Avanzado» (acc.nivel0)
//   Avanzada     = zooms.avanzada  (actividades puntuales con zoom_tipo «avanzada»)
//   Presentación = zooms.pres      (Zoom Presentación Membresías)
//   1 a 1        = zooms.uno
// «Presentación FTDs» y «Cierre» siguen en el perfil pero no aquí.
import { state, hoyISO, estaSaldada, pagado, fechaSaldo } from "./state.js";

export const ETAPAS = [
  { k: "b", l: "Básica",       corto: "Básica",     c: "--etp1" },
  { k: "a", l: "Avanzada",     corto: "Avanzada",   c: "--etp2" },
  { k: "p", l: "Presentación", corto: "Membresías", c: "--etp3", largo: "Presentación Membresías" },
  { k: "u", l: "1 a 1",        corto: "1 a 1",      c: "--etp4" },
];
const ZOOM_DE = { a: "avanzada", p: "pres", u: "uno" };
export const SERVICIO_BASICA = "nivel0";

export const RESULTADOS = [
  ["agp", "Agendó pago"], ["aga", "Agendó abono"], ["abo", "Abonó"], ["sin", "Sin acuerdo"], ["venc", "Vencidos"],
];

const esMembresia = v => (state.productos || []).find(p => p.id === v.producto_id)?.categoria === "membresia";

/* Inicio del ciclo de upgrade. Cada venta de membresía saldada cierra un ciclo:
   lo que la persona hizo ANTES de pagar ya rindió, y para el siguiente nivel
   solo cuenta lo de después. Si no hay venta registrada (miembros de antes del
   módulo de ventas) se usa la fecha de upgrade del perfil. Sin ninguna de las
   dos no se puede saber dónde empieza, y se devuelve null. */
function inicioCiclo(c) {
  const pagos = state.ventas
    .filter(v => v.cliente_id === c.id && estaSaldada(v) && esMembresia(v))
    .map(fechaSaldo).filter(Boolean).sort();
  return pagos.pop() || c.upgradeFecha || null;
}

/* Resultado después del 1 a 1, leído de la venta de membresía abierta:
     agp  venta sin abonos con fecha de pago
     aga  abonos parciales con fecha para el siguiente
     abo  abonos parciales sin fecha
     sin  no hay venta (o se cayó, o no tiene ni abono ni fecha)
   Sin ventas cargadas devuelve null: no inventa «Sin acuerdo» mientras carga. */
function resultado(c, desde) {
  if (!state.ventasOk) return null;
  const v = state.ventas
    .filter(v => v.cliente_id === c.id && v.estado === "abierta" && !estaSaldada(v) && esMembresia(v)
      && (!desde || (v.creado_en || "").slice(0, 10) >= desde))
    .sort((a, b) => (b.creado_en || "").localeCompare(a.creado_en || ""))[0];
  if (!v) return { r: "sin" };
  const ab = pagado(v), f = v.fecha_pago || null;
  const r = ab > 0 ? (f ? "aga" : "abo") : (f ? "agp" : "sin");
  return { r, f, ab, valor: v.valor, venc: !!f && f < hoyISO(), venta: v };
}

/* Todo lo que la fila necesita de una persona. Oro es el nivel máximo: no tiene
   embudo ni upgrade, se muestra sin flechas y va al final. */
export function embudo(c) {
  if (c.mem === "Oro") return { oro: true, etapas: [], nivel: -1, actual: null, rango: 99 };
  const upgrade = c.mem !== "Beca" && c.mem !== "Lead";
  const desde = upgrade ? inicioCiclo(c) : null;
  // En el ciclo de upgrade la Básica no se vuelve a pedir.
  const etapas = upgrade ? ETAPAS.slice(1) : ETAPAS;
  const z = c.zooms || {};
  const est = {};
  for (const e of etapas) {
    let f = null, no = false;
    if (e.k === "b") f = c.acc?.[SERVICIO_BASICA] || null;
    else {
      const x = z[ZOOM_DE[e.k]];
      if (x?.e === "hecha") f = x.f || null;
      else if (x?.e === "no_asistio") no = true;
      if (no && desde && x.f && x.f <= desde) no = false;
    }
    if (f && desde && f <= desde) f = null;   // de un ciclo ya cerrado
    est[e.k] = { f, no };
  }
  const hechas = etapas.filter(e => est[e.k].f);
  const top = hechas[hechas.length - 1] || null;
  const nivel = top ? ETAPAS.indexOf(top) + 1 : 0;   // 0 = sin etapas … 4 = 1 a 1
  const res = est.u?.f ? resultado(c, desde) : null;
  // Rango del orden: primero quien hizo 1 a 1 y tiene fecha de pago (la más
  // próxima arriba, vencidos incluidos), luego «Abonó», luego «Sin acuerdo»;
  // después el resto por la etapa más alta.
  const rango = nivel === 4 ? (res?.f ? 0 : res?.r === "abo" ? 1 : 2) : 7 - nivel;
  const fechas = Object.values(est).map(x => x.f).filter(Boolean).sort();
  return {
    oro: false, upgrade, desde, etapas, est, nivel, res, rango,
    actual: top ? top.k : "none",
    ultima: fechas[fechas.length - 1] || "",
  };
}

// Orden «Cerca del cierre». Recibe embudos ya calculados (se piden una vez por fila).
export function compararEmbudo(ea, eb) {
  if (ea.rango !== eb.rango) return ea.rango - eb.rango;
  if (ea.rango === 0) return ea.res.f.localeCompare(eb.res.f);
  return (eb.ultima || "").localeCompare(ea.ultima || "");
}

export function cumpleResultado(e, filtro) {
  if (!filtro) return true;
  if (!e.res) return false;
  return filtro === "venc" ? e.res.venc : e.res.r === filtro;
}
