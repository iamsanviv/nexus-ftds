// Grabación de notas de voz, compartida por todos los editores de mensajes
// (burbujas.js). Antes vivía dentro de masivo.js y solo servía al mensaje 1 del
// masivo.
//
// El navegador graba lo que sabe: Chrome/Android webm/opus, Safari viejo
// mp4/aac. Cualquiera sirve: la conversión a nota de voz (ogg/opus mono, con
// los tiempos regenerados) la hace el worker. Ver brain KI-002.

const MIMES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];

export const puedeGrabar = () => !!(window.MediaRecorder && navigator.mediaDevices?.getUserMedia);

export const fmtSeg = s => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");

// El bridge y el worker deciden el tipo por la extensión de la URL; acá se usa
// el mismo criterio para saber si un adjunto es una nota de voz.
export const esAudioUrl = u => /\.(webm|m4a|ogg|oga|opus|mp3|aac|wav)(\?|$)/i.test(u || "");

// Empieza a grabar. `alTic(segundos, pausada)` se llama cada segundo y al
// pausar/reanudar. Devuelve los controles; `terminar()` y `descartar()`
// resuelven con `{ blob, ext, seg }` o `null` si no quedó nada que enviar.
export async function iniciarGrabacion(alTic) {
  if (!puedeGrabar()) throw new Error("Este navegador no soporta grabar audio");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw new Error(e.name === "NotAllowedError"
      ? "Permiso de micrófono denegado: actívalo en el navegador"
      : "No pude acceder al micrófono: " + e.message);
  }
  const mime = MIMES.find(m => MediaRecorder.isTypeSupported(m)) || "";
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const trozos = [];
  let seg = 0, timer = null, descartada = false, fin;
  const hecho = new Promise(r => { fin = r; });
  const tic = () => alTic?.(seg, rec.state === "paused");
  const arrancar = () => { clearInterval(timer); timer = setInterval(() => { seg++; tic(); }, 1000); };
  const frenar = () => { clearInterval(timer); timer = null; };

  rec.ondataavailable = e => { if (e.data.size) trozos.push(e.data); };
  rec.onstop = () => {
    stream.getTracks().forEach(t => t.stop());
    frenar();
    if (descartada || !trozos.length) return fin(null);
    const tipo = rec.mimeType || mime || "audio/webm";
    fin({
      blob: new Blob(trozos, { type: tipo.split(";")[0] }),
      // La extensión importa: el worker detecta el audio por ella.
      ext: tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm",
      seg,
    });
  };
  rec.start();
  arrancar();
  tic();

  return {
    alternarPausa() {
      if (rec.state === "recording") { rec.pause(); frenar(); }
      else if (rec.state === "paused") { rec.resume(); arrancar(); }
      tic();
    },
    terminar() { if (rec.state !== "inactive") rec.stop(); return hecho; },
    descartar() { descartada = true; if (rec.state !== "inactive") rec.stop(); return hecho; },
  };
}
