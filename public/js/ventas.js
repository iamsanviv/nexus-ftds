// Módulo de ventas: facturación, abonos y comisiones en tiempo real.
//
// Se apoya en lo que ya existe y no lo modifica: el cliente sale de Personas
// (por eso el upgrade sabe cobrar solo la diferencia), y los FTD se cuentan
// sobre `comunidad_desde`, un dato que la app ya tenía.
//
// Los tres zooms son etapas con fecha y estado. NO mandan WhatsApp ni tocan
// `mensajes_programados`: programar recordatorios sigue viviendo en Seguimiento
// y aquí no se duplica esa maquinaria.
import {
  state, $, esc, fmtF, hoyISO, toast, esLead, norm,
  usd, periodoDe, periodoAntes, mesLegible,
  pagado, saldo, estaSaldada, fechaSaldo, comisionSinDefinir,
  resumenVentas, comisionFtd,
} from "./state.js";
import {
  cargarVentas, vInsert, vPatch, vDelete, abInsert, notaInsert, notaDelete,
} from "./data.js";

const yo = () => state.me?.id;

/* ================= RENDER ================= */
export function renderVentas() {
  if (!state.ventasOk) {
    $("vtHero").innerHTML = `<div class="vacio"><b>El módulo todavía no está instalado</b>
      Falta aplicar <code>sql/2026-07-29_07_ventas_y_comisiones.sql</code> en Supabase.
      <div class="vterr">${esc(state.ventasError || "")}</div></div>`;
    $("vtPeriodos").innerHTML = ""; $("vtLista").innerHTML = "";
    $("abrirVenta").classList.add("hidden");
    return;
  }
  $("abrirVenta").classList.remove("hidden");
  renderPeriodos();
  renderHero();
  renderLista();
}

// Los últimos seis meses con algo dentro, más el actual siempre.
function renderPeriodos() {
  const hoy = hoyISO().slice(0, 7);
  const con = new Set([hoy]);
  state.ventas.filter(v => v.owner_id === yo()).forEach(v => {
    con.add(periodoDe(v.creado_en));
    (v.abonos || []).forEach(a => con.add(periodoDe(a.fecha)));
  });
  const ps = [...con].sort().reverse().slice(0, 6);
  $("vtPeriodos").innerHTML = ps.map(p =>
    `<button class="pill ${p === state.ventasPeriodo ? "on" : ""}" data-p="${p}">${mesLegible(p)}</button>`).join("");
  $("vtPeriodos").querySelectorAll(".pill").forEach(b =>
    b.onclick = () => { state.ventasPeriodo = b.dataset.p; renderVentas(); });
}

function renderHero() {
  const p = state.ventasPeriodo;
  const r = resumenVentas(p, yo());
  const f = comisionFtd(p, yo());
  const total = r.causada + f.pago;

  // Comparativo con el mes anterior: la misma cuenta, un periodo atrás.
  const ant = periodoAntes(p);
  const totalAnt = resumenVentas(ant, yo()).causada + comisionFtd(ant, yo()).pago;
  let cmp = `Sin nada con qué comparar en ${mesLegible(ant)}`;
  if (totalAnt > 0) {
    const d = Math.round((total - totalAnt) / totalAnt * 100);
    const s = d >= 0 ? "up" : "down";
    cmp = `<span class="${s}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%</span> frente a ${mesLegible(ant)} (${usd(totalAnt)})`;
  }

  $("vtHero").innerHTML = `
    <div class="vthero">
      <span class="lbl">Comisión de ${mesLegible(p)}</span>
      <div class="big">${usd(total)}</div>
      <div class="cmp">${cmp}</div>
      <div class="hsplit">
        <div><span class="n k">${usd(r.facturado)}</span><span class="t">Facturado</span></div>
        <div><span class="n">${usd(r.porFacturar)}</span><span class="t">Por facturar</span></div>
        <div><span class="n w">${usd(r.porCausar)}</span><span class="t">Por causar</span></div>
      </div>
      ${r.sinDefinir ? `<div class="vtwarn">${r.sinDefinir} venta${r.sinDefinir === 1 ? "" : "s"}
        sin comisión definida: no suman a «por causar».</div>` : ""}
    </div>`;
}

// El bloque de FTD se mudó a Personas (ftd.js): es donde el agente pasa el día.
// Aquí sigue contando su comisión dentro del total del encabezado.

function renderLista() {
  const p = state.ventasPeriodo;
  const mias = state.ventas.filter(v => v.owner_id === yo());

  // Las saldadas se agrupan por el mes en que se saldaron (cuando se causó la
  // comisión). Las vivas se muestran siempre: una deuda no pertenece a un mes.
  const causadas = mias.filter(v => estaSaldada(v) && periodoDe(fechaSaldo(v)) === p);
  const vivas    = mias.filter(v => v.estado === "abierta" && !estaSaldada(v));
  const perdidas = mias.filter(v => v.estado === "perdida" && periodoDe(v.creado_en) === p);

  const sec = (titulo, arr, extra = "") => arr.length
    ? `<div class="gtitle">${titulo} <span class="cnt">${extra || arr.length}</span></div>`
      + arr.map(tarjeta).join("")
    : "";

  const html =
    sec("Comisión ya causada", causadas, usd(causadas.reduce((s, v) => s + v.comision, 0)))
    + sec("Falta que paguen", vivas.filter(v => v.tipo === "agendado"))
    + sec("Posibles", vivas.filter(v => v.tipo === "posible"))
    + sec("Perdidas", perdidas);

  $("vtLista").innerHTML = html || `<div class="vacio"><b>Nada en ${mesLegible(p)}</b>
    Toca «+ Venta» para registrar la primera.</div>`;
  engancharLista();
}

function tarjeta(v) {
  const ab = pagado(v), sal = saldo(v), lista = estaSaldada(v);
  // Una venta que se cayó no tiene nada pendiente: ni chip de "qué tan firme"
  // ni «por facturar / por causar». Los totales ya la excluyen; la tarjeta
  // también tiene que hacerlo o promete plata que no va a llegar.
  const muerta = v.estado === "perdida";
  const pct = v.valor > 0 ? Math.min(100, Math.round(ab / v.valor * 100)) : 0;
  const abierta = state.ventasAbiertas.has(v.id);
  const sinCom = comisionSinDefinir(v);
  const notas = state.notas[v.cliente_id] || [];

  const comEtiqueta = sinCom
    ? `<span class="vtsin">comisión sin definir</span>`
    : `<b class="${lista ? "ok" : ""}">${usd(v.comision)}</b>`;

  return `
  <div class="card vt ${abierta ? "open" : ""}" data-v="${v.id}">
    <div class="crow vthead">
      <span class="nombre">${esc(v.cliente_nombre)}</span>
      ${v.es_upgrade ? `<span class="vtup">Upgrade</span>` : ""}
      <span class="vtprod">${esc(v.producto_nombre)}</span>
      ${lista || muerta ? "" : `<span class="tipo ${v.tipo === "agendado" ? "ag" : "po"}">${v.tipo}</span>`}
      ${muerta ? `<span class="tipo pe">se cayó</span>` : ""}
      <span class="plata">${usd(v.valor)}</span>
    </div>

    ${v.valor > 0 ? `<div class="barra ${lista ? "full" : ""}"><i style="width:${pct}%"></i></div>` : ""}

    <div class="pct">
      ${lista
        ? `<span class="ok">✓ Saldada ${fmtF(fechaSaldo(v))}</span> <span>· comisión</span> ${comEtiqueta}`
        : `<b>${usd(ab)}</b> <span>de</span> <b>${usd(v.valor)}</b>`}
      ${v.fecha_pago && !lista ? `<span>· pago ${fmtF(v.fecha_pago)}</span>` : ""}
    </div>

    ${lista || muerta ? "" : `
    <div class="vtpend">
      <span>Por facturar <b>${usd(sal)}</b></span>
      <span>Por causar ${comEtiqueta}</span>
    </div>`}

    ${abierta ? cuerpo(v, sal, notas) : ""}
  </div>`;
}

function cuerpo(v, sal, notas) {
  const abonos = (v.abonos || []).map(a =>
    `<div class="ab"><span class="tk">✓</span><span class="f">${fmtF(a.fecha)}</span>
       <span class="m">${usd(a.monto)}</span></div>`).join("");

  const zoom = (lbl, fecha, est) => {
    const cls = est === "hecha" ? "ok" : est === "no_asistio" ? "no" : fecha ? "now" : "";
    const ic = est === "hecha" ? "✓" : est === "no_asistio" ? "✕" : "·";
    return `<div class="paso ${cls}"><span class="dot">${ic}</span>${lbl}
      ${fecha ? `<span class="fz">${fmtF(fecha.slice(0, 10))}</span>` : ""}</div>`;
  };

  return `
    ${notas.length ? `
    <details class="vtnotas">
      <summary>${notas.length} nota${notas.length === 1 ? "" : "s"} ·
        <span>${esc(notas[0].texto.slice(0, 46))}${notas[0].texto.length > 46 ? "…" : ""}</span></summary>
      ${notas.map(n => `<div class="nt"><span class="f">${fmtF(n.creado_en.slice(0, 10))}</span>
        <span class="tx">${esc(n.texto)}</span>
        ${n.autor_id === yo() ? `<button class="ntdel" data-nota="${n.id}">✕</button>` : ""}</div>`).join("")}
    </details>` : ""}

    <div class="vtnota-add">
      <input class="ntin" data-cli="${v.cliente_id || ""}" placeholder="Anotar algo de este cliente…"
        ${v.cliente_id ? "" : "disabled"}>
      <button class="ntgo" data-cli="${v.cliente_id || ""}" ${v.cliente_id ? "" : "disabled"}>Anotar</button>
    </div>

    ${abonos ? `<div class="abonos">${abonos}</div>` : ""}

    ${estaSaldada(v) || v.estado === "perdida" ? "" : `
    <div class="mini">
      <input class="abin" type="number" min="0" step="1" value="${sal}" data-v="${v.id}">
      <button class="go" data-abonar="${v.id}">Abonar</button>
    </div>`}

    <div class="pasos">
      ${zoom("Presentación", v.pres_fecha, v.pres_estado)}
      ${zoom("1 a 1", v.uno_fecha, v.uno_estado)}
      ${zoom("Cierre", v.cierre_fecha, v.cierre_estado)}
    </div>

    <div class="acciones">
      ${estaSaldada(v) || v.estado === "perdida" ? "" :
        `<button class="act pay" data-pago="${v.id}">✓ Pagó completo</button>`}
      <button class="act" data-editar="${v.id}">Editar</button>
      ${v.estado === "perdida"
        ? `<button class="act" data-revivir="${v.id}">Reabrir</button>`
        : estaSaldada(v) ? "" : `<button class="act" data-perder="${v.id}">Se cayó</button>`}
      <button class="act del" data-borrar="${v.id}">Borrar</button>
    </div>`;
}

/* ================= EVENTOS DE LA LISTA ================= */
function engancharLista() {
  const L = $("vtLista");

  L.querySelectorAll(".vthead").forEach(h => h.onclick = () => {
    const id = h.closest(".card").dataset.v;
    state.ventasAbiertas.has(id) ? state.ventasAbiertas.delete(id) : state.ventasAbiertas.add(id);
    renderLista();
  });

  L.querySelectorAll("[data-abonar]").forEach(b => b.onclick = async () => {
    const id = b.dataset.abonar;
    const inp = L.querySelector(`.abin[data-v="${id}"]`);
    const monto = Number(inp.value);
    if (!(monto > 0)) return toast("⚠ El abono tiene que ser mayor que cero");
    b.disabled = true;
    await abonar(id, monto);
  });

  L.querySelectorAll("[data-pago]").forEach(b => b.onclick = async () => {
    const v = state.ventas.find(x => x.id === b.dataset.pago);
    b.disabled = true;
    await abonar(v.id, saldo(v));
  });

  L.querySelectorAll("[data-perder]").forEach(b => b.onclick = async () => {
    if (await vPatch(b.dataset.perder, { estado: "perdida" })) {
      const v = state.ventas.find(x => x.id === b.dataset.perder);
      v.estado = "perdida"; renderVentas();
    }
  });

  L.querySelectorAll("[data-revivir]").forEach(b => b.onclick = async () => {
    if (await vPatch(b.dataset.revivir, { estado: "abierta" })) {
      const v = state.ventas.find(x => x.id === b.dataset.revivir);
      v.estado = "abierta"; renderVentas();
    }
  });

  L.querySelectorAll("[data-borrar]").forEach(b => b.onclick = async () => {
    const v = state.ventas.find(x => x.id === b.dataset.borrar);
    if (!confirm(`¿Borrar la venta de ${v.cliente_nombre}? Se van también sus abonos.`)) return;
    if (await vDelete(v.id)) {
      state.ventas = state.ventas.filter(x => x.id !== v.id);
      toast("Venta borrada"); renderVentas();
    }
  });

  L.querySelectorAll("[data-editar]").forEach(b => b.onclick = () =>
    abrirVenta(state.ventas.find(x => x.id === b.dataset.editar)));

  L.querySelectorAll(".ntgo").forEach(b => b.onclick = async () => {
    const cli = b.dataset.cli;
    const inp = L.querySelector(`.ntin[data-cli="${cli}"]`);
    const txt = (inp.value || "").trim();
    if (!txt) return;
    b.disabled = true;
    const n = await notaInsert(cli, txt);
    if (n) { (state.notas[cli] ||= []).unshift(n); toast("Nota guardada"); renderLista(); }
    else b.disabled = false;
  });

  L.querySelectorAll(".ntdel").forEach(b => b.onclick = async () => {
    if (!(await notaDelete(b.dataset.nota))) return;
    Object.keys(state.notas).forEach(k =>
      state.notas[k] = state.notas[k].filter(n => n.id !== b.dataset.nota));
    renderLista();
  });
}

async function abonar(ventaId, monto) {
  const a = await abInsert(ventaId, monto, hoyISO());
  if (!a) return renderLista();
  const v = state.ventas.find(x => x.id === ventaId);
  v.abonos.push(a);
  toast(estaSaldada(v) ? "✓ Venta saldada, comisión causada" : "Abono registrado");
  renderVentas();
}

/* ================= ALTA Y EDICIÓN ================= */
// Se venden solo clientes PROPIOS. Un director ve los de sus agentes para
// supervisar, pero la venta quedaría a su nombre y le contaría a él la
// comisión: mismo criterio que la regla de envíos.
const misClientes = () => state.clientes
  .filter(c => c.owner_id === yo() && !esLead(c))
  .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

const prod = id => state.productos.find(p => p.id === id);
const nivelDe = mem => ({ Beca: 1, VIP: 2, Platino: 3, Oro: 4 }[mem] || 0);

// Pasar de Beca a una membresía NO es upgrade: la beca es gratis, así que no
// hay pago inicial que descontar ni comisión ya cobrada. Se cobra precio
// completo y comisiona lo del producto. El upgrade empieza en VIP (nivel 2).
const esUpgrade = (cliente, p) =>
  !!p && p.categoria === "membresia" && nivelDe(cliente.mem) > 1 && nivelDe(cliente.mem) < p.nivel;

// Qué pagó el cliente por la membresía que tiene hoy. Se busca su última venta
// de membresía; si no hay (entró antes del módulo), se usa el producto más
// barato de ese nivel, que es la promoción. Es una estimación, y por eso el
// monto queda siempre editable.
function precioActual(cliente) {
  const n = nivelDe(cliente.mem);
  if (!n) return 0;
  const previa = state.ventas
    .filter(v => v.cliente_id === cliente.id && prod(v.producto_id)?.categoria === "membresia")
    .sort((a, b) => b.creado_en.localeCompare(a.creado_en))[0];
  // El PRECIO DE LISTA del producto, no lo que pagó por él: si esa venta previa
  // era a su vez un upgrade, su monto es una diferencia y encadenar diferencias
  // daría un descuento que nadie concedió.
  if (previa && prod(previa.producto_id)) return Number(prod(previa.producto_id).precio);
  const mismos = state.productos.filter(p => p.nivel === n);
  return mismos.length ? Math.min(...mismos.map(p => Number(p.precio))) : 0;
}

// Calcula monto y comisión según el producto y en qué nivel está el cliente.
function calcular() {
  const c = misClientes().find(x => x.id === $("vfCliente").value);
  const p = prod($("vfProducto").value);
  const hint = $("vfHint");
  if (!c || !p) { hint.classList.add("hidden"); return; }

  const esUp = esUpgrade(c, p);
  const comUp = Number(state.parametros.comision_upgrade || 0);

  if (esUp) {
    const base = precioActual(c);
    const dif = Math.max(0, Number(p.precio) - base);
    $("vfValor").value = dif;
    $("vfComision").value = comUp;
    hint.classList.remove("hidden");
    hint.innerHTML = `<span class="ic">↑</span><span>Es un <b>upgrade</b> desde ${esc(c.mem)}:
      el monto queda en <b>${usd(dif)}</b>, la diferencia contra ${usd(base)}.
      ${comUp > 0 ? `Comisión de upgrade: <b>${usd(comUp)}</b>.`
                  : `<b>La comisión de upgrade todavía no está definida</b>, así que esta venta no sumará al total.`}</span>`;
  } else {
    $("vfValor").value = Number(p.precio);
    $("vfComision").value = Number(p.comision);
    if (!(Number(p.comision) > 0)) {
      hint.classList.remove("hidden");
      hint.innerHTML = `<span class="ic">!</span><span>${esc(p.nombre)} <b>no tiene comisión definida</b>.
        Se puede registrar la venta, pero no sumará al total hasta que el director la configure.</span>`;
    } else hint.classList.add("hidden");
  }
}

/* ---------- selectores con búsqueda ---------- */
// Sin dependencias: un input que filtra una lista. `norm()` es la misma que usa
// el buscador de Personas, así que "cesar" encuentra a "César".
const GRUPOS = [
  ["membresia", "Membresías"],
  ["servicio",  "Servicios"],
  // Once de dieciséis productos son bots: mezclados con los servicios tapaban
  // todo lo demás, así que van en su propio grupo.
  ["bot",       "Bots automáticos"],
];

function pintarClientes(filtro = "") {
  const q = norm(filtro);
  const cs = misClientes().filter(c => !q || norm(c.nombre).includes(q));
  const sel = $("vfCliente").value;
  $("vfListaCliente").innerHTML = cs.length
    ? cs.map(c => `<button type="button" class="pkop ${c.id === sel ? "on" : ""}" data-id="${c.id}"
         data-nom="${esc(c.nombre)}"><span class="nm">${esc(c.nombre)}</span>
         <span class="badge b-${c.mem}">${c.mem}</span></button>`).join("")
    : `<div class="pkvacio">Ningún cliente tuyo se llama así.</div>`;
}

function pintarProductos(filtro = "") {
  const q = norm(filtro);
  const hit = p => !q || norm(p.nombre).includes(q);
  const sel = $("vfProducto").value;
  const fila = (id, nom, extra) => `<button type="button" class="pkop ${id === sel ? "on" : ""}"
      data-id="${id}" data-nom="${esc(nom)}"><span class="nm">${esc(nom)}</span>${extra}</button>`;

  let html = GRUPOS.map(([cat, titulo]) => {
    const ps = state.productos.filter(p => p.categoria === cat && hit(p));
    if (!ps.length) return "";
    return `<div class="pkgrupo">${titulo}</div>` + ps.map(p =>
      fila(p.id, p.nombre, `<span class="pr">${usd(p.precio)}</span>`)).join("");
  }).join("");

  // "Otro" siempre disponible: es la salida para vender algo fuera de la lista.
  if (!q || norm("otro a mano").includes(q)) {
    html += `<div class="pkgrupo">Fuera del catálogo</div>` + fila("__otro", "Otro (a mano)", "");
  }
  $("vfListaProducto").innerHTML = html || `<div class="pkvacio">Nada coincide con «${esc(filtro)}».</div>`;
}

// Cablea un selector: escribir filtra, elegir cierra y avisa.
function engancharPick(inputId, listaId, hiddenId, pintar, alElegir) {
  const inp = $(inputId), lista = $(listaId);
  const abrir = () => { pintar(inp.value === inp.dataset.nom ? "" : inp.value); lista.classList.remove("hidden"); };

  inp.onfocus = () => { inp.select(); abrir(); };
  inp.oninput = () => { pintar(inp.value); lista.classList.remove("hidden"); };
  lista.onclick = e => {
    const b = e.target.closest(".pkop");
    if (!b) return;
    $(hiddenId).value = b.dataset.id;
    inp.value = b.dataset.nom;
    inp.dataset.nom = b.dataset.nom;   // para saber que el texto es una selección
    lista.classList.add("hidden");
    alElegir();
  };
}

// Cerrar las listas al tocar fuera; si no, quedan abiertas tapando el formulario.
$("ventaOverlay").addEventListener("click", e => {
  if (!e.target.closest(".vtpick")) {
    $("vfListaCliente").classList.add("hidden");
    $("vfListaProducto").classList.add("hidden");
  }
});

export function abrirVenta(v = null) {
  state.ventaEdit = v;
  $("vTitulo").textContent = v ? "Editar venta" : "Nueva venta";

  const set = (id, val) => $(id).value = val ?? "";
  set("vfCliente", v?.cliente_id); set("vfProducto", v?.producto_id || (v ? "__otro" : ""));
  set("vfOtro", v && !v.producto_id ? v.producto_nombre : "");
  set("vfValor", v?.valor); set("vfComision", v?.comision);
  set("vfTipo", v?.tipo || "agendado"); set("vfFechaPago", v?.fecha_pago);
  set("vfPres", (v?.pres_fecha || "").slice(0, 10));
  set("vfUno", (v?.uno_fecha || "").slice(0, 10));
  set("vfCierre", (v?.cierre_fecha || "").slice(0, 10));
  set("vfAbono", "");
  $("vfPagada").checked = false;
  $("vfHint").classList.add("hidden");
  // Al editar, los abonos ya existen y se manejan desde la tarjeta.
  $("vfPagoRow").classList.toggle("hidden", !!v);
  $("vfOtroRow").classList.toggle("hidden", !!v?.producto_id || !v);

  // Texto visible de los selectores. Al editar salen con lo ya elegido.
  const ponTexto = (inputId, texto) => {
    const i = $(inputId);
    i.value = texto; i.dataset.nom = texto;
  };
  ponTexto("vfBuscaCliente", v?.cliente_nombre || "");
  ponTexto("vfBuscaProducto", v ? (v.producto_id ? v.producto_nombre : "Otro (a mano)") : "");
  $("vfListaCliente").classList.add("hidden");
  $("vfListaProducto").classList.add("hidden");
  pintarClientes(); pintarProductos();

  $("ventaOverlay").classList.add("open");
}

// Al EDITAR no se recalcula solo: manda lo que ya quedó guardado, que puede
// haberse ajustado a mano. Solo se recalcula si cambian cliente o producto.
engancharPick("vfBuscaCliente", "vfListaCliente", "vfCliente", pintarClientes, calcular);
engancharPick("vfBuscaProducto", "vfListaProducto", "vfProducto", pintarProductos, () => {
  const otro = $("vfProducto").value === "__otro";
  $("vfOtroRow").classList.toggle("hidden", !otro);
  if (otro) { $("vfHint").classList.add("hidden"); return; }
  calcular();
});
// Si se marca «ya pagó», el abono inicial sobra: lo cubre el total.
$("vfPagada").onchange = () => {
  $("vfAbono").disabled = $("vfPagada").checked;
  if ($("vfPagada").checked) $("vfAbono").value = "";
};

$("vGuardar").onclick = async () => {
  const cliId = $("vfCliente").value;
  const c = misClientes().find(x => x.id === cliId);
  if (!c) return toast("⚠ Elige el cliente");

  const pid = $("vfProducto").value;
  const otro = pid === "__otro";
  const p = otro ? null : prod(pid);
  const nombreProd = otro ? ($("vfOtro").value || "").trim() : p?.nombre;
  if (!nombreProd) return toast("⚠ Falta el producto");

  const valor = Number($("vfValor").value);
  if (!(valor >= 0)) return toast("⚠ El monto no es válido");

  const esUp = esUpgrade(c, p);
  const campos = {
    cliente_id: c.id, cliente_nombre: c.nombre,
    producto_id: otro ? null : pid, producto_nombre: nombreProd,
    es_upgrade: esUp, nivel_origen: esUp ? c.mem : null,
    valor, comision: Number($("vfComision").value) || 0,
    tipo: $("vfTipo").value, fecha_pago: $("vfFechaPago").value || null,
    pres_fecha: $("vfPres").value || null, uno_fecha: $("vfUno").value || null,
    cierre_fecha: $("vfCierre").value || null,
  };
  // Poner fecha a un zoom lo da por hecho: no hay por qué marcarlo dos veces.
  ["pres", "uno", "cierre"].forEach(k => {
    if (campos[`${k}_fecha`]) campos[`${k}_estado`] = "hecha";
  });

  $("vGuardar").disabled = true;
  try {
    if (state.ventaEdit) {
      if (!(await vPatch(state.ventaEdit.id, campos))) return;
      Object.assign(state.ventaEdit, campos);
      toast("Venta actualizada");
    } else {
      const nueva = await vInsert(campos);
      if (!nueva) return;
      state.ventas.unshift(nueva);
      // Pagada de una, o con abono inicial: en los dos casos es un abono.
      const inicial = $("vfPagada").checked ? valor : Number($("vfAbono").value) || 0;
      if (inicial > 0) {
        const a = await abInsert(nueva.id, Math.min(inicial, valor), hoyISO());
        if (a) nueva.abonos.push(a);
      }
      toast(estaSaldada(nueva) ? "✓ Venta registrada y saldada" : "Venta registrada");
    }
    cerrarVenta();
    renderVentas();
  } finally {
    $("vGuardar").disabled = false;
  }
};

const cerrarVenta = () => { $("ventaOverlay").classList.remove("open"); state.ventaEdit = null; };
$("vCancelar").onclick = cerrarVenta;
$("ventaOverlay").onclick = e => { if (e.target.id === "ventaOverlay") cerrarVenta(); };
$("abrirVenta").onclick = () => abrirVenta();

/* ================= ENTRADA AL MÓDULO ================= */
// ui.js importa a ventas.js para dibujar la vista, así que aquí NO se puede
// importar ui.js de forma estática: sería un ciclo. Igual que en repaso.js, se
// carga a demanda. De paso, este módulo queda montable por sí solo.
$("tabVentas").onclick = async () => {
  state.vista = "ventas";
  const { render } = await import("./ui.js");
  render();                       // pinta la vista y marca la pestaña
  if (!state.ventasOk) {
    await cargarVentas();         // primera entrada: traer datos
    renderVentas();
  }
};
