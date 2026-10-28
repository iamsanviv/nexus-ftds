-- =====================================================================
--  Invitación propia del agente: también imagen/video y mensajes extra
-- =====================================================================
--  Pedido de Sanviv (28/10/2026): al programar una actividad ajena (del
--  director o global del admin) el agente ve la imagen con la que sale la
--  invitación y puede cambiarla, y agregar o cambiar los mensajes 2..4, igual
--  que ya podía personalizar el texto.
--
--  Se guarda en la misma fila de `invitaciones_agente` porque es la misma
--  decisión —«así sale MI invitación de esta actividad»— con la misma
--  propiedad (solo su dueño la lee y escribe) y el mismo momento de guardado
--  (al programar).
--
--  Precedencia de cada pieza, de más específica a más general:
--    texto: invitaciones_agente.texto → actividades.msg_invitacion → plantilla
--    media: invitaciones_agente.media → actividades.imagen → imagen del servicio
--    serie: invitaciones_agente.serie → actividades.serie_invitacion
--
--  `texto` deja de ser obligatorio: la fila puede existir solo por la imagen.
--  `serie` con `partes: []` significa «sin mensajes extra» aunque la
--  actividad traiga los suyos; null significa «los de la actividad».
-- =====================================================================

alter table public.invitaciones_agente
  add column if not exists media text,
  add column if not exists serie jsonb;

alter table public.invitaciones_agente alter column texto drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'inv_agente_serie_ok') then
    alter table public.invitaciones_agente
      add constraint inv_agente_serie_ok check (
        serie is null
        or public.serie_invitacion_ok(serie)
        or (jsonb_typeof(serie) = 'object'
            and jsonb_typeof(serie->'partes') = 'array'
            and jsonb_array_length(serie->'partes') = 0)
      );
  end if;
  -- Una fila sin nada que personalizar no significa nada: se borra.
  if not exists (select 1 from pg_constraint where conname = 'inv_agente_algo') then
    alter table public.invitaciones_agente
      add constraint inv_agente_algo check (
        coalesce(btrim(texto), '') <> '' or media is not null or serie is not null
      );
  end if;
end $$;

comment on column public.invitaciones_agente.media is
  'Imagen o video propio del agente para su invitación de esta actividad. Manda sobre actividades.imagen y la del servicio. null = la de la actividad.';
comment on column public.invitaciones_agente.serie is
  'Mensajes 2..4 propios del agente (misma forma que actividades.serie_invitacion). partes vacío = ninguno. null = los de la actividad.';
