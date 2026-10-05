# Invitaciones y asistencia

## Invitación específica de una actividad

`actividades.msg_invitacion` permite que una actividad puntual tenga su propio texto de invitación.

Reglas:

- `null` significa usar la plantilla normal del agente.
- Solo aplica a la invitación; recordatorios, enlace y confirmación mantienen sus plantillas normales.
- Solo tiene sentido en actividades puntuales. Una actividad de catálogo es recurrente y debe usar la plantilla general.
- El editor se mantiene plegado para no convertir el formulario en una pared de texto.
- Si se abre vacío, se puede sembrar con la plantilla del agente para editar desde una base existente.
- Esta invitación específica tiene prioridad sobre `invitacion_extra` genérica cuando el usuario decidió escribir el texto para ese caso concreto.

## Invitación propia del agente en actividad compartida

Tabla:

`invitaciones_agente (actividad_id, owner_id, texto)`

Existe porque el director puede crear y compartir una actividad puntual, pero cada agente necesita controlar el texto que sale desde su propio WhatsApp.

### Precedencia

De más específica a más general:

1. `invitaciones_agente`
2. `actividades.msg_invitacion`
3. plantilla del agente
4. plantilla del sistema

No cambiar este orden sin una decisión explícita.

### Propiedad

- El editor vive en el panel de programación cuando la actividad no pertenece al agente.
- El director no necesita leer el texto privado de sus agentes.
- Se guarda al programar, porque el valor persistido debe representar el texto con el que realmente salió esa tanda.
- Vaciar el texto elimina la personalización del agente y vuelve a la capa siguiente de precedencia.

## Invitación en serie (hasta 4 mensajes) — rama `invitacion-serie`, 06/10/2026

`actividades.serie_invitacion` (jsonb, `null` = un solo mensaje) guarda los mensajes 2..4:
`{modo: "usuario"|"mensaje", espera_min: 0..120, partes: [{texto, media}]}` (1..3 partes; la base
valida la forma con `serie_invitacion_ok`). Vale en catálogo y en puntual: no reemplaza la plantilla
ni `msg_invitacion`, la continúa. El mensaje 1 sigue la precedencia de siempre (incluida
`invitaciones_agente`); las partes son siempre las de la actividad.

- Cada parte se programa como `tipo = 'invitacion_parte'` con `parte` 2..4. Tipo propio porque el
  tope diario del worker solo frena `invitacion`/`masivo`: el tope decide en el mensaje 1 y, si salió,
  la serie llega entera. Y porque el cambio de hora regenera textos por tipo.
- Trigger `mensajes_cancela_partes`: si una parte pasa de `pendiente` a `cancelado`/`error`, se
  cancelan las siguientes de ese seguimiento. Basta sin tocar el worker porque éste re-verifica
  `sigue_pendiente()` antes de cada envío.
- El orden lo fija `enviar_en` (el worker envía cada agente en ese orden): `cuandoParte()` en
  `seguimiento.js`. Por usuario = A1 A2 A3 B1…; por mensaje = olas. Con minutos, por usuario mide la
  espera desde el mensaje anterior de ESA persona; por mensaje, desde el final estimado de la ola
  (`PASO_ENVIO` 7 s por mensaje).
- «Nada antes que la invitación» se extiende a la serie: el piso de los recordatorios es el ÚLTIMO
  mensaje de cada persona (al programar y al cambiar la hora). Si la serie terminaría después del
  inicio y alguien se quedaría sin el enlace, no se programa.

## La asistencia no retrocede

`acc[servicio]` y `puntuales[actividad].acc` representan un hecho histórico: la persona asistió.

**Nada automático debe borrar o degradar una asistencia ya registrada.**

Reglas:

- Reinvitar a alguien que ya asistió no modifica `acc` ni lo devuelve a un estado anterior.
- Si aún no asistió, una nueva invitación puede refrescar `conf` a la fecha vigente.
- Marcar "no asistió" no destruye historial anterior; solo retira la confirmación correspondiente cuando sea válido.
- Al cancelar un seguimiento de alguien que ya asistió, no ofrecer opciones que impliquen deshacer esa asistencia.
- Para servicios recurrentes, `acc` y `conf` son un valor por servicio, no una bitácora por cada actividad. La UI debe respetar esa limitación en vez de fingir una historia que el modelo no guarda.

## Asistencia de días pasados

Las actividades cerradas salen de la lista del día, pero sus seguimientos conservan la evidencia.

`renderPasadas()` ofrece una ventana de días anteriores para revisar asistencia después del evento.

Reglas importantes:

- Una actividad puntual con personas programadas debe seguir siendo revisable aunque no haya rastreo.
- Una actividad puede mezclar personas con token y sin token; no tratar a quien no tuvo rastreo como "no entró".
- `renderPasadas()` debe ejecutarse después de `cargarActividades()`, porque primero hay que determinar qué actividades ya están cerradas.

## Corrección manual de entradas

El panel de entradas distingue:

- entraron;
- abrieron tarde;
- no abrieron;
- personas sin enlace rastreado.

El clic es evidencia útil, no prueba perfecta de permanencia en la clase. La asistencia manual puede corregirse.

Cuando se corrige una actividad pasada, la fecha registrada debe corresponder al inicio de esa actividad, no al día en que se hace la corrección.

## Zooms y asistencia

Una actividad puntual puede representar una etapa de zoom mediante `actividades.zoom_tipo`.

- La etapa se copia al registro puntual para conservar contexto aunque la actividad luego se cierre o borre.
- `syncZoom()` solo empuja hacia adelante.
- Marcar asistencia puede marcar la etapa como realizada.
- Quitar asistencia no debe borrar automáticamente una etapa que pudo haberse registrado manualmente por otra vía.

## Código relacionado

- `public/js/seguimiento.js`
- `public/js/repaso.js`
- `public/js/data.js`
- `public/js/state.js`
- `public/js/ventas.js`

## Relacionado

- [[../03-domain/activities-followups]]
- [[tracked-links]]
- [[../03-domain/messaging-rules]]