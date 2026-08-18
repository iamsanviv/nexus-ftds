# Personas y seguimiento

## Responsabilidad

La vista de Personas concentra clientes, membresía/progreso, filtros, búsqueda y acceso a las operaciones de seguimiento.

## Búsqueda

La búsqueda vigente contempla nombre y teléfono. Para teléfono se comparan dígitos normalizados; no romper la búsqueda por nombre al ampliar criterios.

## Filtros

En escritorio existen filtros combinables de progreso y membresía. La UI reciente permite usar tarjetas de conteo como filtros y mantener una tira de estado que explica el conjunto visible.

Distinguir siempre:

- filtro visual;
- selección para una acción;
- propiedad operativa del cliente.

Un filtro nunca debe seleccionar silenciosamente destinatarios.

## Filas en escritorio

La fila de cliente fue compactada para mostrar nombre, nivel/indicadores, teléfono, progreso y estado en una línea. Los nombres largos deben ceder con ellipsis sin desplazar insignias/banderas ni romper el layout.

## Móvil

No asumir que la composición de escritorio aplica a móvil. Varias mejoras recientes se diseñaron explícitamente para dejar móvil intacto.

## Seguimiento

La programación desde Personas debe respetar:

- selección inicial vacía;
- propiedad `owner_id` para envíos;
- un solo seguimiento activo por cliente/actividad;
- confirmación antes de encolar;
- preservación de asistencia histórica.

## Código relacionado

- `public/js/seguimiento.js`
- `public/js/state.js`
- `public/js/data.js`
- `public/index.html`
- estilos de Personas en `public/css/`

## Relacionado

- [[../03-domain/activities-followups]]
- [[../03-domain/messaging-rules]]
- [[ui-theme-responsive]]
- [[../08-memory/dangerous-patterns]]