// Capa de datos: todas las consultas y escrituras a Supabase.
// No renderiza; quien llama se encarga de refrescar la vista.
import { SB } from "./supabase.js";
import { state, toast, fechaCO } from "./state.js";

export const mapDesdeDB = r => ({
  id: r.id, owner_id: r.owner_id, nombre: r.nombre, tel: r.telefono || "",
  pais: r.pais || "", mem: r.membresia, creado: r.creado || "",
  // Desfase con Colombia en minutos. Se conserva el null: 0 («igual que
  // Colombia») y «no se sabe» son cosas distintas para el texto del mensaje.
  tzOff: r.tz_offset_min ?? null,
  // Persona inactiva: no recibe mensajes. null = activa.
  inactivoDesde: r.inactivo_desde || null,
  inactivoMotivo: r.inactivo_motivo || null,
  // Un FTD por broker: { exoption: "2026-06-12", iqoption: "2026-09-03" }. Es un
  // mapa y no una fecha suelta porque una persona puede depositar en los dos, y
  // cada fecha cuenta en SU mes.
  ftds: r.ftds || {},
  // Derivado en la base (trigger): el FTD más antiguo. Se lee, no se escribe.
  comunidadDesde: r.comunidad_desde || "", upgradeFecha: r.upgrade_fecha || "",
  nota: r.nota || "", acc: r.acc || {}, conf: r.conf || {},
  // Asistencia a actividades puntuales (fuera del catálogo), auto-contenida:
  // { [actividad_id]: { n, i, conf, acc, z } }. `z` es el tipo de zoom de venta
  // cuando la actividad ES uno: se copia al programar para que los sitios que
  // tocan la asistencia no tengan que ir a buscar la actividad.
  pun: r.puntuales || {},
  // Embudo de venta de la persona: { pres|uno|cierre: { f, e } }.
  zooms: r.zooms || {},
  // Embudo del lead hacia la beca. No van en `mapAEditar`: se escriben solo
  // desde «Seguimiento», campo por campo, y guardar la ficha no debe pisarlos.
  createdAt: r.created_at, registroBroker: r.registro_broker || null,
  registroEn: r.registro_en || null, promesaEn: r.promesa_en || null,
  // Broker objetivo de la promesa: con valor es un pendiente de 2º depósito de
  // alguien que ya es Beca. Como registroBroker/promesaEn, NO va en mapAEditar.
  promesaBroker: r.promesa_broker || null,
  tempManual: r.temp_manual || null, tempManualEn: r.temp_manual_en || null,
});
export const mapAEditar = c => ({
  nombre: c.nombre, telefono: c.tel || null, pais: c.pais || null,
  tz_offset_min: c.tzOff ?? null,
  // Los dos campos viajan juntos: la base rechaza un motivo sin fecha.
  inactivo_desde: c.inactivoDesde || null,
  inactivo_motivo: c.inactivoDesde ? (c.inactivoMotivo || "otro") : null,
  membresia: c.mem, creado: c.creado || null,
  ftds: c.ftds || {},
  // `comunidad_desde` NO se manda: lo calcula el trigger desde `ftds`. Mandarlo
  // no rompería nada (el trigger lo pisa) pero haría creer que se puede fijar a
  // mano, y son dos fuentes de verdad para el mismo dato.
  upgrade_fecha: c.upgradeFecha || null,
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

  // Contactos con leads. Un fallo aquí no debe tumbar el panel: sin ellos la
  // temperatura cae a «según cuándo llegó», que sigue siendo útil.
  const { data: lc, error: e2 } = await SB.from("lead_contactos").select("*").order("en", { ascending: false });
  state.contactos = {};
  if (e2) console.warn("lead_contactos:", e2.message);
  (lc || []).forEach(x => (state.contactos[x.cliente_id] ||= []).push(x));

  await Promise.all([cargarPlantillasEnviadas(), cargarCrm()]);
}

// Leads de HighLevel propios (RLS: owner_id = auth.uid()). Se cargan junto con
// las personas porque deciden quién está «por bajar», y a esos no les sale
// ningún envío automático: el masivo y el seguimiento los leen de aquí.
export async function cargarCrm() {
  const { data, error } = await SB.from("crm_leads").select("*").order("asignado_en");
  if (error) { console.warn("crm_leads:", error.message); state.crm = state.crm || []; }
  else state.crm = data || [];
  state.crmPor = {};
  state.crm.forEach(l => { if (l.cliente_id) state.crmPor[l.cliente_id] = l; });
  // La Edge Function crea la persona cuando el lead llega, pero las personas se
  // cargan una sola vez al entrar: un lead asignado después salía en «Mi día»
  // (que sí recarga crm_leads) y no en Leads. Se traen las que falten.
  if (state.clientes) {
    const hay = new Set(state.clientes.map(c => c.id));
    const faltan = [...new Set(state.crm.map(l => l.cliente_id).filter(id => id && !hay.has(id)))];
    if (faltan.length) {
      const { data: cl, error: e } = await SB.from("clientes").select("*").in("id", faltan);
      if (e) console.warn("clientes nuevos de HighLevel:", e.message);
      else (cl || []).forEach(r => { if (!state.clientes.some(c => c.id === r.id)) state.clientes.push(mapDesdeDB(r)); });
    }
  }
  return state.crm;
}

// Leads «Hoy» y «Todos los leads» también recargan crm_leads (y las personas
// nuevas que traiga) cada 2 min: un lead de HighLevel puede llegar con la
// pantalla abierta. Resuelve true si cambió algo, para re-pintar.
const CRM_FRESCO = 2 * 60e3;
let crmEn = Date.now(), crmCurso = null;
export function asegurarCrm() {
  if (crmCurso) return crmCurso;
  if (Date.now() - crmEn < CRM_FRESCO) return Promise.resolve(false);
  const antes = JSON.stringify(state.crm) + state.clientes.length;
  crmCurso = cargarCrm().then(() => JSON.stringify(state.crm) + state.clientes.length !== antes)
    .catch(() => false).finally(() => { crmEn = Date.now(); crmCurso = null; });
  return crmCurso;
}

// Qué plantilla de seguimiento recibió (o tiene programada) cada lead, para no
// repetirla. Se deriva del mensaje 1 de cada campaña de leads: `enviado` =
// recibida, `pendiente` = programada; cancelados y fallidos no cuentan porque
// no le llegaron. Un fallo aquí no tumba el panel: solo falta la marca.
export async function cargarPlantillasEnviadas() {
  const { data, error } = await SB.from("mensajes_programados")
    .select("cliente_id, estado, enviar_en, enviado_en, campanas!inner(nombre, plantilla_id, lead_tipo)")
    .eq("tipo", "masivo").not("cliente_id", "is", null).in("estado", ["pendiente", "enviado"])
    .not("campanas.lead_tipo", "is", null)
    .order("enviar_en", { ascending: false });
  state.plantillasEnviadas = {};
  if (error) { console.warn("plantillas enviadas:", error.message); return; }
  (data || []).forEach(m => (state.plantillasEnviadas[m.cliente_id] ||= []).push({
    plantillaId: m.campanas.plantilla_id, nombre: m.campanas.nombre,
    estado: m.estado, en: m.enviado_en || m.enviar_en,
  }));
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
  return !error;
}

const BUCKET_SRV = "servicios";

// Sube la imagen de un servicio al Storage y devuelve su URL pública.
// Cada subida lleva nombre NUEVO en vez de pisar `<id>.<ext>`: el worker
// guarda en disco la multimedia por URL (y el CDN de Storage la cachea), así
// que con la URL fija seguía mandando la imagen vieja aunque el panel ya
// mostrara la nueva. Quien llama borra la anterior tras guardar el catálogo.
// El sufijo va en el nombre y no como `?v=`: el bridge decide el tipo por la
// extensión de la URL y un query string podría ensuciarla.
export async function subirImagenServicio(file, serviceId) {
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${serviceId}_${Date.now()}.${ext}`;
  const { error } = await SB.storage.from(BUCKET_SRV)
    .upload(path, file, { contentType: file.type });
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
/* Chats recientes del WhatsApp del agente, para «registrar desde un chat».
   La llena el worker leyendo los bridges; aquí solo se lee.

   Se pide A DEMANDA (al abrir el selector) y no en `cargarTodo`: son cientos
   de filas que la mayoría de las sesiones no va a mirar nunca. El RLS ya
   limita esto a los chats propios, así que no hay filtro por dueño acá. */
export async function cargarChatsRecientes() {
  const { data, error } = await SB
    .from("chats_recientes")
    .select("telefono,nombre_wa,ultimo_en")
    .order("ultimo_en", { ascending: false })
    .limit(300);
  if (error) throw error;
  return data || [];
}

export async function cargarVentas() {
  try {
    const [prod, par, met, ven, base, notas, mag] = await Promise.all([
      // TODOS, retirados incluidos: una venta vieja de un producto retirado
      // necesita su categoría y nivel (subida de nivel, upgrade). Ofrecer solo
      // los activos es cosa del buscador de ventas.js.
      SB.from("productos").select("*").order("orden"),
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

// Contactos con leads. `owner_id` lo fija la base (dueño del lead) y el RLS
// solo deja insertar si ese dueño es quien escribe.
export async function crearContacto(cliente_id, tipo, nota) {
  const { data, error } = await SB.from("lead_contactos")
    .insert({ cliente_id, tipo, nota: nota || null }).select().single();
  if (error) { toast("⚠ " + error.message); return null; }
  return data;
}

export async function actualizarContacto(id, campos) {
  const { error } = await SB.from("lead_contactos").update(campos).eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

export async function borrarContacto(id) {
  const { error } = await SB.from("lead_contactos").delete().eq("id", id);
  if (error) { toast("⚠ " + error.message); return false; }
  return true;
}

// Teléfonos que te ESCRIBIERON en los últimos días, con la fecha de su último
// mensaje entrante (`chats_recientes.entrante_en`, que publica el worker). Se
// pide SOLO al entrar a Leads, no en cada carga, y se filtra a los últimos días
// porque más atrás ya es «frío» y no cambia nada: así la consulta es mínima y
// no hay sondeo. El RLS de la tabla es `owner_id = auth.uid()`, así que solo
// trae tus propios chats (un director no ve la agenda de su equipo).
// Cupo diario de envíos del agente. El worker cancela el PRIMER mensaje de cada
// persona (`masivo` / `invitacion`) cuando el agente ya lleva TOPE enviados en
// el día de Colombia; con él se cae el resto de su serie. Todo lo que sale
// gasta cupo, aunque el tope solo corte a los primeros. 500 refleja
// `TOPE_DIARIO` del worker; si allá cambia, acá también.
//
// Contar solo lo ya enviado no alcanza: «Operativa 8pm» (25/10/2026) se creó
// con 210 de 220 y el aviso dijo que quedaban 10, pero había 70 confirmaciones
// en cola por delante y la campaña entera se canceló sin que nadie se enterara.
// Por eso se simula la cola completa: lo enviado, lo pendiente en el orden en
// que va a salir y, si se está programando algo, lo nuevo en su lugar.
export const TOPE_DIARIO = 500;
const CON_TOPE = new Set(["masivo", "invitacion"]);

// La serie de un mensaje: si su primer mensaje no sale, la base cancela el
// resto (triggers `mensajes_cancela_*`), así que la simulación tampoco los
// cuenta.
const serieDe = m => m.seguimiento_id ? `seg:${m.seguimiento_id}`
  : m.campana_id ? `camp:${m.campana_id}:${m.cliente_id || m.telefono}`
  : `msg:${m.id}`;

export async function cargarCola() {
  const hoy = fechaCO();
  const me = state.me.id;
  const [env, pend] = await Promise.all([
    SB.from("mensajes_programados").select("id", { count: "exact", head: true })
      .eq("owner_id", me).eq("estado", "enviado").gte("enviado_en", `${hoy}T00:00:00-05:00`),
    SB.from("mensajes_programados")
      .select("id,tipo,enviar_en,seguimiento_id,campana_id,cliente_id,telefono")
      .eq("owner_id", me).eq("estado", "pendiente").order("enviar_en"),
  ]);
  if (env.error || pend.error) throw env.error || pend.error;
  return {
    hoy, tope: TOPE_DIARIO, enviados: env.count || 0,
    pendientes: (pend.data || []).map(m => ({ t: Date.parse(m.enviar_en), tipo: m.tipo, serie: serieDe(m) })),
  };
}

// Recorre la cola en el orden del worker (hora programada; a igual hora, lo
// que ya estaba va primero). `nuevas`: [{ t, tipo, serie }] de lo que se está
// por programar, con una serie distinta por persona. Devuelve qué series
// nuevas no saldrían, qué primeros mensajes YA programados dejarían de salir
// (lo nuevo puede quitarles el cupo si va antes) y cuánto se gasta hoy.
export function simularCupo(cola, nuevas = []) {
  const ahora = Date.now();
  const todos = [
    ...cola.pendientes.map(m => ({ ...m, nueva: false })),
    ...nuevas.map(m => ({ ...m, nueva: true })),
  ].sort((a, b) => a.t - b.t || a.nueva - b.nueva);
  const usados = new Map([[cola.hoy, cola.enviados]]);
  const caidas = new Set(), fueraNuevas = new Set();
  let fueraPrevias = [];
  let enColaHoy = 0;
  for (const m of todos) {
    // Lo atrasado sale apenas el worker lo tome: cuenta para hoy.
    const dia = fechaCO(new Date(Math.max(m.t, ahora)));
    if (!m.nueva && dia === cola.hoy) enColaHoy++;
    if (caidas.has(m.serie)) continue;
    const n = usados.get(dia) || 0;
    if (CON_TOPE.has(m.tipo) && n >= cola.tope) {
      caidas.add(m.serie);
      if (m.nueva) fueraNuevas.add(m.serie); else fueraPrevias.push({ ...m, dia });
      continue;
    }
    usados.set(dia, n + 1);
  }
  // Lo ya programado que no iba a salir de todos modos no es culpa de esta
  // tanda: se separa para no decirle al agente que la tanda se lo quitó.
  let yaFuera = fueraPrevias.length;
  if (nuevas.length) {
    const antes = new Set(simularCupo(cola).fueraPrevias.map(m => m.serie));
    yaFuera = antes.size;
    fueraPrevias = fueraPrevias.filter(m => !antes.has(m.serie));
  }
  return { fueraNuevas, fueraPrevias, yaFuera, enColaHoy, usadosHoy: usados.get(cola.hoy), enviados: cola.enviados, tope: cola.tope };
}

// Texto del aviso de cupo para un confirm. Vacío si todo sale. `unidad`
// nombra a quién le escribe esa pantalla («personas», «leads»).
export function avisoCupo(sim, total, unidad = "personas") {
  const nf = sim.fueraNuevas.size, np = sim.fueraPrevias.length;
  if (!nf && !np && !sim.yaFuera) return "";
  const lineas = [];
  if (nf) lineas.push(nf === total
    ? `⚠ Esta tanda NO va a salir: nadie de ${total === 1 ? "esta persona" : `estas ${total} ${unidad}`} recibirá el mensaje, porque el límite diario de ${sim.tope} envíos ya está ocupado.`
    : `⚠ De esta tanda de ${total} ${unidad}, ${nf} NO recibirán el mensaje: no caben en el límite diario de ${sim.tope} envíos.`);
  if (np) lineas.push(`⚠ ${nf ? "Además, " : ""}${np} ${np === 1 ? "persona que ya tenías programada dejaría" : "personas que ya tenías programadas dejarían"} de recibir su mensaje: esta tanda les quita el cupo.`);
  if (sim.yaFuera) lineas.push(`(Sin contar esta tanda, ${sim.yaFuera} ${sim.yaFuera === 1 ? "persona programada ya no iba" : "personas programadas ya no iban"} a recibir su mensaje por el límite.)`);
  lineas.push(`Hoy llevas ${sim.enviados} enviados y ${sim.enColaHoy} más en cola. El límite se reinicia a medianoche (hora Colombia).`);
  return "\n\n" + lineas.join("\n");
}

// Quién te escribió y cuándo, desde `chats_recientes` (lo publica el worker
// cada ~5 min). RLS deja ver solo los chats PROPIOS. 14 días bastan para
// «respondió» a un seguimiento reciente y para la temperatura (a los 3 ya es
// frío). Devuelve las filas tal cual (null si falla); el cruce con las
// personas lo hace entrantes.js.
export async function cargarEntrantes() {
  const desde = fechaCO(new Date(Date.now() - 14 * 864e5));
  const { data, error } = await SB
    .from("chats_recientes")
    .select("telefono,entrante_en,primer_entrante_dia")
    .not("entrante_en", "is", null)
    .gte("entrante_en", desde);
  if (error) { console.warn("entrantes:", error.message); return null; }
  return data || [];
}
