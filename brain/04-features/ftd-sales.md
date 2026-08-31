# FTD y ventas

Este documento describe comportamiento funcional. Las reglas conceptuales de comisión viven en `../03-domain/ftd-sales-commissions.md`.

## FTD: cargados, reales y sin subir

No son sinónimos:

- `cargados`: clientes FTD que ya están registrados en la plataforma;
- `declarado`: cifra que el agente reporta en `ftd_base`;
- `reales`: `max(declarado, cargados)`;
- `sin subir`: diferencia entre reales y cargados cuando existe deuda de carga.

**Las metas usan `reales`, no simplemente `cargados`.**

La casilla de "ya lo conté" no marca un cliente individual; ajusta la cifra declarada. Solo debe aparecer cuando existe una diferencia pendiente.

## Contar FTD históricos

No contar FTD por `membresia = 'Beca'` como fuente histórica. La membresía representa el nivel actual y cambia cuando una persona sube de nivel.

La fecha `comunidad_desde` es la referencia estable para saber cuándo esa persona ingresó como FTD.

Por eso el formulario de persona no la deja vacía al convertir: al salir de `Lead` se rellena con la fecha de hoy si no había ninguna. El formulario pide **una sola fecha, la que corresponde al nivel** —`Registrado el` para `Lead`, `Ingreso a la Comunidad` de `Beca` en adelante—, nunca las dos.

`upgrade_fecha` ya no se escribe a mano: salió del formulario y viaja en un campo oculto para no perderse al guardar.

## Borrado simétrico

Crear un FTD puede aumentar la cifra declarada. Borrar ese mismo cliente del mes debe deshacer el efecto cuando corresponda.

`trasBorrarCliente` mantiene esa simetría. No descontar meses cerrados ni registros que no pertenecen al periodo vigente.

## Base y metas

- `ftd_base` persiste la base que llega del mes anterior.
- La meta personal del mes se mide sin sumar esa base.
- La comisión FTD sí puede considerar base según la regla vigente.
- Al cerrar el mes, el sobrante puede sembrar la base del siguiente.
- Un mes cerrado no debe reabrirse para un agente normal; el cierre protege cifras ya pagadas.

La meta del agente puede ser libre. Cuando se calcula qué pago corresponde a una cifra, se busca la mayor meta alcanzada, no una coincidencia exacta.

## Resumen de meses anteriores

`abrirResumen()` recalcula meses históricos usando las mismas funciones del mes vivo. No guardar un snapshot adicional solo para mostrar el resumen: una corrección de abono con fecha histórica debe reflejarse en la misma fuente de verdad.

## Ventas

Archivo principal:

`public/js/ventas.js`

Reglas:

- moneda: USD;
- solo registrar ventas para clientes propios;
- `productos.categoria` distingue `membresia`, `servicio` y `bot`;
- cliente y producto se buscan por texto en lugar de depender de `<select>` enormes;
- la comisión FTD y la comisión de ventas se muestran separadas; el total combinado puede mostrarse como síntesis, no como sustituto de ambas métricas;
- priorizar visualmente ventas pendientes de pago sobre las ya saldadas;
- mantener el aviso de que las cifras son de guía y no constituyen liquidación oficial de Nexus.

## Comisión congelada

La comisión aplicable se copia a la venta al crearla. Cambiar el catálogo después no reescribe la historia.

`comision = 0` significa sin definir.

## Comisión de los bots: no hay un porcentaje único

`productos.comision` guarda un **monto**, no un porcentaje, así que el
porcentaje solo existe en la cabeza de quien carga el precio. Hoy conviven dos:

- familia **GoPro** → 25 % (siete precios, de $320 a $735 — `sql/2026-08-31_17_...`);
- **Bot IA, GoTraders y Gold** → 30 %.

Excepción viva: `gopro_vip` («Bot GoPro (Servicios VIP)», $135) sigue al 30 %
porque no venía en la lista de precios del dueño; queda pendiente de que él
decida.

Consecuencia práctica: al cambiar el precio de un bot hay que **recalcular la
comisión a mano** con el porcentaje de SU familia. Asumir 30 % para todos ya es
un error.

## Facturado y saldada

No existe un booleano autoritativo de "saldada": se deduce de los abonos.

La regla `FACTURA_VALOR_AL_SALDAR` hace que, cuando una venta se completa en un mes, ese periodo contabilice el valor completo como facturado según el criterio empresarial vigente. No eliminar esta aparente duplicación sin validar la regla comercial.

## Abonos

- monto y fecha son corregibles;
- la fecha decide el periodo;
- monto cero no es una corrección válida: para retirar el abono se elimina;
- `abonos` hereda alcance desde su venta mediante la relación correspondiente, no necesita una propiedad duplicada solo para simplificar RLS.

## La venta aplica el nivel

Cuando una venta de categoría `membresia` queda **saldada**, el cliente sube al nivel del producto. Si deja de estarlo —se borra un abono, se corrige a la baja, sube el valor, se da por perdida o se borra la venta— vuelve a lo que tenía.

`ventas.membresia_previa` guarda a dónde volver, y su sola presencia significa «esta venta tiene un nivel aplicado». No se puede deducir: `nivel_origen` solo existe en upgrades (VIP+) y no cubre Beca → membresía, que es el caso más común.

Toda la regla vive en **una** función (`sincronizarMembresia` en `ventas.js`) que llaman los ocho sitios capaces de mover `estaSaldada`. Repartirla por cada botón garantiza que alguno se quede atrás y el nivel se desincronice en silencio.

Dos guardas que no se pueden quitar:

- **solo sube**: si el cliente ya está igual o más arriba, no se toca. Una venta de nivel menor a quien ya subió es un dedazo, no una intención;
- **solo revierte lo suyo**: se devuelve el nivel únicamente si el que tiene hoy es el que puso esa venta. Si cambió después —otra venta, o a mano en el perfil— pisarlo destruiría una decisión más reciente.

Las ventas que ya estaban saldadas antes de este cambio quedan con `membresia_previa` nulo a propósito: no se aplica nada retroactivamente.

## Upgrade

El upgrade usa la diferencia entre valores de lista de los productos involucrados, no el monto de una venta histórica que quizá ya fue un upgrade.

Comisión del upgrade = comisión del producto nuevo - comisión del producto previo.

Beca -> membresía no se trata como upgrade pagado.

## Embudo de zooms

El embudo pertenece al cliente (`clientes.zooms`), no a una venta concreta. La presentación puede ocurrir antes de que exista una venta y debe sobrevivir a upgrades posteriores.

Una actividad puntual puede representar una etapa del embudo mediante `zoom_tipo`; la asistencia puede sincronizar esa etapa sin convertir actividad y venta en dos fuentes separadas del mismo hecho.

## Alertas de pago

La clasificación visual de vencimientos debe derivarse de `fecha_pago` y mantener el orden de urgencia.

Los cálculos de días se hacen con una referencia temporal estable para evitar que la hora local cambie el resultado del mismo día calendario.

## RLS verificado históricamente

Las pruebas históricas cubrieron, entre otros casos:

- agente no ve ni edita ventas ajenas;
- abonos de venta ajena no son visibles;
- agente no escribe `ftd_base` ajena;
- agente no reabre mes cerrado;
- agente no crea productos/precios;
- director puede ver ventas de sus agentes dentro de su jerarquía.

Revalidar contra Supabase vivo cuando se cambie autorización.

## Código relacionado

- `public/js/ftd.js`
- `public/js/ventas.js`
- `public/js/state.js`
- `public/js/data.js`
- `public/js/ui.js`

## SQL histórico relevante

- `sql/2026-07-29_07_ventas_y_comisiones.sql`
- `sql/2026-07-29_08_ftd_reales_y_metas.sql`
- `sql/2026-08-12_15_upgrade_comisiona_la_diferencia.sql`
- cambios posteriores relacionados

## Relacionado

- [[../03-domain/ftd-sales-commissions]]
- [[../02-architecture/security-rls]]
- [[invitations-attendance]]