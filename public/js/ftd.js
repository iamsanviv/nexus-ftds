// Bloque de FTD del mes, asistente de metas y cierre mensual.
//
// Vive aparte de ventas.js porque su sitio ya no es el módulo de ventas: el
// bloque se muestra en Personas, que es donde el agente pasa el día. La
// comisión de FTD sigue sumando al encabezado de Ventas.
//
// TRES NÚMEROS que no hay que confundir (ver comisionFtd en state.js):
//   cargados  → los que están en la plataforma
//   reales    → los que el agente dice que lleva (lo que manda)
//   sin subir → su tarea pendiente
import {
  state, $, esc, hoyISO, toast, usd, mesLegible, periodoAntes, periodoDe, estaSaldada,
  comisionFtd, metasDe, progresoMeta, periodoSinCerrar, ftdDelMes, resumenVentas,
} from "./state.js";
import { cargarVentas, guardarFtd, guardarMeta } from "./data.js";

const yo = () => state.me?.id;
const mesActual = () => hoyISO().slice(0, 7);


// Los datos de ventas se cargaban solo al entrar a esa pestaña. Ahora el bloque
// vive en Personas, así que hay que traerlos la primera vez que se pinta.
let cargando = false;
async function asegurarDatos(alTerminar) {
  if (state.ventasOk || cargando) return;
  cargando = true;
  await cargarVentas();
  cargando = false;
  alTerminar();
}

/* ================= BLOQUE EN PERSONAS ================= */
export function renderBloqueFtd() {
  const cont = $("ftdPanel");
  if (!cont) return;

  // Solo en Comunidad: un lead todavía no es un FTD.
  if (state.modulo !== "comunidad") { cont.innerHTML = ""; return; }
  if (!state.ventasOk) {
    cont.innerHTML = "";
    asegurarDatos(renderBloqueFtd);
    return;
  }

  const p = mesActual();
  const f = comisionFtd(p, yo());
  // Dos cosas distintas y separadas a propósito:
  //   g → la meta que se puso, medida SOLO con los FTD del mes (sin base)
  //   f → la comisión, que sí cuenta la base porque para eso se acumula
  const g = progresoMeta(p, yo());
  // La comisión de ventas del mes, solo para el total discreto de la esquina.
  const vent = resumenVentas(p, yo()).causada;

  cont.innerHTML = `
    <div class="metacard ftdcard">
      <div class="fhead">
        <span class="lbl">FTD de ${mesLegible(p)}</span>
        <span class="fpago ${f.pago ? "on" : ""}">${usd(f.pago)}</span>
      </div>

      <div class="fbig"><b>${f.reales}</b><span>FTD este mes</span></div>

      <div class="fsub">
        <span><b>${f.cargados}</b> cargados</span>
        ${f.sinSubir ? `<button class="chipsub" id="ftdSinSubir">↑ ${f.sinSubir} sin subir</button>` : ""}
      </div>

      <div class="barrawrap">
        <div class="barra dos ${g.cumplida ? "full" : ""}">
          <u style="width:${g.pctCargados}%"></u><i style="width:${g.pct}%"></i>
        </div>
        <span class="metafin">${g.meta || "—"}</span>
      </div>

      <div class="fpie">
        ${g.meta
          ? (g.cumplida
              ? `<span class="ok">✓ Cumpliste tu meta de
                   <button class="metalink" id="ftdMeta">${g.meta}</button></span>`
              : `Te faltan <b>${g.faltan}</b> para ${g.propia ? "tu meta" : "la meta"} de
                   <button class="metalink" id="ftdMeta">${g.meta}</button>`)
          : `<button class="metalink" id="ftdMeta">Ponte una meta</button>`}
        <button class="ftdajuste" id="ftdAjustar">${f.declaro ? "Ajustar" : "Poner mis números"}</button>
      </div>

      ${f.base ? `<div class="fcom">Aparte, tus <b>${f.base}</b> de base suman
        <b>${f.efectivos}</b> para la comisión${f.meta ? `: pagan ${usd(f.pago)}` : ""}.
        <span>No cuentan para tu meta del mes.</span></div>` : ""}


      <div class="totalmes">Total del mes con ventas (${usd(vent)}) · <b>${usd(f.pago + vent)}</b></div>
      <div class="fmeses"><button class="metalink" id="ftdMeses">📅 Ver meses anteriores</button></div>
    </div>`;

  const chip = $("ftdSinSubir");
  if (chip) chip.onclick = () => toast(
    `Llevas ${f.reales} FTD pero solo ${f.cargados} están cargados. Sube los ${f.sinSubir} que faltan cuando puedas.`);
  $("ftdAjustar").onclick = () => abrirAsistente("ajuste");
  // La meta es tocable: el asistente promete que se puede cambiar cuando sea, y
  // "Ajustar" solo abre los números del mes.
  $("ftdMeta").onclick = () => abrirAsistente("metas");
  $("ftdMeses").onclick = () => abrirResumen();

  // Momento natural para el ritual: el agente acaba de llegar a Personas.
  revisarRituales();
}

// Lo que paga una meta cualquiera: la mayor meta REAL que ese número alcanza.
// No puede ser coincidencia exacta — desde que la meta se elige con deslizador,
// un 70 no está en la tabla y habría mostrado $0.
const pagoDeMeta = n => {
  const alc = [...state.metasFtd].reverse().find(m => n >= m.ftd);
  return alc ? Number(alc.pago) : 0;
};

/* ================= RESUMEN DE MESES ANTERIORES ================= */
// El panel solo hablaba del mes en curso: al pasar el mes, lo que uno hizo
// desaparecía de la vista aunque los datos siguieran ahí. Esto es la puerta
// para consultarlos.
//
// No guarda nada nuevo: todo se recalcula con las mismas funciones del mes
// vivo (`comisionFtd`, `progresoMeta`, `resumenVentas`). Un resumen congelado
// sería una segunda verdad que se separa de los datos en cuanto se corrija un
// abono con fecha vieja.

// Meses con algo que mostrar: donde declaró FTD o donde entró plata. El mes en
// curso NO va — ese ya está arriba, en la tarjeta.
function periodosConDatos() {
  const hoy = mesActual();
  const ps = new Set();
  for (const k of Object.keys(state.ftdBase)) {
    const [owner, periodo] = k.split("|");
    if (owner === yo() && periodo < hoy) ps.add(periodo);
  }
  for (const v of state.ventas) {
    if (v.owner_id !== yo()) continue;
    for (const a of v.abonos || []) {
      const p = periodoDe(a.fecha);
      if (p && p < hoy) ps.add(p);
    }
  }
  return [...ps].sort().reverse();
}

let resMes = null;   // periodo elegido en el panel

export function abrirResumen(periodo) {
  const ps = periodosConDatos();
  if (!ps.length) { toast("Todavía no hay meses anteriores que mostrar"); return; }
  resMes = periodo && ps.includes(periodo) ? periodo : ps[0];
  $("ftdOverlay").classList.add("open");
  pintarResumen(ps);
}

function pintarResumen(ps) {
  const p = resMes;
  const f = comisionFtd(p, yo());
  const g = progresoMeta(p, yo());
  const v = resumenVentas(p, yo());
  const metas = metasDe(p, yo());
  const total = f.pago + v.causada;
  const cerrado = f.cerrado;

  // Cuántas ventas se saldaron ese mes: es el número que la gente busca cuando
  // pregunta «¿cuántas cerré?».
  const cerradas = state.ventas.filter(x =>
    x.owner_id === yo() && estaSaldada(x) &&
    periodoDe([...(x.abonos || [])].sort((a, b) => a.fecha.localeCompare(b.fecha)).at(-1)?.fecha) === p
  ).length;

  const dato = (etq, val, sub) =>
    `<div class="rsdato"><span class="rl">${etq}</span><b>${val}</b>${
      sub ? `<span class="rs">${sub}</span>` : ""}</div>`;

  $("ftdModal").innerHTML = `
    <div class="asis">
      ${cabeza("Resumen", mesLegible(p),
        cerrado ? "Mes cerrado — estas cifras ya no cambian."
                : "Mes sin cerrar: las cifras todavía se pueden mover.")}
      <div class="abody">
        <div class="rschips">${ps.map(x =>
          `<button class="pill ${x === p ? "on" : ""}" data-resmes="${x}">${mesLegible(x)}</button>`).join("")}</div>

        <div class="rstot">
          <span class="rl">Comisión total de ${mesLegible(p)}</span>
          <b class="${total ? "on" : ""}">${usd(total)}</b>
        </div>

        <div class="pstitle">FTD</div>
        <div class="rsgrid">
          ${dato("Reales", f.reales, `${f.cargados} cargados`)}
          ${dato("Base que traía", f.base, f.base ? "de meses anteriores" : "")}
          ${dato("Efectivos", f.efectivos, "reales + base")}
          ${dato("Comisión", usd(f.pago), f.meta ? `meta de ${f.meta}` : "no alcanzó meta")}
        </div>
        ${metas?.metaFtd
          ? `<div class="ayuda">Tu meta era de <b>${metas.metaFtd}</b> FTD del mes (sin contar base)
             y ${g.cumplida ? "<b>la cumpliste</b> ✓" : `llegaste a <b>${f.reales}</b>`}.</div>`
          : `<div class="ayuda">Ese mes no te pusiste meta.</div>`}

        <div class="pstitle">Ventas</div>
        <div class="rsgrid">
          ${dato("Recaudado", usd(v.facturado), "abonos que entraron")}
          ${dato("Ventas saldadas", cerradas, "quedaron pagas")}
          ${dato("Comisión", usd(v.causada), "de lo saldado")}
        </div>

        <div class="ayuda">Las cifras se recalculan cada vez que abres esto, así que
          si corriges un abono con fecha de ${mesLegible(p)}, este resumen lo refleja.</div>
        <button class="abtn quiet" id="rsCerrar">Cerrar</button>
      </div>
    </div>`;

  $("ftdModal").querySelectorAll("[data-resmes]").forEach(b => b.onclick = () => {
    resMes = b.dataset.resmes;
    pintarResumen(ps);
  });
  $("rsCerrar").onclick = () => $("ftdOverlay").classList.remove("open");
}

/* ================= ASISTENTE ================= */
// Un solo overlay con pasos. `modo`:
//   inicio → primera vez en el sistema (declara dónde va + metas)
//   cierre → día 1: cierra el mes anterior y abre el nuevo
//   ajuste → solo corregir los números del mes en curso
let asis = null;

export function abrirAsistente(modo) {
  const p = mesActual();
  const f = comisionFtd(p, yo());
  const cerrar = periodoSinCerrar(yo());
  const metas = metasDe(p, yo());

  asis = {
    modo, paso: 0, periodo: p,
    // Al cerrar se trabaja sobre el mes anterior.
    periodoCierre: cerrar,
    declarado: f.declaro ? f.reales : f.cargados,
    base: f.base,
    // La base se escribe a mano SOLO para arrancar. Si ya hubo un mes cerrado,
    // la calculó el cierre y no se toca.
    baseManual: !haCerradoAlguno(),
    finalMes: cerrar ? Math.max(comisionFtd(cerrar, yo()).reales, 0) : 0,
    metaFtd: metas?.metaFtd || (state.metasFtd[0]?.ftd ?? 45),
    metaVentas: metas?.metaVentas || 0,
  };
  $("ftdOverlay").classList.add("open");
  pintarPaso();
}

const haCerradoAlguno = () =>
  Object.entries(state.ftdBase).some(([k, v]) => k.startsWith(yo() + "|") && v.cerrado);

function pasos() {
  if (asis.modo === "ajuste") return ["numeros"];      // solo los FTD del mes
  if (asis.modo === "metas")  return ["metas", "total"];  // solo lo que se propone
  if (asis.modo === "cierre") return ["cierre", "metas", "total"];
  return ["numeros", "metas", "total"];
}

function pintarPaso() {
  const ps = pasos();
  const cual = ps[asis.paso];
  const n = ps.length;
  const puntos = n > 1
    ? `<div class="puntos">${ps.map((_, i) => `<i class="${i === asis.paso ? "on" : ""}"></i>`).join("")}</div>`
    : "";
  $("ftdModal").innerHTML = (
    cual === "numeros" ? pasoNumeros() :
    cual === "cierre"  ? pasoCierre()  :
    cual === "metas"   ? pasoMetas()   : pasoTotal()) + puntos;
  engancharPaso(cual);
}

function pasoNumeros() {
  const f = comisionFtd(asis.periodo, yo());
  return `
    <div class="asis">
      ${cabeza(asis.modo === "ajuste" ? "" : `Paso 1 de ${pasos().length}`,
               "¿Cuántos FTD llevas de verdad?",
               `Tengo <b>${f.cargados}</b> cargados en ${mesLegible(asis.periodo)}. Si el número real es otro, corrígelo.`)}
      <div class="abody">
        <div class="frow"><label>FTD reales de este mes</label>
          <input id="asDeclarado" type="number" min="0" step="1" value="${asis.declarado}" inputmode="numeric">
        </div>
        ${asis.baseManual ? `
        <div class="frow"><label>Base que traes de antes</label>
          <input id="asBase" type="number" min="0" step="1" value="${asis.base}" inputmode="numeric">
          <div class="ayuda">Los FTD que te sobraron de meses anteriores y no se pagaron.
            <b>Solo se pregunta esta vez</b>: de aquí en adelante la calcula el sistema al cerrar cada mes.</div>
        </div>` : `
        <div class="ayuda">Traes <b>${asis.base}</b> de base, calculada al cerrar ${mesLegible(periodoAntes(asis.periodo))}.</div>`}
        <div id="asEco" class="eco"></div>
        <button class="abtn" id="asSeguir">${asis.modo === "ajuste" ? "Guardar" : "Seguir"}</button>
        ${asis.modo === "ajuste" ? "" : `<button class="abtn quiet" id="asSaltar">Ahora no</button>`}
      </div>
    </div>`;
}

function pasoCierre() {
  const f = comisionFtd(asis.periodoCierre, yo());
  return `
    <div class="asis">
      ${cabeza(`Cierre de ${mesLegible(asis.periodoCierre)}`,
               `¿Con cuántos FTD terminaste ${mesLegible(asis.periodoCierre)}?`,
               `Tengo <b>${f.cargados}</b> cargados. Si el número real es otro, corrígelo.`)}
      <div class="abody">
        <div class="frow"><label>FTD de ${mesLegible(asis.periodoCierre)}</label>
          <input id="asFinal" type="number" min="0" step="1" value="${asis.finalMes}" inputmode="numeric">
        </div>
        <div id="asEco" class="eco"></div>
        <button class="abtn" id="asSeguir">Cerrar ${mesLegible(asis.periodoCierre).split(" ")[0]} y seguir</button>
        <button class="abtn quiet" id="asSaltar">Ahora no, recuérdamelo mañana</button>
      </div>
    </div>`;
}

// Tope del deslizador: la meta más alta que paga. Más arriba no cambia nada.
const topeMeta = () => state.metasFtd.length
  ? Math.max(...state.metasFtd.map(m => m.ftd)) : 150;

// Lo que pagaría cumplir una meta de `n` FTD.
//
// La META es solo del mes (sin base, por eso el agente se la puso). La
// COMISIÓN sí cuenta la base, porque para eso se acumula. Son dos cuentas
// distintas sobre el mismo número y hay que decirlo, o el agente ve una cifra
// que no le cuadra con la tabla de metas.
function pagoDeLaMeta(n) {
  const base = asis ? asis.base || 0 : 0;
  const efectivos = n + base;
  const alc = [...state.metasFtd].reverse().find(m => efectivos >= m.ftd) || null;
  const sig = state.metasFtd.find(m => m.ftd > efectivos) || null;
  return { base, efectivos, pago: alc ? Number(alc.pago) : 0, meta: alc ? alc.ftd : 0, sig };
}

// Qué significa el número elegido, en plata. Se actualiza al arrastrar.
function textoMeta(n) {
  const p = pagoDeLaMeta(n);
  const conBase = p.base ? `<b>${n}</b> + <b>${p.base}</b> de base = <b>${p.efectivos}</b>` : `<b>${n}</b> FTD`;
  if (!p.pago) return `${conBase} · todavía no paga${
    p.sig ? `; la primera meta es ${p.sig.ftd} (${usd(p.sig.pago)})` : ""}`;
  return `${conBase} · paga <b>${usd(p.pago)}</b>${
    p.efectivos === p.meta ? "" : ` (la meta de ${p.meta})`}`;
}

function pasoMetas() {
  const tope = topeMeta();
  const atajos = state.metasFtd.map(m =>
    `<button class="atajo ${m.ftd === asis.metaFtd ? "on" : ""}" data-ftd="${m.ftd}">${m.ftd}</button>`).join("");
  return `
    <div class="asis">
      ${cabeza(`Paso ${asis.paso + 1} de ${pasos().length}`, "¿Qué te propones este mes?",
               "Dos números. El tercero lo saco yo.")}
      <div class="abody">
        <div class="frow"><label>Meta de FTD</label>
          <div class="atajos">${atajos}</div>
          <div class="metaslider">
            <input type="range" id="asMetaRange" min="1" max="${tope}"
                   value="${Math.min(asis.metaFtd, tope)}" step="1"
                   aria-label="Meta de FTD del mes">
            <div class="slval" id="asMetaVal"></div>
          </div>
        </div>
        <div class="frow"><label>Meta de comisión por ventas (USD)</label>
          <input id="asMetaVentas" type="number" min="0" step="10" value="${asis.metaVentas || ""}"
                 placeholder="0" inputmode="decimal">
          <div class="ayuda">Lo que te quieres ganar en comisiones de venta durante el mes.</div>
        </div>
        <button class="abtn" id="asSeguir">Seguir</button>
      </div>
    </div>`;
}

function pasoTotal() {
  const p = pagoDeLaMeta(asis.metaFtd);
  const pago = p.pago;
  const total = pago + Number(asis.metaVentas || 0);
  return `
    <div class="asis">
      ${cabeza(`Paso ${asis.paso + 1} de ${pasos().length}`, "Tu mes, en un número",
               "Con lo que acabas de decirme.")}
      <div class="abody">
        <div class="desglose">
          <div><span>Meta de ${asis.metaFtd} FTD</span><b>${pago ? usd(pago) : "no paga"}</b></div>
          ${p.base ? `<div class="conbase"><span>con tus ${p.base} de base son
            <b>${p.efectivos}</b> para la comisión</span></div>` : ""}
          <div><span>Meta de comisión por ventas</span><b>${usd(asis.metaVentas || 0)}</b></div>
        </div>
        <div class="totalcard">
          <div class="t">Si cumples las dos</div>
          <div class="n">${usd(total)}</div>
          <div class="d">es tu meta de comisión total de ${mesLegible(asis.periodo)}</div>
        </div>
        ${p.base ? `<div class="ayuda">Ojo: tu meta sigue siendo de
          <b>${asis.metaFtd} FTD este mes</b>. La base solo suma para calcular la comisión.</div>` : ""}
        <div class="ayuda">Para cambiarlas, toca la meta en la tarjeta de FTD (Personas)
          o en la de comisión por ventas.</div>
        <button class="abtn" id="asSeguir">${asis.modo === "inicio" ? "Empezar" : "Guardar metas"}</button>
      </div>
    </div>`;
}

const cabeza = (paso, titulo, sub) => `
  <div class="ahead">
    ${paso ? `<div class="apaso">${esc(paso)}</div>` : ""}
    <h4>${esc(titulo)}</h4>
    <div class="asd">${sub}</div>
  </div>`;

function engancharPaso(cual) {
  const eco = () => {
    const e = $("asEco");
    if (!e) return;
    if (cual === "numeros") {
      const d = Number($("asDeclarado").value) || 0;
      const b = $("asBase") ? Number($("asBase").value) || 0 : asis.base;
      const cargados = ftdDelMes(asis.periodo, yo());
      const falta = Math.max(0, d - cargados);
      // Se dicen por separado: los del mes son los que cuentan para la meta;
      // la base solo suma para la comisión.
      e.innerHTML = `<b>${d}</b> FTD este mes${
        falta ? ` · <b>${falta}</b> por subir a la plataforma` : " · todo cargado ✓"}${
        b ? `<br>Con tus <b>${b}</b> de base sumas <b>${d + b}</b> para la comisión.` : ""}`;
    } else if (cual === "cierre") {
      const d = Number($("asFinal").value) || 0;
      const b = state.ftdBase[`${yo()}|${asis.periodoCierre}`]?.base || 0;
      const ef = d + b;
      const alc = [...state.metasFtd].reverse().find(m => ef >= m.ftd);
      e.innerHTML = alc
        ? `Alcanzas la meta de <b>${alc.ftd}</b>: se pagan <b>${usd(alc.pago)}</b>, y <b>${ef - alc.ftd}</b> pasan de base.`
        : `No alcanzas la primera meta (${state.metasFtd[0]?.ftd ?? "—"}). Los <b>${ef}</b> pasan completos de base.`;
    }
  };
  ["asDeclarado", "asBase", "asFinal"].forEach(id => { if ($(id)) $(id).oninput = eco; });
  eco();

  // Deslizador y atajos son la misma cifra por dos caminos. Al arrastrar NO se
  // vuelve a pintar el paso: eso mataría el arrastre a mitad de gesto. Solo se
  // refresca la lectura y qué atajo queda marcado.
  const range = $("asMetaRange");
  if (range) {
    const refrescar = () => {
      asis.metaFtd = Number(range.value);
      $("asMetaVal").innerHTML = textoMeta(asis.metaFtd);
      range.style.setProperty("--pct", (asis.metaFtd / Number(range.max) * 100) + "%");
      $("ftdModal").querySelectorAll(".atajo").forEach(b =>
        b.classList.toggle("on", Number(b.dataset.ftd) === asis.metaFtd));
    };
    range.oninput = refrescar;
    $("ftdModal").querySelectorAll(".atajo").forEach(b => b.onclick = () => {
      range.value = b.dataset.ftd;
      refrescar();
    });
    refrescar();
  }

  if ($("asSaltar")) $("asSaltar").onclick = cerrarAsistente;
  $("asSeguir").onclick = () => avanzar(cual);
}

async function avanzar(cual) {
  const btn = $("asSeguir");
  btn.disabled = true;
  try {
    if (cual === "numeros") {
      asis.declarado = Number($("asDeclarado").value) || 0;
      if ($("asBase")) asis.base = Number($("asBase").value) || 0;
      const ok = await guardarFtd(yo(), asis.periodo,
        { base: asis.base, declarado: asis.declarado, declarado_en: new Date().toISOString() });
      if (!ok) return;
      if (asis.modo === "ajuste") { cerrarAsistente(); return refrescar(); }
    }

    if (cual === "cierre") {
      const d = Number($("asFinal").value) || 0;
      const b = state.ftdBase[`${yo()}|${asis.periodoCierre}`]?.base || 0;
      const ef = d + b;
      const alc = [...state.metasFtd].reverse().find(m => ef >= m.ftd);
      // Congelar el mes que se cierra…
      if (!(await guardarFtd(yo(), asis.periodoCierre,
            { base: b, declarado: d, declarado_en: new Date().toISOString(), cerrado: true }))) return;
      // …y sembrar la base del mes nuevo. De aquí en adelante nadie la escribe a mano.
      const sobra = ef - (alc ? alc.ftd : 0);
      if (!(await guardarFtd(yo(), asis.periodo, { base: sobra }))) return;
      asis.base = sobra;
      toast(alc ? `${mesLegible(asis.periodoCierre)} cerrado: ${usd(alc.pago)}` : `${mesLegible(asis.periodoCierre)} cerrado`);
    }

    if (cual === "metas") {
      asis.metaVentas = Number($("asMetaVentas").value) || 0;
    }

    if (cual === "total") {
      if (!(await guardarMeta(yo(), asis.periodo, asis.metaFtd, asis.metaVentas))) return;
      toast("Metas guardadas ✓");
      cerrarAsistente();
      return refrescar();
    }

    asis.paso++;
    pintarPaso();
  } finally {
    if ($("asSeguir")) $("asSeguir").disabled = false;
  }
}

function cerrarAsistente() {
  $("ftdOverlay").classList.remove("open");
  asis = null;
}
$("ftdOverlay").onclick = e => { if (e.target.id === "ftdOverlay") cerrarAsistente(); };

async function refrescar() {
  renderBloqueFtd();
  const { render } = await import("./ui.js");
  render();
}

/* ================= DISPARADORES ================= */
// El ritual del día 1 y el alta inicial. Se revisa al arrancar la app, una vez.
let yaRevisado = false;
export async function revisarRituales() {
  if (yaRevisado) return;
  yaRevisado = true;
  await asegurarDatos(() => {});
  if (!state.ventasOk) return;

  const pendiente = periodoSinCerrar(yo());
  if (pendiente) return abrirAsistente("cierre");

  // Primera vez: no ha declarado nada ni tiene metas puestas.
  const f = comisionFtd(mesActual(), yo());
  if (!f.declaro && !metasDe(mesActual(), yo()) && f.cargados > 0) abrirAsistente("inicio");
}

/* ================= CASILLA AL CREAR UN CLIENTE ================= */
// Solo aparece mientras haya FTD sin subir. Si no debes ninguno, no la ves.
export function pintarCasillaFtd() {
  const row = $("ftdChkRow");
  if (!row) return;
  const f = state.ventasOk ? comisionFtd(mesActual(), yo()) : null;
  const aplica = !!f && f.sinSubir > 0 && !state.cliEdit;
  row.classList.toggle("hidden", !aplica);
  if (!aplica) return;
  row.innerHTML = `
    <label class="chkline"><input type="checkbox" id="fFtdContado" checked>
      Es uno de los ${f.sinSubir} que ya conté</label>
    <div class="ayuda">Déjala marcada si este cliente ya estaba en tus ${f.reales}.
      Quítala si es un FTD <b>nuevo</b>, aparte de los que declaraste.</div>`;
}

// Al guardar un cliente nuevo: si la casilla quedó DESMARCADA, es un FTD que no
// estaba en lo declarado, así que sube el declarado en 1. Si quedó marcada no
// hay nada que hacer: `cargados` sube solo y «sin subir» baja.
export async function trasCrearCliente(nuevo) {
  const chk = $("fFtdContado");
  if (!chk || chk.checked) return;
  if (!state.ventasOk || nuevo.mem === "Lead") return;
  const p = mesActual();
  if ((nuevo.comunidadDesde || "").slice(0, 7) !== p) return;
  const f = comisionFtd(p, yo());
  await guardarFtd(yo(), p, { base: f.base, declarado: f.reales + 1 });
}
