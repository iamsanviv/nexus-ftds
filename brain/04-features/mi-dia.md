# Mi día · guía personal del agente

Código: `public/js/midia.js` (vista `state.vista === "midia"`), cableado en `ui.js`
(`render`, `renderShell`, pestaña `#tabMiDia`) y `auth.js` (pantalla de inicio).
Especificación: entrevista con el usuario del 14/10/2026 (36 preguntas, hilo «Guía del día para agentes»).

## Alcance actual (fases 1 y 2)
- Solo para los usuarios de `MI_DIA_USUARIOS` (`midia.js`); para ellos es la pantalla de inicio.
- Bloques («pasos») en el orden del usuario: leads de WhatsApp →
  leads de HighLevel → posibles ventas (cobros) → clase de hoy. «Lo que Nexus hizo por ti hoy» siempre visible (total + detalle plegado).

## Diseño «paso a paso» (20/10/2026, alternativa B elegida por el usuario)
- Reemplazó la barra de puntos («16 de 41 listos», un punto por tarea sin decir de
  qué bloque era: el usuario no la entendía) y la tarjeta «Ahora» con cinco botones.
- Arriba: meta de hoy en una línea (`metaHoyDatos`, `ftd.js`) y los pasos visibles
  como pestañas con `hechos/total` y barra; numerados 1..N en el orden en que se ven.
  En escritorio caben todos en una fila; en el teléfono se desplazan.
- Abajo: solo la lista del paso elegido. Cada fila = nombre + etiqueta de color +
  dato corto (`razonCorta`, `leads.js`, mismas reglas que `razon`). Orden en la
  lista: pendientes → en espera → hechos. Una fila abierta a la vez con sus acciones;
  por defecto la de «Ahora» (`cola`). Lead de WhatsApp: «Abrir chat» y «Seguimiento»
  a la vista; embudo, «Ver en Leads» y «Pasar» en una fila secundaria.
- Estado de vista solo en memoria (`pasoSel`, `filaSel`): tocar otro paso se queda
  ahí; un aviso «Ahora …» devuelve al foco. La fila elegida a mano se suelta cuando
  cambia de pendiente a hecha, para que la guía avance sola.
- Corte de la semana y «Nexus hizo» van en dos tarjetas pequeñas (abajo en el
  teléfono, columna derecha en escritorio).
- Urgencias: lo que tiene hora (promesa de hoy con hora, clase de hoy sin invitados)
  sube al frente 1 hora antes. Cierre del día a las 21:00.
- **Lead de HighLevel recién llegado** (asignado hoy, sin intentos, resultado ni
  siguiente paso) va primero en «Ahora», por encima de urgencias
  («Nuevo · Ahora», decisión del 15/10/2026). Si hay varios, el más reciente
  primero.
- **Dentro de cada bloque** (15/10/2026): primero lo agendado para hoy (promesa con
  hora, llamada o reintento, clase), el más próximo antes; luego el resto del más
  reciente al más antiguo (`prog`/`rec` en `itemsDelDia`, `porTiempo`). Reciente =
  último movimiento: te escribió, contacto, promesa, llegada/asignación, respuesta
  en el CRM, fecha de pago. Deja de serlo al anotar cualquier resultado de llamada.

## Reglas («hecho» se deriva, no se marca)
- Repaso de asistencias: **ya no está en Mi día** (quitado el 16/10/2026 a pedido del usuario; antes se podía saltar por hoy). Sigue el indicador del encabezado y el repaso automático al entrar (`repaso.js`).
- Leads de WhatsApp **por temperatura** (`leads.temperatura`, decisión del 16/10/2026):
  bloques «En la mira» (calientes, todos), «Recuperar tibios» (tope 10) y
  «Recuperar fríos» (tope 5). En los topes entran primero los ya atendidos hoy y
  luego los de movimiento más reciente (`TOPE_T`, `BLOQUE_T` en `midia.js`). La
  etapa (`categoria`) sigue en el subtítulo y en la hora de la promesa. Un lead
  contactado hoy sin respuesta pasa a tibio (regla de `leads.js`) y se ve en ese
  bloque como hecho.
  Atendido = contacto registrado hoy, o le escribiste hoy por WhatsApp: `chats_recientes.ultimo_en`
  de hoy y posterior a `entrante_en`, **excluyendo** si coincide (±2 min) con un
  `mensajes_programados` enviado a ese teléfono — un recordatorio automático no es «atenderlo».
- Cobros: ventas propias `abierta` con `fecha_pago <= hoy`; hecho con un abono de hoy.
  `fecha_pago` es fecha sin hora: nunca sube como urgencia.
- Clase de hoy: actividades activas de hoy propias, compartidas por el director o del admin para todos. Sin ninguna → «Crea la clase de hoy».
  Hecho con al menos un seguimiento propio no cancelado.

- Tarjeta de un lead de WhatsApp: «Abrir chat», «Enviar seguimiento» (abre el envío de
  `envioleads.js` con `soloId`: SOLO esa persona marcada, porque la eligió con el clic; ahí elige
  una plantilla guardada) y «Ver en Leads» (lleva al panel «Hoy» en su etapa, donde se
  anota el contacto/promesa/depósito). El seguimiento cuenta como «atendido» DESDE QUE SE PONE
  EN COLA (pedido del usuario, 14/10/2026: el worker tarda): mensaje 1 (`tipo='masivo'`) con
  `cliente_id`, `enviar_en` de hoy y estado distinto de `error`/`cancelado`. Si termina en
  error o cancelado deja de contar y el lead vuelve a la guía en el siguiente refresco (≤2 min).
  No se escribe nada nuevo: se deriva de `mensajes_programados` (no tiene `created_at`).

## HighLevel (fase 2)
- El agente no tiene token de la API (usuario de subcuenta): los leads llegan **empujados**.
  Un workflow suyo («contacto asignado a mí» → Webhook POST) llama a la Edge Function
  `supabase/functions/highlevel-lead` con `?t=TOKEN`. El token es suyo (`crm_tokens`,
  creado desde «Conectar» en el bloque HighLevel); la función lo resuelve a `owner_id`
  con service role y es la única que inserta en `crm_leads` (upsert por `owner_id, ghl_id`,
  sin pisar las anotaciones del agente). SQL: `sql/2026-10-14_35_crm_leads.sql`.
- RLS estricta `owner_id = auth.uid()` (select/update); sin insert/delete para authenticated.
- El teléfono llega en formato **nacional** cuando es colombiano («318 5506790», sin +57):
  la función le antepone +57 a móviles de 10 dígitos que empiezan por 3. Sin eso no cruza
  con WhatsApp y la ficha lo guarda como «+318…» (pasó el 15/10/2026). `payload` queda crudo.
- En la guía: asignados hoy o ayer, o con `vuelve_en`/`siguiente_en` hoy. «Hecho» = resultado
  de llamada de hoy + «Le escribí» (`escribi_en`, manual).
- No contestó / Buzón: 1.er intento vuelve en 2 h, 2.º mañana, 3.º → `fuera`.
  Número equivocado / No le interesa → `fuera`. Contestó → el agente elige
  `bajara` / `crm` (con fecha) / `llamada` (fecha y hora).
- Bajó a WhatsApp: manual (crea cliente Lead si no hay uno con ese teléfono) o automático
  cuando hay un entrante propio (`entranteDe`) posterior a `asignado_en`.

## Leads de HighLevel en Leads «Hoy» (14/10/2026, decisiones del usuario)
- El lead entra como PERSONA de Nexus (lead) al llegar: la Edge Function lo enlaza con quien ya
  tenga ese número (`claveTel`) o lo crea, y guarda `crm_leads.cliente_id`. Si ya existía, queda
  `estado='bajo'` (ya era de WhatsApp). Leads anteriores: backfill en `sql/2026-10-14_36`.
- «Por bajar» NO es columna: `crm.js porBajar(c)` = tiene `crm_leads` con estado ≠ `bajo` y sin
  entrante posterior a `asignado_en`. `fuera` cuenta como por bajar (nunca llegó a WhatsApp).
- Por bajar ⇒ SIN envíos automáticos: excluido en `destinatariosMasivo` (masivo y envioleads) y
  en `seguimiento.js mios()` (invitaciones). Su seguimiento es desde el CRM. `state.crm` se carga
  con las personas (`data.cargarCrm`) para que esos filtros nunca lo vean vacío por timing.
- «Hoy»: dentro de cada etapa, grupo «HighLevel · por bajar» primero y luego «WhatsApp»; naranja
  `#E8833A`. Acciones = las de Mi día (`crm.accionesCrm`, compartidas) + embudo (abrió cuenta,
  promesa, depósito). Sin «Enviar seguimiento». Al bajar pasa al grupo WhatsApp con «vino de HighLevel».
- Si no baja: en «Hoy» solo hasta «Llegaron ayer»; después solo el día que vuelve por fecha
  (`vuelve_en`/`siguiente_en`) o el día que sale (`fuera`). Sigue en «Todos los leads».
- «Te escribieron» para un lead HL: automático si escribe por WhatsApp (y entonces ya bajó) o
  manual «Me respondió en el CRM» (`crm_leads.respondio_en`, lo lee `leads.categoria`).
- Tarjeta (`crm.accionesCrm`, 20/10/2026, pedido del usuario): cuatro grupos separados por línea:
  **Llamada** (número + botón «Llamar» solo si `telColombia`; resultados, con «Número equivocado» y
  «No le interesa» discretos), **Chat en HighLevel** (Le escribí / Me respondió), **Avance**
  (Bajado a WA + embudo de la pantalla) y **Nota**. La nota es `clientes.nota` de la persona
  enlazada (la misma de su ficha, no `notas_cliente`); se guarda al salir del campo
  (`crm.manejarNotas`) y sin `cliente_id` no aparece.
- En Leads «Hoy» esa tarjeta va **plegada** por defecto (`hoy.js hlAbiertos`): el encabezado
  muestra nombre, temperatura, razón y el ícono de llamar (+57); se abre tocando el encabezado o
  el chevrón. Queda abierta tras una acción y se abre sola si hay un formulario del lead abierto.
- Botón de llamar (`tel:`) solo para +57 de 10 dígitos (`state.telColombia`): también en las
  filas de leads de WhatsApp de Mi día, como ícono junto a «Abrir chat» y «Seguimiento».
- En Mi día los por bajar NO salen en el bloque WhatsApp (van en su bloque HighLevel).

## Pendiente (fase 3, definida con el usuario)
- Interesados (manual + sugeridos desde 5 clases asistidas) con fecha de próximo seguimiento.
- Tareas propias con hora (tabla nueva).

## Embudo y «Pasar al siguiente» en «Ahora» (16/10/2026)

- La tarjeta de un lead de WhatsApp trae el paso del embudo que toca (Depositó/Reagendar,
  Prometió depositar o Creó cuenta) con el mismo formulario y lógica de `leads.js`
  (`form`, `manejarLead`), como el panel «Hoy».
- Toda fila abierta tiene «Pasar» (vuelve en 30 min): el ítem queda
  en espera (no hecho) y vuelve solo. Se guarda en `localStorage`
  (`nexus:midia:pospuestos:<usuario>` = {id: ms}); «Atender ahora» dentro de la fila lo trae de vuelta.
- El repintado de cada minuto se salta si hay un campo con foco, para no borrar un formulario a medio llenar.

## «Bajado a WA» (16/10/2026)

El antiguo «Bajó a WhatsApp» se llama **«Bajado a WA»** con ícono de descargar (`ICO_BAJAR`, `crm.js`).
Aparece en la tarjeta de un lead de HighLevel por bajar en «Mi día», en Leads «Hoy» y,
desde esta fecha, también en su tarjeta de «Todos los leads» (`ui.js`, `marcarBajo`).
