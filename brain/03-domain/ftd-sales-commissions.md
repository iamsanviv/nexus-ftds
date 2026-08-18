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