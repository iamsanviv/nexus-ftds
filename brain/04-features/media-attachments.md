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

Habilitado en Masivo desde el 20/08/2026, **solo MP4 y MOV**.

El bridge decide el tipo de mensaje por la **extensión del archivo**, no por el MIME que declara el navegador ni por el que guarda el Storage:

| extensión | qué manda el bridge |
|---|---|
| `mp4`, `mov`, `avi` | VideoMessage |
| `ogg` | AudioMessage con PTT |
| `jpg`, `png`, `gif`, `webp` | ImageMessage |
| **cualquier otra** | DocumentMessage |

De ahí las dos exclusiones deliberadas de la UI:

- **`webm` fuera**: el bucket lo acepta pero el bridge no tiene esa rama, así que llegaría como archivo adjunto. Es el mismo agujero que hoy afecta a la nota de voz — ver [[../08-memory/known-issues]] KI-002;
- **`avi` fuera**: el bridge sí lo mapea, pero el bucket no acepta ese MIME.

La nota anterior decía que `.mp4`/`.mov` llegaban como nota de voz porque el bridge «solo tenía rama para imagen». Verificado contra la VM el 20/08: eso no es cierto del binario en uso, que sí trae las tres cadenas `video/*` compiladas. Queda la duda de qué se observó realmente en la prueba del 30/07; ver [[../08-memory/known-issues]] KI-003.

El `VideoMessage` no manda `Seconds`, `Width/Height` ni miniatura. Son opcionales: el video se reproduce, pero la vista previa en el chat puede salir sosa.

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