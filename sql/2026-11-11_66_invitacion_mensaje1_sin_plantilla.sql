-- =====================================================================
--  Invitación: el mensaje 1 puede ir sin plantilla o sin imagen heredada
--  Rama `mensajes-reordenables-voz`. Aditiva: solo AFLOJA una validación.
-- =====================================================================
--
--  QUÉ CAMBIA EN EL PANEL
--
--  Los mensajes de una invitación se editan como conversación y se reordenan
--  arrastrando. Dos cosas nuevas pueden pasar con el PRIMERO:
--
--    · es una nota de voz (o solo una imagen/video): va SIN la plantilla;
--    · la imagen del catálogo se movió con su mensaje a otro lugar: el primero
--      va SIN imagen heredada.
--
--  Eso se guarda en la misma serie (jsonb), sin columnas nuevas:
--
--      { "modo": …, "espera_min": …, "partes": [ … ],
--        "m1": { "sin_texto": true|false, "sin_media": true|false } }
--
--  `m1` solo se escribe cuando marca algo. Una invitación de siempre se guarda
--  exactamente igual que antes.
--
--  POR QUÉ HACE FALTA TOCAR LA BASE
--
--  `serie_invitacion_ok` exigía de 1 a 3 `partes`. Una invitación que es UNA
--  sola nota de voz no tiene mensajes 2..4, pero sí necesita `m1.sin_texto`:
--  con la regla vieja no se podía guardar en `actividades.serie_invitacion`.
--  (`invitaciones_agente.serie` ya admitía `partes: []`.)
--
--  Ahora se admiten 0 partes SOLO si `m1` marca algo: una serie vacía y sin
--  marcas sigue siendo inválida (para eso está null).
--
--  El worker no cambia: una invitación sin texto es una fila con `texto = ''`
--  y el audio en `media_url`, igual que la nota de voz de un masivo.
-- =====================================================================

create or replace function public.serie_invitacion_ok(s jsonb)
returns boolean
language sql
immutable
as $$
  -- El `coalesce(…, false)` de fuera importa: en un CHECK, NULL cuenta como
  -- válido. Sin él, una serie a la que le falta una clave (o vacía y sin
  -- marcas) daba NULL y pasaba la restricción. La versión anterior de esta
  -- función tenía ese mismo hueco para una serie sin `modo`.
  select s is null or coalesce((
    jsonb_typeof(s) = 'object'
    and s->>'modo' in ('usuario', 'mensaje')
    and coalesce(s->>'espera_min', '') ~ '^[0-9]{1,3}$'
    and (s->>'espera_min')::int between 0 and 120
    and jsonb_typeof(s->'partes') = 'array'
    and jsonb_array_length(s->'partes') between 0 and 3
    and (s->'m1' is null or jsonb_typeof(s->'m1') = 'object')
    -- Sin mensajes 2..4 la serie solo existe para marcar cómo va el primero.
    and (
      jsonb_array_length(s->'partes') > 0
      or coalesce(s->'m1'->'sin_texto' = 'true'::jsonb, false)
      or coalesce(s->'m1'->'sin_media' = 'true'::jsonb, false)
    )
    and not exists (
      select 1 from jsonb_array_elements(s->'partes') p
      where jsonb_typeof(p) <> 'object'
         -- Cada parte lleva texto, adjunto o ambos; vacía no es un mensaje.
         or (coalesce(btrim(p->>'texto'), '') = '' and coalesce(p->>'media', '') = '')
         or length(coalesce(p->>'texto', '')) > 4000
    )
  ), false)
$$;

comment on column public.actividades.serie_invitacion is
  'Mensajes 2..4 de la invitación y cómo se envían (modo usuario|mensaje, espera_min). m1 = cómo va el mensaje 1 (sin_texto: sin plantilla, p. ej. nota de voz; sin_media: sin imagen heredada). null = un solo mensaje, de siempre.';
