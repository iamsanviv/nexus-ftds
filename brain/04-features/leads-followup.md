# Leads · seguimiento (embudo, contactos y temperatura)

Código: `public/js/leads.js` (reglas + sección «Seguimiento» de la tarjeta),
integrado en `ui.js` (`cardHTML`/`wireCards`). Datos: `sql/2026-10-05_27_leads_seguimiento.sql`.

## Fases
- F1 (DB) aplicada · F2 (tarjeta) · F3 panel «Hoy» · F4 «bajaron hoy».
- Estado: EN PRODUCCIÓN (`main`) desde 06/10/2026, incluido el envío de seguimiento en serie
  y la opción «escalonar entre leads». La columna `entrante_en` y el parche de `chats_sync`
  están en VM1; VM2 aún sin publicar `chats_recientes` (los leads que escriben por un canal de
  VM2 no mueven temperatura hasta que se instale allí).

## Embudo
`registro_broker + registro_en` (abrió cuenta) → `promesa_en` (prometió depositar: fecha y hora,
guardada como `-05:00`) → depósito. El depósito NO tiene columna: es `ftds` + paso a `Beca`, y llama
`ftd.ajustarDeclarado(c,+1)` porque es un FTD nuevo que no estaba en lo declarado.
Los campos del embudo no viajan en `mapAEditar`: guardar la ficha no debe pisarlos.

## Temperatura (acordada con el usuario)
- Promesa: hoy/futura caliente, vencida 1–2 días tibio, 3+ frío.
- Señal del lead (última respuesta «sí» o registro, la más reciente): mismo corte por días.
- Sin contactos: según llegada (`creado` o `created_at`).
- Contactado sin respuesta: tibio desde el primer contacto; 3+ días frío.
- Corrección a mano: vale mientras `temp_manual_en` sea posterior al último contacto.

## Categoría (una sola, la más alta)
pend (promesa) > reg (registro) > hoy (llegó hoy) > bajo (respondió hoy; F4 lo cambia a «escribió hoy») > ayer > resto.

## Panel «Hoy» (`public/js/hoy.js`, rediseño «riel» 05/10/2026)
- Leads abre en «Hoy» (`state.leadsVista`); «Todos los leads» es la lista de siempre.
- Solo leads PROPIOS y activos: es una lista de trabajo y las acciones son del dueño.
- Mismo manejador que la tarjeta (`leads.manejarLead`): las dos vistas no pueden divergir.
- Arriba, la meta del día (`ftd.renderMetaHoy`): tarjeta `.metacard` translúcida dorada (la
  del FTD en Personas), anillo con hechos/meta, «N prometieron hoy» y el corte como barra.
  Sin `overflow:hidden` para no recortar el globo de la ⓘ (el brillo se dibuja dentro).
- Debajo, un RIEL con las 6 etapas en orden de prioridad (icono y color propios, conteo y un
  dato corto). Se elige una y se listan sus leads; abre en la primera con leads. En escritorio
  el riel es una fila fija de 6. «Siguiente etapa» salta a la próxima con leads.
- Escritorio (≥1040 px): el panel llega a 1120 px; la meta va en una fila (día | corte, con
  «faltan N en D días» solo aquí) y los leads de la etapa en columnas de ≥380 px.
- Ya NO hay filtro por temperatura en «Hoy»: el diseño aprobado lo quitó; la temperatura se
  ve en cada lead y se filtra en «Todos los leads».
- Pendientes: hoy y próximos por hora ascendente, luego vencidos (más reciente arriba).
- `ritmoMeta` cuenta solo las promesas de hoy: `metaHoy = max(reparto, min(pendHoy + hechosHoy,
  falta))`. Se suman los hechos de hoy porque un pendiente que deposita deja de ser lead y la
  meta no debe bajar al cumplirse.

## «Bajaron hoy» y temperatura automática (F4)
- `chats_recientes.entrante_en` = último mensaje ENTRANTE (is_from_me=0), que publica
  `chats_sync.py` en la misma lectura que ya hace (no agrega sondeos). `ultimo_en` NO
  sirve: es el último mensaje en cualquier dirección y se mueve cuando el agente escribe.
- El panel lo cruza por teléfono (`state.entrantes`, dígitos→fecha). Se pide UNA vez al
  entrar a Leads (`ui.js`, guard `state.entrantes===null`), filtrado a los últimos días.
- `senalReciente(c)` elige la señal más nueva entre: te escribió (entrante), registro en
  el broker y «Me respondió» a mano. La usan `tempAuto` y `razon` para no contradecirse.
- Categoría `bajo` = escribió hoy (entrante de hoy, o «Me respondió» de hoy).
- Un mensaje entrante mueve la temperatura igual que una respuesta: «te escribió hoy» → caliente.

## Hora de la promesa: opcional (05/10/2026)
`promesa_en` sigue siendo `timestamptz`. La hora es OPCIONAL en el formulario; cuando no la
dan, se guarda con segundos `:01` (`${f}T00:00:01-05:00`) como marca de «sin hora»: un
`<input type=time>` solo produce `:00`, así que la marca no colisiona con ninguna hora real
y no hace falta una columna aparte. `leads.sinHora(ts)` lo detecta (`getUTCSeconds()===1`) y
`cuandoHora(ts)` muestra la fecha con o sin hora según eso. No afecta temperatura ni categoría
(son por día). El orden de pendientes usa el instante guardado (una promesa sin hora cae a ~medianoche).

## La vista de Leads no muestra invitaciones (05/10/2026)
A diferencia de Comunidad, las tarjetas de lead NO renderizan la grilla de actividades
(`grupos`), ni el conteo «✦ N invitaciones», ni los contadores/filtros «Con/Sin actividad»,
ni el orden «Más comprometidos». Las invitaciones siguen disponibles en Seguimiento masivo y
por actividad; solo salieron de la vista de Leads. En su lugar: tarjetas de conteo por
temperatura (Calientes/Tibios/Fríos) que filtran la lista (`state.filtroTemp`), y el orden
«cerca» de leads ordena por temperatura (`TEMP_ORD`). `cardHTML` omite `grupos` y la línea
`.pct` cuando es lead.

## Envío de seguimiento a leads (`public/js/envioleads.js`, 06/10/2026)
- Botón «Enviar seguimiento» en Leads (Hoy y Todos los leads). Es un MASIVO a leads: los
  destinatarios salen de `destinatariosMasivo()` (el cuello del masivo, exportado de masivo.js)
  filtrado a `esLead`. No es una tercera vía de envío.
- Serie de 1 a 4 mensajes (texto y/o adjunto), por usuario / por mensaje, pausa natural / minutos:
  mismo `cuandoParte()` (state.js) que la invitación en serie.
- `{hora}` y `{zona}` SÍ funcionan (09/10/2026), igual que en el masivo: el agente elige UNA hora de
  referencia (`ldHoraRef`, visible solo si algún mensaje la menciona) y a cada persona le llega
  convertida a su huso (`resolverLead` → `horaDeCliente`/`etiquetaZona` con `c.tzOff`). `{dia}` sigue
  bloqueado: un seguimiento no cuelga de una actividad, así que no hay día de evento. La hora de
  referencia es una sola para toda la tanda (lo que cambia por persona es el huso, no la hora anunciada).
- Escalonar entre leads (`plantillas_lead.escalona`, 06/10/2026): «por usuario + minutos» separa por
  N min los mensajes DENTRO de la serie de cada lead, pero entre leads el arranque va al ritmo del
  worker (~7 s), así que los saludos salen casi juntos en la vista de salida del agente. Con
  `escalona=true`, cada lead ARRANCA N min después del anterior (saludos a 0, N, 2N…), a costa de que
  la tanda entera tarde más. Solo aplica en por usuario con minutos; se ignora en el resto. En
  `cuandoParte`: `base + (i+k)*espera + i` (el `+i` solo desempata el instante). Cada lead sigue
  recibiendo SU serie separada por N min; el amontonamiento que el agente veía era solo en su salida.
- `plantillas_lead` guarda flujos reutilizables (nombre, tipo, mensajes, modo, espera, escalona), privadas.
- Campaña con `campanas.lead_tipo` (los 6 tipos de `lead_contactos`); cada fila con `cliente_id`.
  Mensaje 1 = `masivo` (lo frena el tope), 2..4 = `masivo_parte` (no). Orden por `enviar_en`, sin
  `parte` (un seguimiento no se re-genera por cambio de hora).
- Triggers: `mensajes_cancela_serie_lead` cancela lo que sigue de ese lead si uno no sale;
  `mensajes_registra_contacto_lead` anota el contacto (tipo = lead_tipo, nota = nombre de la campaña,
  `en` = hora real de envío) cuando el mensaje 1 pasa a `enviado`. Al programar no se anota nada.
- La selección arranca vacía; «Marcar visibles» solo toca lo filtrado; se confirma con nombres.
- Aviso de cuota diaria (`data.cuotaDiaria`, TOPE_DIARIO=220 que refleja el worker): el footer
  muestra lo que llevas hoy y, si la tanda no cabe, cuántos leads no saldrán; el confirm lo repite.
  Mismo aviso en el masivo. El registro de envíos ya muestra el motivo también de los CANCELADOS.

## Pendiente de depósito por bróker — 2º depósito de un becado (`promesa_broker`, 09/10/2026)
Alguien que ya es Beca (depositó en un bróker) puede quedar pendiente de depositar en OTRO. Antes
imposible: la promesa (`promesa_en`) era un solo dato sin bróker y Pendientes exigía `mem = 'Lead'`.

- `clientes.promesa_broker` (SQL `2026-10-09_32`): null = promesa sin bróker (lead en su 1er depósito,
  histórico); con valor = pendiente de depósito en ese bróker. NO va en `mapAEditar` (como
  registroBroker/promesaEn): guardar la ficha no pisa el embudo. Mapeado como `promesaBroker` (data.js).
- Selector «+ Pendiente de depósito» en el panel «Hoy» (`public/js/pendep.js`, modal `pdOverlay`):
  elige a CUALQUIER persona propia activa con algún bróker libre (leads y becados), bróker a depositar
  (solo los que no tiene), fecha y hora opcional. Es la opción B del mockup aprobado; escribe
  `promesa_en + promesa_broker` directo, no abre vía nueva. El botón se ve aunque no haya leads.
- «Hoy» (`hoy.js`): `mios` incluye ahora los becados propios con `promesaEn && promesaBroker`; caen en
  «Pendientes» (categoria() mira promesaEn). Fila con badge «2º depósito · <bróker>» cuando no es lead.
- Registrar el depósito (`leads.okDeposito`): el FTD se SUMA a `ftds` (`{...c.ftds,[brk]:f}`, NO
  reemplaza) y la promesa se limpia (`promesa_en` + `promesa_broker`). Un lead además pasa a Beca; un
  becado conserva su `mem`. `comunidad_desde` lo recalcula el trigger (FTD más antiguo): en un 2º
  depósito no cambia. `ajustarDeclarado(+1)` corre igual (es un FTD nuevo del mes).
- Meta (`state.js ritmoMeta`): `pendHoy` cuenta la promesa de hoy de un lead Y la de un becado con
  `promesa_broker` (ambas son un FTD esperado hoy).

## Cancelar un envío masivo persona por persona (09/10/2026)
En el detalle de «Envíos masivos» (`seguimiento.abrirCampana`, modal `repOverlay`), cada persona EN
COLA tiene un botón `✕` que cancela SOLO su mensaje (`estado='cancelado'` por id). Si es parte de una
serie de leads, la base cancela el resto de SU secuencia (trigger `mensajes_cancela_serie_lead`), por
eso el detalle se RECARGA de la base tras cancelar (no voltea la fila a mano). Sigue estando el botón
de cancelar la campaña entera; esto es el grano fino que faltaba.

## Autorización
Solo el dueño (`owner_id === me`) ve acciones; la base lo sostiene: el trigger fija el dueño del
contacto y la política exige `owner_id = auth.uid()`. El director ve, no registra.
