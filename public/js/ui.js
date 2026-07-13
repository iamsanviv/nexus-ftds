// Renderizado de vistas (Comunidad/Leads · por cliente/por servicio), perfil y catálogo.
import Sortable from "https://esm.sh/sortablejs@1.15.3";
import { NIVEL } from "./config.js";
import {
  state, $, esc, fmtF, hoyISO, uid, toast, copyNum, norm,
  todos, esRequerido, esAdicional, esLead, progreso, siguiente,
} from "./state.js";
import { dbInsert, dbPatch, dbDelete, guardarCatalogo, mapAEditar, subirImagenServicio, borrarImagenServicio } from "./data.js";

const NIVELES = ["Lead", "Beca", "VIP", "Platino", "Oro"];

/* ================= RENDER PRINCIPAL ================= */
export function render() {
  renderModuleSwitch();
  renderViewToggle();
  const isLead = state.modulo === "leads";

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
  $("buscar").placeholder = isLead ? "Buscar lead…" : "Buscar cliente…";

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
  const q = norm($("buscar").value.trim());
  let vis = base.filter(c => {
    if (q && !norm(c.nombre).includes(q)) return false;
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
  const paisTag = c.pais ? `<span class="pais">📍 ${esc(c.pais)}</span>` : "";
  const extraTag = p.extra ? ` · <span class="extra">+${p.extra} ✦</span>` : "";

  const metric = isLead
    ? `<span class="extra">✦ <b>${p.extra}</b> invitación${p.extra === 1 ? '' : 'es'}</span>${paisTag ? ' · ' + paisTag : ''}`
    : `<b>${p.done}/${p.total}</b> · ${p.pct}% · ${p.pct === 100 ? '<span class="falta cero">✓ Completó todo</span>' : `Le falta${falta === 1 ? '' : 'n'} <span class="falta">${falta}</span>`}${extraTag}${paisTag ? ' · ' + paisTag : ''}`;

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
        ${rankChip}
        <div class="cinfo">
          <div class="nombre"><span class="nmlink" data-perfil="${c.id}">${esc(c.nombre)}</span> <span class="badge b-${c.mem}">${c.mem}</span> ${ownerBadge}</div>
          ${isLead ? '' : `<div class="barra"><i style="width:${p.pct}%"></i></div>`}
          <div class="pct">${metric}</div>
        </div>
        <div class="chev">▸</div>
      </div>
      <div class="cbody">
        ${nota}${grupos}
        <div class="cfoot">
          ${c.tel ? `<button class="copynum" data-num="${esc(c.tel)}">${esc(c.tel)}</button><a class="wachip" target="_blank" rel="noopener" href="https://wa.me/${c.tel.replace(/\D/g,'')}">WhatsApp</a>` : ''}
          <button data-acc="perfil">✎ Perfil</button>
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
      if (await dbDelete(c.id)) { state.clientes = state.clientes.filter(x => x.id !== c.id); state.abiertos.delete(c.id); render(); }
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
  const numchip = c => c.tel ? `<button class="copynum" data-num="${esc(c.tel)}">${esc(c.tel)}</button><a class="wachip" target="_blank" rel="noopener" href="https://wa.me/${c.tel.replace(/\D/g,'')}">WhatsApp</a>` : '';
  const owner = c => (dir && c.owner_id !== state.me.id) ? `<span class="owner">👤 ${esc(state.perfiles[c.owner_id] || 'agente')}</span>` : '';
  const info = c => `<div class="pl"><span class="pn nmlink" data-perfil="${c.id}">${esc(c.nombre)}</span><span class="badge b-${c.mem}">${c.mem}</span>${c.pais ? `<span class="pais">📍 ${esc(c.pais)}</span>` : ''}${owner(c)}${numchip(c)}</div>`;

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
  construirActividades(c);
  $("overlay").classList.add("open");
}

function construirActividades(c) {
  const items = todos().filter(s => c.acc[s.id]);
  if (!items.length) { $("fActividades").innerHTML = `<div class="pstitle">Fechas de actividades</div><div class="naplica">Aún no ha tomado ningún servicio.</div>`; return; }
  $("fActividades").innerHTML = `<div class="pstitle">Fechas de actividades (edita o vacía para quitar)</div>` +
    items.map(s => `<div class="actrow"><span class="an">${esc(s.n)}</span><input type="date" data-sid="${s.id}" value="${c.acc[s.id]}"></div>`).join("");
}

function cerrarM() {
  $("overlay").classList.remove("open"); state.cliEdit = null;
  ["fNombre", "fPais", "fTel", "fNota", "fCreado", "fComunidad", "fUpgrade"].forEach(i => $(i).value = "");
  $("fMem").innerHTML = opcionesNivel(state.modulo === "leads" ? "Lead" : "Beca");
  $("fActividades").innerHTML = ""; $("btnConvertir").classList.add("hidden");
}

$("abrirModal").onclick = () => {
  state.cliEdit = null;
  $("cliTitulo").textContent = state.modulo === "leads" ? "Nuevo lead" : "Nuevo cliente";
  ["fNombre", "fPais", "fTel", "fNota", "fCreado", "fComunidad", "fUpgrade"].forEach(i => $(i).value = "");
  $("fMem").innerHTML = opcionesNivel(state.modulo === "leads" ? "Lead" : "Beca");
  $("fActividades").innerHTML = ""; $("btnConvertir").classList.add("hidden");
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

  // Duplicados (entre mis contactos): mismo teléfono bloquea, mismo nombre advierte.
  const mios = state.clientes.filter(x => x.owner_id === state.me.id && x.id !== state.cliEdit);
  if (telN) {
    const dupTel = mios.find(x => (x.tel || "").replace(/\D/g, "") === telN);
    if (dupTel) { toast(`⚠ Ese número ya es de ${dupTel.nombre}`); return; }
  }
  const dupNom = mios.find(x => norm(x.nombre) === norm(nombre));
  if (dupNom && !confirm(`Ya tienes un contacto llamado «${dupNom.nombre}». ¿Guardar de todas formas?`)) return;
  const datos = {
    nombre, pais: $("fPais").value.trim(), tel: telN ? "+" + telN : "",
    mem: $("fMem").value, creado: $("fCreado").value || "",
    comunidadDesde: $("fComunidad").value || "", upgradeFecha: $("fUpgrade").value || "",
    nota: $("fNota").value.trim(),
  };
  if (state.cliEdit) {
    const c = state.clientes.find(x => x.id === state.cliEdit);
    Object.assign(c, datos);
    // aplicar fechas de actividades editadas
    $("fActividades").querySelectorAll("input[data-sid]").forEach(inp => {
      const sid = inp.dataset.sid;
      if (inp.value) c.acc[sid] = inp.value; else delete c.acc[sid];
    });
    if (await dbPatch(c, mapAEditar(c))) toast("Perfil actualizado ✓");
  } else {
    const nuevo = await dbInsert({ ...datos, acc: {} });
    if (nuevo) { state.clientes.push(nuevo); toast((datos.mem === "Lead" ? "Lead" : "Cliente") + " agregado ✓"); }
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
