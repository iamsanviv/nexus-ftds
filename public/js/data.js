// Capa de datos: todas las consultas y escrituras a Supabase.
// No renderiza; quien llama se encarga de refrescar la vista.
import { SB } from "./supabase.js";
import { state, toast } from "./state.js";

export const mapDesdeDB = r => ({
  id: r.id, owner_id: r.owner_id, nombre: r.nombre, tel: r.telefono || "",
  pais: r.pais || "", mem: r.membresia, creado: r.creado || "",
  // Desfase con Colombia en minutos. Se conserva el null: 0 («igual que
  // Colombia») y «no se sabe» son cosas distintas para el texto del mensaje.
  tzOff: r.tz_offset_min ?? null,
  comunidadDesde: r.comunidad_desde || "", upgradeFecha: r.upgrade_fecha || "",
  nota: r.nota || "", acc: r.acc || {}, conf: r.conf || {},
  // Asistencia a actividades puntuales (fuera del catálogo), auto-contenida:
  // { [actividad_id]: { n, i, conf, acc, z } }. `z` es el tipo de zoom de venta
  // cuando la actividad ES uno: se copia al programar para que los sitios que
  // tocan la asistencia no tengan que ir a buscar la actividad.
  pun: r.puntuales || {},
  // Embudo de venta de la persona: { pres|uno|cierre: { f, e } }.
  zooms: r.zooms || {},
});
export const mapAEditar = c => ({
  nombre: c.nombre, telefono: c.tel || null, pais: c.pais || null,
  tz_offset_min: c.tzOff ?? null,
  membresia: c.mem, creado: c.creado || null,
  comunidad_desde: c.comunidadDesde || null, upgrade_fecha: c.upgradeFecha || null,
  nota: c.nota || null, acc: c.acc || {}, conf: c.conf || {},
  puntuales: c.pun || {},
  zooms: c.zooms || {},
  // Solo se manda si quien guarda eligió dueño (un director asignando a uno de
  // sus agentes). Si no va, la base pone auth.uid() por defecto. El RLS valida
  // que el dueño elegido sea de su equipo: no se puede regalar a un ajeno.
  ...(c.owner_id ? { owner_id: c.owner_id } : {}),
});

export async function cargarTodo() {
  const { data: cfg } = await SB.from("config").select("data").eq("id", "catalogo").single();
  state.catalogo = (cfg && Array.isArray(cfg.data)) ? cfg.data : [];

  if (state.me.role === "director") {
    // El RLS ya limita esto al equipo del director (él + sus agentes).
    const { data: ps } = await SB.from("profiles").select("id,full_name,role,aprobado");
    state.perfiles = {};
    state.equipo = [];
    (ps || []).forEach(p => {
      const nombre = p.full_name || "(sin nombre)";
      state.perfiles[p.id] = nombre;
      // Los pendientes de aprobación no pueden operar, así que tampoco se les
      // asignan clientes.
      if (p.aprobado) state.equipo.push({ id: p.id, nombre, yo: p.id === state.me.id });
    });
    state.equipo.sort((a, b) =>
      a.yo ? -1 : b.yo ? 1 : a.nombre.localeCompare(b.nombre, "es"));
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

// Adjunto de un mensaje (imagen o video, masivo o de una actividad): nombre
// único para que no se pisen entre campañas/actividades distintas. El nombre
// se quedó en "Imagen" por historia, pero sube cualquier archivo tal cual:
// el tipo lo decide `file.type`, no esta función.
export async function subirImagenMensaje(file) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await SB.storage.from("mensajes").upload(path, file, { contentType: file.type });
  if (error) throw error;
  return SB.storage.from("mensajes").getPublicUrl(path).data.publicUrl;
}

/* ═══════════════ HISTORIAL DE INVITADOS (segmentos) ═══════════════ */
// Vive acá, y no en seguimiento.js, porque lo alimentan DOS sitios: programar
// una actividad y enviar un masivo. Antes solo lo escribía Seguimiento, así que
// las selecciones hechas en Masivo no se podían reutilizar en las actividades
// —solo al revés—, que es justo lo que no tenía sentido.
const MAX_HISTORIAL = 8;

// Se UNIFICA por `clave`, no se apila una entrada por guardado.
//
// El agente programa de a poquitos, según le van confirmando: si cada tanda
// creara su propia entrada, una sola actividad se comía el historial entero y
// además dejaba ocho versiones incompletas de la misma lista. Con la clave, las
// tandas se funden en una entrada que va creciendo.
//
// La unión es acumulativa a propósito: quien ya entró a la lista se queda,
// aunque en la tanda siguiente no se le haya vuelto a marcar.
export async function guardarHistorialSegmento({ clienteIds, nombre, clave }) {
  if (!clienteIds || !clienteIds.length) return;
  try {
    const previo = clave
      ? (await SB.from("segmentos").select("id, definicion")
          .eq("owner_id", state.me.id)
          .eq("definicion->>clave", clave)
          .limit(1)).data?.[0]
      : null;

    if (previo) {
      const union = [...new Set([...(previo.definicion.cliente_ids || []), ...clienteIds])];
      await SB.from("segmentos")
        .update({
          nombre,
          definicion: { ...previo.definicion, cliente_ids: union },
          // Se sube al tope de «recientes»: la actividad que se está armando
          // ahora es la que el agente va a querer volver a tocar.
          created_at: new Date().toISOString(),
        })
        .eq("id", previo.id);
      return;
    }

    await SB.from("segmentos").insert({
      owner_id: state.me.id, nombre,
      definicion: { tipo: "historial", cliente_ids: clienteIds, clave },
    });

    // Poda: solo los MAX_HISTORIAL más recientes de tipo historial. Se hace
    // únicamente al CREAR uno nuevo; al unificar no crece la cuenta.
    const { data } = await SB.from("segmentos")
      .select("id, definicion, created_at")
      .eq("owner_id", state.me.id)
      .order("created_at", { ascending: false });
    const sobran = (data || [])
      .filter(s => s.definicion?.tipo === "historial")
      .slice(MAX_HISTORIAL);
    if (sobran.length) await SB.from("segmentos").delete().in("id", sobran.map(s => s.id));
  } catch (e) {
    // Guardar el historial es una comodidad: que falle no puede tumbar una
    // programación ni un envío que ya salieron bien.
  }
}

/* ═══════════════ VENTAS, ABONOS Y NOTAS ═══════════════ */

// Carga todo lo del módulo de ventas de una sola vez. Los abonos vienen
// anidados en su venta (PostgREST resuelve la relación), así no hay que
// cruzarlos a mano ni hacer una consulta por venta.
//
// Si la migración de ventas todavía no se aplicó, las tablas no existen y esto
// falla. En vez de tumbar la app entera, devuelve `instalado: false` y la vista
// muestra un aviso: el resto del sistema tiene que seguir funcionando igual.
export async function cargarVentas() {
  try {
    const [prod, par, met, ven, base, notas, mag] = await Promise.all([
      SB.from("productos").select("*").eq("activo", true).order("orden"),
      SB.from("parametros").select("clave,valor"),
      SB.from("metas_ftd").select("*").order("ftd"),
      SB.from("ventas").select("*, abonos(*)").order("creado_en", { ascending: false }),
      SB.from("ftd_base").select("*"),
      SB.from("notas_cliente").select("*").order("creado_en", { ascending: false }),
      SB.from("metas_agente").select("*"),
    ]);
    const err = prod.error || par.error || met.error || ven.error || base.error || notas.error || mag.error;
    if (err) throw err;

    state.productos = prod.data || [];
    state.parametros = Object.fromEntries((par.data || []).map(p => [p.clave, Number(p.valor)]));
    state.metasFtd = met.data || [];
    state.ventas = (ven.data || []).map(mapVenta);
    state.ftdBase = Object.fromEntries((base.data || []).map(b => [`${b.owner_id}|${b.periodo}`,
      { base: b.base, declarado: b.declarado, cerrado: b.cerrado }]));
    state.metasAgente = Object.fromEntries((mag.data || []).map(m => [`${m.owner_id}|${m.periodo}`, m]));
    state.notas = {};
    (notas.data || []).forEach(n => (state.notas[n.cliente_id] ||= []).push(n));
    state.ventasOk = true;
  } catch (e) {
    state.ventasOk = false;
    state.ventasError = e.message || String(e);
  }
}

const mapVenta = r => ({ ...r, valor: Number(r.valor), comision: Number(r.comision),
  abonos: (r.abonos || []).map(a => ({ ...a, monto: Number(a.monto) }))
                          .sort((a, b) => a.fecha.localeCompare(b.fecha)) });

export async function vInsert(campos) {
  const { data, error } = await SB.from("ventas").insert(campos).select("*, abonos(*)").single();
  if (error) { toast("⚠ " + error.message); return null; }
  return mapVenta(data);
}

export async function vPatch(id, campos) {
  const { error } = await SB.from("ventas").update(campos).eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function vDelete(id) {
  const { error } = await SB.from("ventas").delete().eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function abInsert(venta_id, monto, fecha) {
  const { data, error } = await SB.from("abonos").insert({ venta_id, monto, fecha }).select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  return { ...data, monto: Number(data.monto) };
}

// Corregir un abono mal puesto. El monto y la fecha son lo único editable: la
// fecha importa porque decide en qué mes se causa la comisión.
export async function abPatch(id, campos) {
  const { error } = await SB.from("abonos").update(campos).eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function abDelete(id) {
  const { error } = await SB.from("abonos").delete().eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

// Declaración de FTD y cierre de mes. `upsert` porque la fila del periodo puede
// no existir todavía: la primera vez que un agente declara, la crea.
export async function guardarFtd(owner_id, periodo, campos) {
  const { data, error } = await SB.from("ftd_base")
    .upsert({ owner_id, periodo, ...campos }, { onConflict: "owner_id,periodo" })
    .select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  state.ftdBase[`${owner_id}|${periodo}`] =
    { base: data.base, declarado: data.declarado, cerrado: data.cerrado };
  return data;
}

export async function guardarMeta(owner_id, periodo, meta_ftd, meta_ventas) {
  const { data, error } = await SB.from("metas_agente")
    .upsert({ owner_id, periodo, meta_ftd, meta_ventas }, { onConflict: "owner_id,periodo" })
    .select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  state.metasAgente[`${owner_id}|${periodo}`] = data;
  return data;
}

// Las notas se APILAN por cliente (tabla propia), a diferencia de
// `clientes.nota`, que es un solo texto que se sobrescribe. Las dos conviven.
export async function notaInsert(cliente_id, texto) {
  const { data, error } = await SB.from("notas_cliente").insert({ cliente_id, texto }).select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  return data;
}

export async function notaDelete(id) {
  const { error } = await SB.from("notas_cliente").delete().eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

// Nota de voz para masivos: se sube tal como la grabó el navegador (webm/m4a);
// el worker la convierte a ogg/opus al enviar para que WhatsApp la muestre
// como nota de voz (PTT). La extensión importa: el worker detecta audio por ella.
export async function subirAudioMensaje(blob, ext) {
  const path = `a_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await SB.storage.from("mensajes").upload(path, blob, { contentType: blob.type || "audio/webm" });
  if (error) throw error;
  return SB.storage.from("mensajes").getPublicUrl(path).data.publicUrl;
}
