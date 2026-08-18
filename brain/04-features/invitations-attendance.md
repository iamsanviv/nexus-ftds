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