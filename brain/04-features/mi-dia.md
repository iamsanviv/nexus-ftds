# Mi día · guía personal del agente

Código: `public/js/midia.js` (vista `state.vista === "midia"`), cableado en `ui.js`
(`render`, `renderShell`, pestaña `#tabMiDia`) y `auth.js` (pantalla de inicio).
Especificación: entrevista con el usuario del 14/10/2026 (36 preguntas, hilo «Guía del día para agentes»).

## Alcance actual (fases 1 y 2)
- Solo para los usuarios de `MI_DIA_USUARIOS` (`midia.js`); para ellos es la pantalla de inicio.
- Una tarjeta «Ahora» y bloques en el orden del usuario: Repaso → leads de WhatsApp →
  leads de HighLevel → posibles ventas (cobros) → clase de hoy. Bloque fijo «Lo que Nexus hizo por ti hoy».
- Urgencias: lo que tiene hora (promesa de hoy con hora, clase de hoy sin invitados)
  sube al frente 1 hora antes. Cierre del día a las 21:00.
- **Lead de HighLevel recién llegado** (asignado hoy, sin intentos, resultado ni
  siguiente paso) va primero en «Ahora», por encima de urgencias y del repaso
  («Nuevo · Ahora», decisión del 15/10/2026). Si hay varios, el que más espera
  primero. Deja de serlo al anotar cualquier resultado de llamada.

## Reglas («hecho» se deriva, no se marca)
- Repaso: `repasoPendientes() === 0`. Se puede **saltar por hoy** (botón en «Ahora» o enlace en la fila): sale de «Ahora», no cuenta como listo, sigue en «Pasa a mañana» y se puede retomar. El salto se guarda en `localStorage` (`nexus:midia:salto-repaso:<usuario>` = fecha) y caduca solo al cambiar el día.
- Leads de WhatsApp: solo etapas `pend`, `reg`, `bajo`, `hoy` (las de `leads.categoria`).
  Atendido = contacto registrado hoy, o le escribiste hoy por WhatsApp: `chats_recientes.ultimo_en`
  de hoy y posterior a `entrante_en`, **excluyendo** si coincide (±2 min) con un
  `mensajes_programados` enviado a ese teléfono — un recordatorio automático no es «atenderlo».
- Cobros: ventas propias `abierta` con `fecha_pago <= hoy`; hecho con un abono de hoy.
  `fecha_pago` es fecha sin hora: nunca sube como urgencia.
- Clase de hoy: actividades activas de hoy propias o compartidas. Sin ninguna → «Crea la clase de hoy».
  Hecho con al menos un seguimiento propio no cancelado.

- Tarjeta de un lead de WhatsApp: «Abrir chat», «Enviar seguimiento» (abre el envío de
  `envioleads.js` con `soloId`: SOLO esa persona marcada, porque la eligió con el clic; ahí elige
  una plantilla guardada) y «Ver en Leads» (lleva al panel «Hoy» en su etapa, donde se
  anota el contacto/promesa/depósito). El seguimiento cuenta como «atendido» DESDE QUE SE PONE
  EN COLA (pedido del usuario, 14/10/2026: el worker tarda): mensaje 1 (`tipo='masivo'`) con
  `cliente_id`, `enviar_en` de hoy y estado distinto de `error`/`cancelado`. Si termina en
  error o cancelado deja de contar y el lead vuelve a la guía en el siguiente refresco (≤2 min).
  No se escribe nada nuevo: se deriva de `mensajes_programados` (no tiene `created_at`).

## HighLevel (fase 2)
- El agente no tiene token de la API (usuario de subcuenta): los leads llegan **empujados**.
  Un workflow suyo («contacto asignado a mí» → Webhook POST) llama a la Edge Function
  `supabase/functions/highlevel-lead` con `?t=TOKEN`. El token es suyo (`crm_tokens`,
  creado desde «Conectar» en el bloque HighLevel); la función lo resuelve a `owner_id`
  con service role y es la única que inserta en `crm_leads` (upsert por `owner_id, ghl_id`,
  sin pisar las anotaciones del agente). SQL: `sql/2026-10-14_35_crm_leads.sql`.
- RLS estricta `owner_id = auth.uid()` (select/update); sin insert/delete para authenticated.
- En la guía: asignados hoy o ayer, o con `vuelve_en`/`siguiente_en` hoy. «Hecho» = resultado
  de llamada de hoy + «Le escribí» (`escribi_en`, manual).
- No contestó / Buzón: 1.er intento vuelve en 2 h, 2.º mañana, 3.º → `fuera`.
  Número equivocado / No le interesa → `fuera`. Contestó → el agente elige
  `bajara` / `crm` (con fecha) / `llamada` (fecha y hora).
- Bajó a WhatsApp: manual (crea cliente Lead si no hay uno con ese teléfono) o automático
  cuando hay un entrante propio (`entranteDe`) posterior a `asignado_en`.

## Leads de HighLevel en Leads «Hoy» (14/10/2026, decisiones del usuario)
- El lead entra como PERSONA de Nexus (lead) al llegar: la Edge Function lo enlaza con quien ya
  tenga ese número (`claveTel`) o lo crea, y guarda `crm_leads.cliente_id`. Si ya existía, queda
  `estado='bajo'` (ya era de WhatsApp). Leads anteriores: backfill en `sql/2026-10-14_36`.
- «Por bajar» NO es columna: `crm.js porBajar(c)` = tiene `crm_leads` con estado ≠ `bajo` y sin
  entrante posterior a `asignado_en`. `fuera` cuenta como por bajar (nunca llegó a WhatsApp).
- Por bajar ⇒ SIN envíos automáticos: excluido en `destinatariosMasivo` (masivo y envioleads) y
  en `seguimiento.js mios()` (invitaciones). Su seguimiento es desde el CRM. `state.crm` se carga
  con las personas (`data.cargarCrm`) para que esos filtros nunca lo vean vacío por timing.
- «Hoy»: dentro de cada etapa, grupo «HighLevel · por bajar» primero y luego «WhatsApp»; naranja
  `#E8833A`. Acciones = las de Mi día (`crm.accionesCrm`, compartidas) + embudo (abrió cuenta,
  promesa, depósito). Sin «Enviar seguimiento». Al bajar pasa al grupo WhatsApp con «vino de HighLevel».
- Si no baja: en «Hoy» solo hasta «Llegaron ayer»; después solo el día que vuelve por fecha
  (`vuelve_en`/`siguiente_en`) o el día que sale (`fuera`). Sigue en «Todos los leads».
- «Te escribieron» para un lead HL: automático si escribe por WhatsApp (y entonces ya bajó) o
  manual «Me respondió en el CRM» (`crm_leads.respondio_en`, lo lee `leads.categoria`).
- En Mi día los por bajar NO salen en el bloque WhatsApp (van en su bloque HighLevel).

## Pendiente (fase 3, definida con el usuario)
- Interesados (manual + sugeridos desde 5 clases asistidas) con fecha de próximo seguimiento.
- Tareas propias con hora (tabla nueva).
