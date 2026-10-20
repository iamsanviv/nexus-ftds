// Módulo «Administración» (solo admin): catálogo de productos con su comisión,
// el equipo agrupado por director con su WhatsApp y los avisos para todos.
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

/* ================= AVISOS ================= */
// Un mensaje para todas las cuentas aprobadas, ya o a una hora. El envío lo
// hace la base (enviar_avisos, sql/2026-10-20_44): push a quien lo tenga
// activado y ventana en el panel para todos (avisos.js).
let plantillas = [];

const fechaTxt = t => new Date(t).toLocaleString("es-CO",
  { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
// datetime-local trabaja en hora local sin zona: se arma a mano.
const aLocal = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

async function pintarAvisos() {
  const body = $("admBody");
  const [al, pl, av] = await Promise.all([
    SB.rpc("admin_alcance_avisos"),
    SB.from("aviso_plantillas").select("*").order("titulo"),
    SB.from("avisos").select("*").order("enviar_en", { ascending: false }).limit(60),
  ]);
  if (state.vista !== "admin" || seccion !== "avisos") return;
  const err = al.error || pl.error || av.error;
  if (err) { body.innerHTML = `<div class="naplica">⚠ ${esc(err.message)}</div>`; return; }
  plantillas = pl.data || [];
  const { aprobados, con_push } = al.data?.[0] || { aprobados: 0, con_push: 0 };
  const avisos = av.data || [];
  const prog = avisos.filter(a => !a.enviado_en && !a.cancelado_en).reverse();
  const hechos = avisos.filter(a => a.enviado_en || a.cancelado_en).slice(0, 20);
  const enHora = new Date(Date.now() + 60 * 60000); enHora.setMinutes(0, 0, 0);

  const item = (a, conCancelar) => `<div class="admaviso">
      <div class="admavtop"><b>${esc(a.titulo)}</b>
        ${a.cancelado_en ? `<span class="agchip gris">Cancelado</span>`
          : a.enviado_en ? `<span class="agchip ok">Enviado · ${esc(fechaTxt(a.enviado_en))}</span>`
          : `<span class="agchip ojo">${esc(fechaTxt(a.enviar_en))}</span>`}</div>
      <div class="admavcuerpo">${esc(a.cuerpo)}</div>
      ${conCancelar ? `<div><button class="pmark off mini" data-cancelar="${a.id}">Cancelar</button></div>` : ""}
    </div>`;

  body.innerHTML = `
    <div class="admgrupo">
      <div class="admgtop"><b>Nuevo aviso</b></div>
      <div class="msgshelp admavalc">Llega a las <b>${aprobados}</b> cuentas aprobadas: como notificación a las
        <b>${con_push}</b> que la tienen activada, y a todas como ventana al abrir el panel.</div>
      <div class="frow"><label>Plantilla</label>
        <div class="admavpl">
          <select id="avPlantilla"><option value="">${plantillas.length ? "Elegir una plantilla…" : "Aún no hay plantillas"}</option>
            ${plantillas.map(p => `<option value="${p.id}">${esc(p.titulo)}</option>`).join("")}</select>
          <button class="pmark off mini hidden" id="avBorrarPl">Borrar</button>
        </div></div>
      <div class="frow"><label>Título</label><input id="avTitulo" maxlength="80" placeholder="Ej: Zoom general hoy 8 p. m." autocomplete="off"></div>
      <div class="frow"><label>Mensaje</label><textarea id="avCuerpo" rows="3" maxlength="300" placeholder="Lo que verán en la notificación y en el panel"></textarea>
        <div class="msgshelp" id="avCuenta">0 / 300</div></div>
      <div class="frow"><label>Cuándo</label>
        <div class="admtipo">
          <label><input type="radio" name="avCuando" value="ya" checked> Ahora</label>
          <label><input type="radio" name="avCuando" value="prog"> Programar</label>
        </div>
        <input id="avFecha" type="datetime-local" class="hidden" value="${aLocal(enHora)}" min="${aLocal(new Date())}">
      </div>
      <div class="admavacc">
        <button class="tbtn" id="avGuardarPl">Guardar como plantilla</button>
        <button class="btn-oro" id="avEnviar">Enviar a todos</button>
      </div>
    </div>
    <div class="pstitle">Programados <span class="cnt">${prog.length}</span></div>
    <div class="admlista">${prog.map(a => item(a, true)).join("") || `<div class="admuted admvacio">No hay avisos programados</div>`}</div>
    <div class="pstitle">Últimos enviados</div>
    <div class="admlista">${hechos.map(a => item(a, false)).join("") || `<div class="admuted admvacio">Todavía no se ha enviado ninguno</div>`}</div>`;

  const cuando = () => document.querySelector('input[name="avCuando"]:checked').value;
  const cuenta = () => { $("avCuenta").textContent = `${$("avCuerpo").value.length} / 300`; };
  $("avCuerpo").oninput = cuenta;
  document.querySelectorAll('input[name="avCuando"]').forEach(r => r.onchange = () => {
    $("avFecha").classList.toggle("hidden", cuando() !== "prog");
    $("avEnviar").textContent = cuando() === "prog" ? "Programar" : "Enviar a todos";
  });
  $("avPlantilla").onchange = () => {
    const p = plantillas.find(x => String(x.id) === $("avPlantilla").value);
    $("avBorrarPl").classList.toggle("hidden", !p);
    if (!p) return;
    $("avTitulo").value = p.titulo; $("avCuerpo").value = p.cuerpo; cuenta();
  };
  $("avBorrarPl").onclick = async () => {
    const p = plantillas.find(x => String(x.id) === $("avPlantilla").value);
    if (!p || !confirm(`¿Borrar la plantilla «${p.titulo}»?`)) return;
    const { error } = await SB.from("aviso_plantillas").delete().eq("id", p.id);
    if (error) return toast("⚠ " + error.message);
    toast("Plantilla borrada"); pintarAvisos();
  };

  const leer = () => {
    const titulo = $("avTitulo").value.trim(), cuerpo = $("avCuerpo").value.trim();
    if (!titulo) { toast("⚠ Falta el título"); return null; }
    if (!cuerpo) { toast("⚠ Falta el mensaje"); return null; }
    return { titulo, cuerpo };
  };
  $("avGuardarPl").onclick = async () => {
    const f = leer(); if (!f) return;
    const { error } = await SB.from("aviso_plantillas").insert(f);
    if (error) return toast("⚠ " + error.message);
    toast("Plantilla guardada");
    const t = $("avTitulo").value, c = $("avCuerpo").value;
    await pintarAvisos();
    // Se conserva lo escrito: guardar la plantilla no debe borrar el aviso en curso.
    $("avTitulo").value = t; $("avCuerpo").value = c; cuenta();
  };
  $("avEnviar").onclick = async () => {
    const f = leer(); if (!f) return;
    let enviar_en;
    if (cuando() === "prog") {
      const d = new Date($("avFecha").value);
      if (isNaN(d)) return toast("⚠ Elige la fecha y la hora");
      if (d <= new Date()) return toast("⚠ Esa hora ya pasó");
      enviar_en = d.toISOString();
      if (!confirm(`¿Programar «${f.titulo}» para ${fechaTxt(d)}? Llegará a las ${aprobados} cuentas aprobadas.`)) return;
    } else if (!confirm(`¿Enviar «${f.titulo}» ahora a las ${aprobados} cuentas aprobadas?`)) return;
    const btn = $("avEnviar"); btn.disabled = true;
    const { error } = await SB.from("avisos").insert(enviar_en ? { ...f, enviar_en } : f);
    btn.disabled = false;
    if (error) return toast("⚠ " + error.message);
    toast(enviar_en ? "Aviso programado" : "Aviso enviado a todos");
    pintarAvisos();
  };
  body.querySelectorAll("[data-cancelar]").forEach(b => b.onclick = async () => {
    if (!confirm("¿Cancelar este aviso? No se enviará.")) return;
    // Si ya salió, la política no deja tocarlo y no cambia ninguna fila.
    const { data, error } = await SB.from("avisos").update({ cancelado_en: new Date().toISOString() })
      .eq("id", b.dataset.cancelar).select("id");
    if (error) return toast("⚠ " + error.message);
    toast(data?.length ? "Aviso cancelado" : "⚠ Ya se había enviado");
    pintarAvisos();
  });
}

/* ================= VISTA ================= */
export async function renderAdmin() {
  $("admSecciones").innerHTML = [["productos", "Productos"], ["equipo", "Agentes"], ["avisos", "Avisos"]].map(([k, t]) =>
    `<button class="pill ${k === seccion ? "on" : ""}" data-s="${k}">${t}</button>`).join("");
  $("admSecciones").querySelectorAll(".pill").forEach(b =>
    b.onclick = () => { seccion = b.dataset.s; renderAdmin(); });
  $("admBody").innerHTML = `<div class="naplica">Cargando…</div>`;
  if (seccion === "equipo") return pintarEquipo();
  if (seccion === "avisos") return pintarAvisos();
  try { await cargarProductos(); }
  catch (e) { $("admBody").innerHTML = `<div class="naplica">⚠ ${esc(e.message)}</div>`; return; }
  if (state.vista === "admin" && seccion === "productos") pintarProductos();
}
