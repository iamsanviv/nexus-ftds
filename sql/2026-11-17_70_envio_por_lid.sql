-- =====================================================================
--  70 · Enviar a quien no tiene número visible (por su identidad oculta)
-- =====================================================================
--
--  POR QUÉ
--
--  Desde SQL 69 se puede registrar a alguien sin número (`clientes.wa_lid`),
--  pero no escribirle: todo el envío viaja por `mensajes_programados.telefono`.
--  El bridge sí acepta un JID completo (`<lid>@lid`) como destinatario.
--
--  `destino_lid` LO PONE LA BASE, NUNCA EL PANEL
--
--  El trigger lo deriva de la ficha del cliente (por `cliente_id` o por el
--  seguimiento) y pisa lo que venga en la fila. Así:
--  - nadie puede apuntar un mensaje a una identidad arbitraria escribiendo la
--    columna (sería mandar a un desconocido desde el WhatsApp del agente);
--  - solo se usa si el cliente es del MISMO dueño que el mensaje: la regla de
--    oro de envío (`owner_id`) se sostiene también aquí.
--  Con teléfono, `destino_lid` queda NULL: el teléfono sigue mandando, igual
--  que antes. El worker NUNCA convierte la identidad en número: sus dígitos
--  serían el teléfono de otra persona.
--
--  Sin teléfono ni identidad la fila se RECHAZA. Hasta hoy no existe ni un
--  mensaje sin teléfono (17/11/2026: 0 de ~68.600), así que no rompe nada.
--
--  PREGUNTA ANTES DEL LINK
--
--  `procesar_preguntas_link` lee la respuesta en `chats_recientes`, que cruza
--  por teléfono. Para alguien sin número nunca vería un «sí» y le CANCELARÍA
--  el link del Zoom («no confirmó a tiempo»). Por eso su pregunta nace
--  cancelada y le llegan los recordatorios normales, como a quien escribe a un
--  WhatsApp que no publica respuestas.
-- =====================================================================

alter table public.mensajes_programados add column if not exists destino_lid text;

alter table public.mensajes_programados drop constraint if exists mensajes_destino_lid_formato;
alter table public.mensajes_programados add constraint mensajes_destino_lid_formato
  check (destino_lid is null or destino_lid ~ '^[0-9]{6,20}$');

create or replace function public.mensaje_destino_lid()
returns trigger
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_cliente uuid;
  v_lid text;
  v_owner uuid;
begin
  -- Lo que venga del panel no cuenta: se deriva siempre de la ficha.
  new.destino_lid := null;
  if nullif(btrim(coalesce(new.telefono, '')), '') is not null then
    return new;
  end if;
  new.telefono := null;

  v_cliente := new.cliente_id;
  if v_cliente is null and new.seguimiento_id is not null then
    select s.cliente_id into v_cliente from public.seguimientos s where s.id = new.seguimiento_id;
  end if;
  if v_cliente is not null then
    select c.wa_lid, c.owner_id into v_lid, v_owner from public.clientes c where c.id = v_cliente;
    if v_lid is not null and v_owner = new.owner_id then
      new.destino_lid := v_lid;
    end if;
  end if;

  if new.destino_lid is null then
    raise exception 'mensaje sin destinatario: la persona no tiene teléfono ni chat de WhatsApp tuyo'
      using errcode = '23514';
  end if;

  if new.tipo = 'pregunta_link' and new.estado = 'retenido' then
    new.estado := 'cancelado';
    new.error := 'omitido: sin número no se puede leer su respuesta';
  end if;
  return new;
end $$;

drop trigger if exists mensajes_destino_lid on public.mensajes_programados;
create trigger mensajes_destino_lid
  before insert or update of telefono, destino_lid, cliente_id, seguimiento_id
  on public.mensajes_programados
  for each row execute function public.mensaje_destino_lid();
