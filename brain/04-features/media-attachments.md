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

## Imagen de catálogo: resolución tardía

Las imágenes del servicio se resuelven al enviar para que un cambio de catálogo previo al envío use la versión vigente.

Esto contrasta deliberadamente con valores financieros como la comisión de una venta, que sí se congelan históricamente.

## Audio

La nota de voz ha estado oculta porque existieron casos en los que el archivo subía y el worker lo enviaba, pero WhatsApp no lo reproducía correctamente.

No reactivar audio por presencia de código. Hace falta prueba real de extremo a extremo: subida, envío, recepción y reproducción.

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