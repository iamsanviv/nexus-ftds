# Envíos masivos

## Propiedad

Un usuario solo puede enviar y administrar campañas propias. Que un director pueda ver información de sus agentes no le autoriza a cancelar o enviar campañas en nombre de ellos.

## Progreso

El progreso real se calcula desde `mensajes_programados`. `campanas.total` representa lo encolado inicialmente; los estados de los mensajes representan qué ocurrió después.

No crear un segundo contador mutable de enviados/fallidos si puede derivarse de la cola real. Dos fuentes de verdad se desincronizan ante errores o reintentos.

## Varios mensajes por persona

Desde el 15/10/2026 un masivo lleva hasta 4 mensajes por persona, con el mismo editor y las mismas opciones que el seguimiento a leads (por usuario / por mensaje, pausa natural / minutos, escalonar). El orden lo decide `cuandoParte()` de `state.js`, compartida con leads y con la invitación en serie.

- mensaje 1 = `masivo` (lo frena el tope diario); 2..4 = `masivo_parte` (no lo frena);
- las filas del masivo **no llevan `cliente_id`**: Mi día cuenta un `masivo` con `cliente_id` como «le enviaste un seguimiento» al lead, y un saludo general no debe tachar esa tarea;
- por eso el trigger `mensajes_cancela_serie_lead` identifica a la persona por `cliente_id` cuando existe y por `telefono` dentro de la campaña cuando no (`sql/2026-10-15_38_masivo_en_serie.sql`). Si el mensaje 1 no sale, se cancela el resto de esa persona.

## Doble envío

El botón «Enviar» se bloquea antes del primer `await` (ver [[../08-memory/dangerous-patterns]] DP-010). El 15/10/2026 un doble clic durante `canalVinculado()` encoló la misma campaña dos veces, 161 ms aparte, y 25 personas recibieron el saludo doble.

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