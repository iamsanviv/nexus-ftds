# Leads · seguimiento (embudo, contactos y temperatura)

Código: `public/js/leads.js` (reglas + sección «Seguimiento» de la tarjeta),
integrado en `ui.js` (`cardHTML`/`wireCards`). Datos: `sql/2026-10-05_27_leads_seguimiento.sql`.

## Fases
- F1 (DB) aplicada · F2 (tarjeta) · F3 panel «Hoy» · F4 «bajaron hoy».
- Estado: toda la lógica vive en la rama `main-jvpvtk` (vista previa), aún NO en `main`.
  La columna `entrante_en` y el parche de `chats_sync` en VM1 YA están en producción
  (inofensivos para `main` actual, que no lee la columna). VM2 aún sin `chats_recientes`.

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

## Panel «Hoy» (F3, `public/js/hoy.js`)
- Leads abre en «Hoy» (`state.leadsVista`); «Todos los leads» es la lista de siempre.
- Solo leads PROPIOS y activos: es una lista de trabajo y las acciones son del dueño.
- Mismo manejador que la tarjeta (`leads.manejarLead`): las dos vistas no pueden divergir.
- Pendientes: hoy y próximos por hora ascendente, luego vencidos (más reciente arriba).
- «El resto» plegado, salvo con filtro de temperatura activo.
- Meta de hoy arriba (`ftd.renderRitmoEn`). `ritmoMeta` cuenta solo las promesas de hoy:
  `metaHoy = max(reparto, min(pendHoy + hechosHoy, falta))`. Se suman los hechos de hoy
  porque un pendiente que deposita deja de ser lead y la meta no debe bajar al cumplirse.

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

## La vista de Leads no muestra invitaciones (05/10/2026)
A diferencia de Comunidad, las tarjetas de lead NO renderizan la grilla de actividades
(`grupos`), ni el conteo «✦ N invitaciones», ni los contadores/filtros «Con/Sin actividad»,
ni el orden «Más comprometidos». Las invitaciones siguen disponibles en Seguimiento masivo y
por actividad; solo salieron de la vista de Leads. En su lugar: tarjetas de conteo por
temperatura (Calientes/Tibios/Fríos) que filtran la lista (`state.filtroTemp`), y el orden
«cerca» de leads ordena por temperatura (`TEMP_ORD`). `cardHTML` omite `grupos` y la línea
`.pct` cuando es lead.

## Autorización
Solo el dueño (`owner_id === me`) ve acciones; la base lo sostiene: el trigger fija el dueño del
contacto y la política exige `owner_id = auth.uid()`. El director ve, no registra.
