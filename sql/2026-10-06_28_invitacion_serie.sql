-- =====================================================================
--  Invitación en serie: hasta 4 mensajes por invitación
--  Rama de trabajo (todavía NO en producción del panel). Aditiva: columnas
--  nullable y un trigger que solo actúa sobre el tipo nuevo.
-- =====================================================================
--
--  QUÉ GUARDA
--
--  1. `actividades.serie_invitacion` (jsonb, null = invitación de un solo
--     mensaje, como siempre): los mensajes 2..4 y cómo se envían.
--       { "modo": "usuario" | "mensaje",   -- por persona o en olas
--         "espera_min": 0..120,            -- 0 = pausa natural del worker
--         "partes": [ { "texto": "...", "media": "<url>|null" }, … ] }  -- 1..3
--     El mensaje 1 sigue siendo la invitación de siempre (plantilla o texto
--     propio + imagen/video de la actividad o del servicio).
--
--  2. `mensajes_programados.parte` (2..4) con `tipo = 'invitacion_parte'`.
--     Tipo PROPIO y no 'invitacion' a propósito:
--       · el tope diario del worker solo frena 'invitacion' y 'masivo'. Así
--         el tope decide en el mensaje 1 y, si ese salió, la serie llega
--         ENTERA: nunca se corta a una persona entre el 2 y el 3;
--       · al cambiar la hora de la actividad el panel regenera el texto por
--         tipo; con el mismo tipo las cuatro partes quedarían con el texto 1.
--
--  POR QUÉ EL TRIGGER
--
--  Si una parte NO sale (tope del mensaje 1, error del bridge, cancelación),
--  las siguientes de esa persona no deben salir sueltas: «y además…» sin la
--  invitación no tiene sentido. El worker vuelve a preguntar si el mensaje
--  sigue pendiente antes de cada envío, así que cancelarlas aquí basta, sin
--  tocar el worker.
-- =====================================================================

alter table public.actividades
  add column if not exists serie_invitacion jsonb;

alter table public.mensajes_programados
  add column if not exists parte smallint;

-- Forma de la serie. En SQL y no solo en el panel: es lo que lee el panel de
-- TODOS los agentes de una actividad compartida.
create or replace function public.serie_invitacion_ok(s jsonb)
returns boolean
language sql
immutable
as $$
  select s is null or (
    jsonb_typeof(s) = 'object'
    and s->>'modo' in ('usuario', 'mensaje')
    and coalesce(s->>'espera_min', '') ~ '^[0-9]{1,3}$'
    and (s->>'espera_min')::int between 0 and 120
    and jsonb_typeof(s->'partes') = 'array'
    and jsonb_array_length(s->'partes') between 1 and 3
    and not exists (
      select 1 from jsonb_array_elements(s->'partes') p
      where jsonb_typeof(p) <> 'object'
         -- Cada parte lleva texto, adjunto o ambos; vacía no es un mensaje.
         or (coalesce(btrim(p->>'texto'), '') = '' and coalesce(p->>'media', '') = '')
         or length(coalesce(p->>'texto', '')) > 4000
    )
  )
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'actividades_serie_ok') then
    alter table public.actividades
      add constraint actividades_serie_ok check (public.serie_invitacion_ok(serie_invitacion));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'mensajes_parte_ok') then
    -- `parte` existe si y solo si es una parte de invitación, y es 2..4 (la 1
    -- es la fila 'invitacion' de siempre).
    alter table public.mensajes_programados
      add constraint mensajes_parte_ok check (
        (parte is null) = (tipo is distinct from 'invitacion_parte')
        and (parte is null or parte between 2 and 4)
      );
  end if;
end $$;

comment on column public.actividades.serie_invitacion is
  'Mensajes 2..4 de la invitación y cómo se envían (modo usuario|mensaje, espera_min). null = un solo mensaje.';
comment on column public.mensajes_programados.parte is
  'Número de parte (2..4) de una invitación en serie; solo con tipo invitacion_parte.';

-- Cascada: una parte que no sale cancela las siguientes de la misma persona.
create or replace function public.cancelar_partes_siguientes()
returns trigger
language plpgsql
set search_path to 'public'
as $$
begin
  update public.mensajes_programados
     set estado = 'cancelado',
         error  = 'omitido: la parte anterior de la invitación no salió'
   where seguimiento_id = new.seguimiento_id
     and tipo = 'invitacion_parte'
     and estado = 'pendiente'
     and parte > coalesce(new.parte, 1);
  return null;
end
$$;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'mensajes_cancela_partes') then
    create trigger mensajes_cancela_partes
      after update of estado on public.mensajes_programados
      for each row
      when (old.estado = 'pendiente'
            and new.estado in ('cancelado', 'error')
            and new.tipo in ('invitacion', 'invitacion_parte')
            and new.seguimiento_id is not null)
      execute function public.cancelar_partes_siguientes();
  end if;
end $$;
