-- =====================================================================
--  canales_wa.puerto ÚNICO — venda para un fallo que costó un número
--  Aplicado el 2026-08-06 con el MCP de Supabase, en caliente.
-- =====================================================================
--
--  QUÉ PASÓ
--
--  Al repartir bridges en dos máquinas, dos canales quedaron con el mismo
--  puerto:
--
--      Sofía Muñoz   → localhost:8092
--      Leonardo      → 10.0.0.23:8092
--
--  `worker.py` guarda el mapa de máquinas indexado SOLO por puerto:
--
--      HOST_POR_PUERTO = {c["puerto"]: c["host"] or "localhost" ...}
--
--  Con el puerto repetido, una entrada pisó a la otra. Los mensajes de
--  Leonardo se enviaron a `localhost:8092` — el bridge de Sofía — así que
--  salieron **desde el WhatsApp de ella** hacia contactos de él.
--
--  Alcance medido: 173 mensajes a 35 personas distintas, entre el 06/08
--  18:00 y el 07/08 19:12 (hora Bogotá). WhatsApp le bloqueó el número a
--  Sofía: para ellos era un número escribiéndole a 35 desconocidos.
--
--  LA CAUSA DE FONDO
--
--  El puerto identificaba un bridge sin ambigüedad **mientras hubo una
--  sola máquina**. Al partirla en dos, dejó de ser un identificador y
--  nadie lo notó, porque el diccionario no se queja: simplemente pisa.
--  Un identificador solo es único dentro del alcance donde se creó.
--
--  QUÉ HACE ESTE ÍNDICE
--
--  Convierte ese fallo silencioso en uno ruidoso: repetir un puerto ahora
--  revienta al escribir, en vez de cruzar los envíos entre agentes.
--
--  ES UNA VENDA, NO LA CURA. La cura es que el worker enrute por
--  `owner_id` —lo único único de verdad— pasando el host junto al puerto
--  a través de `puerto_de()` y `procesar_agente()`. El parche está escrito
--  en `contexto-worker.md`, pendiente de aplicar.
--
--  CUANDO SE APLIQUE ESA CURA, QUITAR ESTE ÍNDICE:
--
--      drop index public.canales_wa_puerto_unico;
--
--  Con enrutamiento por dueño, dos máquinas pueden reutilizar el mismo
--  número de puerto sin ningún problema, y este índice estorbaría.
-- =====================================================================

create unique index if not exists canales_wa_puerto_unico
  on public.canales_wa (puerto);

comment on index public.canales_wa_puerto_unico is
  'Temporal: el worker indexa host por puerto, así que un puerto repetido cruza los envíos entre agentes. Quitar cuando worker.py enrute por owner_id.';

-- Reasignación que se hizo junto con el índice, para poder crearlo:
--   Sofía Muñoz  8092 → 8192  (canal no vinculado, número bloqueado)
--   Leonardo     8189 → 8092  (vuelve a apuntar a su bridge real en la VM2)
