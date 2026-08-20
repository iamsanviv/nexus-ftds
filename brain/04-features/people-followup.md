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

## Personas inactivas

`clientes.inactivo_desde` (con `inactivo_motivo`) marca a quien dejó de responder, pidió no seguir o tiene el número dado de baja. `NULL` = activa.

No es una membresía: estado y nivel son ejes independientes, alguien puede ser Oro e inactivo. Meterlo en `membresia` habría contaminado FTD y comisiones.

Reglas:

- **no se borra**: conserva asistencia, ventas e historial;
- queda fuera de la lista de Personas, de los conteos por membresía y de la vista por servicio;
- se ve con su propio filtro, y la tira de estado dice cuántas quedaron sin mostrar;
- el motivo es **solo un dato**: los cuatro excluyen igual y reactivar es un clic en todos los casos;
- la fecha se sella al marcar y **no se reinicia** al cambiar el motivo: interesa desde cuándo dejó de recibir mensajes.

La base sostiene la coherencia: fecha y motivo existen o faltan juntos, y el motivo está restringido a los cuatro valores. La UI nunca puede producir un par inválido, pero la restricción cubre la llamada directa.

Ver [[../03-domain/messaging-rules]] para dónde se aplica la exclusión.

## Desfase horario

El perfil guarda la diferencia de hora del cliente con Colombia (`tz_offset_min`, en minutos; `NULL` = sin definir). Existe para que la hora del mensaje llegue ya convertida.

Lo pone el agente a mano y **no se deduce del país**: un mismo país puede tener varios husos —México tiene tres— así que adivinar acierta a veces y falla en silencio el resto. El selector va en saltos de media hora y agrupado por dirección (atrasada / adelantada), con un ejemplo vivo debajo: es lo único que delata un signo invertido antes de que el error salga por WhatsApp.

Ver [[../03-domain/messaging-rules]] para cómo se usa en el texto.

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