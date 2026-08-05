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
  resumenVentas, comisionFtd, metasDe, alertaPago, alertasDelMes,
} from "./state.js";
import {
  cargarVentas, vInsert, vPatch, vDelete, abInsert, abPatch, abDelete,
  notaInsert, notaDelete, dbPatch,
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
  const m = metasDe(p, yo());
  const metaV = m?.metaVentas || 0;
  // Las dos comisiones van SEPARADAS: esta tarjeta es solo la de ventas. El
  // total con FTD baja a la esquina, discreto, para no volver a mezclarlas.
  const total = r.causada + f.pago;
  const pct = metaV ? Math.min(100, Math.round(r.causada / metaV * 100)) : 0;

  // Comparativo con el mes anterior, solo de ventas.
  const ant = periodoAntes(p);
  const antV = resumenVentas(ant, yo()).causada;
  const cmp = antV > 0
    ? (() => { const d = Math.round((r.causada - antV) / antV * 100);
        return `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d)}%</span>
                frente a ${mesLegible(ant)} (${usd(antV)})`; })()
    : "";

  $("vtHero").innerHTML = `
    <div class="metacard">
      <div class="fhead"><span class="lbl">Comisión por ventas de ${mesLegible(p)}</span></div>

      <div class="fbig"><b>${usd(r.causada)}</b>
        <span>${metaV ? `de tu meta de <button class="metalink" id="vtMeta">${usd(metaV)}</button>`
                      : "causada este mes"}</span></div>
      ${cmp ? `<div class="fsub">${cmp}</div>` : ""}

      ${metaV ? `
      <div class="barrawrap">
        <div class="barra ${pct >= 100 ? "full" : ""}"><i style="width:${pct}%"></i></div>
        <span class="metafin">${usd(metaV)}</span>
      </div>
      <div class="fpie">${pct >= 100
        ? `<span class="ok">✓ Cumpliste tu meta de ventas</span>`
        : `Te faltan <b>${usd(metaV - r.causada)}</b> para tu meta`}</div>`
      : `<div class="fpie"><button class="metalink" id="vtMeta">Ponte una meta de ventas</button></div>`}

      <div class="hsplit">
        <div><span class="n k">${usd(r.facturado)}</span><span class="t">Facturado</span></div>
        <div><span class="n">${usd(r.porFacturar)}</span><span class="t">Por facturar</span></div>
        <div><span class="n w">${usd(r.porCausar)}</span><span class="t">Por causar</span></div>
      </div>

      ${r.sinDefinir ? `<div class="vtwarn">${r.sinDefinir} venta${r.sinDefinir === 1 ? "" : "s"}
        sin comisión definida: no suman a «por causar».</div>` : ""}

      <div class="totalmes">Total del mes con FTD (${usd(f.pago)}) · <b>${usd(total)}</b></div>
    </div>
    ${avisoAlertas()}`;

  // El asistente de metas vive en ftd.js; import dinámico para no crear ciclo.
  $("vtMeta").onclick = async () =>
    (await import("./ftd.js")).abrirAsistente("metas");
}

// Aviso de cobro. Solo aparece si hay algo vencido o venciendo hoy: si sale
// siempre, deja de mirarse.
function avisoAlertas() {
  const a = alertasDelMes(yo());
  if (!a.vencidas && !a.hoy) return "";
  const partes = [];
  if (a.vencidas) partes.push(`<b>${a.vencidas}</b> vencida${a.vencidas === 1 ? "" : "s"}`);
  if (a.hoy) partes.push(`<b>${a.hoy}</b> vence${a.hoy === 1 ? "" : "n"} hoy`);
  return `<div class="vtalerta">
    <span class="ic">!</span>
    <span>${partes.join(" · ")} — <b>${usd(a.monto)}</b> por cobrar${
      a.pronto ? `. ${a.pronto === 1 ? "Otra vence" : `Otras ${a.pronto} vencen`} esta semana.` : "."}</span>
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

  // Por urgencia de cobro: lo vencido arriba, lo que no tiene fecha al final.
  // A igual urgencia, primero lo que vence antes.
  const porUrgencia = (a, b) => {
    const oa = alertaPago(a)?.orden ?? 9, ob = alertaPago(b)?.orden ?? 9;
    return oa - ob || (a.fecha_pago || "9999").localeCompare(b.fecha_pago || "9999");
  };

  // Lo que falta que paguen va PRIMERO: es donde hay que poner la energía.
  // Lo ya causado es historia y baja al final.
  const html =
    sec("Falta que paguen", vivas.filter(v => v.tipo === "agendado").sort(porUrgencia))
    + sec("Posibles", vivas.filter(v => v.tipo === "posible").sort(porUrgencia))
    + sec("Comisión ya causada", causadas, usd(causadas.reduce((s, v) => s + v.comision, 0)))
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

  // La alerta pinta el filo izquierdo de la tarjeta, para poder barrer la lista
  // con la vista sin leer fechas.
  const al = alertaPago(v);
  const filo = al && al.nivel !== "ok" ? ` al-${al.nivel}` : "";

  return `
  <div class="card vt${filo} ${abierta ? "open" : ""}" data-v="${v.id}">
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
      ${al && !lista ? `<span class="alchip ${al.nivel}">${al.texto}</span>` : ""}
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
  // Los abonos se pueden corregir en el sitio: un dedazo no debería obligar a
  // borrar la venta entera. La fecha es editable porque decide en qué mes se
  // causa la comisión.
  const abonos = (v.abonos || []).map(a => `
    <div class="ab">
      <input class="abf" type="date" value="${a.fecha}" data-ab="${a.id}" title="Fecha del abono">
      <input class="abm" type="number" min="0" step="1" value="${a.monto}" data-ab="${a.id}"
             inputmode="decimal" title="Monto del abono">
      <button class="abx" data-abdel="${a.id}" title="Borrar este abono">✕</button>
    </div>`).join("");

  // El embudo es de la PERSONA, no de esta venta: la presentación pasa antes de
  // que la venta exista, y con un upgrade había dos filas repitiendo el mismo
  // embudo. Se lee del cliente; si ya no está en la lista, no se pinta nada
  // en vez de inventar un embudo vacío.
  const cli = state.clientes.find(x => x.id === v.cliente_id);
  const zs = (cli || {}).zooms || {};
  const zoom = (k, lbl) => {
    const { f: fecha, e: est } = zs[k] || {};
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
      ${zoom("pres", "Presentación")}
      ${zoom("uno", "1 a 1")}
      ${zoom("cierre", "Cierre")}
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

  // Corregir un abono. `change` y no `input`: se guarda al salir del campo, no
  // en cada tecla, que si no cada dígito sería una escritura a la base.
  L.querySelectorAll(".abm, .abf").forEach(inp => inp.onchange = async () => {
    const id = inp.dataset.ab;
    const v = state.ventas.find(x => (x.abonos || []).some(a => a.id === id));
    const a = v.abonos.find(x => x.id === id);
    const esMonto = inp.classList.contains("abm");

    if (esMonto && !(Number(inp.value) > 0)) {
      toast("⚠ Un abono no puede ser cero. Bórralo con la ✕.");
      inp.value = a.monto;
      return;
    }
    const campos = esMonto ? { monto: Number(inp.value) } : { fecha: inp.value };
    if (!(await abPatch(id, campos))) { inp.value = esMonto ? a.monto : a.fecha; return; }
    Object.assign(a, campos);
    toast("Abono corregido ✓");
    renderVentas();
  });

  L.querySelectorAll("[data-abdel]").forEach(b => b.onclick = async () => {
    const id = b.dataset.abdel;
    const v = state.ventas.find(x => (x.abonos || []).some(a => a.id === id));
    const a = v.abonos.find(x => x.id === id);
    if (!confirm(`¿Borrar el abono de ${usd(a.monto)} del ${fmtF(a.fecha)}?`)) return;
    if (!(await abDelete(id))) return;
    v.abonos = v.abonos.filter(x => x.id !== id);
    toast("Abono borrado");
    renderVentas();
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
  // Las tres fechas del embudo salen del CLIENTE, no de la venta.
  const zc = (state.clientes.find(x => x.id === v?.cliente_id) || {}).zooms || {};
  set("vfPres", (zc.pres || {}).f || "");
  set("vfUno", (zc.uno || {}).f || "");
  set("vfCierre", (zc.cierre || {}).f || "");
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
  };

  // El embudo se guarda en el CLIENTE, aparte de la venta. Poner fecha a un
  // zoom lo da por hecho: no hay por qué marcarlo dos veces. Vaciarla borra la
  // etapa, salvo que ya estuviera en «no asistió», que es un dato que el agente
  // puso a mano y no se pisa desde aquí.
  const zPrev = c.zooms || {};
  const zNuevo = {};
  [["pres", "vfPres"], ["uno", "vfUno"], ["cierre", "vfCierre"]].forEach(([k, id]) => {
    const f = $(id).value || "";
    if (f) zNuevo[k] = { f, e: zPrev[k]?.e === "no_asistio" ? "no_asistio" : "hecha" };
    else if (zPrev[k]?.e === "no_asistio") zNuevo[k] = zPrev[k];
  });

  $("vGuardar").disabled = true;
  try {
    // El embudo va al cliente antes que la venta: es de la persona y vale
    // aunque la venta no llegue a guardarse.
    if (JSON.stringify(zNuevo) !== JSON.stringify(zPrev)) {
      c.zooms = zNuevo;
      await dbPatch(c, { zooms: zNuevo });
    }
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
