// Estadísticas: resumen, evolución mensual y distribución por membresía.
// Se abre como modal (patrón overlay, igual que catálogo y perfil).
// Consume las vistas v_stats_* (security_invoker => respetan RLS).
import { SB } from "./supabase.js";
import { state, $, toast } from "./state.js";

const COLOR_MEM = { Beca: "var(--beca)", VIP: "var(--vip)", Platino: "var(--plat)", Oro: "var(--oro)" };

async function cargarStats() {
  const [resumen, mensual, membresia] = await Promise.all([
    SB.from("v_stats_resumen").select("*").single(),
    SB.from("v_stats_mensual").select("*").limit(12),
    SB.from("v_stats_membresia").select("*"),
  ]);
  const err = resumen.error || mensual.error || membresia.error;
  if (err) { toast("⚠ Error cargando estadísticas: " + err.message); return null; }
  return {
    resumen: resumen.data,
    mensual: (mensual.data || []).slice().reverse(), // cronológico para la gráfica
    membresia: membresia.data || [],
  };
}

function tarjetasHTML(r) {
  const t = [
    [r.total_clientes ?? 0, "Clientes"],
    [r.total_leads ?? 0, "Leads"],
    [r.total_upgrades ?? 0, "Upgrades"],
    [(r.tasa_upgrade_pct ?? 0) + "%", "Tasa upgrade"],
  ];
  const dias = r.dias_promedio_a_upgrade;
  return `<div class="stats">${t.map(([n, l]) =>
    `<div class="stat"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
    ${dias != null ? `<div class="stx-dato">⏱ Un cliente tarda en promedio <b>${dias} días</b> desde que entra a la Comunidad hasta su upgrade.</div>` : ""}`;
}

function mensualHTML(filas) {
  if (!filas.length) return `<div class="naplica">Aún no hay historial mensual.</div>`;
  const W = 640, H = 200, padX = 30, padY = 26;
  const max = Math.max(...filas.map(f => Math.max(f.nuevos_clientes, f.nuevos_leads)), 1);
  const bw = (W - padX * 2) / filas.length;
  const barras = filas.map((f, i) => {
    const x = padX + i * bw;
    const h = v => ((H - padY * 2) * v) / max;
    return `
      <rect x="${x + bw * 0.12}" y="${H - padY - h(f.nuevos_clientes)}" width="${bw * 0.24}" height="${h(f.nuevos_clientes)}" fill="var(--gold)" rx="2"><title>${f.mes}: ${f.nuevos_clientes} clientes</title></rect>
      <rect x="${x + bw * 0.40}" y="${H - padY - h(f.nuevos_leads)}" width="${bw * 0.24}" height="${h(f.nuevos_leads)}" fill="var(--lead)" rx="2"><title>${f.mes}: ${f.nuevos_leads} leads</title></rect>
      <rect x="${x + bw * 0.68}" y="${H - padY - h(f.upgrades_mismo_mes)}" width="${bw * 0.24}" height="${h(f.upgrades_mismo_mes)}" fill="var(--ok)" rx="2"><title>${f.mes}: ${f.upgrades_mismo_mes} upgrades</title></rect>
      <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--muted)">${f.mes.slice(2)}</text>`;
  }).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block" role="img" aria-label="Evolución mensual">
      <line x1="${padX}" y1="${H - padY}" x2="${W - padX}" y2="${H - padY}" stroke="var(--border)"/>
      ${barras}
    </svg>
    <div class="stx-leyenda">
      <span><i style="background:var(--gold)"></i>Clientes</span>
      <span><i style="background:var(--lead)"></i>Leads</span>
      <span><i style="background:var(--ok)"></i>Upgrades</span>
    </div>`;
}

function membresiaHTML(filas) {
  if (!filas.length) return `<div class="naplica">Sin clientes de Comunidad todavía.</div>`;
  const total = filas.reduce((s, f) => s + f.cantidad, 0);
  return filas.map(f => {
    const pct = total ? Math.round(100 * f.cantidad / total) : 0;
    const color = COLOR_MEM[f.membresia] || "var(--muted)";
    return `<div class="stx-tier">
      <span class="badge b-${f.membresia}">${f.membresia}</span>
      <div class="stx-barra"><i style="width:${pct}%;background:${color}"></i></div>
      <span class="stx-num">${f.cantidad} (${pct}%)</span>
    </div>`;
  }).join("");
}

function inactivosHTML() {
  const hoy = new Date();
  const filas = state.clientes
    .filter(c => c.mem !== "Lead")
    .map(c => {
      const fechas = Object.values(c.acc || {}).filter(Boolean).sort();
      const ultima = fechas[fechas.length - 1] || null;
      const dias = ultima ? Math.floor((hoy - new Date(ultima)) / 86400000) : null;
      return { c, ultima, dias };
    })
    .filter(x => x.dias === null || x.dias >= 21)   // 3+ semanas sin actividad
    .sort((a, b) => (b.dias ?? 9999) - (a.dias ?? 9999));

  if (!filas.length) return `<div class="naplica">🎉 Nadie lleva más de 3 semanas inactivo.</div>`;

  return filas.map(({ c, ultima, dias }) => `
    <div class="stx-tier">
      <span class="badge b-${c.mem}">${c.mem}</span>
      <span style="font-size:.88rem">${c.nombre}</span>
      <span class="stx-num" style="color:var(--bad)">${
        ultima ? `hace ${dias} días` : "sin actividad"
      }</span>
    </div>`).join("");
}

async function abrirStats() {
  const box = $("statsBody");
  box.innerHTML = `<div class="naplica">Cargando…</div>`;
  $("statsOverlay").classList.add("open");
  const d = await cargarStats();
  if (!d) { box.innerHTML = `<div class="naplica">No se pudieron cargar los datos.</div>`; return; }
  box.innerHTML =
    tarjetasHTML(d.resumen) +
    `<div class="pstitle">⚠ Sin actividad reciente (3+ semanas)</div>` + inactivosHTML() +
    `<div class="pstitle">Evolución mensual</div>` + mensualHTML(d.mensual) +
    `<div class="pstitle">Distribución por membresía</div>` + membresiaHTML(d.membresia) +
    (state.me.role === "director"
      ? `<div class="stx-dato">Vista de director: estos números incluyen a todos los agentes.</div>`
      : `<div class="stx-dato">Estos números corresponden solo a tus clientes.</div>`);
}

/* ---------- wiring (se ejecuta al importar, como csv.js) ---------- */
$("btnStats").onclick = abrirStats;
$("statsCerrar").onclick = () => $("statsOverlay").classList.remove("open");
$("statsOverlay").onclick = e => { if (e.target.id === "statsOverlay") $("statsOverlay").classList.remove("open"); };