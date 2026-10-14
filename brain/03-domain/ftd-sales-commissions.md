# FTD, ventas y comisiones

## Moneda

El módulo de ventas trabaja en dólares.

## Comisión de producto

La comisión es un monto fijo por producto, no un porcentaje. Al crear la venta se congela el valor de comisión aplicable en ese momento. El catálogo sirve como valor por defecto para ventas nuevas; no debe modificar retroactivamente ventas históricas.

`comision = 0` significa **sin definir**, no "sin comisión". Una comisión indefinida no debe sumar como si fuera una cifra conocida.

## Saldada

No guardar un booleano redundante. La venta está saldada cuando la suma de abonos alcanza o supera el valor. La comisión se causa según las reglas del mes en que el abono completa el valor.

## Facturado

La base conceptual es lo recaudado. Existe una regla empresarial explícita controlada por `FACTURA_VALOR_AL_SALDAR` en `state.js`: cuando una venta termina de pagarse en un mes, ese mes puede contabilizar el valor completo de la venta como facturado, aunque existieran abonos anteriores. Esa duplicación temporal es intencional y responde al criterio comercial vigente; no "corregirla" sin validar primero la regla de negocio.

## Abonos

Cada abono tiene identidad propia y debe poder corregirse en su fila. La fecha importa porque determina el mes contable/comercial. Un abono cero no representa una operación válida; para eliminar un abono se elimina la fila.

## Upgrade

Un upgrade cobra la diferencia de precio entre producto nuevo y producto previo y comisiona la diferencia entre sus comisiones. La comisión del pago inicial no se vuelve a causar.

Beca -> membresía no se trata como upgrade pagado porque la beca no representa un producto previo cobrado que deba descontarse.

## Broker del FTD

El FTD se hacía en **ExOption** y se está trasladando a **IQ Option**. El broker es una propiedad del depósito, no de la persona, y una misma persona puede tener **un FTD por broker**, cada uno con su fecha.

Por eso `clientes.ftds` es un mapa `broker -> fecha` (jsonb) y no una columna: hereda el RLS de `clientes` en vez de duplicar `puede_ver_de`, y la lista de brokers queda como dato en `BROKERS` (`state.js`), no como esquema. `comunidad_desde` pasó a ser derivado —el FTD más antiguo— y lo mantiene el trigger `trg_clientes_sync_comunidad`.

**Consecuencia sobre el pago, decidida a propósito:** un segundo depósito de alguien que YA estaba en la comunidad cuenta como un FTD más del mes en que ocurre, y por lo tanto puede subir un escalón de `metas_ftd`. Trasladar gente existente paga igual que traer gente nueva. El desglose de la tarjeta separa esos casos bajo la etiqueta «trasladados», que es **derivada** (la persona tiene una fecha anterior en otro broker) y **no se resta** de ningún broker: esos depósitos ya están contados en el suyo.

## FTD mensual

El cálculo combina datos declarados y datos cargados según las reglas implementadas en `public/js/ftd.js` y `public/js/state.js`. Al borrar un cliente que había aumentado el FTD del mes, la parte declarada debe deshacerse cuando corresponda para mantener simetría con la creación.

No reimplementar el cálculo desde cero sin revisar las funciones vigentes y las reglas históricas de `sql/2026-07-29_08_ftd_reales_y_metas.sql` y cambios posteriores.

## Código relacionado

- `public/js/ftd.js`
- `public/js/state.js`
- `public/js/data.js`
- módulo de ventas correspondiente en `public/js/`
- SQL histórico de ventas/comisiones y FTD en `sql/`

## Relacionado

- [[../01-product/current-state]]
- [[../08-memory/dangerous-patterns]]
## Meta de hoy y corte semanal (2026-10-05)

`ritmoMeta()` en `state.js`; se pinta en la tarjeta de FTD (`ftd.js`, `ritmoHtml`).

- **Cuatro cortes:** 1–7, 8–14, 15–21 y **22–fin** (los días 29–31 se suman a la cuarta semana; decidido por el usuario el 2026-10-05: un corte de 3 días no sirve como cierre). Cada corte pide el **acumulado** proporcional: `ceil(meta × díaFinBloque ÷ díasDelMes)`, y el último pide la meta entera. Lo que falte en una semana pasa solo al siguiente corte.
- **Meta de hoy** = lo que falta para el corte, medido con lo hecho **hasta ayer** (para que no baje mientras se trabaja hoy), repartido en enteros (mayor resto) entre los días que le quedan al bloque con **peso por día**: entre semana 1, sábado 0,6, domingo 0,4.
- **Pendientes de hoy** (leads propios con `promesa_en` de hoy) suben la meta de hoy si son más, sin pasar de lo que falta. `ritmoMeta` los cuenta solo y les suma los FTD ya hechos hoy, para que la meta no baje cuando un pendiente deposita (deja de ser lead). Ver `04-features/leads-followup.md`.
- Cuentan los FTD **reales**, no solo los cargados (pedido del usuario el 2026-10-14): los reportados sin cargar (`sinSubir`) se suman a lo hecho **hasta ayer**, porque no tienen fecha. Bajan la meta de hoy y suben el «llevas» del corte sin tocar los «hechos hoy». Si se cargan después con fecha anterior a hoy, nada se mueve; si se cargan con fecha de hoy, pasan a «hechos hoy» y la meta de hoy puede subir lo mismo.
- La meta base es la de `progresoMeta` (la propia del agente o, si no tiene, la siguiente de comisión).
- La explicación vive detrás de la ⓘ: el usuario pidió la tarjeta limpia, sin texto.

## Tarjeta de FTD en Comunidad (2026-10-14)

Diseño «Limpio» elegido por el usuario entre tres mockups (`ftd.js`, `renderBloqueFtd`). Una sola plantilla: móvil apila y escritorio (≥1040 px) pone tres columnas: **mes** (FTD reales / meta, barra, desglose por broker y «sin subir»), **ritmo** (meta de hoy y corte) y **comisión**. Las acciones (ajustar números, cambiar metas, meses anteriores) viven en el menú ⋯.

- **Meta de hoy lleva distintivo** (variante «Sello», elegida por el usuario): fondo dorado suave, borde, diana y la fecha («Hoy · mié 14», solo en escritorio).
- **Comisión actual** = `f.pago` (escalón alcanzado con base) + ventas causadas del mes. Reemplaza al antiguo «Total del mes».
- **Comisión esperada** = pago de su meta de FTD (`pagoDeMeta`, no coincidencia exacta con `metas_ftd`) + su meta de ventas. Sin metas propias se muestra «Siguiente escalón» (pago de `f.siguiente`). Cada parte toma el mayor entre lo esperado y lo ya causado, para que la esperada nunca quede por debajo de lo que se cobra. Si no hay nada por encima de lo actual, la esperada y su barra no se muestran.
