# Medios adjuntos en mensajería

## Regla general

La aceptación de archivos debe ser coherente entre interfaz, JavaScript, Storage y worker. Si una capa admite un tipo que otra rechaza, el usuario ve fallos tardíos y poco claros.

## Fuentes que deben coincidir

Históricamente existen al menos tres lugares que describen tipos aceptados:

1. `accept` del `<input>` correspondiente;
2. `TIPOS_OK` en `public/js/masivo.js`;
3. `allowed_mime_types` del bucket de Supabase Storage.

El límite de tamaño del frontend y `file_size_limit` del bucket también deben expresar el mismo contrato.

No habilitar un MIME en una sola capa.

## Columnas de medios en mensajes programados

La documentación histórica distingue:

- `imagen_url`: columna sin uso efectivo en el flujo documentado;
- `media_url`: medio propio de un mensaje/actividad;
- `servicio_id`: permite que el worker resuelva la imagen vigente del catálogo al momento de enviar.

No enviar dos fuentes de imagen simultáneamente para el mismo mensaje salvo que el worker tenga un contrato explícito y probado para decidir precedencia.

## Imagen en el mensaje del link (05/11/2026)

Es de la ACTIVIDAD: `actividades.imagen_enlace`. Al programar, la fila «Enlace de la sala» tiene un chip «＋ Imagen»; solo el dueño de la actividad la pone o la quita (en ajenas se ve la miniatura, sin ✕). Solo imagen, no video. Recordatorios de 1 h y 15 min no la llevan (Sanviv pidió solo el link por ahora).

La base la aplica, no el panel (`sql/2026-11-05_61_imagen_enlace_actividad.sql`): un trigger BEFORE INSERT copia la imagen a cada mensaje `enlace` sin `media_url`, y otro, al cambiar `imagen_enlace`, la propaga a los `enlace` pendientes o retenidos de todos los seguimientos activos (de cualquier agente; security definer porque el dueño no ve filas ajenas por RLS). Una primera versión la ponía por tanda; Sanviv la quiso general para todos los que van a la actividad.

Probado 05/11: el worker entrega `media_url` en mensajes `enlace` (Sanviv lo recibió en su teléfono).

## Imagen de catálogo: resolución tardía

Las imágenes del servicio se resuelven al enviar para que un cambio de catálogo previo al envío use la versión vigente.

Esto contrasta deliberadamente con valores financieros como la comisión de una venta, que sí se congelan históricamente.

**Cada imagen nueva necesita URL nueva (20/10/2026).** La subida pisaba `servicios/<id>.<ext>` con `upsert`, así que la URL nunca cambiaba. La resolución tardía sí entregaba la URL vigente, pero la caché en disco del worker (clave por URL, ver [[../05-integrations/whatsapp-worker]]) y el CDN de Storage (`max-age=3600`) seguían sirviendo el archivo viejo: el panel mostraba la imagen nueva y WhatsApp recibía la anterior (caso «Nivel 0 a Avanzado», resubida el 20/10 16:45 UTC y aún enviada vieja 5 h después). Ahora `subirImagenServicio` sube a `<id>_<timestamp>.<ext>` sin `upsert` y `ui.js` borra la anterior solo después de que el catálogo guardó la nueva. El sufijo va en el nombre, no como `?v=`, porque el bridge decide el tipo por la extensión de la URL. Las imágenes subidas antes del arreglo conservan la URL fija: para que cambien hay que volver a subirlas una vez.

## Audio

La nota de voz ha estado oculta porque existieron casos en los que el archivo subía y el worker lo enviaba, pero WhatsApp no lo reproducía correctamente.

No reactivar audio por presencia de código. Hace falta prueba real de extremo a extremo: subida, envío, recepción y reproducción.

**11/11/2026:** la causa estaba en la conversión del worker (tiempos inválidos heredados de la grabación de Chrome, y estéreo). Arreglada y probada de extremo a extremo desde el panel (iPhone, Android, VM1 y VM2). Detalle y trampas de diagnóstico en [[../08-memory/known-issues]] KI-002.

## Editor de conversación: mensajes reordenables y nota de voz (11/11/2026, rama `mensajes-reordenables-voz`)

Los tres envíos en serie —**masivo**, **invitación de actividad** y **seguimiento a leads**— se editan con el mismo componente, `public/js/burbujas.js`: los mensajes (hasta 4) se ven como burbujas en el orden en que llegan y se reordenan arrastrando ⠿. La grabación vive en `public/js/grabadora.js`.

Tres reglas que pidió Sanviv:

1. **El orden de la lista es el orden de llegada**, sea texto, imagen, video o nota de voz.
2. **Cada mensaje se mueve entero**: su imagen o video viaja con él. Antes la imagen del catálogo quedaba anclada al primer mensaje.
3. **La nota de voz es un mensaje propio, sin texto.** WhatsApp no le pone pie a una nota de voz, y el worker manda el audio y luego el texto por su cuenta; al ser mensajes separados, el orden lo decide el agente. Un mensaje de texto no admite audio adjunto.

`burbujas.js` **no guarda nada propio**: es una vista sobre el estado que ya existía (mensaje 1 + arreglo de los mensajes 2..4), así que la cola y el worker no cambiaron. Una nota de voz es un mensaje con el audio en `media` (`a_<ts>.webm|m4a|ogg` en el bucket `mensajes`, subida al terminar de grabar) y `texto` vacío. El worker decide que es audio por la extensión.

- **Masivo**: el `textarea`, la imagen y la lista de partes siguen en el DOM dentro de un `hidden`; son el estado que lee `enviarSinCandado()`.
- **Leads**: escribe en `bor.mensajes`. La nota de voz queda **dentro de la plantilla** (`plantillas_lead.mensajes[].media`): quien use una plantilla ajena envía la voz de quien la grabó.
- **Invitación**: el mensaje 1 tiene respaldos (plantilla del agente, imagen del catálogo o de la actividad). Ver «El mensaje 1 de la invitación» en [[../03-domain/activities-followups]].

Limitación conocida: al mover el mensaje que mostraba la imagen **del catálogo**, esa URL queda copiada en la serie. Si después se cambia la imagen del servicio, el catálogo borra el archivo anterior y esa copia deja de existir (el worker manda entonces solo el texto). Las actividades son del día, así que casi no se nota; en una plantilla de leads no aplica (no hereda del catálogo).

Probado en navegador sin sesión (carga de módulos, reordenar, grabar con micrófono simulado, paneles de masivo y leads, arrastre real en el formulario de actividad). **No probado: ningún envío real con el editor nuevo.**

## Video

Habilitado en Masivo desde el 20/08/2026. Desde el **08/10/2026: SOLO MP4** (antes también MOV).

El bridge decide el tipo de mensaje por la **extensión del archivo**, no por el MIME que declara el navegador ni por el que guarda el Storage:

| extensión | qué manda el bridge |
|---|---|
| `mp4`, `mov`, `avi` | VideoMessage |
| `ogg` | AudioMessage con PTT |
| `jpg`, `png`, `gif`, `webp` | ImageMessage |
| **cualquier otra** | DocumentMessage |

De ahí las exclusiones deliberadas de la UI:

- **`mov` fuera (08/10/2026)**: el bridge SÍ lo mapea a video, pero WhatsApp no lo entrega aunque el worker diga «enviado» (contenedor QuickTime descartado en silencio) — ver [[../08-memory/known-issues]] KI-013. Se bloquea en tres capas: `TIPOS_ADJUNTO` ya no incluye `video/quicktime`, `validarAdjunto` exige además extensión `.mp4` para video (por si el navegador reporta un `.mov` como `video/mp4`), y el bucket `mensajes` ya no acepta `video/quicktime` ni `video/webm` (solo `video/mp4`);
- **`webm` fuera**: el bridge no tiene esa rama, así que llegaría como archivo adjunto. Es el mismo agujero que afecta a la nota de voz — ver [[../08-memory/known-issues]] KI-002;
- **`avi` fuera**: el bridge sí lo mapea, pero el bucket no acepta ese MIME.

**Ojo: el bridge no es el único que decide.** El `worker.py` clasifica el archivo ANTES; si lo cree audio lo convierte a ogg con `-vn` —que le quita la imagen— antes de que el bridge lo vea. Ahí estuvo el defecto que se cerró el 20/08: ver [[../08-memory/known-issues]] KI-003.

**Dónde se sube video:** el masivo y la invitación de una actividad. Los dos leen la misma lista de tipos, el mismo tope y el mismo validador desde `state.js`, y los dos ponen su `accept` desde esa constante en vez de escribirlo en el HTML — antes se desfasaban y un formulario ofrecía lo que el otro rechazaba.

**El texto viaja como pie del adjunto**, en el mismo mensaje. La única excepción es la nota de voz, que no admite pie y manda el texto aparte.

El `VideoMessage` no manda `Seconds`, `Width/Height` ni miniatura. Faltando eso la vista previa sale sosa, pero el video SÍ se reproduce si el contenedor es MP4 válido.

**`.mov` NO llega aunque el worker diga «enviado» (06/10/2026).** Un `.mov` (contenedor QuickTime,
aunque adentro sea H.264/AAC) se sube al CDN de WhatsApp y el bridge reporta `Media uploaded OK` +
`Message sent true`, pero el cliente del destinatario lo **descarta en silencio**: no muestra nada,
ni un recuadro de error. El mensaje de texto del mismo flujo sí llega, así que se nota cuando un
mensaje con video «desaparece». La fila queda `enviado` en la base: no es un bug de estado, es que
WhatsApp acepta pero no entrega el `.mov`. La mención de «solo MP4 y MOV» más arriba solo quiere
decir que el filtro los ADMITE, no que ambos lleguen; el end-to-end con `.mov` nunca se había
probado a un teléfono real. **Workaround vigente:** subir el video como `.mp4` (confirmado que
llega). **Arreglo pendiente (no aplicado):** que `worker.py` remuxee todo video a MP4 limpio
(`ffmpeg -c copy -movflags +faststart`, sin recomprimir cuando ya es H.264/AAC) antes de
entregarlo al bridge. Ver `08-memory/known-issues.md`.

## Regla operativa

Antes de activar un nuevo tipo de medio:

1. verificar MIME y tamaño en UI;
2. verificar Storage;
3. verificar qué columna/URL llega a `mensajes_programados`;
4. verificar worker real;
5. realizar envío real desde un canal de prueba;
6. comprobar recepción en WhatsApp.

## Código relacionado

- `public/js/masivo.js`
- `public/index.html`
- lógica de mensajes en `public/js/`
- worker externo documentado en `../05-integrations/whatsapp-worker.md`

## Relacionado

- [[mass-messaging]]
- [[../05-integrations/whatsapp-worker]]
- [[../08-memory/known-issues]]