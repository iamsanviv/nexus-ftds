-- =====================================================================
--  Invitación propia del AGENTE para una actividad que le comparten
--  Aplicado el 2026-08-12 con el MCP de Supabase.
-- =====================================================================
--
--  QUÉ FALTABA
--
--  El director crea las actividades puntuales y las comparte; los agentes
--  programan a sus clientes bajo esa actividad. Pero la invitación que sale
--  era la del director (`actividades.msg_invitacion`) o, si no la escribió,
--  la plantilla del agente. El agente no tenía forma de escribir un texto
--  propio para ESA actividad: el editor de `msg_invitacion` vive en el
--  formulario de la actividad, y una actividad ajena no la puede abrir.
--
--  QUÉ HACE ESTA TABLA
--
--  Guarda el texto de invitación de UN agente para UNA actividad. Solo afecta
--  a los seguimientos que programa él.
--
--  PRECEDENCIA (de más específica a más general), probada con 7 casos:
--    1. invitaciones_agente.texto   ← lo que el agente escribió para esta actividad
--    2. actividades.msg_invitacion  ← lo que puso el dueño de la actividad
--    3. plantillas_seguimiento      ← la plantilla de siempre del agente
--    4. PLANTILLAS_DEF              ← la del sistema
--  Gana la más específica porque es la que alguien se tomó el trabajo de
--  escribir para este caso concreto.
--
--  POR QUÉ UNA TABLA Y NO UN CAMPO EN `seguimientos`
--
--  El agente programa en tandas —va confirmando gente de a poquitos—, así que
--  el texto tiene que sobrevivir entre tandas. Guardarlo por seguimiento
--  obligaría a reescribirlo en cada una y acabaría con versiones distintas del
--  mismo mensaje para la misma actividad.
--
--  ALCANCE (RLS): cada quien SOLO ve y toca lo suyo
--
--  El director NO ve el texto de sus agentes, a propósito: la redacción de un
--  agente es suya, igual que sus plantillas. Es la misma razón por la que
--  `reprogramarPorHora()` solo regenera el texto de los seguimientos PROPIOS.
--
--  Políticas POR COMANDO, no `FOR ALL`: en `seguimientos` un FOR ALL con
--  WITH CHECK acabó bloqueando el UPDATE del director en silencio.
--
--  PROBADO (simulando sesiones, en transacción revertida):
--    | prueba                                        | resultado |
--    |-----------------------------------------------|-----------|
--    | agente ve solo su fila (de 2 que hay)         | 1 de 2    |
--    | agente lee la de otro agente                  | 0 filas   |
--    | agente edita la de otro agente                | sin efecto|
--    | agente edita la SUYA                          | 1 fila    |
--    | agente borra la de otro agente                | sin efecto|
--    | agente crea una A NOMBRE de otro              | bloqueado |
--    | director ve las de sus agentes                | 0 (a propósito) |
--
--  EN LA INTERFAZ
--
--  El editor va en el PANEL DE PROGRAMACIÓN (no en el formulario de la
--  actividad), plegado detrás de «✎ Personalizar mi invitación», y solo
--  aparece si la actividad NO es del agente — si es suya ya tiene el editor
--  del formulario, y dos sitios para lo mismo solo confunden.
--
--  Al abrirlo vacío se siembra con lo que HOY saldría (la del director, o su
--  plantilla): retocar es más fácil que escribir en una caja en blanco.
--  Se guarda al PROGRAMAR, no al escribir, para que lo guardado sea exactamente
--  el texto con el que salieron los mensajes. Vaciarlo borra la fila.
-- =====================================================================

create table if not exists public.invitaciones_agente (
  actividad_id uuid not null references public.actividades(id) on delete cascade,
  owner_id     uuid not null references public.profiles(id)   on delete cascade,
  texto        text not null,
  actualizado  timestamptz not null default now(),
  primary key (actividad_id, owner_id)
);

comment on table public.invitaciones_agente is
  'Invitacion propia de un agente para una actividad concreta (normalmente una que le comparte su director, que el no puede editar). Manda sobre actividades.msg_invitacion y sobre su plantilla. Solo afecta a los seguimientos que programa el.';

alter table public.invitaciones_agente enable row level security;

create policy inv_agente_select on public.invitaciones_agente
  for select using (owner_id = auth.uid());

create policy inv_agente_insert on public.invitaciones_agente
  for insert with check (owner_id = auth.uid());

create policy inv_agente_update on public.invitaciones_agente
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy inv_agente_delete on public.invitaciones_agente
  for delete using (owner_id = auth.uid());
