-- Vista tabla de Comunidad (23/11/2026, pedido de Sanviv): por cliente, su
-- necesidad y la recomendación de venta. Las dos las escribe el agente (en la
-- celda de la tabla o en el perfil) y, para los clientes de Sanviv, la IA que
-- lee sus chats de WhatsApp.
--
-- Columnas propias y no `nota`: `nota` es contexto libre y la IA no debe
-- pisarlo. `recomendacion` NULL = el panel muestra la que se deriva de la
-- etapa y del pago (embudo.js); con texto, ese texto manda.
--
-- No viajan en `mapAEditar`: se guardan campo por campo, así guardar el perfil
-- nunca pisa lo que la IA escribió mientras el formulario estaba abierto.
alter table public.clientes
  add column if not exists necesidad text,
  add column if not exists recomendacion text;

alter table public.clientes
  drop constraint if exists clientes_necesidad_largo,
  add constraint clientes_necesidad_largo check (char_length(necesidad) <= 1000),
  drop constraint if exists clientes_recomendacion_largo,
  add constraint clientes_recomendacion_largo check (char_length(recomendacion) <= 1000);
