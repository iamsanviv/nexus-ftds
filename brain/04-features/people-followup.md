# Personas y seguimiento

## Responsabilidad

La vista de Personas concentra clientes, membresía/progreso, filtros, búsqueda y acceso a las operaciones de seguimiento.

## Búsqueda

La búsqueda vigente contempla nombre y teléfono. Para teléfono se comparan dígitos normalizados; no romper la búsqueda por nombre al ampliar criterios.

Para el nombre se usa `normBusqueda()` de `state.js`, **en los cuatro buscadores**: Personas, vista por servicio, selección de una actividad y masivo. Reduce el texto a letras y números en minúscula con un espacio simple, así que da igual la tilde, la ñ, la mayúscula, el punto de «Ma. José» o un espacio doble invisible en el nombre guardado.

Es más agresiva que `norm()` a propósito. `norm()` se sigue usando donde el texto se compara consigo mismo (país, detección de nombres duplicados); un buscador necesita perdonar más que una comparación.

Si aparece un quinto buscador, tiene que usar la misma función: tener uno que distinga tildes y otro que no es peor que que ninguno lo haga, porque nadie sabe cuál es cuál.

## Filtros

Los filtros de progreso (`En progreso` / `Completos` / `Todos` / `Inactivas`) y el de membresía son combinables y **funcionan igual en escritorio y en móvil**. La membresía se elige tocando las tarjetas de conteo, que son botones; las píldoras por nivel que existían solo en móvil se eliminaron porque eran un segundo mando para lo mismo. La vista abre en `En progreso` y una tira de estado explica el conjunto visible con un «Quitar filtros».

En móvil el buscador vive entre los filtros y la lista (`#buscarFila` en `index.html`); en escritorio se reubica por JS a la fila de filtros, junto a «+ Cliente»; en las demás vistas vuelve al encabezado. Es **un solo nodo** que se mueve, no copias: duplicarlo partiría el texto escrito.

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
- el motivo es **solo un dato** para excluir, pero **sí se muestra**: cada motivo tiene una forma larga (perfil) y una corta (insignia de fila);
- reactivar es un clic, sin distinción por motivo;
- se pueden incluir a propósito, tanto en Masivo como al programar una actividad, con un interruptor que nace apagado en cada tanda;
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