// Novedades del panel: la campana junto al indicador de asistencias pendientes
// y el tutorial de cada funcionalidad nueva.
//
// Cada novedad se le muestra SOLA a cada cuenta una única vez, al entrar.
// Después queda en la campana para volver a verla. «Visto» es por cuenta, no
// por dispositivo (tabla `novedades_vistas`, sql/2026-11-11_67), así que quien
// la vio en el celular no la vuelve a recibir en el computador.
//
// Para anunciar otra: agregarla ARRIBA en NOVEDADES con una `clave` nueva. Las
// claves no se reutilizan: la marca de visto va por clave.
import { SB } from "./supabase.js";
import { state, $, esc } from "./state.js";

const NOVEDADES = [
  {
    clave: "notas-de-voz-2026-11",
    fecha: "2026-11-11",
    titulo: "Notas de voz en tus envíos",
    texto: "Graba tu voz y envíala a muchas personas a la vez, junto a textos, imágenes y videos, en el orden que tú decidas.",
    url: "/novedades/notas-de-voz.html",
  },
];

// Respaldo si la tabla no responde (sin migración, sin red): el visto se
// recuerda al menos en este navegador, para no mostrar el tutorial en cada
// entrada.
const LS = "nexus.novedadesVistas";
const vistasLocales = () => { try { return JSON.parse(localStorage.getItem(LS) || "[]"); } catch { return []; } };
const guardarLocal = c => { try { localStorage.setItem(LS, JSON.stringify([...new Set([...vistasLocales(), c])])); } catch { /* sin almacenamiento */ } };

let vistas = new Set();

async function cargarVistas() {
  const { data, error } = await SB.from("novedades_vistas").select("clave");
  if (error) { console.warn("novedades:", error.message); return new Set(vistasLocales()); }
  return new Set([...(data || []).map(r => r.clave), ...vistasLocales()]);
}

async function marcarVista(clave) {
  if (vistas.has(clave)) return;
  vistas.add(clave);
  guardarLocal(clave);
  pintarCampana();
  // upsert: dos pestañas pueden abrir la misma novedad.
  const { error } = await SB.from("novedades_vistas").upsert({ clave }, { ignoreDuplicates: true });
  if (error) console.warn("novedades:", error.message);
}

function pintarCampana() {
  const btn = $("novInd");
  if (!btn) return;
  const sinVer = NOVEDADES.filter(n => !vistas.has(n.clave)).length;
  btn.classList.toggle("nueva", sinVer > 0);
  btn.setAttribute("aria-label", sinVer ? `Novedades: ${sinVer} sin ver` : "Novedades");
}

function abrirTutorial(n) {
  $("novLista").classList.add("hidden");
  $("novTit").textContent = n.titulo;
  // ?auto: arranca solo. El parámetro de versión evita que el navegador
  // muestre una copia vieja del tutorial después de un despliegue.
  $("novFrame").src = `${n.url}?auto&v=${encodeURIComponent(n.clave)}`;
  $("novFrame").classList.remove("hidden");
  $("novVolver").classList.toggle("hidden", NOVEDADES.length < 2);
  $("novOverlay").classList.add("open");
  marcarVista(n.clave);
}

function abrirLista() {
  $("novTit").textContent = "Novedades";
  $("novFrame").classList.add("hidden");
  $("novFrame").src = "about:blank";
  $("novVolver").classList.add("hidden");
  $("novLista").innerHTML = NOVEDADES.map((n, i) => `
    <button type="button" class="novitem" data-i="${i}">
      <span class="novtag">${vistas.has(n.clave) ? "Novedad" : "Nuevo"}</span>
      <b>${esc(n.titulo)}</b>
      <span class="novtxt">${esc(n.texto)}</span>
      <span class="novver">▶ Ver el tutorial</span>
    </button>`).join("");
  $("novLista").querySelectorAll(".novitem").forEach(b => b.onclick = () => abrirTutorial(NOVEDADES[+b.dataset.i]));
  $("novLista").classList.remove("hidden");
  $("novOverlay").classList.add("open");
}

function cerrar() {
  $("novOverlay").classList.remove("open");
  // Vaciar el iframe detiene el tutorial en vez de dejarlo corriendo oculto.
  $("novFrame").src = "about:blank";
}

// Al entrar: pinta la campana y, si hay una novedad que esta cuenta no vio,
// abre su tutorial. Una sola por entrada; la siguiente, en la próxima.
export async function revisarNovedades() {
  if (!state.me) return;
  vistas = await cargarVistas();
  pintarCampana();
  if ($("novOverlay").classList.contains("open")) return;
  // No encima de otro aviso: el del equipo manda y la novedad espera.
  if (document.querySelector(".overlay.open")) return;
  const nueva = NOVEDADES.find(n => !vistas.has(n.clave));
  if (nueva) abrirTutorial(nueva);
}

$("novInd").onclick = () => (NOVEDADES.length === 1 ? abrirTutorial(NOVEDADES[0]) : abrirLista());
$("novCerrar").onclick = cerrar;
$("novVolver").onclick = abrirLista;
$("novOverlay").onclick = e => { if (e.target.id === "novOverlay") cerrar(); };
document.addEventListener("keydown", e => { if (e.key === "Escape" && $("novOverlay").classList.contains("open")) cerrar(); });
