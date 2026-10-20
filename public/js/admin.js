// Módulo «Administración» (solo admin): catálogo de productos con su comisión
// y el equipo agrupado por director con su WhatsApp.
//
// La autorización real vive en la base: `productos_wr` solo deja escribir al
// admin y las dos RPC (`admin_ventas_por_producto`, `admin_resumen_equipo`)
// rechazan a cualquier otro. Esconder la pestaña es solo comodidad.
import { SB } from "./supabase.js";
import { state, $, esc, toast, usd, norm, MEMBRESIA_DE_NIVEL } from "./state.js";
import { cargarVentas } from "./data.js";

const CATEGORIAS = [["membresia", "Membresías"], ["servicio", "Servicios"], ["bot", "Bots"]];

let seccion = "productos";
let productos = [];
let ventasDe = {};          // producto_id -> nº de ventas (de todo el equipo)
let editando = null;        // producto abierto en el formulario; null = nuevo

/* ================= PRODUCTOS ================= */
async function cargarProductos() {
  const [prod, ven] = await Promise.all([
    SB.from("productos").select("*").order("orden"),
    SB.rpc("admin_ventas_por_producto"),
  ]);
  if (prod.error) throw prod.error;
  if (ven.error) throw ven.error;
  productos = prod.data || [];
  ventasDe = Object.fromEntries((ven.data || []).map(r => [r.producto_id, Number(r.ventas)]));
}

const pctTxt = n => Number(n).toLocaleString("es-CO", { maximumFractionDigits: 2 }) + " %";
const comisionTxt = p => p.comision_pct != null
  ? `${usd(p.comision)} <span class="admuted">· ${pctTxt(p.comision_pct)}</span>`
  : Number(p.comision) > 0 ? `${usd(p.comision)} <span class="admuted">· fija</span>`
  : `<span class="agbad">Sin definir</span>`;

function pintarProductos() {
  const body = $("admBody");
  body.innerHTML = `
    <div class="admbar"><button class="admnew" id="admNuevo">+ Producto</button></div>
    ${CATEGORIAS.map(([cat, titulo]) => {
      const ps = productos.filter(p => p.categoria === cat);
      if (!ps.length) return "";
      return `<div class="pstitle">${titulo} <span class="cnt">${ps.length}</span></div>
        <div class="admlista">${ps.map(p => {
          const n = ventasDe[p.id] || 0;
          return `<button class="admprod${p.activo ? "" : " off"}" data-id="${esc(p.id)}">
            <span class="admnom">${esc(p.nombre)}
              ${p.nivel ? `<span class="agrol">da ${esc(MEMBRESIA_DE_NIVEL[p.nivel] || "")}</span>` : ""}
              ${p.activo ? "" : `<span class="agchip gris">Retirado</span>`}</span>
            <span class="admcifras">
              <span><span class="admlbl">Precio</span><b>${usd(p.precio)}</b></span>
              <span><span class="admlbl">Comisión</span><b>${comisionTxt(p)}</b></span>
              <span><span class="admlbl">Ventas</span><b>${n}</b></span>
            </span>
          </button>`;
        }).join("")}</div>`;
    }).join("")}`;
  $("admNuevo").onclick = () => abrirForm(null);
  body.querySelectorAll("[data-id]").forEach(b =>
    b.onclick = () => abrirForm(productos.find(p => p.id === b.dataset.id)));
}

/* ---------- formulario ---------- */
const tipoCom = () => document.querySelector('input[name="apTipo"]:checked').value;

function vistaPrevia() {
  const precio = Number($("apPrecio").value) || 0;
  const v = Number($("apCom").value) || 0;
  const pct = tipoCom() === "pct";
  $("apComLbl").textContent = pct ? "Porcentaje del precio" : "Monto en USD";
  $("apCom").placeholder = pct ? "Ej: 25" : "Ej: 75";
  $("apPrev").innerHTML = pct && v > 0
    ? `Comisión por venta: <b>${usd(Math.round(precio * v) / 100)}</b>. Si cambias el precio, se recalcula sola para las ventas nuevas.`
    : "Las ventas ya registradas conservan la comisión con la que se crearon.";
}

function abrirForm(p) {
  editando = p;
  const nuevo = !p;
  const n = p ? (ventasDe[p.id] || 0) : 0;
  $("apTitulo").textContent = nuevo ? "Nuevo producto" : "Editar producto";
  $("apNombre").value = p?.nombre || "";
  $("apPrecio").value = p ? Number(p.precio) : "";
  // La categoría y el nivel solo se eligen al crear: cambiarlos en un producto
  // ya vendido movería de grupo sus ventas y lo que la venta hace con el nivel.
  $("apCat").value = p?.categoria || "membresia";
  $("apCat").disabled = !nuevo;
  $("apNivel").innerHTML = Object.entries(MEMBRESIA_DE_NIVEL)
    .map(([nv, nom]) => `<option value="${nv}">${esc(nom)}</option>`).join("");
  $("apNivel").value = p?.nivel || 2;
  $("apNivel").disabled = !nuevo;
  const pct = p?.comision_pct != null;
  document.querySelector(`input[name="apTipo"][value="${pct ? "pct" : "fija"}"]`).checked = true;
  $("apCom").value = p ? (pct ? Number(p.comision_pct) : Number(p.comision)) : "";
  $("apCatNota").textContent = nuevo ? "" : "La categoría no se cambia en un producto ya creado.";
  mostrarNivel();
  vistaPrevia();

  // Borrar solo sin ventas (la base lo impide igual); con ventas, retirar.
  $("apBorrar").classList.toggle("hidden", nuevo || n > 0);
  $("apRetirar").classList.toggle("hidden", nuevo || !p.activo || n === 0);
  $("apReactivar").classList.toggle("hidden", nuevo || p.activo);
  $("apAccNota").textContent = nuevo ? ""
    : n > 0 ? `Tiene ${n} venta${n === 1 ? "" : "s"}: no se puede borrar. Retirarlo lo quita de las ventas nuevas y conserva las viejas.`
    : "No tiene ventas: se puede borrar.";
  $("admProdOverlay").classList.add("open");
}

function mostrarNivel() {
  $("apNivelRow").classList.toggle("hidden", $("apCat").value !== "membresia");
}

// El id es texto y lo leen las ventas: se arma una vez a partir del nombre y
// no cambia aunque después se renombre el producto.
function nuevoId(nombre) {
  const base = norm(nombre).replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "producto";
  let id = base, i = 2;
  while (productos.some(p => p.id === id)) id = `${base}_${i++}`;
  return id;
}

async function guardar() {
  const nombre = $("apNombre").value.trim();
  const precio = Number($("apPrecio").value);
  const valor = Number($("apCom").value);
  const pct = tipoCom() === "pct";
  if (!nombre) return toast("⚠ Falta el nombre");
  if (!(precio > 0)) return toast("⚠ El precio debe ser mayor que cero");
  if (pct && !(valor > 0 && valor <= 100)) return toast("⚠ El porcentaje va de 0 a 100");
  if (!pct && !(valor >= 0)) return toast("⚠ La comisión no puede ser negativa");

  // Con porcentaje, el monto lo calcula la base (trigger) a partir del precio.
  const fila = { nombre, precio, comision_pct: pct ? valor : null, comision: pct ? 0 : valor };
  const btn = $("apGuardar"); btn.disabled = true;
  let error;
  if (editando) {
    ({ error } = await SB.from("productos").update(fila).eq("id", editando.id));
  } else {
    const cat = $("apCat").value;
    const orden = Math.max(0, ...productos.map(p => p.orden || 0)) + 1;
    ({ error } = await SB.from("productos").insert({
      ...fila, id: nuevoId(nombre), categoria: cat, activo: true, orden,
      nivel: cat === "membresia" ? Number($("apNivel").value) : null,
    }));
  }
  btn.disabled = false;
  if (error) return toast("⚠ " + error.message);
  toast(editando ? "Producto actualizado" : "Producto creado");
  await trasCambio();
}

async function cambiarActivo(activo) {
  const { error } = await SB.from("productos").update({ activo }).eq("id", editando.id);
  if (error) return toast("⚠ " + error.message);
  toast(activo ? "Producto reactivado" : "Producto retirado · ya no aparece en ventas nuevas");
  await trasCambio();
}

async function borrar() {
  if (!confirm(`¿Borrar «${editando.nombre}»? No tiene ventas, así que no se pierde nada más.`)) return;
  const { error } = await SB.from("productos").delete().eq("id", editando.id);
  // 23503: alguien registró una venta mientras el formulario estaba abierto.
  if (error) return toast(error.code === "23503"
    ? "⚠ Ya tiene ventas: no se puede borrar. Puedes retirarlo." : "⚠ " + error.message);
  toast("Producto borrado");
  await trasCambio();
}

async function trasCambio() {
  $("admProdOverlay").classList.remove("open");
  // El buscador de ventas lee state.productos: se recarga para que el cambio
  // se vea ahí sin recargar la página.
  try { await Promise.all([cargarProductos(), cargarVentas()]); } catch (e) { toast("⚠ " + e.message); }
  if (state.vista === "admin") pintarProductos();
}

$("apCat").onchange = mostrarNivel;
document.querySelectorAll('input[name="apTipo"]').forEach(r => r.onchange = vistaPrevia);
$("apCom").oninput = vistaPrevia;
$("apPrecio").oninput = vistaPrevia;
$("apGuardar").onclick = guardar;
$("apCancelar").onclick = () => $("admProdOverlay").classList.remove("open");
$("apBorrar").onclick = borrar;
$("apRetirar").onclick = () => cambiarActivo(false);
$("apReactivar").onclick = () => cambiarActivo(true);

/* ================= EQUIPO ================= */
// Cuatro estados, uno por acción distinta. El bridge late cada ~30 s, así que
// 5 minutos sin latido ya es una caída y no un retraso.
const SENAL_MS = 5 * 60 * 1000;
function estadoWa(f) {
  if (f.baja_en) return ["gris", "Retirado"];
  if (f.estado_canal === "vinculado") {
    const vivo = f.ultimo_visto && Date.now() - new Date(f.ultimo_visto).getTime() < SENAL_MS;
    return vivo ? ["ok", "Conectado"] : ["ojo", "Sin señal"];
  }
  return ["mal", "Sin vincular"];
}

async function pintarEquipo() {
  const body = $("admBody");
  const { data, error } = await SB.rpc("admin_resumen_equipo");
  if (state.vista !== "admin" || seccion !== "equipo") return;
  if (error) { body.innerHTML = `<div class="naplica">⚠ ${esc(error.message)}</div>`; return; }
  const filas = data || [];
  const porNombre = (a, b) => (a.nombre || "").localeCompare(b.nombre || "", "es");
  const directores = filas.filter(f => f.rol === "director").sort(porNombre);
  const ids = new Set(directores.map(d => d.id));
  const sueltos = filas.filter(f => f.rol === "agente" && !ids.has(f.director_id)).sort(porNombre);

  const cuenta = {};
  filas.forEach(f => { const t = estadoWa(f)[1]; cuenta[t] = (cuenta[t] || 0) + 1; });
  const resumen = ["Conectado", "Sin señal", "Sin vincular", "Retirado"].filter(t => cuenta[t])
    .map(t => `<span>${t}: <b>${cuenta[t]}</b></span>`).join("");

  const fila = (f, esDir) => {
    const [cls, txt] = estadoWa(f);
    return `<div class="admag">
      <span class="admagnom">${esc(f.nombre || "(sin nombre)")}${esDir ? ` <span class="agrol">director</span>` : ""}</span>
      <span class="admagper"><b>${f.personas}</b> persona${f.personas == 1 ? "" : "s"}</span>
      <span class="agchip ${cls}">${txt}</span>
    </div>`;
  };
  const grupo = (titulo, dir, agentes) => {
    const total = agentes.reduce((s, a) => s + Number(a.personas), dir ? Number(dir.personas) : 0);
    return `<div class="admgrupo">
      <div class="admgtop"><b>${esc(titulo)}</b>
        <span class="admuted">${agentes.length} agente${agentes.length === 1 ? "" : "s"} · ${total} personas</span></div>
      ${dir ? fila(dir, true) : ""}
      ${agentes.map(a => fila(a, false)).join("") || `<div class="admuted admvacio">Sin agentes aprobados</div>`}
    </div>`;
  };

  body.innerHTML = `
    <div class="admresumen">${resumen}</div>
    ${directores.map(d => grupo(d.nombre || "(sin nombre)", d,
      filas.filter(f => f.rol === "agente" && f.director_id === d.id).sort(porNombre))).join("")}
    ${sueltos.length ? grupo("Sin director", null, sueltos) : ""}`;
}

/* ================= VISTA ================= */
export async function renderAdmin() {
  $("admSecciones").innerHTML = [["productos", "Productos"], ["equipo", "Agentes"]].map(([k, t]) =>
    `<button class="pill ${k === seccion ? "on" : ""}" data-s="${k}">${t}</button>`).join("");
  $("admSecciones").querySelectorAll(".pill").forEach(b =>
    b.onclick = () => { seccion = b.dataset.s; renderAdmin(); });
  $("admBody").innerHTML = `<div class="naplica">Cargando…</div>`;
  if (seccion === "equipo") return pintarEquipo();
  try { await cargarProductos(); }
  catch (e) { $("admBody").innerHTML = `<div class="naplica">⚠ ${esc(e.message)}</div>`; return; }
  if (state.vista === "admin" && seccion === "productos") pintarProductos();
}
