# Actividades y seguimientos

## Tipos de actividad

`servicio_id` puede ser nulo. En ese caso la actividad es puntual: lanzamiento, clase única u otro evento que no pertenece al catálogo y no debe contar para el progreso del servicio.

Una actividad `compartida` pertenece al director y puede ser utilizada por sus agentes para programar a sus propios clientes. El agente no adquiere permiso para editar o borrar la actividad del director.

## Lista visible

La operación normal muestra:

- actividades propias;
- actividades compartidas por el director.

No mezclar aquí las actividades de los agentes del director; esa información corresponde a supervisión.

## Ciclo de vida

### Eliminar

Antes de borrar una actividad se cancelan sus seguimientos activos y los mensajes pendientes asociados. El orden inverso puede dejar huérfanos difíciles de identificar.

### Cambiar la hora

Reprogramar los recordatorios pendientes respecto de la nueva hora. Regenerar el texto dependiente de la hora. Si un recordatorio queda en el pasado, cancelarlo.

La invitación no cambia su instante original de envío solo porque cambió la hora de la actividad, pero sí puede necesitar texto actualizado.

### Actividad compartida

El agente que no es dueño no la borra. Debe existir una operación separada para desmontar únicamente sus propios seguimientos.

## Seguimiento único activo

Un cliente no puede tener más de un seguimiento `activo` para la misma actividad. La base contiene una restricción/índice parcial para convertir esta regla en invariante y no en mera advertencia de UI.

Cancelar o completar libera la posibilidad de programar un nuevo seguimiento legítimo.

## Programación segura

- La selección nace vacía.
- Buscar oculta filas, pero nunca debe dejar una selección invisible sin que el usuario la conozca.
- Antes de programar se confirma la cantidad real de seleccionados.
- Los duplicados activos se omiten, no se dejan a decisión del usuario.

## Rastreo

Cada seguimiento rastreado tiene su propio `clic_token`. El token identifica a esa persona dentro de esa actividad y debe sobrevivir a reprogramaciones de mensajes.

Ver [[../04-features/tracked-links]] para reglas completas.

## Código relacionado

- `public/js/seguimiento.js`
- `public/js/repaso.js`
- `public/js/data.js`
- `public/js/state.js`
- migraciones históricas de actividades/seguimientos en `sql/`

## Relacionado

- [[messaging-rules]]
- [[../04-features/tracked-links]]
- [[../08-memory/dangerous-patterns]]