// Renderizado de vistas (Comunidad/Leads · por cliente/por servicio), perfil y catálogo.
import Sortable from "https://esm.sh/sortablejs@1.15.3";
import { NIVEL } from "./config.js";
import {
  state, $, esc, fmtF, hoyISO, uid, toast, copyNum, norm, bandera, ZOOMS,
  todos, esRequerido, esAdicional, esLead, progreso, siguiente,
} from "./state.js";
import { dbInsert, dbPatch, dbDelete, guardarCatalogo, mapAEditar, subirImagenServicio, borrarImagenServicio } from "./data.js";
// repaso.js importa a ui.js: para no crear un ciclo, aquí solo se usa el
// contador (función pura sobre `state`) y el modo manual se carga a demanda.
import { repasoPendientes } from "./repaso.js";
import { refrescarCanal } from "./canal.js";

const NIVELES = ["Lead", "Beca", "VIP", "Platino", "Oro"];

/* El logo de WhatsApp va como SVG en línea, no como <img>: no hay build ni CDN
   propio, y una imagen externa serían 200+ peticiones (una por tarjeta) además
   de una dependencia de un dominio ajeno. Va al tamaño de un emoji.
   El número ya no se imprime: era la línea más ruidosa de la tarjeta y casi
   nunca se lee, solo se copia. El botón sigue copiándolo y lo lleva en el
   `title` para quien necesite verlo. */
const ICO_WA = `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347M12.05 21.785h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413"/></svg>`;

/* Bandera con el nombre del país en el `title` (no se pierde el dato, deja de
   ocupar renglón). Si el país está escrito de una forma que no se reconoce se
   muestra el texto tal cual: mejor raro que desaparecido. */
const banderaTag = c => {
  if (!c.pais) return "";
  const b = bandera(c.pais, c.tel);
  return b
    ? ` <span class="bandera" title="${esc(c.pais)}">${b}</span>`
    : ` <span class="pais">${esc(c.pais)}</span>`;
};

// Los dos accesos al teléfono, iguales en la tarjeta y en la vista por servicio.
const contacto = c => c.tel
  ? `<a class="wabtn" target="_blank" rel="noopener" href="https://wa.me/${c.tel.replace(/\D/g, '')}" title="Escribir por WhatsApp" aria-label="Escribir por WhatsApp">${ICO_WA}</a>`
    + `<button class="copynum" data-num="${esc(c.tel)}" title="Copiar ${esc(c.tel)}" aria-label="Copiar el número"></button>`
  : '';

/* ================= RENDER PRINCIPAL ================= */
export function render() {
  renderModuleSwitch();
  renderViewToggle();
  renderShell();
  const isLead = state.modulo === "leads";
  // Seguimiento usa dos columnas en escritorio, así que necesita más ancho que
  // el resto de la app (las demás vistas son listas y se leen mejor angostas).
  document.body.classList.toggle("segwide", state.vista === "seguimiento");

  // Ventas vive en ventas.js y se dibuja solo. El import es dinámico por lo
  // mismo que el de repaso.js: ventas.js importa render() de aquí, y hacerlo
  // estático en los dos sentidos crearía un ciclo.
  $("vistaVentas").classList.toggle("hidden", state.vista !== "ventas");
  if (state.vista === "ventas") {
    $("vistaCliente").classList.add("hidden");
    $("vistaServicio").classList.add("hidden");
    $("vistaSeguimiento").classList.add("hidden");
    $("vistaMas").classList.add("hidden");
    $("abrirModal").classList.add("hidden");
    $("buscar").classList.add("hidden");
    import("./ventas.js").then(m => m.renderVentas());
    return;
  }
  $("abrirVenta").classList.add("hidden");

  if (state.vista === "mas") {
    $("vistaCliente").classList.add("hidden");
    $("vistaServicio").classList.add("hidden");
    $("vistaSeguimiento").classList.add("hidden");
    $("vistaMas").classList.remove("hidden");
    $("abrirModal").classList.add("hidden");
    refrescarCanal();
    return;
  }
  $("vistaMas").classList.add("hidden");

  if (state.vista === "seguimiento") {
    $("vistaCliente").classList.add("hidden");
    $("vistaServicio").classList.add("hidden");
    $("vistaSeguimiento").classList.remove("hidden");
    $("abrirModal").classList.add("hidden");
    $("buscar").classList.add("hidden");
    return;
  }
  $("vistaSeguimiento").classList.add("hidden");
  $("buscar").classList.remove("hidden");

  if (state.vista === "servicio") {
    $("vistaCliente").classList.add("hidden");
    $("vistaServicio").classList.remove("hidden");
    $("abrirModal").classList.add("hidden");
    $("buscar").placeholder = "Buscar persona…";
    renderServicio();
    return;
  }
  $("vistaCliente").classList.remove("hidden");
  $("vistaServicio").classList.add("hidden");
  $("abrirModal").classList.remove("hidden");
  $("buscar").placeholder = isLead ? "Buscar lead…" : "Buscar por nombre o teléfono…";

  // Bloque de FTD del mes. Import dinámico por lo mismo que ventas.js y
  // repaso.js: ftd.js necesita render() de aquí y no puede haber ciclo.
  import("./ftd.js").then(m => m.renderBloqueFtd());

  const base = state.clientes.filter(c => isLead ? esLead(c) : !esLead(c));
  const pr = c => progreso(c);

  /* ----- stats ----- */
  if (isLead) {
    const con = base.filter(c => pr(c).extra > 0).length;
    $("stats").innerHTML = stat("lead", base.length, "Leads") + stat("ok", con, "Con actividad") + stat("mut", base.length - con, "Sin actividad");
  } else {
    $("stats").innerHTML = ["Beca", "VIP", "Platino", "Oro"]
      .map(m => stat(m.toLowerCase().slice(0, 4), base.filter(c => c.mem === m).length, m)).join("");
  }

  /* ----- filtros ----- */
  const defs = isLead
    ? [["todos", "Todos"], ["activos", "🔥 Con actividad"], ["inactivos", "Sin actividad"]]
    : [["todos", "Todos"], ["Beca", "Beca"], ["VIP", "VIP"], ["Platino", "Platino"], ["Oro", "Oro"], ["incompletos", "⏳ En progreso"], ["completos", "✓ Completos"]];
  $("filtros").innerHTML = defs.map(([v, l]) => `<button class="pill ${state.filtro === v ? 'on' : ''}" data-f="${v}">${l}</button>`).join("");
  $("filtros").querySelectorAll(".pill").forEach(b => b.onclick = () => { state.filtro = b.dataset.f; render(); });

  /* ----- orden ----- */
  const ords = isLead
    ? [["cerca", "🔥 Más comprometidos"], ["recientes", "Recientes"], ["az", "A–Z"]]
    : [["cerca", "🏁 Cerca de completar"], ["membresia", "Membresía"], ["recientes", "Recientes"], ["az", "A–Z"]];
  $("orden").innerHTML = ords.map(([v, l]) => `<button class="oseg ${state.orden === v ? 'on' : ''}" data-o="${v}">${l}</button>`).join("");
  $("orden").querySelectorAll(".oseg").forEach(b => b.onclick = () => { state.orden = b.dataset.o; render(); });

  /* ----- filtrar ----- */
  const crudo = $("buscar").value.trim();
  const q = norm(crudo);
  // Búsqueda por teléfono: se buscan los DÍGITOS de la consulta dentro de los
  // dígitos del teléfono. Es aditiva —el nombre sigue funcionando igual—, así
  // que "3390" o "55 3390" encuentran al cliente sin romper nada. Mínimo 2
  // dígitos para no filtrar de más al escribir un solo número suelto.
  const qDig = crudo.replace(/\D/g, "");
  let vis = base.filter(c => {
    if (q) {
      const porNombre = norm(c.nombre).includes(q);
      const porTel = qDig.length >= 2 && (c.tel || "").replace(/\D/g, "").includes(qDig);
      if (!porNombre && !porTel) return false;
    }
    if (state.filtro === "todos") return true;
    if (state.filtro === "activos") return pr(c).extra > 0;
    if (state.filtro === "inactivos") return pr(c).extra === 0;
    if (state.filtro === "incompletos") return pr(c).pct < 100;
    if (state.filtro === "completos") return pr(c).pct === 100;
    return c.mem === state.filtro;
  });

  /* ----- ordenar ----- */
  if (state.orden === "membresia") vis.sort((a, b) => NIVEL[b.mem] - NIVEL[a.mem] || pr(b).pct - pr(a).pct || a.nombre.localeCompare(b.nombre));
  else if (state.orden === "recientes") vis.sort((a, b) => (b.creado || "").localeCompare(a.creado || "") || a.nombre.localeCompare(b.nombre));
  else if (state.orden === "az") vis.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  else if (isLead) vis.sort((a, b) => pr(b).extra - pr(a).extra || a.nombre.localeCompare(b.nombre));
  else vis.sort((a, b) => {
    const pa = pr(a), pb = pr(b), da = pa.pct === 100, db = pb.pct === 100;
    if (da !== db) return da ? 1 : -1;
    if (da && db) return a.nombre.localeCompare(b.nombre);
    return pb.pct - pa.pct || (pa.total - pa.done) - (pb.total - pb.done) || a.nombre.localeCompare(b.nombre);
  });

  const rankMap = {};
  if (state.orden === "cerca") { let n = 0; vis.forEach(c => { if (isLead ? pr(c).extra > 0 : pr(c).pct < 100) rankMap[c.id] = ++n; }); }

  if (!vis.length) {
    const vacioMsg = isLead
      ? (base.length ? "Prueba otro filtro." : "Toca «+ Lead» para registrar a alguien que aún no es de la Comunidad.")
      : (base.length ? "Prueba otro filtro." : "Toca «+ Cliente» o importa tu CSV.");
    $("lista").innerHTML = `<div class="vacio"><b>${base.length ? "Nada en este filtro" : (isLead ? "Aún no hay leads" : "Aún no hay clientes")}</b>${vacioMsg}</div>`;
    return;
  }

  const dir = state.me.role === "director";
  $("lista").innerHTML = vis.map(c => cardHTML(c, pr(c), rankMap[c.id], isLead, dir)).join("");
  wireCards();
}

function stat(cls, n, label) {
  return `<div class="stat ${cls}"><b>${n}</b><span>${label}</span></div>`;
}

function cardHTML(c, p, rank, isLead, dir) {
  const next = siguiente(c), open = state.abiertos.has(c.id);
  const falta = p.total - p.done;

  let rankChip = "";
  if (state.orden === "cerca") {
    if (isLead) rankChip = rank ? `<div class="rank ${rank <= 3 ? 'r' + rank : ''}"><span class="rn">${rank}</span></div>` : "";
    else rankChip = p.pct === 100 ? `<div class="rank done">✓</div>` : `<div class="rank ${rank <= 3 ? 'r' + rank : ''}"><span class="rn">${rank}</span></div>`;
  }

  const ownerBadge = (dir && c.owner_id !== state.me.id) ? `<span class="owner">👤 ${esc(state.perfiles[c.owner_id] || "agente")}</span>` : "";
  // La bandera sube a la línea del nombre: es un dato de la persona, no de su
  // progreso, y ahí no le roba renglón a las cifras.
  const paisTag = banderaTag(c);
  const extraTag = p.extra ? ` · <span class="extra">+${p.extra} ✦</span>` : "";

  const metric = isLead
    ? `<span class="extra">✦ <b>${p.extra}</b> invitación${p.extra === 1 ? '' : 'es'}</span>`
    // Sin el porcentaje: la barra de al lado ya lo dice y «1/3» es el mismo dato
    // por tercera vez. Queda lo exacto y lo accionable.
    : `<b>${p.done}/${p.total}</b> · ${p.pct === 100 ? '<span class="falta cero">✓ Completó todo</span>' : `Le falta${falta === 1 ? '' : 'n'} <span class="falta">${falta}</span>`}${extraTag}`;

  const grupos = state.catalogo.map(g => {
    if (!g.items.length) return "";
    const filas = g.items.map(s => {
      const ok = !!c.acc[s.id], adic = esAdicional(c.mem, s), esNext = next && next.id === s.id;
      return `<div class="srv ${ok ? 'done' : ''} ${adic ? 'adic' : ''} ${esNext ? 'next' : ''}" data-srv="${s.id}">
          <div class="check">${ok ? '✓' : ''}</div>
          <div class="sname">${esc(s.n)} ${esNext ? `<span class="nextlbl">← ${isLead ? 'invitar' : 'siguiente'}</span>` : ''}</div>
          ${adic ? `<span class="stag adic">✦ invitación</span>` : ''}
          ${s.tier ? `<span class="stag ${s.tier}">${s.tier === 'oro' ? 'ORO' : 'VIP'}</span>` : ''}
          ${ok ? `<span class="sfecha">${fmtF(c.acc[s.id])}</span>` : ''}
        </div>`;
    }).join("");
    return `<div class="grupo"><div class="gtitle">${esc(g.g)}</div>${filas}</div>`;
  }).join("");

  const nota = c.nota ? `<div class="notaimp"><span class="nlbl">Nota</span>${esc(c.nota)}</div>` : "";

  return `<div class="card ${open ? 'open' : ''}" data-id="${c.id}">
      <div class="chead">
        ${rankChip || `<div class="cav">${esc(iniciales(c.nombre))}</div>`}
        <div class="cinfo">
          <div class="nombre"><span class="nmlink" data-perfil="${c.id}">${esc(c.nombre)}</span> <span class="badge b-${c.mem}">${c.mem}</span>${paisTag} ${ownerBadge}</div>
          ${isLead ? '' : `<div class="barra"><i style="width:${p.pct}%"></i></div>`}
          <div class="pct">${metric}</div>
        </div>
        <div class="chev">▸</div>
      </div>
      <div class="cbody">
        ${nota}${grupos}
        <div class="cfoot">
          ${contacto(c)}
          <button data-acc="perfil">Perfil</button>
          <button class="del" data-acc="borrar">Eliminar</button>
        </div>
      </div>
    </div>`;
}

// Re-renderiza manteniendo fija en pantalla la tarjeta indicada. Sin esto, al
// marcar un servicio la lista se reconstruye y reordena, y el scroll salta.
function renderKeepingCard(cardId) {
  const sel = `.card[data-id="${cardId}"]`;
  const antes = document.querySelector(sel)?.getBoundingClientRect().top;
  render();
  if (antes == null) return;
  const el = document.querySelector(sel);
  if (el) window.scrollBy(0, el.getBoundingClientRect().top - antes);
}

function wireCards() {
  $("lista").querySelectorAll(".card").forEach(card => {
    const c = state.clientes.find(x => x.id === card.dataset.id);
    card.querySelector(".chead").onclick = () => { state.abiertos.has(c.id) ? state.abiertos.delete(c.id) : state.abiertos.add(c.id); renderKeepingCard(c.id); };
    const nml = card.querySelector(".nmlink"); if (nml) nml.onclick = e => { e.stopPropagation(); abrirPerfil(c); };
    card.querySelectorAll(".srv").forEach(row => {
      row.onclick = async () => {
        const s = todos().find(x => x.id === row.dataset.srv);
        if (c.acc[s.id]) delete c.acc[s.id];
        else {
          c.acc[s.id] = (c.conf || {})[s.id] || hoyISO();
        }
        renderKeepingCard(c.id);
        await dbPatch(c, { acc: c.acc });
      };
    });
    card.querySelector('[data-acc="perfil"]').onclick = () => abrirPerfil(c);
    const cn = card.querySelector('.copynum'); if (cn) cn.onclick = e => { e.stopPropagation(); copyNum(cn.dataset.num); };
    card.querySelector('[data-acc="borrar"]').onclick = async () => {
      if (!confirm(`¿Eliminar a ${c.nombre}?`)) return;
      if (await dbDelete(c.id)) {
        state.clientes = state.clientes.filter(x => x.id !== c.id);
        state.abiertos.delete(c.id);
        // Descuenta el FTD si este cliente lo había sumado este mes (simétrico
        // a trasCrearCliente). Va después de sacarlo de state.clientes.
        await (await import("./ftd.js")).trasBorrarCliente(c);
        render();
      }
    };
  });
}

/* ================= SWITCH DE MÓDULO Y DE VISTA ================= */
function renderModuleSwitch() {
  const ms = [["comunidad", "🎓 Comunidad"], ["leads", "🌱 Leads"]];
  $("modSwitch").innerHTML = ms.map(([v, l]) => `<button class="mbtn ${v} ${state.modulo === v ? 'on' : ''}" data-m="${v}">${l}</button>`).join("");
  $("modSwitch").querySelectorAll(".mbtn").forEach(b => b.onclick = () => {
    if (state.modulo === b.dataset.m && state.vista !== "seguimiento") return;
    state.modulo = b.dataset.m; state.filtro = "todos";
    if (state.vista === "seguimiento") state.vista = "cliente";
    render();
  });
  $("abrirModal").textContent = state.modulo === "leads" ? "+ Lead" : "+ Cliente";
}

function renderViewToggle() {
  const vs = [["cliente", "👤 Por persona"], ["servicio", "📋 Por servicio"]];
  $("viewToggle").innerHTML = vs.map(([v, l]) => `<button class="vbtn ${state.vista === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join("");
  $("viewToggle").querySelectorAll(".vbtn").forEach(b => b.onclick = () => { state.vista = b.dataset.v; render(); });
}

/* ================= SHELL DE APP (header + tab bar) ================= */
export const iniciales = n => (n || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();

function renderShell() {
  const V = state.vista;
  const isLead = state.modulo === "leads";
  const titulos = { cliente: isLead ? "Leads" : "Personas", servicio: "Servicios", seguimiento: "Seguimiento", ventas: "Ventas", mas: "Más" };
  $("viewTitle").textContent = titulos[V] || "Seguimiento";
  let sub = "";
  if (V === "cliente" || V === "servicio") {
    const n = state.clientes.filter(c => isLead ? esLead(c) : !esLead(c)).length;
    sub = isLead ? `${n} lead${n === 1 ? "" : "s"}` : `${n} en la comunidad`;
  } else if (V === "seguimiento") sub = "Actividades y mensajes automáticos";
  else if (V === "ventas") sub = "Facturación y comisiones";
  else sub = "Cuenta y herramientas";
  $("viewSub").textContent = sub;

  document.querySelectorAll(".tabbar .tab").forEach(t => t.classList.toggle("on", t.dataset.v === V));

  const enListas = V === "cliente" || V === "servicio";
  $("modSwitch").classList.toggle("hidden", !enListas);
  $("buscar").classList.toggle("hidden", !enListas);

  const av = $("meAv");
  if (av && state.me?.name) av.textContent = iniciales(state.me.name);
  const sav = $("sideAv");
  if (sav && state.me?.name) sav.textContent = iniciales(state.me.name);

  renderRepInd();
}

// Indicador de repaso: solo aparece si hay invitaciones sin responder.
function renderRepInd() {
  const btn = $("repInd");
  if (!btn) return;
  const n = repasoPendientes();
  btn.classList.toggle("hidden", n === 0);
  if (n) $("repIndCount").textContent = n;
}

// El repaso se carga a demanda (import dinámico) para no crear un ciclo
// de dependencias entre ui.js y repaso.js.
$("repInd").onclick = async () => {
  const { repasoManual } = await import("./repaso.js");
  repasoManual();
};

$("tabPersonas").onclick = () => { state.vista = "cliente"; render(); };
$("tabServicios").onclick = () => { state.vista = "servicio"; render(); };
$("tabMas").onclick = () => { state.vista = "mas"; render(); };

/* ================= VISTA POR SERVICIO ================= */
function renderServicio() {
  const isLead = state.modulo === "leads";
  const base = state.clientes.filter(c => isLead ? esLead(c) : !esLead(c));

  const sel = $("srvPick"), cur = sel.value;
  sel.innerHTML = state.catalogo.map(g => `<optgroup label="${esc(g.g)}">` +
    g.items.map(s => `<option value="${s.id}">${esc(s.n)}${s.tier ? (s.tier === 'oro' ? ' (Oro)' : ' (VIP)') : ''}</option>`).join("")
    + `</optgroup>`).join("");
  if (cur && todos().some(s => s.id === cur)) sel.value = cur;
  sel.onchange = () => render();

  const sid = sel.value, s = todos().find(x => x.id === sid);
  if (!s) { $("srvStats").innerHTML = ""; $("srvLista").innerHTML = `<div class="vacio"><b>No hay servicios en el catálogo</b></div>`; return; }

  const q = norm($("buscar").value.trim());
  const conf = c => (c.conf || {})[sid];
  const asis = c => c.acc[sid];
  const asistieron = base.filter(c => asis(c));
  const invitados = base.filter(c => conf(c) && !asis(c));
  const porInvitar = base.filter(c => !conf(c) && !asis(c));
  const total = base.length;
  const pct = total ? Math.round(asistieron.length / total * 100) : 0;

  const filt = arr => arr.filter(c => !q || norm(c.nombre).includes(q));
  const aA = filt(asistieron).sort((a, b) => (a.acc[sid] || "").localeCompare(b.acc[sid] || "") * -1);
  const aC = filt(invitados).sort((a, b) => (conf(b) || "").localeCompare(conf(a) || ""));
  const aP = filt(porInvitar).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  $("srvStats").innerHTML = `<div class="srvstat">
    <div class="srvstat-top"><b>${asistieron.length}</b> asistieron · <b>${invitados.length}</b> invitados · <span class="falta">${porInvitar.length} por invitar</span></div>
    <div class="barra"><i style="width:${pct}%"></i></div>
  </div>`;

  const dir = state.me.role === 'director';
  const owner = c => (dir && c.owner_id !== state.me.id) ? `<span class="owner">👤 ${esc(state.perfiles[c.owner_id] || 'agente')}</span>` : '';
  const info = c => `<div class="pl"><span class="pn nmlink" data-perfil="${c.id}">${esc(c.nombre)}</span><span class="badge b-${c.mem}">${c.mem}</span>${banderaTag(c)}${owner(c)}${contacto(c)}</div>`;

  const rowAsis = c => `<div class="prow">${info(c)}<div class="pr"><span class="pdate">asistió ${fmtF(c.acc[sid])}</span><button class="pmark off" data-unasis="${c.id}" title="Quitar asistencia">✕</button></div></div>`;
  const rowConf = c => `<div class="prow">${info(c)}<div class="pr"><span class="pdate conf">invitado ${fmtF(conf(c))}</span><button class="pmark" data-asis="${c.id}">✓ Asistió</button><button class="pmark off" data-unconf="${c.id}" title="Quitar confirmación">✕</button></div></div>`;
  const rowPend = c => `<div class="prow">${info(c)}<div class="pr"><button class="pmark" data-conf="${c.id}">✓ invitado</button></div></div>`;
  const mini = t => `<div class="naplica">${t}</div>`;

  // Acordeón: cada grupo se pliega/despliega; con búsqueda activa se abren todos.
  const grupoAcc = (key, titulo, filas, vacioMsg) => {
    const open = q ? true : state.srvOpen[key];
    return `<div class="grupo acc ${open ? 'open' : ''}">
      <div class="gtitle gclick" data-g="${key}"><span class="gchev">▸</span>${titulo}</div>
      <div class="gbody">${filas || mini(vacioMsg)}</div>
    </div>`;
  };
  $("srvLista").innerHTML =
      grupoAcc("asis", `✓ Asistieron (${aA.length})`, aA.map(rowAsis).join(""), q ? "Nadie coincide" : "Nadie aún")
    + grupoAcc("conf", `📋 invitados · falta preguntar asistencia (${aC.length})`, aC.map(rowConf).join(""), q ? "Nadie coincide" : "Nadie confirmado todavía")
    + grupoAcc("pend", `${isLead ? '🌱 Por invitar' : '⏳ Por invitar'} (${aP.length})`, aP.map(rowPend).join(""), q ? "Nadie coincide" : "¡Todos contactados! 🎉");

  $("srvLista").querySelectorAll(".gclick").forEach(t => t.onclick = () => {
    const k = t.dataset.g;
    state.srvOpen[k] = !state.srvOpen[k];
    render();
  });

  const find = id => state.clientes.find(x => x.id === id);
  $("srvLista").querySelectorAll("[data-perfil]").forEach(b => b.onclick = () => { const c = find(b.dataset.perfil); if (c) abrirPerfil(c); });
  $("srvLista").querySelectorAll("[data-conf]").forEach(b => b.onclick = async () => {
    const c = find(b.dataset.conf); if (!c) return; c.conf = c.conf || {}; c.conf[sid] = hoyISO();
    render(); await dbPatch(c, { conf: c.conf }); toast(`✓ ${c.nombre.split(' ')[0]} invitado «${s.n}»`);
  });
  $("srvLista").querySelectorAll("[data-unconf]").forEach(b => b.onclick = async () => {
    const c = find(b.dataset.unconf); if (!c) return; c.conf = c.conf || {}; delete c.conf[sid];
    render(); await dbPatch(c, { conf: c.conf });
  });
  $("srvLista").querySelectorAll("[data-asis]").forEach(b => b.onclick = async () => {
    const c = find(b.dataset.asis); if (!c) return; c.acc[sid] = (c.conf || {})[sid] || hoyISO();
    render(); await dbPatch(c, { acc: c.acc }); toast(`✓ ${c.nombre.split(' ')[0]} asistió a «${s.n}»`);
  });
  $("srvLista").querySelectorAll("[data-unasis]").forEach(b => b.onclick = async () => {
    const c = find(b.dataset.unasis); if (!c) return; delete c.acc[sid];
    render(); await dbPatch(c, { acc: c.acc });
  });
  $("srvLista").querySelectorAll(".copynum").forEach(b => b.onclick = e => { e.stopPropagation(); copyNum(b.dataset.num); });
}

/* ================= PERFIL (crear / editar persona) ================= */
function opcionesNivel(sel) {
  return NIVELES.map(m => `<option ${m === sel ? 'selected' : ''}>${m}</option>`).join("");
}

function abrirPerfil(c) {
  state.cliEdit = c.id;
  $("cliTitulo").textContent = "Perfil de " + c.nombre;
  $("fNombre").value = c.nombre; $("fPais").value = c.pais || ""; $("fTel").value = c.tel || "";
  $("fMem").innerHTML = opcionesNivel(c.mem);
  $("fCreado").value = c.creado || ""; $("fComunidad").value = c.comunidadDesde || ""; $("fUpgrade").value = c.upgradeFecha || "";
  $("fNota").value = c.nota || "";
  $("btnConvertir").classList.toggle("hidden", c.mem !== "Lead");
  // Al editar se precarga el dueño actual: el director también puede
  // reasignar un cliente a otro agente de su equipo.
  renderDueno(c.owner_id);
  construirActividades(c);
  $("overlay").classList.add("open");
}

function construirActividades(c) {
  const items = todos().filter(s => c.acc[s.id]);
  // Actividades puntuales a las que asistió. Van aparte porque no son del
  // catálogo y no cuentan para el progreso, pero sí son parte de su historia.
  const pun = Object.entries(c.pun || {})
    .filter(([, p]) => p && p.acc)
    .sort((a, b) => (b[1].acc || "").localeCompare(a[1].acc || ""));

  // Embudo de venta. Va en TODOS los perfiles porque la presentación pasa antes
  // de que exista una venta —hasta hoy no había dónde anotarla— pero plegado:
  // 300+ clientes de comunidad no lo usan y no tiene por qué estorbarles.
  const z = c.zooms || {};
  const hechos = ZOOMS.filter(([k]) => (z[k] || {}).e === "hecha").length;
  const zHtml = `<details class="punacc zoomacc">
      <summary><span class="pat">◎ Embudo de venta</span><span class="pcn">${hechos}/3</span></summary>
      <div class="punbody">
        <div class="msgshelp">Se marcan solos al ponerle asistencia a una actividad puntual que sea un zoom. También puedes editarlos aquí.</div>
        ${ZOOMS.map(([k, lbl]) => {
          const zz = z[k] || {};
          return `<div class="actrow zrow">
            <span class="an">${lbl}</span>
            <select data-zest="${k}" title="Estado">
              <option value="" ${!zz.e || zz.e === "pendiente" ? "selected" : ""}>Pendiente</option>
              <option value="hecha" ${zz.e === "hecha" ? "selected" : ""}>✓ Hecho</option>
              <option value="no_asistio" ${zz.e === "no_asistio" ? "selected" : ""}>✕ No asistió</option>
            </select>
            <input type="date" data-zf="${k}" value="${esc(zz.f || "")}">
          </div>`;
        }).join("")}
      </div>
    </details>`;

  let html = "";
  html += items.length
    ? `<div class="pstitle">Fechas de actividades (edita o vacía para quitar)</div>` +
      items.map(s => `<div class="actrow"><span class="an">${esc(s.n)}</span><input type="date" data-sid="${s.id}" value="${c.acc[s.id]}"></div>`).join("")
    : `<div class="pstitle">Fechas de actividades</div><div class="naplica">Aún no ha tomado ningún servicio.</div>`;

  // Acordeón: los lanzamientos y clases sueltas se acumulan con el tiempo y no
  // se consultan casi nunca. Plegado, el perfil sigue cabiendo en una pantalla;
  // desplegado, está la historia completa con fecha.
  if (pun.length) {
    html += `<details class="punacc">
      <summary><span class="pat">✦ Actividades puntuales</span><span class="pcn">${pun.length}</span></summary>
      <div class="punbody">` +
      pun.map(([id, p]) => `<div class="actrow">
        <span class="an">${esc(p.n || "actividad")}</span>
        <input type="date" data-pid="${esc(id)}" value="${esc(p.acc)}">
        <button type="button" class="pmark off" data-punx="${esc(id)}"
                title="Eliminar este registro">✕</button>
      </div>`).join("") +
      `</div></details>`;
  }
  html += zHtml;
  $("fActividades").innerHTML = html;

  // Guardar el embudo. Vaciar la fecha y dejar «Pendiente» borra la etapa: es
  // la única forma de deshacer un zoom marcado por error.
  const guardarZoom = async () => {
    const nuevo = {};
    for (const [k] of ZOOMS) {
      const e = $("fActividades").querySelector(`[data-zest="${k}"]`).value;
      const f = $("fActividades").querySelector(`[data-zf="${k}"]`).value;
      if (e || f) nuevo[k] = { ...(f ? { f } : {}), ...(e ? { e } : { e: "pendiente" }) };
    }
    c.zooms = nuevo;
    if (await dbPatch(c, { zooms: nuevo })) toast("Embudo actualizado");
  };
  $("fActividades").querySelectorAll("[data-zest],[data-zf]")
    .forEach(el => el.onchange = guardarZoom);

  // Eliminar un registro puntual. Pide confirmación con el nombre adentro: es
  // la única forma de borrar una asistencia sin querer desde acá, y la lista
  // puede tener varias parecidas.
  $("fActividades").querySelectorAll("[data-punx]").forEach(b => b.onclick = async () => {
    const id = b.dataset.punx;
    const p = (c.pun || {})[id] || {};
    if (!confirm(`¿Eliminar el registro de «${p.n || "esta actividad"}»?\n\n`
               + `Se borra su asistencia del ${fmtF(p.acc)}. No se puede deshacer.`)) return;
    delete c.pun[id];
    if (await dbPatch(c, { puntuales: c.pun })) {
      toast("Registro eliminado");
      construirActividades(c);
      render();
    }
  });
}

function cerrarM() {
  $("overlay").classList.remove("open"); state.cliEdit = null;
  ["fNombre", "fPais", "fTel", "fNota", "fCreado", "fComunidad", "fUpgrade"].forEach(i => $(i).value = "");
  $("fMem").innerHTML = opcionesNivel(state.modulo === "leads" ? "Lead" : "Beca");
  $("fActividades").innerHTML = ""; $("btnConvertir").classList.add("hidden");
}

// Selector de dueño: solo tiene sentido para un director, que es el único que
// puede crear clientes a nombre de otra persona (los de SU equipo). Para los
// demás la fila queda oculta y el dueño lo pone la base (auth.uid()).
function renderDueno(seleccionado) {
  const row = $("fDuenoRow"), sel = $("fDueno");
  const puede = state.me.role === "director" && state.equipo.length > 1;
  row.classList.toggle("hidden", !puede);
  if (!puede) { sel.innerHTML = ""; return; }
  sel.innerHTML = state.equipo.map(m =>
    `<option value="${m.id}">${esc(m.nombre)}${m.yo ? " (yo)" : ""}</option>`).join("");
  sel.value = seleccionado || state.me.id;
}

$("abrirModal").onclick = () => {
  state.cliEdit = null;
  $("cliTitulo").textContent = state.modulo === "leads" ? "Nuevo lead" : "Nuevo cliente";
  ["fNombre", "fPais", "fTel", "fNota", "fCreado", "fComunidad", "fUpgrade"].forEach(i => $(i).value = "");
  $("fMem").innerHTML = opcionesNivel(state.modulo === "leads" ? "Lead" : "Beca");
  $("fActividades").innerHTML = ""; $("btnConvertir").classList.add("hidden");
  renderDueno(state.me.id);
  import("./ftd.js").then(m => m.pintarCasillaFtd());
  $("overlay").classList.add("open");
};
$("cerrarModal").onclick = cerrarM;
$("overlay").onclick = e => { if (e.target.id === "overlay") cerrarM(); };

$("btnConvertir").onclick = () => {
  $("fMem").value = "Beca";
  if (!$("fComunidad").value) $("fComunidad").value = hoyISO();
  $("btnConvertir").classList.add("hidden");
  toast("Se convertirá a Beca al guardar ✓");
};

$("guardarBtn").onclick = async () => {
  const nombre = $("fNombre").value.trim();
  if (!nombre) { toast("Falta el nombre"); return; }
  const telN = $("fTel").value.replace(/\D/g, "");

  // ¿A nombre de quién queda? Solo un director elige; el resto son sus propios.
  const eligeDueno = !$("fDuenoRow").classList.contains("hidden") && $("fDueno").value;
  const dueno = eligeDueno || state.me.id;
  const ajeno = dueno !== state.me.id;
  const deQuien = ajeno ? (state.perfiles[dueno] || "ese agente") : null;

  // Duplicados: se comparan contra los contactos DEL DUEÑO elegido, no contra
  // los de quien está escribiendo. Mismo teléfono bloquea, mismo nombre advierte.
  const suyos = state.clientes.filter(x => x.owner_id === dueno && x.id !== state.cliEdit);
  if (telN) {
    const dupTel = suyos.find(x => (x.tel || "").replace(/\D/g, "") === telN);
    if (dupTel) {
      toast(ajeno
        ? `⚠ ${deQuien} ya tiene ese número (${dupTel.nombre})`
        : `⚠ Ese número ya es de ${dupTel.nombre}`);
      return;
    }
  }
  const dupNom = suyos.find(x => norm(x.nombre) === norm(nombre));
  if (dupNom && !confirm(ajeno
    ? `${deQuien} ya tiene un contacto llamado «${dupNom.nombre}». ¿Guardar de todas formas?`
    : `Ya tienes un contacto llamado «${dupNom.nombre}». ¿Guardar de todas formas?`)) return;

  const datos = {
    nombre, pais: $("fPais").value.trim(), tel: telN ? "+" + telN : "",
    mem: $("fMem").value, creado: $("fCreado").value || "",
    comunidadDesde: $("fComunidad").value || "", upgradeFecha: $("fUpgrade").value || "",
    nota: $("fNota").value.trim(),
    ...(eligeDueno ? { owner_id: eligeDueno } : {}),
  };
  if (state.cliEdit) {
    const c = state.clientes.find(x => x.id === state.cliEdit);
    Object.assign(c, datos);
    // aplicar fechas de actividades editadas
    $("fActividades").querySelectorAll("input[data-sid]").forEach(inp => {
      const sid = inp.dataset.sid;
      if (inp.value) c.acc[sid] = inp.value; else delete c.acc[sid];
    });
    // lo mismo para las puntuales: vaciar la fecha borra la asistencia
    $("fActividades").querySelectorAll("input[data-pid]").forEach(inp => {
      const pid = inp.dataset.pid;
      if (!c.pun || !c.pun[pid]) return;
      if (inp.value) c.pun[pid] = { ...c.pun[pid], acc: inp.value };
      else delete c.pun[pid];
    });
    if (await dbPatch(c, mapAEditar(c))) toast("Perfil actualizado ✓");
  } else {
    const nuevo = await dbInsert({ ...datos, acc: {} });
    if (nuevo) {
      state.clientes.push(nuevo);
      // Si el cliente NO estaba en los FTD ya declarados, sube el declarado.
      await (await import("./ftd.js")).trasCrearCliente(nuevo);
      const qué = datos.mem === "Lead" ? "Lead" : "Cliente";
      toast(ajeno ? `${qué} agregado a nombre de ${deQuien} ✓` : `${qué} agregado ✓`);
    }
  }
  cerrarM(); render();
};

/* ================= CATÁLOGO (solo director) ================= */
$("btnCat").onclick = () => { renderCat(); $("catOverlay").classList.add("open"); };
$("catCerrar").onclick = () => $("catOverlay").classList.remove("open");
$("catOverlay").onclick = e => { if (e.target.id === "catOverlay") $("catOverlay").classList.remove("open"); };

function renderCat() {
  $("catLista").innerHTML = state.catalogo.map((g, gi) => `
    <div class="catgrupo">
      <h3>${esc(g.g)}
        <button data-gren="${gi}">✎</button>
        ${g.items.length === 0 ? `<button data-gdel="${gi}" style="color:var(--bad)">✕</button>` : ''}
      </h3>
      <div class="catitems" data-gi="${gi}">
      ${g.items.map((s, si) => `
        <div class="catrow" data-si="${si}">
          <span class="drag" title="Arrastra para reordenar">☰</span>
          <span class="cn">${esc(s.n)}</span>
          ${s.img ? `<span class="stag img" title="Tiene imagen">🖼</span>` : ''}
          ${s.tier ? `<span class="stag ${s.tier}">${s.tier === 'oro' ? 'ORO' : 'VIP'}</span>` : ''}
          <button data-e="${gi}:${si}">✎</button>
          <button class="cdel" data-d="${gi}:${si}">✕</button>
        </div>`).join("") || `<div style="font-size:.78rem;color:var(--muted);padding:4px">Grupo vacío — elimínalo con ✕</div>`}
      </div>
    </div>`).join("");
  $("cGroup").innerHTML = state.catalogo.map((g, i) => `<option value="${i}">${esc(g.g)}</option>`).join("");

  const save = () => { guardarCatalogo(); renderCat(); render(); };
  $("catLista").querySelectorAll("[data-gren]").forEach(b => b.onclick = () => { const gi = +b.dataset.gren; const n = prompt("Nuevo nombre del grupo:", state.catalogo[gi].g); if (n && n.trim()) { state.catalogo[gi].g = n.trim(); save(); } });
  $("catLista").querySelectorAll("[data-gdel]").forEach(b => b.onclick = () => { const gi = +b.dataset.gdel; if (confirm(`¿Eliminar el grupo «${state.catalogo[gi].g}»?`)) { state.catalogo.splice(gi, 1); save(); } });
  $("catLista").querySelectorAll("[data-e]").forEach(b => b.onclick = () => {
    const [gi, si] = b.dataset.e.split(":").map(Number); state.srvEdit = { gi, si };
    const s = state.catalogo[gi].items[si];
    $("eName").value = s.n;
    $("eGroup").innerHTML = state.catalogo.map((g, i) => `<option value="${i}" ${i === gi ? 'selected' : ''}>${esc(g.g)}</option>`).join("");
    $("eTier").value = s.tier || "";
    setImgPreview(s.img);
    $("srvOverlay").classList.add("open");
  });
  $("catLista").querySelectorAll("[data-d]").forEach(b => b.onclick = () => {
    const [gi, si] = b.dataset.d.split(":").map(Number); const s = state.catalogo[gi].items[si];
    if (!confirm(`¿Eliminar «${s.n}» del catálogo?`)) return;
    state.catalogo[gi].items.splice(si, 1); save();
  });
  $("catLista").querySelectorAll(".catitems").forEach(cont => {
    const gi = +cont.dataset.gi;
    if (!state.catalogo[gi].items.length) return;
    Sortable.create(cont, {
      handle: ".drag", animation: 150, ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const it = state.catalogo[gi].items;
        const [moved] = it.splice(evt.oldIndex, 1);
        it.splice(evt.newIndex, 0, moved);
        guardarCatalogo(); renderCat(); render();
      },
    });
  });
}

// ---- imagen del servicio ----
function setImgPreview(url) {
  const img = $("eImgPreview"), del = $("eImgDel");
  if (url) {
    img.src = url + (url.includes("?") ? "" : "?v=" + Date.now());  // cache-bust solo en la vista
    img.classList.remove("hidden"); del.classList.remove("hidden");
  } else {
    img.src = ""; img.classList.add("hidden"); del.classList.add("hidden");
  }
  $("eImgEstado").textContent = "";
}

$("eImgPick").onclick = () => $("eImgFile").click();
$("eImgFile").onchange = async () => {
  const file = $("eImgFile").files[0];
  if (!file || !state.srvEdit) return;
  const { gi, si } = state.srvEdit, s = state.catalogo[gi].items[si];
  $("eImgEstado").textContent = "Subiendo…";
  try {
    const url = await subirImagenServicio(file, s.id);
    s.img = url;
    await guardarCatalogo();
    setImgPreview(url);
    $("eImgEstado").textContent = "✓ Imagen guardada";
    renderCat();
  } catch (err) {
    $("eImgEstado").textContent = "⚠ " + err.message;
  } finally {
    $("eImgFile").value = "";
  }
};
$("eImgDel").onclick = async () => {
  if (!state.srvEdit) return;
  const { gi, si } = state.srvEdit, s = state.catalogo[gi].items[si];
  if (!s.img || !confirm("¿Quitar la imagen de este servicio?")) return;
  try { await borrarImagenServicio(s.img); } catch (e) { /* si ya no está, seguimos */ }
  delete s.img;
  await guardarCatalogo();
  setImgPreview(null);
  renderCat();
};

$("srvCerrar").onclick = () => { $("srvOverlay").classList.remove("open"); state.srvEdit = null; };
$("srvOverlay").onclick = e => { if (e.target.id === "srvOverlay") { $("srvOverlay").classList.remove("open"); state.srvEdit = null; } };
$("srvGuardar").onclick = () => {
  if (!state.srvEdit) return;
  const { gi, si } = state.srvEdit, s = state.catalogo[gi].items[si], n = $("eName").value.trim();
  if (!n) { toast("Falta el nombre"); return; }
  s.n = n; const t = $("eTier").value; t ? s.tier = t : delete s.tier;
  const ngi = +$("eGroup").value;
  if (ngi !== gi) { state.catalogo[gi].items.splice(si, 1); state.catalogo[ngi].items.push(s); }
  guardarCatalogo(); renderCat(); render();
  $("srvOverlay").classList.remove("open"); state.srvEdit = null; toast("Servicio actualizado ✓");
};
$("cAddBtn").onclick = () => {
  const n = $("cName").value.trim(); if (!n) { toast("Falta el nombre del servicio"); return; }
  const ng = $("cNewGroup").value.trim(); let g;
  if (ng) { g = { g: ng, items: [] }; state.catalogo.push(g); } else g = state.catalogo[+$("cGroup").value];
  const s = { id: uid("s"), n }; const t = $("cTier").value; if (t) s.tier = t;
  g.items.push(s); $("cName").value = ""; $("cNewGroup").value = "";
  guardarCatalogo(); renderCat(); render(); toast(`Servicio «${n}» agregado ✓`);
};
