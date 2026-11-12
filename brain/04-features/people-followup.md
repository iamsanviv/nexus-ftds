# Personas y seguimiento

## Responsabilidad

La vista de Personas concentra clientes, membresía/progreso, filtros, búsqueda y acceso a las operaciones de seguimiento.

## Búsqueda

La búsqueda vigente contempla nombre y teléfono. Para teléfono se comparan dígitos normalizados; no romper la búsqueda por nombre al ampliar criterios.

Para el nombre se usa `normBusqueda()` de `state.js`, **en los tres buscadores**: Personas, selección de una actividad y masivo. Reduce el texto a letras y números en minúscula con un espacio simple, así que da igual la tilde, la ñ, la mayúscula, el punto de «Ma. José» o un espacio doble invisible en el nombre guardado.

Es más agresiva que `norm()` a propósito. `norm()` se sigue usando donde el texto se compara consigo mismo (país, detección de nombres duplicados); un buscador necesita perdonar más que una comparación.

Si aparece otro buscador, tiene que usar la misma función: tener uno que distinga tildes y otro que no es peor que que ninguno lo haga, porque nadie sabe cuál es cuál.

## Registrar desde un chat reciente

WhatsApp ya no muestra el número de quien escribe, así que el agente no puede copiarlo. En el alta de persona hay «Traer de un chat reciente», que lista los chats de **su propio** WhatsApp de los últimos 30 días que todavía no están en su cartera, y rellena nombre y teléfono.

- La tabla es `chats_recientes`, la llena el worker (ver `brain/05-integrations/whatsapp-worker.md`) y su RLS es **`owner_id = auth.uid()`, no `puede_ver_de`**. El contenido no es una cartera sino quién escribió a un WhatsApp personal, incluida gente que no es cliente. Un director supervisa clientes, no la agenda de su equipo.
- Los agentes **no pueden escribir** en esa tabla: sin política de escritura, solo el service role. Si pudieran, se fabricarían un chat inexistente.
- El botón solo aparece al CREAR. Editando ya hay número.
- Los duplicados se descartan comparando **solo dígitos**: la tabla guarda `+57300…` y hay clientes viejos guardados con espacios.
- El nombre de WhatsApp no pisa un nombre ya escrito: es punto de partida, no verdad.

## Filtros

En Comunidad los filtros visibles son: **Membresía** (las tarjetas de conteo, que son botones), **Etapa** (`state.filtroEtapa`: 1 a 1 / Presentación / Avanzada / Básica / Sin etapas, por la etapa más alta del ciclo) y **Resultado** (`state.filtroRes`: Agendó pago / Agendó abono / Abonó / Sin acuerdo / Vencidos, solo quien ya hizo 1 a 1). Funcionan igual en escritorio y en móvil, son combinables y una tira de estado explica el conjunto visible con un «Quitar filtros». Activas / Inactivas pasó a «Más filtros» (`#filtrosIna`). Los filtros de progreso (`En progreso` / `Completos`) se quitaron con la vista de etapas (12/11/2026).

En móvil el buscador vive entre los filtros y la lista (`#buscarFila` en `index.html`); en escritorio se reubica por JS a la fila de filtros, junto a «+ Cliente»; en las demás vistas vuelve al encabezado. Es **un solo nodo** que se mueve, no copias: duplicarlo partiría el texto escrito.

Los ejes secundarios (broker, depósito, servicio) viven plegados tras el botón «Más filtros» (`state.filtrosMas`, cerrado al entrar), porque juntos eran demasiados mandos a la vista. El botón va primero en la fila de píldoras —en celular la fila se desplaza de lado y al final quedaba oculto— y muestra cuántos de esos ejes están activos: plegar nunca puede esconder un filtro que recorta la lista sin decirlo. La tira de estado también los nombra y «Quitar filtros» los limpia.

Distinguir siempre:

- filtro visual;
- selección para una acción;
- propiedad operativa del cliente.

Un filtro nunca debe seleccionar silenciosamente destinatarios.

## Filtro por servicio (sustituye a la pestaña «Servicios»)

La pestaña «Servicios» (vista por servicio con «invitado / asistió» a mano) se quitó el 14/10/2026: invitar ya lo hace Seguimiento y la asistencia la marca él mismo en `acc[servicio]`. Su único uso vivo —ver quién fue o no a un servicio— quedó como un eje de filtro más:

- Personas: `state.filtroSrv = { id, modo: "si" | "no" }`, combinable con membresía, broker, depósito y progreso; sale en la tira de estado y lo limpia «Quitar filtros».
- Masivo: `masSrv` + `masSrvModo`, para escribirle directo a quien le falta un servicio. Como los demás filtros del masivo, es visual: no marca a nadie; «Marcar visibles» sigue siendo la acción explícita.

El catálogo **no** se quitó: lo usan las actividades de catálogo (imagen, asistencia) y el % de progreso. Se sigue editando desde «Más».

## Paginación (solo Comunidad)

20 por página por defecto, con 20/50/100 a elegir (el tamaño se recuerda en el navegador, `nx.porPagina`). La página vuelve a 1 cuando cambia cualquier filtro, el orden o la búsqueda. El número de rango de «Cerca del cierre» se cuenta sobre la lista entera: la página 2 empieza en 21. Leads no se pagina (su lista de trabajo es «Hoy»).

## Vista de etapas de venta (desde 12/11/2026)

Sustituye al ranking «X/29 servicios»: Nexus crea clases nuevas a cada rato y ese progreso no se revisaba. Cada fila muestra qué tan cerca está la persona de la venta. Decisiones de Sanviv; lógica en `public/js/embudo.js`, pintado en `etapasHTML` / `resultadoHTML` de `ui.js`.

- **Etapas (4)**, todas derivadas, sin columna propia: Básica = `acc.nivel0` (servicio «Nivel 0 a Avanzado»); Avanzada = `zooms.avanzada`; Presentación Membresías = `zooms.pres`; 1 a 1 = `zooms.uno`. Presentación FTDs y Cierre siguen solo en el perfil. `zooms.*` con `e: "no_asistio"` se pinta en rojo («No asistió»).
- **Resultado tras el 1 a 1**, leído de la venta de membresía abierta más reciente (`ventas` + `abonos`): sin abonos con `fecha_pago` = Agendó pago; abonos parciales con fecha = Agendó abono; parciales sin fecha = Abonó; sin venta (o sin abono ni fecha) = Sin acuerdo. Vencido = `fecha_pago` < hoy. Mientras las ventas cargan no se inventa «Sin acuerdo» (conteos en «…»).
- **Upgrade**: cada venta de membresía saldada cierra un ciclo; las etapas solo cuentan con fecha posterior al último pago (si no hay venta registrada, `upgrade_fecha`). El ciclo de upgrade no pide Básica. Etiqueta «Upgrade · desde <fecha>».
- **Oro** es el nivel máximo: sin flechas, al final («Oro · nivel máximo»).
- **Orden «Cerca del cierre»** (por defecto): 1 a 1 con fecha de pago/abono (la más próxima arriba, vencidos incluidos), luego Abonó sin fecha, luego Sin acuerdo; después Presentación, Avanzada, Básica y sin etapas, lo más reciente arriba.
- El progreso X/29 de servicios ya no está en la lista; queda en el perfil y en la ficha expandida.
- Diseño: flechas encadenadas con ícono, color por etapa (`--etp1..4` en `tema.css`, claro y oscuro) y fecha «10/oct». En celular las flechas ocupan todo el ancho de la tarjeta (también bajo el número del ranking) y usan el nombre corto («Membresías»); en fila con ícono al lado solo si la fila de flechas mide ≥560px (container query), y el nombre largo desde 720px.

## Móvil

No asumir que la composición de escritorio aplica a móvil. Varias mejoras recientes se diseñaron explícitamente para dejar móvil intacto.

## Personas inactivas

`clientes.inactivo_desde` (con `inactivo_motivo`) marca a quien dejó de responder, pidió no seguir o tiene el número dado de baja. `NULL` = activa.

No es una membresía: estado y nivel son ejes independientes, alguien puede ser Oro e inactivo. Meterlo en `membresia` habría contaminado FTD y comisiones.

Reglas:

- **no se borra**: conserva asistencia, ventas e historial;
- queda fuera de la lista de Personas y de los conteos por membresía;
- se ve con su propio filtro, y la tira de estado dice cuántas quedaron sin mostrar;
- el motivo es **solo un dato** para excluir, pero **sí se muestra**: cada motivo tiene una forma larga (perfil) y una corta (insignia de fila);
- reactivar es un clic, sin distinción por motivo;
- se pueden incluir a propósito, tanto en Masivo como al programar una actividad, con un interruptor que nace apagado en cada tanda;
- la fecha se sella al marcar y **no se reinicia** al cambiar el motivo: interesa desde cuándo dejó de recibir mensajes.

La base sostiene la coherencia: fecha y motivo existen o faltan juntos, y el motivo está restringido a los cuatro valores. La UI nunca puede producir un par inválido, pero la restricción cubre la llamada directa.

Ver [[../03-domain/messaging-rules]] para dónde se aplica la exclusión.

## Desfase horario

El perfil guarda la diferencia de hora del cliente con Colombia (`tz_offset_min`, en minutos; `NULL` = sin definir). Existe para que la hora del mensaje llegue ya convertida.

Lo pone el agente a mano y **no se deduce del país**: un mismo país puede tener varios husos —México tiene tres— así que adivinar acierta a veces y falla en silencio el resto. Única excepción: al escribir un número `+57` completo el formulario pone país Colombia y diferencia 0 (un solo huso, sin horario de verano). Un `+52` completo pone país México y deja la hora sin tocar (`paisDesdeTel` en `public/js/ui.js`). El CSV no hace esta deducción. El selector va en saltos de media hora y agrupado por dirección (atrasada / adelantada), con un ejemplo vivo debajo: es lo único que delata un signo invertido antes de que el error salga por WhatsApp.

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