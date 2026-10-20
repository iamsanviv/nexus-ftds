# Módulo «Administración» (solo admin)

Pedido y definido por el usuario el 2026-10-19/20, requisito por requisito.

## Entrada

Pestaña en la barra lateral de escritorio (`#tabAdmin`) y fila en «Más» en el móvil (`#btnAdmin`), porque la barra inferior ya va llena. Ambas solo para `role = 'admin'` (`auth.js`). Código: `public/js/admin.js`, vista `#vistaAdmin`, modal `#admProdOverlay`.

## Productos

- Crear y editar nombre, precio y comisión. Categoría y nivel se eligen **solo al crear**: cambiarlos en un producto vendido movería sus ventas de grupo y lo que la venta hace con el nivel.
- Comisión fija o por porcentaje (`comision_pct`). Con porcentaje, el trigger `productos_comision_derivada` recalcula `comision`; nada de `ventas.js` sabe de porcentajes. Las ventas ya creadas no cambian (comisión congelada).
- **Borrar solo sin ventas.** El FK `ventas.producto_id` es `ON DELETE SET NULL`, que dejaba ventas huérfanas en silencio; lo impide el trigger `productos_no_borrar_vendido` (errcode 23503). Con ventas se ofrece **Retirar** (`activo = false`) y **Reactivar**.
- El admin no ve ventas ajenas: el conteo por producto sale de `admin_ventas_por_producto()` (solo cuenta).
- El `id` se genera una vez desde el nombre y no cambia al renombrar.

## Productos retirados siguen cargados

`state.productos` trae **todos** los productos; `ventas.js` filtra `activo` solo al ofrecerlos (buscador y promo de referencia del upgrade). Si se cargaran solo los activos, una venta de un producto retirado perdería categoría y nivel, y `sincronizarMembresia` dejaría de aplicar o revertir el nivel.

## Equipo

`admin_resumen_equipo()` (SECURITY DEFINER, exige `es_admin()`): cuentas aprobadas de agentes y directores, total de personas (solo el número) y datos del canal. Agrupado por director; el director tiene su propia fila. Estados de WhatsApp derivados en el panel:

| Estado | Regla |
|---|---|
| Retirado | `baja_en` puesto |
| Conectado | `estado = 'vinculado'` y `ultimo_visto` < 5 min (el bridge late ~30 s) |
| Sin señal | `vinculado` sin latido reciente |
| Sin vincular | cualquier otro (vinculando, sin fila) |

Fuera de alcance por decisión del usuario: escalones de FTD (`metas_ftd`) y desglose de personas por nivel.

SQL: `sql/2026-10-20_42_modulo_administracion.sql`.

## Relacionado

- [[../03-domain/ftd-sales-commissions]]
- [[ftd-sales]]
- [[channel-health]]
