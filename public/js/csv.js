// Importación y exportación de personas (clientes y leads) en CSV.
import { state, $, hoyISO, toast, todos } from "./state.js";
import { dbInsertMany } from "./data.js";
import { render } from "./ui.js";

function parseCSV(text) {
  let inQ = false, counts = { ",": 0, ";": 0, "\t": 0 };
  for (const ch of text) { if (ch === '"') inQ = !inQ; else if (!inQ) { if (ch === "\n") break; if (counts[ch] !== undefined) counts[ch]++; } }
  const delim = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else {
      if (ch === '"') q = true;
      else if (ch === delim) { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cell); cell = ""; if (row.some(c => c.trim() !== "")) rows.push(row); row = []; }
      else cell += ch;
    }
  }
  row.push(cell); if (row.some(c => c.trim() !== "")) rows.push(row);
  return rows;
}
const norm = s => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

async function importar(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) { toast("El archivo no tiene filas de datos"); return; }
  const head = rows[0].map(norm), col = names => head.findIndex(h => names.includes(h));
  const iFirst = col(["first name", "primer nombre"]), iLast = col(["last name", "apellido", "apellidos"]),
    iNom = col(["nombre", "name", "nombre completo"]), iTel = col(["phone", "telefono", "tel", "whatsapp", "celular"]),
    iPais = col(["pais", "country", "país"]),
    iMem = col(["membresia", "membership", "tipo", "nivel"]), iCre = col(["created", "creado", "fecha de creacion", "fecha"]),
    iNota = col(["last note", "nota", "ultima nota", "notes"]);
  const srvCols = {}; todos().forEach(s => { const ix = head.indexOf(norm(s.n)); if (ix >= 0) srvCols[s.id] = ix; });
  if (iNom < 0 && iFirst < 0) { toast("⚠ No encontré columna de nombre"); return; }

  // En el módulo Leads, los importados entran como Lead por defecto.
  const defMem = state.modulo === "leads" ? "Lead" : "Beca";
  const existentes = new Set(state.clientes.map(c => (c.tel || "").replace(/\D/g, "")).filter(Boolean));
  const aInsertar = []; let dups = 0;
  rows.slice(1).forEach(r => {
    let nombre = iNom >= 0 ? r[iNom] : [r[iFirst], iLast >= 0 ? r[iLast] : ""].filter(Boolean).join(" ");
    nombre = (nombre || "").trim(); if (!nombre) return;
    const telN = iTel >= 0 ? (r[iTel] || "").replace(/\D/g, "") : "";
    if (telN && existentes.has(telN)) { dups++; return; }
    let mem = defMem; if (iMem >= 0) { const ok = ["Lead", "Beca", "VIP", "Platino", "Oro"].find(x => norm(x) === norm(r[iMem] || "")); if (ok) mem = ok; }
    let creado = null; if (iCre >= 0 && r[iCre]) { const m = r[iCre].match(/\d{4}-\d{2}-\d{2}/); if (m) creado = m[0]; }
    const acc = {}; Object.entries(srvCols).forEach(([sid, ix]) => { const v = (r[ix] || "").trim(); if (v) { const m = v.match(/\d{4}-\d{2}-\d{2}/); acc[sid] = m ? m[0] : hoyISO(); } });
    aInsertar.push({ nombre, telefono: telN ? "+" + telN : null, pais: iPais >= 0 ? (r[iPais] || "").trim() || null : null, membresia: mem, creado, comunidad_desde: null, upgrade_fecha: null, nota: iNota >= 0 ? (r[iNota] || "").trim() : null, acc });
    if (telN) existentes.add(telN);
  });
  if (!aInsertar.length) { toast(`No hay registros nuevos${dups ? ` · ${dups} duplicado(s) omitido(s)` : ''}`); return; }
  const insertados = await dbInsertMany(aInsertar);
  if (!insertados) return;
  insertados.forEach(c => state.clientes.push(c));
  render();
  toast(`✓ ${insertados.length} importado(s)${dups ? ` · ${dups} duplicado(s) omitido(s)` : ''}`);
}

/* ---------- wiring ---------- */
$("btnImport").onclick = () => $("fileInput").click();
$("fileInput").onchange = e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = ev => { importar(ev.target.result.replace(/^\uFEFF/, "")).catch(err => toast("⚠ " + err.message)); e.target.value = ""; };
  r.readAsText(f, "utf-8");
};
$("btnExport").onclick = () => {
  if (!state.clientes.length) { toast("No hay datos para exportar"); return; }
  const svs = todos(), dir = state.me.role === "director";
  const head = ["Nombre", "Phone", "Pais", "Membresia", "Creado", "IngresoComunidad", "UltimoUpgrade", "Nota", ...(dir ? ["Agente"] : []), ...svs.map(s => s.n)];
  const e2 = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const filas = state.clientes.map(c => [
    c.nombre, c.tel || "", c.pais || "", c.mem, c.creado || "", c.comunidadDesde || "", c.upgradeFecha || "", c.nota || "",
    ...(dir ? [state.perfiles[c.owner_id] || (c.owner_id === state.me.id ? state.me.name : "")] : []),
    ...svs.map(s => c.acc[s.id] || "")
  ].map(e2).join(";"));
  const csv = "\uFEFF" + head.map(e2).join(";") + "\r\n" + filas.join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  a.download = `nexus-${hoyISO()}.csv`; a.click(); URL.revokeObjectURL(a.href);
  toast("⬇ Exportado");
};
$("buscar").oninput = () => render();
