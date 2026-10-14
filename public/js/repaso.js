// Repaso de asistencias: al primer ingreso del día (después de las 7 AM)
// pregunta, una por una, por las invitaciones que quedaron sin respuesta
// (¿asistió o no?), para mantener el sistema al día.
//
// También se puede abrir a demanda desde el indicador del header, por si se
// omitió el repaso automático.
//
// Margen: una invitación solo se pregunta cuando ya pasó al menos MARGEN_MS
// desde el inicio de la actividad. Como `conf` guarda solo la fecha (sin hora),
// la hora real se busca en la tabla `actividades`; si no hay actividad asociada
// (invitación marcada a mano), se usa la regla de "día anterior".
import { state, $, esc, fmtF, toast, todos, hoyISO, syncZoom, componerMensaje, esInactivo, motivoCorto } from "./state.js";
import { SB } from "./supabase.js";
import { dbPatch, cuotaDiaria } from "./data.js";
import { render } from "./ui.js";
import { canalVinculado } from "./canal.js";
import { destinatariosMasivo } from "./masivo.js";

const clave = () => "nexusRepaso:" + state.me.id;

const MARGEN_MS = 60 * 60 * 1000;   // 1 hora después del inicio de la actividad

// Horarios reales de las actividades, para no preguntar por una que todavía
// no ocurrió. `conf` guarda el día en que se PROGRAMÓ la invitación, no el de
// la actividad (se invita el lunes a la clase del jueves), así que buscar la
// actividad de ese día fallaba y se preguntaba al día siguiente de invitar.
//
// Fuentes, de más precisa a menos:
//   1. invitada: "cliente|servicio" -> inicio de la actividad de su seguimiento
//      más reciente. Es exactamente a la que se le invitó.
//   2. porServicio: la primera actividad propia de ese servicio que empieza el
//      día de la invitación o después (invitaciones sin seguimiento).
//   3. sin nada: desde el día siguiente a la invitación (marcada a mano).
// Puntuales: `porId` con el inicio vigente de la tabla, porque el copiado en
// `puntuales` se queda viejo si la actividad se reprograma.
// Se recarga cada pocos minutos: el panel puede quedar abierto días enteros.
let horarios = null, horariosEn = 0, cargando = null;
const VIGENCIA_MS = 5 * 60 * 1000;
const VENTANA_SEG_MS = 60 * 24 * 60 * 60 * 1000;   // seguimientos de los últimos 60 días

async function cargarHorarios() {
  if (horarios && Date.now() - horariosEn < VIGENCIA_MS) return horarios;
  if (cargando) return cargando;
  cargando = (async () => {
    const porServicio = new Map(), porId = new Map(), servicioDe = new Map(), invitada = new Map();
    try {
      const { data, error } = await SB.from("actividades").select("id, servicio_id, inicio, owner_id");
      if (error) throw error;
      for (const a of data || []) {
        const t = new Date(a.inicio).getTime();
        if (isNaN(t)) continue;
        porId.set(a.id, t);
        if (a.servicio_id) servicioDe.set(a.id, a.servicio_id);
        if (a.servicio_id && a.owner_id === state.me.id) {
          if (!porServicio.has(a.servicio_id)) porServicio.set(a.servicio_id, []);
          porServicio.get(a.servicio_id).push(t);
        }
      }
      porServicio.forEach(l => l.sort((x, y) => x - y));

      const desde = new Date(Date.now() - VENTANA_SEG_MS).toISOString();
      const { data: segs, error: e2 } = await SB.from("seguimientos")
        .select("cliente_id, actividad_id, inicio")
        .eq("owner_id", state.me.id).neq("estado", "cancelado").gte("created_at", desde)
        .order("created_at", { ascending: false });
      if (e2) throw e2;
      for (const g of segs || []) {
        const sid = servicioDe.get(g.actividad_id);
        if (!sid) continue;
        const k = g.cliente_id + "|" + sid;
        if (invitada.has(k)) continue;                       // vale la más reciente
        const t = porId.get(g.actividad_id) ?? new Date(g.inicio).getTime();
        if (!isNaN(t)) invitada.set(k, t);
      }
      horarios = { porServicio, porId, invitada };
      horariosEn = Date.now();
    } catch (e) {
      // Sin horarios se cae a la regla de "día anterior": nunca bloquea el repaso.
      // Se marca la hora igual: reintentar en cada render haría un bucle.
      horarios = horarios || { porServicio, porId, invitada };
      horariosEn = Date.now();
    } finally { cargando = null; }
    return horarios;
  })();
  return cargando;
}

// Inicio del día `f` (YYYY-MM-DD) en hora local, en ms.
const inicioDia = f => new Date(f + "T00:00:00").getTime();

// ¿Ya se le puede preguntar a esta invitación del catálogo? Solo cuando pasó
// MARGEN_MS desde que empezó la actividad a la que se invitó.
function yaSePuedePreguntar(c, sid, f, hoy) {
  let inicio = horarios?.invitada.get(c.id + "|" + sid);
  if (inicio == null) inicio = horarios?.porServicio.get(sid)?.find(t => t >= inicioDia(f));
  if (inicio != null) return Date.now() >= inicio + MARGEN_MS;
  return f < hoy;
}

// Invitados (conf) sin asistencia marcada (acc), míos, ya "preguntables".
//
// `!c.acc[s.id]` es la regla que importa: de quien YA ASISTIÓ no se pregunta
// nunca más, aunque se le vuelva a invitar diez veces. Preguntar otra vez es
// justo lo que abría la puerta a que una respuesta borrara la asistencia vieja.
function pendientes() {
  const hoy = hoyISO();
  const items = [];
  for (const c of state.clientes) {
    if (c.owner_id !== state.me.id) continue;
    for (const s of todos()) {
      const f = (c.conf || {})[s.id];
      if (f && !c.acc[s.id] && yaSePuedePreguntar(c, s.id, f, hoy)) items.push({ c, s, f });
    }
    // Actividades puntuales: viven en su propio mapa y traen nombre y hora
    // copiados, así que no hay que resolver nada contra otra tabla.
    for (const [actId, p] of Object.entries(c.pun || {})) {
      if (!p || !p.conf || p.acc) continue;
      const inicio = horarios?.porId.get(actId) ?? (p.i ? new Date(p.i).getTime() : null);
      const listo = inicio != null ? Date.now() >= inicio + MARGEN_MS : p.conf < hoy;
      if (listo) items.push({ c, actId, s: { n: p.n || "actividad" }, f: p.conf });
    }
  }
  return items.sort((a, b) => a.f.localeCompare(b.f));
}

// Cuántas quedan sin responder (para el indicador del header).
export function repasoPendientes() {
  if (!state.me) return 0;
  // Si los horarios envejecieron, se piden de nuevo en segundo plano y se repinta.
  if (horarios && Date.now() - horariosEn >= VIGENCIA_MS && !cargando) cargarHorarios().then(() => render());
  return pendientes().length;
}

// Precarga los horarios y refresca el indicador (no abre nada).
export async function repasoPreparar() {
  await cargarHorarios();
  render();
}

/* ---------- mensaje al cliente ---------- */

// Variantes {a|b|c} sorteadas por persona, como en el masivo: que no llegue
// idéntico a todos.
const MENSAJE_SEGUIMIENTO =
  "{Hola|Buenas|Qué tal|Hola, qué gusto saludarte} {nombre}, " +
  "{espero tengas un buen día|espero que vayas muy bien|ojalá estés teniendo un gran día}. " +
  "{¿Lograste ingresar a la clase que te invité?|¿Pudiste entrar a la clase a la que te invité?|¿Alcanzaste a conectarte a la clase que te compartí?} " +
  "{Estoy atento a tu progreso|Quedo pendiente de cómo te va|Estoy pendiente de tu avance} {🙌🏻|💪🏻|🚀}";

// Un solo mensaje, encolado como masivo sin campaña: no es una tercera vía de
// envío sino un masivo de una persona, y por eso el destinatario se valida con
// el mismo cuello (`destinatariosMasivo`). Sin campaña para no llenar «Envíos
// masivos» de tandas de uno; el worker ya entrega masivos con `campana_id` nulo.
const textoSeguimiento = c =>
  componerMensaje(MENSAJE_SEGUIMIENTO, { nombre: (c.nombre || "").trim().split(/\s+/)[0] });

// «Ir al chat»: abre el chat en el WhatsApp del propio agente con el texto ya
// escrito, y él decide si lo envía. No pasa por la cola, así que no depende
// de tener el canal vinculado.
const enlaceWa = c =>
  `https://wa.me/${c.tel.replace(/\D/g, "")}?text=${encodeURIComponent(textoSeguimiento(c))}`;

async function escribirle(c, btn) {
  // Inactivas incluidas a propósito: aquí el agente eligió a esta persona, y la
  // confirmación de abajo se lo recuerda.
  if (!destinatariosMasivo(true).some(x => x.id === c.id)) {
    toast(c.tel ? "Solo puedes escribirle a tus propios clientes" : "Esta persona no tiene teléfono");
    return;
  }
  // Se vuelve a comprobar al enviar: el canal pudo caerse con el repaso abierto.
  if (!(await canalVinculado())) {
    toast("Tu WhatsApp se desvinculó: usa «Ir al chat» para escribirle desde tu teléfono");
    return;
  }
  const texto = textoSeguimiento(c);
  const cuota = await cuotaDiaria();
  const avisos = [
    esInactivo(c) ? `😴 Está marcada como inactiva (${motivoCorto(c.inactivoMotivo)}).` : "",
    cuota.restan === 0 ? `⚠ Ya alcanzaste el límite diario de envíos (${cuota.enviados}/${cuota.tope}): este mensaje se cancelará.` : "",
  ].filter(Boolean).join("\n");
  if (!confirm(`Vas a enviarle a ${c.nombre} desde tu WhatsApp:\n\n«${texto}»${avisos ? "\n\n" + avisos : ""}\n\n¿Enviar?`)) return;

  btn.disabled = true; btn.textContent = "Enviando…";
  const { error } = await SB.from("mensajes_programados").insert({
    tipo: "masivo", cliente_id: c.id, telefono: c.tel, texto,
    enviar_en: new Date().toISOString(),
  });
  if (error) {
    toast("⚠ " + error.message);
    btn.disabled = false; btn.textContent = "⚡ Preguntarle en automático";
    return;
  }
  // Queda deshabilitado para este paso: un segundo toque no duplica el mensaje.
  btn.textContent = "✓ Mensaje en cola";
  toast(`✓ Mensaje a ${c.nombre.split(" ")[0]} en cola`);
}

/* ---------- overlay ---------- */

// `canal`: si el WhatsApp del agente está vinculado al abrir el repaso. Sin él,
// «Preguntarle en automático» (que encola) queda deshabilitado; «Ir al chat» siempre está.
function abrir(items, marcarHecho, canal) {
  const hoy = hoyISO();
  let i = 0;

  const cerrar = () => {
    if (marcarHecho) localStorage.setItem(clave(), hoy);
    $("repOverlay").classList.remove("open");
    render();
  };

  const paso = () => {
    if (i >= items.length) {
      $("repSub").textContent = "Repaso completado";
      $("repBody").innerHTML = `<div class="naplica" style="font-size:.95rem">🎉 Todo al día. ¡Buen trabajo!</div>`;
      if (marcarHecho) localStorage.setItem(clave(), hoy);
      return;
    }
    const { c, s, f, actId } = items[i];
    $("repSub").textContent = `${i + 1} de ${items.length} · invitaciones sin respuesta`;
    $("repBody").innerHTML = `
      <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
        <div style="font-size:.95rem">¿<b>${esc(c.nombre)}</b> <span class="badge b-${c.mem}">${c.mem}</span> asistió a <b>${esc(s.n)}</b>?
          <span class="sfecha">invitado el ${fmtF(f)}</span>
        </div>
        ${!c.tel ? "" : `<div style="display:flex;gap:6px;flex-wrap:wrap">
          <button class="pmark off mini" data-escribir ${canal ? "" : `disabled title="Vincula tu WhatsApp en «Más → Mi WhatsApp» para enviarlo automáticamente"`}>⚡ Preguntarle en automático</button>
          <a class="pmark off mini" style="display:inline-block;text-decoration:none" target="_blank" rel="noopener" href="${esc(enlaceWa(c))}">↗ Ir al chat</a>
        </div>`}
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="pmark" data-r="si">✓ Sí asistió</button>
          <button class="pmark off" data-r="no">✗ No asistió</button>
          <button class="tbtn" data-r="skip">Saltar por hoy</button>
        </div>
      </div>`;
    const bEsc = $("repBody").querySelector("[data-escribir]");
    if (bEsc) bEsc.onclick = () => escribirle(c, bEsc);
    $("repBody").querySelectorAll("[data-r]").forEach(b => b.onclick = async () => {
      if (b.dataset.r === "si") {
        if (actId) {
          c.pun[actId] = { ...c.pun[actId], acc: f };
          // Si la actividad era un zoom de venta, esta respuesta también cierra
          // su etapa del embudo: es el mismo hecho, no dos.
          const campos = { puntuales: c.pun };
          if (syncZoom(c, actId, "hecha", f)) campos.zooms = c.zooms;
          await dbPatch(c, campos);
        } else {
          c.acc[s.id] = f;
          await dbPatch(c, { acc: c.acc });
        }
        toast(`✓ ${c.nombre.split(" ")[0]} asistió a «${s.n}»`);
      } else if (b.dataset.r === "no") {
        if (actId) {
          // Antes esto hacía `delete c.pun[actId]`, o sea borraba el registro
          // ENTERO — incluida una asistencia anterior si la hubiera. Responder
          // «no asistió» no puede destruir el historial de nadie. Ahora solo se
          // quita la invitación: sin `conf` deja de preguntarse, y `acc` (si
          // existe) se queda donde está.
          const { conf, ...resto } = c.pun[actId] || {};
          c.pun[actId] = resto;
          // «No asistió» a un zoom SÍ es un dato: deja la etapa con ✕ y su
          // fecha, que es como se sabe a quién hay que reagendar.
          const campos = { puntuales: c.pun };
          if (syncZoom(c, actId, "no_asistio", f)) campos.zooms = c.zooms;
          await dbPatch(c, campos);
          toast(`${c.nombre.split(" ")[0]} no asistió · anotado`);
        } else if (!c.acc[s.id]) {
          // El `if` es una red, no un adorno: `pendientes()` ya excluye a quien
          // asistió, pero borrar `conf` de alguien que sí fue lo devolvería a
          // «por invitar» y el estado se le habría corrido hacia atrás.
          delete c.conf[s.id];
          await dbPatch(c, { conf: c.conf });
          toast(`${c.nombre.split(" ")[0]} vuelve a «por invitar»`);
        }
      }
      i++;
      paso();
    });
  };

  $("repTit").textContent = "☀ Repaso del día";
  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };
  paso();
  $("repOverlay").classList.add("open");
}

/* ---------- entradas ---------- */

// Automático: una vez al día, al entrar.
export async function repasoDiario() {
  const hoy = hoyISO();
  await cargarHorarios();
  render();                                            // pinta el indicador
  if (new Date().getHours() < 7) return;               // antes de las 7 no molesta
  if (localStorage.getItem(clave()) === hoy) return;   // ya se hizo hoy
  const items = pendientes();
  if (!items.length) { localStorage.setItem(clave(), hoy); return; }
  abrir(items, true, await canalVinculado());
}

// A demanda: desde el indicador del header, sin importar el candado del día.
export async function repasoManual() {
  horarios = null;                 // a demanda: siempre con horarios frescos
  await cargarHorarios();
  const items = pendientes();
  if (!items.length) { toast("🎉 No hay invitaciones pendientes"); render(); return; }
  abrir(items, false, await canalVinculado());             // abrirlo a mano no marca el repaso del día
}
