// Capa de datos: todas las consultas y escrituras a Supabase.
// No renderiza; quien llama se encarga de refrescar la vista.
import { SB } from "./supabase.js";
import { state, toast } from "./state.js";

export const mapDesdeDB = r => ({
  id: r.id, owner_id: r.owner_id, nombre: r.nombre, tel: r.telefono || "",
  pais: r.pais || "", mem: r.membresia, creado: r.creado || "",
  comunidadDesde: r.comunidad_desde || "", upgradeFecha: r.upgrade_fecha || "",
  nota: r.nota || "", acc: r.acc || {}, conf: r.conf || {},
});
export const mapAEditar = c => ({
  nombre: c.nombre, telefono: c.tel || null, pais: c.pais || null,
  membresia: c.mem, creado: c.creado || null,
  comunidad_desde: c.comunidadDesde || null, upgrade_fecha: c.upgradeFecha || null,
  nota: c.nota || null, acc: c.acc || {}, conf: c.conf || {},
});

export async function cargarTodo() {
  const { data: cfg } = await SB.from("config").select("data").eq("id", "catalogo").single();
  state.catalogo = (cfg && Array.isArray(cfg.data)) ? cfg.data : [];

  if (state.me.role === "director") {
    const { data: ps } = await SB.from("profiles").select("id,full_name,role");
    state.perfiles = {};
    (ps || []).forEach(p => state.perfiles[p.id] = p.full_name || "(sin nombre)");
  }

  const { data: cl, error } = await SB.from("clientes").select("*").order("created_at", { ascending: true });
  if (error) throw error;
  state.clientes = (cl || []).map(mapDesdeDB);
}

export async function dbInsert(c) {
  const { data, error } = await SB.from("clientes").insert(mapAEditar(c)).select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  return mapDesdeDB(data);
}

export async function dbInsertMany(rows) {
  const { data, error } = await SB.from("clientes").insert(rows).select();
  if (error) { toast("⚠ " + error.message); return null; }
  return (data || []).map(mapDesdeDB);
}

export async function dbPatch(c, campos) {
  const { error } = await SB.from("clientes").update(campos).eq("id", c.id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function dbDelete(id) {
  const { error } = await SB.from("clientes").delete().eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function guardarCatalogo() {
  const { error } = await SB.from("config")
    .update({ data: state.catalogo, updated_at: new Date().toISOString() })
    .eq("id", "catalogo");
  if (error) toast("⚠ No se pudo guardar el catálogo: " + error.message);
}

const BUCKET_SRV = "servicios";

// Sube la imagen de un servicio al Storage y devuelve su URL pública.
// El archivo se nombra por el id del servicio, así reemplaza la anterior.
export async function subirImagenServicio(file, serviceId) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${serviceId}.${ext}`;
  const { error } = await SB.storage.from(BUCKET_SRV)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw error;
  return SB.storage.from(BUCKET_SRV).getPublicUrl(path).data.publicUrl;
}

// Borra del Storage la imagen a partir de su URL pública.
export async function borrarImagenServicio(url) {
  const m = (url || "").split("?")[0].match(/\/servicios\/(.+)$/);
  if (m) await SB.storage.from(BUCKET_SRV).remove([m[1]]);
}
