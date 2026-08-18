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

El video debe permanecer deshabilitado mientras el worker vigente no tenga una rama explícita y comprobada para `video/*`.

Históricamente un `.mp4`/`.mov` podía terminar tratado como PTT. Del lado web ya existieron piezas de validación/previsualización, pero eso no significa que el contrato completo esté soportado.

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