// Formato de texto de WhatsApp para las VISTAS PREVIAS: el agente escribe
// *negrita*, _cursiva_, ~tachado~ o ```monoespaciado``` y la previa debe verse
// como lo verá la persona, no con los símbolos. El texto que se envía no se
// toca: WhatsApp interpreta los símbolos en el teléfono.
//
// Devuelve HTML: el texto se escapa PRIMERO y solo después se insertan las
// etiquetas propias, así nada que escriba el usuario llega como HTML.
import { esc } from "./state.js";

// Letra o número a cualquier lado del símbolo anula el formato, como en
// WhatsApp: así `archivo_final_v2` o `https://x.com/a_b` no se vuelven cursiva.
const ALNUM = "\\p{L}\\p{N}";
const marca = s => new RegExp(
  // El contenido no cruza saltos de línea ni empieza/termina en espacio.
  `(^|[^${ALNUM}${s}])${s}(?=[^\\s${s}])([^\\n]*?[^\\s${s}])${s}(?![${ALNUM}${s}])`, "gu");
const MARCAS = [[marca("_"), "em"], [marca("\\*"), "strong"], [marca("~"), "s"]];

export function formatoWa(texto) {
  // Los bloques de código se apartan antes: dentro de ellos WhatsApp no aplica
  // ningún otro formato. Se quita \u0000 del texto para que no choque con las marcas.
  const guardados = [];
  const guardar = html => `\u0000${guardados.push(html) - 1}\u0000`;
  let h = esc(String(texto ?? "").replace(/\u0000/g, ""))
    .replace(/```([\s\S]+?)```/g, (_, c) => guardar(`<code class="wamono">${c}</code>`))
    .replace(/`([^`\n]+)`/g, (_, c) => guardar(`<code class="wacod">${c}</code>`));

  h = h.split("\n").map(linea => {
    let pre = "", post = "";
    // Cita: «> texto». Viaja escapada como &gt;.
    const cita = linea.match(/^&gt; (.*)$/);
    if (cita) { linea = cita[1]; pre = `<span class="wacita">`; post = "</span>"; }
    // Lista con viñeta: «* texto» o «- texto» se ve con un punto.
    linea = linea.replace(/^([*-]) (?=\S)/, "• ");
    for (const [re, tag] of MARCAS) {
      // Se repite para que *_ambos_* y marcas seguidas en la misma línea apliquen.
      let antes;
      do { antes = linea; linea = linea.replace(re, `$1<${tag}>$2</${tag}>`); } while (linea !== antes);
    }
    return pre + linea + post;
  }).join("\n");

  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => guardados[+i]);
}
