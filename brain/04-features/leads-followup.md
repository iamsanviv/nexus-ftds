# Leads · seguimiento (embudo, contactos y temperatura)

Código: `public/js/leads.js` (reglas + sección «Seguimiento» de la tarjeta),
integrado en `ui.js` (`cardHTML`/`wireCards`). Datos: `sql/2026-10-05_27_leads_seguimiento.sql`.

## Fases
- F1 (DB) aplicada · F2 (tarjeta del lead) · F3 panel «Hoy» · F4 «bajaron hoy» real desde chats_sync.

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

## Autorización
Solo el dueño (`owner_id === me`) ve acciones; la base lo sostiene: el trigger fija el dueño del
contacto y la política exige `owner_id = auth.uid()`. El director ve, no registra.
