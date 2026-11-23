// Enfoque de una función nueva: cuando el elemento queda a la vista, todo lo
// demás se oscurece y desenfoca, y al lado sale qué hace. Existe porque un aviso
// de novedad en la parte de arriba se cierra sin leerlo (Sanviv, 23/11/2026):
// explicar la función EN el control, en el momento en que se va a usar, sí se lee.
//
// Sale UNA vez por cuenta y función (ver `marcar`).
//
// El desenfoque se arma con cuatro paneles alrededor del elemento y no subiendo
// el elemento por encima de un velo: con z-index, cualquier ancestro que cree
// su propio contexto de apilamiento (transform, overflow, z-index) lo dejaría
// debajo del velo, desenfocado justo lo que se quería mostrar.

import { SB } from "./supabase.js";
import { state } from "./state.js";

// Identificadores de cada enfoque. Viven aquí porque los usan dos lados:
// seguimiento.js (donde se muestran) y novedades.js (que los repite desde la campana).
export const ENFOQUES = ["pregunta-link", "filtros-asistencia"];

// «Visto» va por CUENTA, en `novedades_vistas` (clave `enfoque-<id>`), y no solo
// en el navegador: con localStorage solo, salía de nuevo en cada dispositivo o
// navegador donde se entraba (Sanviv, 23/11/2026: «me aparece cada vez que
// entro»). localStorage queda de respaldo si la tabla no responde.
const claveCuenta = id => `enfoque-${id}`;
const claveLocal = id => `nexus.enfoque.${state.me?.id}.${id}`;
let vistos = null;          // Set de ids vistos por la cuenta; null = sin cargar
let cargando = null;
const forzados = new Set(); // repetir a pedido desde la campana, solo en esta sesión

function cargarVistos() {
  if (!cargando) cargando = (async () => {
    const set = new Set();
    for (const id of ENFOQUES) { try { if (localStorage.getItem(claveLocal(id))) set.add(id); } catch { /* sin almacenamiento */ } }
    const { data, error } = await SB.from("novedades_vistas").select("clave").like("clave", "enfoque-%");
    if (!error) for (const r of data || []) set.add(r.clave.slice(8));
    vistos = set;
  })();
  return cargando;
}

const visto = id => !forzados.has(id) && (!vistos || vistos.has(id));

// Se marca AL MOSTRARLO, no al cerrar: si se recarga o se cambia de pantalla
// sin tocar «Entendido», igual ya se vio y no debe repetirse.
function marcar(id) {
  forzados.delete(id);
  vistos?.add(id);
  try { localStorage.setItem(claveLocal(id), new Date().toISOString()); } catch { /* sin almacenamiento */ }
  SB.from("novedades_vistas").upsert({ clave: claveCuenta(id) }, { ignoreDuplicates: true })
    .then(({ error }) => { if (error) console.warn("enfoque:", error.message); });
}

// Desde la campana: que vuelva a salir la próxima vez que se vea, aunque ya se
// haya visto. No borra la marca (la tabla no deja borrar): solo esta sesión.
export const repetirEnfoque = id => forzados.add(id);

const vigilando = new Map();   // id → IntersectionObserver
let abierto = false;

// Vigila `el` y, cuando se ve completo y quieto, lo enfoca. Se puede llamar en
// cada repintado: el elemento suele reemplazarse y se vuelve a vigilar el nuevo.
// `selector` (opcional) reencuentra el elemento si un repintado lo reemplaza
// mientras el enfoque está abierto.
export async function enfocarUnaVez(el, { id, titulo, texto, selector }) {
  vigilando.get(id)?.disconnect();
  vigilando.delete(id);
  if (!state.me || typeof IntersectionObserver === "undefined") return;
  if (!vistos) await cargarVistos();
  if (!el || !el.isConnected || visto(id)) return;
  const io = new IntersectionObserver(es => {
    if (abierto || !es.some(e => e.isIntersecting)) return;
    // Espera a que el scroll se asiente: enfocar algo que pasa de largo marea.
    // Y que esté quieto: abrir un panel suele venir con un scroll suave, y un
    // enfoque medido a mitad de camino queda corrido.
    setTimeout(() => {
      if (abierto || visto(id) || !el.isConnected || !aLaVista(el)) return;
      const y = el.getBoundingClientRect().top;
      setTimeout(() => {
        if (abierto || visto(id) || !el.isConnected || !aLaVista(el)) return;
        if (Math.abs(el.getBoundingClientRect().top - y) > 1) return;   // sigue moviéndose: la próxima vez
        io.disconnect(); vigilando.delete(id);
        mostrar(el, { id, titulo, texto, selector });
      }, 200);
    }, 700);
  }, { threshold: 0.95 });
  // Otra llamada pudo empezar a vigilar mientras se cargaban los vistos.
  vigilando.get(id)?.disconnect();
  io.observe(el);
  vigilando.set(id, io);
}

function aLaVista(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
}

function mostrar(el, { id, titulo, texto, selector }) {
  abierto = true;
  marcar(id);
  const raiz = document.createElement("div");
  raiz.className = "enfoque";
  raiz.setAttribute("role", "dialog");
  raiz.setAttribute("aria-modal", "true");
  raiz.setAttribute("aria-labelledby", "enfoqueTit");
  raiz.innerHTML = `
    <div class="enfpanel" data-p="t"></div><div class="enfpanel" data-p="b"></div>
    <div class="enfpanel" data-p="l"></div><div class="enfpanel" data-p="r"></div>
    <div class="enfaro"></div>
    <div class="enfcaja">
      <div class="enfnuevo">✨ Nuevo</div>
      <div class="enftit" id="enfoqueTit"></div>
      <div class="enftxt"></div>
      <button class="enfok" type="button">Entendido</button>
    </div>`;
  raiz.querySelector(".enftit").textContent = titulo;
  raiz.querySelector(".enftxt").innerHTML = texto;   // texto propio del código, no del usuario
  document.body.appendChild(raiz);
  // Sin scroll mientras está abierto. No con `overflow:hidden` en la página:
  // quitar la barra de desplazamiento corre todo el contenido y el hueco queda
  // fuera de lugar.
  const quieto = e => e.preventDefault();
  raiz.addEventListener("wheel", quieto, { passive: false });
  raiz.addEventListener("touchmove", quieto, { passive: false });

  const P = 8;   // aire alrededor del elemento
  const actual = () => (el.isConnected ? el : (selector && document.querySelector(selector)) || el);
  const ubicar = () => {
    const r = actual().getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const x0 = Math.max(0, r.left - P), y0 = Math.max(0, r.top - P);
    const x1 = Math.min(W, r.right + P), y1 = Math.min(H, r.bottom + P);
    const pos = (n, s) => Object.assign(raiz.querySelector(`[data-p="${n}"]`).style, s);
    pos("t", { left: 0, top: 0, width: W + "px", height: y0 + "px" });
    pos("b", { left: 0, top: y1 + "px", width: W + "px", height: (H - y1) + "px" });
    pos("l", { left: 0, top: y0 + "px", width: x0 + "px", height: (y1 - y0) + "px" });
    pos("r", { left: x1 + "px", top: y0 + "px", width: (W - x1) + "px", height: (y1 - y0) + "px" });
    Object.assign(raiz.querySelector(".enfaro").style,
      { left: x0 + "px", top: y0 + "px", width: (x1 - x0) + "px", height: (y1 - y0) + "px" });
    // La caja va debajo si cabe; si no, encima. Alineada con el elemento,
    // sin salirse de la pantalla (16 px de margen, como el resto del panel).
    const caja = raiz.querySelector(".enfcaja");
    const cw = Math.min(360, W - 32);
    caja.style.width = cw + "px";
    caja.style.left = Math.min(Math.max(16, x0), W - cw - 16) + "px";
    const ch = caja.offsetHeight;
    caja.style.top = (y1 + 14 + ch <= H - 16 ? y1 + 14 : Math.max(16, y0 - 14 - ch)) + "px";
  };
  // Se re-mide en cada cuadro: un repintado de la lista o un scroll que
  // termina detrás del velo moverían el elemento y el hueco quedaría vacío.
  let cuadro;
  const seguir = () => { ubicar(); cuadro = requestAnimationFrame(seguir); };
  seguir();

  const cerrar = () => {
    cancelAnimationFrame(cuadro);
    document.removeEventListener("keydown", tecla);
    raiz.classList.add("saliendo");
    setTimeout(() => { raiz.remove(); abierto = false; }, 220);
  };
  const tecla = e => { if (e.key === "Escape") cerrar(); };
  document.addEventListener("keydown", tecla);
  raiz.querySelector(".enfok").onclick = cerrar;
  raiz.querySelector(".enfok").focus({ preventScroll: true });
}
