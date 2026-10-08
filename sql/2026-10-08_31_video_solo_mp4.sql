-- =====================================================================
--  Video adjunto: solo MP4 (se bloquea MOV y WEBM)
-- =====================================================================
--
--  POR QUÉ
--
--  Un video `.mov` (contenedor QuickTime, aun con H.264/AAC adentro) se sube
--  al CDN de WhatsApp y el bridge reporta «enviado», pero el teléfono del
--  destinatario lo descarta en silencio: no llega nada. WhatsApp solo entrega
--  video en contenedor MP4 válido. Ver brain/08-memory/known-issues.md KI-013.
--
--  El frontend no es frontera: `TIPOS_ADJUNTO`/`validarAdjunto` (state.js) ya
--  rechazan todo video que no sea `.mp4`, pero el bucket debe sostener el mismo
--  contrato para una subida directa que esquive la UI.
--
--  Se quitan `video/quicktime` (MOV) y `video/webm` (que el bridge tampoco
--  entrega como video: llegaría como adjunto). Único video permitido: MP4.
--  Los MIME de audio se conservan (la nota de voz sube como `audio/webm`).
-- =====================================================================

update storage.buckets
   set allowed_mime_types = array[
     'image/jpeg','image/png','image/webp','image/gif',
     'audio/webm','audio/mp4','audio/ogg','audio/mpeg','audio/aac','audio/x-m4a',
     'video/mp4'
   ]
 where id = 'mensajes';
