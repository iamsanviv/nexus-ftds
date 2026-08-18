# Envíos masivos

## Propiedad

Un usuario solo puede enviar y administrar campañas propias. Que un director pueda ver información de sus agentes no le autoriza a cancelar o enviar campañas en nombre de ellos.

## Progreso

El progreso real se calcula desde `mensajes_programados`. `campanas.total` representa lo encolado inicialmente; los estados de los mensajes representan qué ocurrió después.

No crear un segundo contador mutable de enviados/fallidos si puede derivarse de la cola real. Dos fuentes de verdad se desincronizan ante errores o reintentos.

## Cancelación

Cancelar una campaña solo debe afectar mensajes todavía `pendiente`. Lo ya enviado no puede recuperarse y la UI debe decirlo con claridad.

## Actualización inmediata

Después de encolar un masivo, refrescar la sección de campañas sin obligar al agente a recargar la página. La sección puede desplegarse automáticamente en ese momento porque el usuario acaba de ejecutar la acción y necesita confirmar su estado.

## Detalle de campaña

Al abrir una campaña mostrar el texto base de la campaña y el resultado por persona.

Prioridad de grupos para acción operativa:

1. fallidos;
2. pendientes/en cola;
3. enviados.

No tomar al azar el texto de un mensaje individual como texto representativo: los mensajes pueden contener variables, snippets o nombre ya resuelto. La campaña conserva la intención/base común.

## Historial de segmentos

El historial de destinatarios se comparte entre programación de actividades y masivos. La persistencia común vive en `data.js` (`guardarHistorialSegmento`).

La identidad lógica del segmento usa `clave` para acumular tandas de la misma actividad/campaña en vez de crear entradas fragmentadas:

- `act:<actividad_id>`
- `cam:<campana_id>`

La unión es acumulativa. La poda del historial se aplica al crear nuevas claves, no al actualizar una existente.

## Código relacionado

- `public/js/masivo.js`
- `public/js/data.js`
- `public/js/seguimiento.js`
- `mensajes_programados`
- `campanas`

## Relacionado

- [[../03-domain/messaging-rules]]
- [[../08-memory/dangerous-patterns]]