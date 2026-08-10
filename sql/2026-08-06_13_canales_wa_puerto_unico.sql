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
--  ERA UNA VENDA; LA CURA YA SE APLICÓ. Desde el 08-08 el worker enruta por
--  `owner_id` (mapa `HOST_POR_OWNER` + `_ctx.host` por hilo, fijado en
--  `procesar_agente()`; sin host resuelto NO envía). Con eso el índice ya no
--  hace falta para que el sistema sea correcto.
--
--  DECISIÓN (08-10): EL ÍNDICE SE QUEDA de todos modos. Es una red barata
--  contra la falla exacta que costó un número: mientras los puertos sean
--  únicos entre las dos VM —trivial con <20 agentes—, una regresión en la
--  lógica de enrutamiento del worker no puede volver a cruzar envíos. El
--  único costo es no reutilizar el mismo número de puerto en VM1 y VM2, que
--  no cuesta nada. Solo reconsiderar si algún día se audita `worker.py` y se
--  confirma el enrutamiento por dueño a prueba de balas.
--
--  Para quitarlo, llegado ese caso:  drop index public.canales_wa_puerto_unico;
-- =====================================================================

create unique index if not exists canales_wa_puerto_unico
  on public.canales_wa (puerto);

comment on index public.canales_wa_puerto_unico is
  'Red de seguridad: aunque el worker ya enruta por owner_id (08-08), se mantiene para que un puerto repetido entre las dos VM sea imposible por construcción. Costó un número de WhatsApp cuando faltaba.';

-- Reasignación que se hizo junto con el índice, para poder crearlo:
--   Sofía Muñoz  8092 → 8192  (canal no vinculado, número bloqueado)
--   Leonardo     8189 → 8092  (vuelve a apuntar a su bridge real en la VM2)
