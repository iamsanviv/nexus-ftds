# Mi día · guía personal del agente

Código: `public/js/midia.js` (vista `state.vista === "midia"`), cableado en `ui.js`
(`render`, `renderShell`, pestaña `#tabMiDia`) y `auth.js` (pantalla de inicio).
Especificación: entrevista con el usuario del 14/10/2026 (36 preguntas, hilo «Guía del día para agentes»).

## Alcance actual (fase 1)
- Solo para los usuarios de `MI_DIA_USUARIOS` (`midia.js`); para ellos es la pantalla de inicio.
- Una tarjeta «Ahora» y bloques en el orden del usuario: Repaso → leads de WhatsApp →
  posibles ventas (cobros) → clase de hoy. Bloque fijo «Lo que Nexus hizo por ti hoy».
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

## Pendiente (fases 2 y 3, definidas con el usuario)
- HighLevel: webhook desde un workflow del agente al quedar asignado; llamar y escribir;
  resultados Contestó/No contestó/Buzón/Número equivocado/No le interesa; reintento a las 2 h
  y al día siguiente; solo hoy y ayer; paso a WhatsApp automático por teléfono o manual.
- Interesados (manual + sugeridos desde 5 clases asistidas) con fecha de próximo seguimiento.
- Tareas propias con hora (tabla nueva).
