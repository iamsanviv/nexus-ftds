// Pestaña «Plantillas» de Leads: las plantillas de seguimiento propias y las
// públicas de otros usuarios, para encontrar una buena antes de enviar.
//
// Decisiones del usuario (21/10/2026): pestaña dentro de Leads; aquí se ve,
// se usa, se copia y se publica, pero se escribe en un solo lugar (el modal de
// envío), para no mantener dos editores; las más usadas primero, con chips por
// tipo y buscador.
//
// El uso sale de `uso_plantillas_lead()` (solo conteos: las campañas de otros
// no se leen) y el autor de `autores_plantillas_publicas()`.
import { SB } from "./supabase.js";
import { state, esc, toast, normBusqueda } from "./state.js";
import { TIPOS, nombreTipo } from "./leads.js";

let datos = null;            // { plantillas, uso, autores } o null mientras carga
let cargando = null;
let fTipo = "todos", q = "";

async function cargar() {
  const [pl, uso, au] = await Promise.all([
    SB.from("plantillas_lead")
      .select("id, owner_id, publica, nombre, tipo, mensajes, modo, espera_min, escalona, actualizado_en")
      .order("actualizado_en", { ascending: false }),
    SB.rpc("uso_plantillas_lead"),
    SB.rpc("autores_plantillas_publicas"),
  ]);
  if (pl.error) throw pl.error;
  datos = {
    plantillas: pl.data || [],
    uso: Object.fromEntries((uso.data || []).map(u => [u.plantilla_id, u])),
    autores: Object.fromEntries((au.data || []).map(a => [a.id, a.nombre])),
  };
}

const esMia = p => p.owner_id === state.me.id;
const usoDe = p => datos.uso[p.id] || { agentes: 0, leads: 0 };
// Más usadas primero; a igual uso, la más reciente.
const porUso = (a, b) => usoDe(b).leads - usoDe(a).leads || usoDe(b).agentes - usoDe(a).agentes
  || String(b.actualizado_en).localeCompare(String(a.actualizado_en));

function usoTxt(p) {
  const u = usoDe(p);
  if (!u.leads) return "Aún sin envíos";
  return `Usada por ${u.agentes} usuario${u.agentes === 1 ? "" : "s"} · ${u.leads} lead${u.leads === 1 ? "" : "s"}`;
}
const esVideo = u => /\.(mp4|mov)(\?|$)/i.test(u || "");

function tarjeta(p) {
  const mia = esMia(p);
  const msgs = p.mensajes || [];
  return `
  <article class="plcard" data-id="${p.id}">
    <div class="plhd">
      <b class="plnom">${esc(p.nombre)}</b>
      <span class="pltipo">${esc(nombreTipo(p.tipo))}</span>
    </div>
    <div class="plmeta">
      ${mia ? (p.publica ? `<span class="plpub">Pública</span>` : `<span>Solo tú</span>`)
            : `<span>de <b>${esc(datos.autores[p.owner_id] || "otro usuario")}</b></span>`}
      <span class="pluso">${usoTxt(p)}</span>
      ${msgs.length > 1 ? `<span>${msgs.length} mensajes</span>` : ""}
    </div>
    <ol class="plmsgs">${msgs.map(m => `
      <li>${m.texto ? `<span class="pltxt">${esc(m.texto)}</span>` : ""}${
        m.media ? `<span class="pladj">${esVideo(m.media) ? "🎬 Video" : "🖼 Imagen"}</span>` : ""}</li>`).join("")}
    </ol>
    <div class="placc">
      <button type="button" class="plusar" data-pl="usar">Usar</button>
      ${mia
        ? `<label class="segtoggle"><input type="checkbox" data-pl="publica" ${p.publica ? "checked" : ""}> Pública</label>`
        : `<button type="button" class="lbtn" data-pl="copiar">Copiar a mis plantillas</button>`}
    </div>
  </article>`;
}

function seccion(titulo, lista, vacio) {
  return `<section class="plsec">
    <h3 class="paneh">${titulo}<span class="cnt">${lista.length || ""}</span><span class="rule"></span></h3>
    ${lista.length ? `<div class="plgrid">${lista.map(tarjeta).join("")}</div>` : `<div class="naplica">${vacio}</div>`}
  </section>`;
}

export function renderPlantillas(cont, render) {
  if (!datos) {
    cont.innerHTML = `<div class="naplica">Cargando plantillas…</div>`;
    cargando ||= cargar().then(() => renderPlantillas(cont, render))
      .catch(e => { cont.innerHTML = `<div class="naplica">⚠ No se pudieron cargar las plantillas: ${esc(e.message)}</div>`; })
      .finally(() => { cargando = null; });
    return;
  }
  const qn = normBusqueda(q);
  const pasa = p => (fTipo === "todos" || p.tipo === fTipo)
    && (!qn || normBusqueda(`${p.nombre} ${(p.mensajes || []).map(m => m.texto || "").join(" ")}`).includes(qn));
  const todas = datos.plantillas;
  const mias = todas.filter(p => esMia(p) && pasa(p)).sort(porUso);
  const otras = todas.filter(p => !esMia(p) && pasa(p)).sort(porUso);
  // Solo los tipos que existen: un chip que filtra a cero es ruido.
  const tipos = TIPOS.filter(([k]) => todas.some(p => p.tipo === k));
  const filtrando = fTipo !== "todos" || qn;

  cont.innerHTML = `
    <div class="plfiltros">
      <input class="buscar" id="plBuscar" placeholder="Buscar plantilla o texto…" value="${esc(q)}" autocomplete="off">
      <div class="lchips">${[["todos", "Todos los tipos"], ...tipos].map(([k, n]) =>
        `<button type="button" class="lchip ${fTipo === k ? "on" : ""}" data-tp="${k}">${esc(n)}</button>`).join("")}</div>
    </div>
    ${seccion("Mis plantillas", mias, filtrando ? "Ninguna tuya con este filtro."
      : "Aún no tienes plantillas. Créalas desde «Enviar seguimiento» con «Guardar como plantilla».")}
    ${seccion("Públicas de otros", otras, filtrando ? "Ninguna pública con este filtro."
      : "Nadie ha publicado plantillas todavía. Marca una tuya como «Pública» para compartirla.")}`;

  const inp = cont.querySelector("#plBuscar");
  inp.oninput = () => {
    q = inp.value;
    const pos = inp.selectionStart;
    renderPlantillas(cont, render);
    // Re-pintar reemplaza el input: se devuelve el foco para seguir escribiendo.
    const n = cont.querySelector("#plBuscar"); n.focus(); n.setSelectionRange(pos, pos);
  };
  cont.querySelectorAll("[data-tp]").forEach(b => b.onclick = () => { fTipo = b.dataset.tp; renderPlantillas(cont, render); });

  cont.querySelectorAll(".plcard").forEach(card => {
    const p = todas.find(x => x.id === card.dataset.id);
    card.querySelector('[data-pl="usar"]').onclick = async () => {
      // Al cerrar el envío se recarga: si salió, cambió el conteo de uso.
      (await import("./envioleads.js")).abrirEnvioLeads(() => { datos = null; render(); }, { plantillaId: p.id });
    };
    const cp = card.querySelector('[data-pl="copiar"]');
    if (cp) cp.onclick = async () => {
      cp.disabled = true;
      // La copia nace privada: publicarla es decisión de su nuevo dueño.
      const { error } = await SB.from("plantillas_lead").insert({
        nombre: p.nombre, tipo: p.tipo, mensajes: p.mensajes, modo: p.modo,
        espera_min: p.espera_min || 0, escalona: !!p.escalona, publica: false,
      });
      if (error) { cp.disabled = false; toast("⚠ " + error.message); return; }
      toast(`✓ «${p.nombre}» copiada a tus plantillas`);
      datos = null; renderPlantillas(cont, render);
    };
    const pub = card.querySelector('[data-pl="publica"]');
    if (pub) pub.onchange = async () => {
      const v = pub.checked;
      const { error } = await SB.from("plantillas_lead").update({ publica: v }).eq("id", p.id);
      if (error) { pub.checked = !v; toast("⚠ " + error.message); return; }
      p.publica = v;
      toast(v ? `✓ «${p.nombre}» ahora es pública` : `✓ «${p.nombre}» vuelve a ser solo tuya`);
      renderPlantillas(cont, render);
    };
  });
}
