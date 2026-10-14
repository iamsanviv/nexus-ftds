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

## Reglas («hecho» se deriva, no se marca)
- Repaso: `repasoPendientes() === 0`.
- Leads de WhatsApp: solo etapas `pend`, `reg`, `bajo`, `hoy` (las de `leads.categoria`).
  Atendido = contacto registrado hoy, o le escribiste hoy por WhatsApp: `chats_recientes.ultimo_en`
  de hoy y posterior a `entrante_en`, **excluyendo** si coincide (±2 min) con un
  `mensajes_programados` enviado a ese teléfono — un recordatorio automático no es «atenderlo».
- Cobros: ventas propias `abierta` con `fecha_pago <= hoy`; hecho con un abono de hoy.
  `fecha_pago` es fecha sin hora: nunca sube como urgencia.
- Clase de hoy: actividades activas de hoy propias o compartidas. Sin ninguna → «Crea la clase de hoy».
  Hecho con al menos un seguimiento propio no cancelado.

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

## Pendiente (fase 3, definida con el usuario)
- Interesados (manual + sugeridos desde 5 clases asistidas) con fecha de próximo seguimiento.
- Tareas propias con hora (tabla nueva).
