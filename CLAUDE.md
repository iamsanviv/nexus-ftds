# Seguimiento FTDs y Ventas

Panel para que un equipo de agentes gestione clientes y les automatice mensajes
de WhatsApp alrededor de actividades (clases, operativas, lanzamientos).

**Stack:** HTML + CSS + JS vanilla (módulos ES, **sin build**) · Supabase
(Postgres + Auth + RLS) · desplegado en Cloudflare Workers (assets estáticos).

---

## Cómo se trabaja aquí

- **Todo en español**: interfaz, comentarios y mensajes de commit. El equipo es
  colombiano y no todos leen inglés.
- **Los comentarios explican el *porqué***, no el qué. Si algo tiene una forma
  rara, casi siempre hay una razón: déjala escrita.
- **Sin build.** No agregar bundler, framework ni dependencias de npm. Lo poco
  externo entra por `esm.sh` en tiempo de ejecución (Sortable, qrcode).
- **El banco de pruebas tiene que incluir el ENCABEZADO REAL.** Un banco parcial
  da una falsa sensación de haberlo comprobado: la vista de escritorio se
  desplegó «verificada» y se veía mal, porque el banco no traía el título, el
  selector Comunidad/Leads ni el buscador — y eran justo esos los que se
  estiraban a todo lo ancho. Si el bloque vive dentro de `#app`, el banco lo
  monta dentro de `#app` completo.
- **Renderizar antes de dar algo por bueno.** Leer el código no basta: en esta
  sesión, montar un banco de pruebas con Playwright encontró defectos reales
  (formulario de 1180 px, nombre truncado, campo debajo del botón que lo
  necesita). El patrón: extraer el bloque de `index.html`, servirlo con
  `npx http-server public`, inyectar datos representativos y capturar a 1280 y
  390 px. Chromium está en `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  y Playwright en `/opt/node22/lib/node_modules/playwright`.
- **Diseño: mockup antes que código.** Para cambios visuales grandes, publicar
  primero un artifact con opciones y esperar la elección.
- **Probar el RLS simulando sesiones**, no razonando. Patrón:
  `set_config('request.jwt.claims', ...)` + `set_config('role','authenticated')`
  dentro de `begin; … rollback;`. Ojo: al elegir un usuario "ajeno" para una
  prueba, verificar que de verdad lo sea — dos veces se usó a alguien que sí
  colgaba del director y la prueba dio un falso positivo.

## Despliegue

`git push` a `main` dispara Cloudflare Workers Builds → producción. El repo se
desarrolla en la rama `main-jvpvtk` y se lleva a `main` con fast-forward.
Rollback: Cloudflare → Worker `nexus-ftds` → Deployments → versión anterior.

Las migraciones se aplican con el MCP de Supabase y **además** se documentan en
`sql/` con el porqué y las pruebas hechas. Ese directorio es documentación, no
un sistema de migraciones: el estado real está en la base.

---

## Modelo de dominio

### Roles y jerarquía (`profiles`)

| Rol | Ve |
|---|---|
| `agente` | solo lo suyo |
| `director` | lo suyo + lo de **sus** agentes (`director_id` apunta a él) |
| `admin` | administra; de clientes ajenos **solo el nombre** |

- Cada agente elige director al registrarse. Hoy todos cuelgan de Juan Camilo.
- **`puede_ver_de(owner)` es la regla única de alcance.** Todas las políticas de
  datos la usan. Si cambia la jerarquía, se toca ahí y en ningún otro lado.
- El admin **no** aparece en esa función a propósito: sobre `clientes` solo ve
  lo suyo. Para el resto existe la vista `clientes_directorio` (SECURITY
  DEFINER, filtrada por `es_admin()`), que expone solo nombre y dueño.
- Cuentas nuevas nacen con `aprobado = false` → pantalla de espera. Aprueban el
  admin (a cualquiera) o el director (solo a sus agentes, y solo con rol
  `agente`). Rechazar marca `rechazado_en`, **no** borra `director_id`.
- **El rol solo lo cambia un admin.** Si un director pudiera, ascendería a un
  agente suyo y escalaría a través de él.

### Regla de oro de los envíos

**Cada quien le escribe únicamente a los clientes que agregó** (`owner_id =
auth.uid()`), tanto en Seguimiento como en Masivo. Un director ve los de sus
agentes para supervisar, pero el mensaje saldría desde *su* WhatsApp a gente
que no lo agregó. Filtrar por lo que el RLS deja ver **no** es suficiente aquí.

### Actividades

- `servicio_id` puede ser nulo → **actividad puntual** (lanzamiento, clase
  única). No entra al catálogo y no cuenta para el progreso.
- `compartida` → un director la comparte con su equipo. Los agentes la ven y
  programan a sus clientes, pero no pueden editarla ni borrarla.
- La lista muestra **lo propio + lo compartido por mi director**. Nunca lo de
  mis agentes: eso es supervisión y vive en «Agentes y canales».

### Ciclo de vida de una actividad

- **Borrarla cancela sus seguimientos** activos y sus mensajes pendientes. Se
  cancela *antes* de borrar: al revés quedan huérfanos y ya no hay por dónde
  alcanzarlos. El aviso dice cuántos se van a cancelar.
- En una actividad **compartida** el agente no puede borrarla (no es suya) pero
  tiene «✕ Mis seguimientos» para desmontar lo que él programó.
- **Cambiar la hora reprograma los mensajes pendientes**: recalcula `enviar_en`
  y regenera el texto (que anuncia la hora). Los recordatorios que con la hora
  nueva quedarían en el pasado se cancelan en vez de programarse hacia atrás.
  La invitación no se re-temporiza —su hora es cuándo invitas— pero su texto sí
  se regenera. El texto solo se regenera en seguimientos **propios**: los de un
  agente se escribieron con *sus* plantillas y sobreescribirlos con las del
  director le cambiaría la redacción a otra persona.

### Enlace rastreado (saber quién entró)

Cada seguimiento nace con un `clic_token`, y el mensaje del enlace manda
`…/i?<token>` en vez de la URL de Zoom. Al abrirlo, la RPC `abrir_enlace(t)`
registra el clic, marca asistencia y redirige.

- **El largo del enlace es un requisito, no un detalle.** Va entero en un
  mensaje de WhatsApp y uno largo y raro parece spam. Quedó en 53 caracteres:
  `https://nexus-ftds.nexus-pro.workers.dev/i?4k7mqx2rvb`. De ahí, **40 son el
  dominio**: lo único que falta por recortar ya no es código, sería comprar uno
  corto. Los tres recortes fueron `/i` en vez de `/i.html`, `?tok` en vez de
  `?t=tok`, y el token de 10 en vez de 16.
- **El token es de 10 y el piso no lo pone la seguridad, lo ponen las
  colisiones.** 50 bits sobran para lo poco que se gana adivinando uno. Pero
  `clic_token` es único: dos iguales tumban el lote entero de `programar()` con
  un error que no explica nada. Con 8 caracteres eso pasaría ~1 vez cada dos
  años a 100 mil enlaces/año; con 10, nunca.
- **El dominio sale de `BASE_URL` (`config.js`), no de `location.origin`.** Con
  `location.origin`, un agente que abriera el panel desde una URL de preview le
  mandaría a sus clientes enlaces de preview. Cambiar `BASE_URL` **mata los
  enlaces ya enviados**: se hace entre actividades, nunca con seguimientos vivos.
- **`html_handling` en `wrangler.toml` sostiene el enlace corto.** Es el valor
  por defecto de Cloudflare, pero va escrito: si `/i` dejara de resolver a
  `i.html`, `not_found_handling` serviría el `index.html` y el cliente vería el
  panel de agentes en mitad de la clase, sin error en ninguna parte. Por eso
  `index.html` lleva además una red de tres líneas que reenvía `/i` a `/i.html`.
  Un default implícito no puede sostener algo que falla así de callado.

- **El token va en el seguimiento, no en el mensaje**: identifica a la persona
  en esa actividad y sobrevive a que los mensajes se reprogramen.
- **La redirección se hace en el navegador**, no en el servidor. Los bots que
  arman la previsualización del enlace en WhatsApp no ejecutan JS, así que una
  previsualización no cuenta como clic. Es la razón de que `i.html` sea una
  página con `<script>` y no una respuesta 302.
- **Devuelve el enlace *vigente* de la actividad**, no la copia del seguimiento.
  Efecto secundario bueno: con rastreo ya **no hay que propagar** el enlace a
  los mensajes pendientes cuando se agrega la sala después; se resuelve al
  hacer clic. Por eso `guardarActividad()` **no debe pisar** el `enlace_url` de
  los seguimientos con token — hacerlo apagaría el rastreo en silencio.
- **Ventana de asistencia: una hora desde el inicio.** El mensaje del enlace
  sale a la hora de arranque, así que un clic dentro de esa hora es alguien
  entrando; más tarde es alguien abriendo el mensaje al otro día, y marcarle
  asistencia sería inventarla. Fuera de la ventana **redirige igual** (sí quiere
  entrar) pero no toca `acc`.
- **La regla vive en un solo sitio, en lo que significa cada columna**:
  `clics` son todas las aperturas; `clic_en` es la primera que **contó**.
  Entonces `clics > 0` con `clic_en` nulo *es* «abrió tarde», y la interfaz solo
  traduce a chips en vez de repetir el cálculo de la ventana.
- **No sobreescribe una asistencia puesta a mano**: si el agente ya la confirmó
  en el repaso, su fecha manda.
- Devuelve **tres cosas distintas a propósito**: `null` (token inexistente),
  `''` (existe pero la sala no tiene enlace todavía) y la URL. Con un solo
  `null` para los dos primeros, la persona veía «enlace inválido» cuando lo que
  pasaba era que el asesor no había pegado la sala.
- **Se decide al PROGRAMAR, no al crear la actividad** (casilla en el bloque de
  programación, encendida por defecto y que vuelve a encenderse en cada tanda).
  A una lista de confianza se le rastrea; a un público frío que ya desconfía se
  le manda el `zoom.us` tal cual —cambiarlo resta confianza y es señal de spam,
  y aquí ya hubo un número restringido—, y la misma actividad puede querer las
  dos cosas en tandas distintas.
- **Tener `clic_token` ES la respuesta**, persona por persona: no hay ninguna
  bandera aparte que consultar. Por eso `actividades.rastrear` se eliminó en vez
  de dejarla sin uso — una columna muerta que sigue ahí es la trampa de
  `imagen_url` otra vez.
- Lo que **no** puede saber, y está dicho en pantalla: un clic es que abrió, no
  que se quedó; si reenvía el mensaje el clic queda a nombre de quien lo
  recibió; quien entre con un enlace que ya tenía no genera clic; y el agente
  que abra el enlace para probarlo le marca asistencia a ese cliente.

### Programar: nadie marcado por defecto, y confirmación siempre

**Dos veces se programó a 40+ personas de un clic sin querer.** El 05/08 quedó
probado con los tiempos de `seguimientos`: cuatro filas con 932 s, 72 s y 38 s
de separación —el agente yendo uno por uno— y de pronto **43 más en el mismo
milisegundo**. Eso no es lentitud humana: es una sola llamada masiva.

La causa eran dos piezas que por separado parecían inofensivas:

1. Al abrir el panel se **pre-marcaba a todos** los que faltaban (`segSel` se
   llenaba en `mostrarProg`).
2. **El buscador oculta pero no desmarca.** Con un nombre escrito se ve una
   fila, pero `segSel` sigue teniendo a los otros 43 — y `programar()` encola la
   SELECCIÓN, no lo visible.

Buscar un nombre y darle «Programar» mandaba, entonces, a todo el mundo. La red
de duplicados no saltaba porque en la primera tanda nadie tenía seguimiento aún.

- **`segSel` nace vacío.** Para invitar a varios está «Marcar visibles», que sí
  respeta el filtro. El masivo silencioso dejó de ser el camino por defecto.
- **`confirm()` antes de encolar, siempre**, con el número y los primeros ocho
  nombres. Es la única forma de enterarse de a cuántos se le va a escribir de
  verdad, porque lo seleccionado y lo visible pueden no coincidir. El aviso de
  duplicados se pliega en ese mismo diálogo en vez de abrir un segundo.
- `faltantes()` quedó sin uso y se eliminó — la trampa de la columna muerta.

### Envíos masivos: progreso y cancelación

`campanas` se escribía y **nunca se leía**: un masivo salía y desaparecía de la
vista. La sección «Envíos masivos» (en Seguimiento, al lado de «Seguimientos
activos») muestra las 10 últimas con su barra de progreso y permite cancelar lo
que falta por salir.

- **El progreso no se guarda, se cuenta** desde `mensajes_programados` al
  pintar. `campanas.total` es lo que se encoló; el estado real de cada mensaje
  lo mueve el worker. Un contador propio sería una segunda verdad que se
  desincroniza en cuanto falle un envío.
- **Solo las propias** (`owner_id = auth.uid()`), aunque el RLS le deje a un
  director ver las de sus agentes: cancelar el envío de otro es meterse en su
  trabajo. Misma lógica que la regla de oro.
- **Cancelar solo toca lo `pendiente`.** El aviso dice que lo ya enviado no se
  puede recoger, porque es lo que la gente asume mal de un botón de cancelar.
- Se refresca desde `masivo.js` con `import()` dinámico justo después de
  encolar: el agente acaba de mandar y espera verlo ahí, no al recargar. Ese es
  además el único momento en que la sección **se despliega sola**; el resto del
  tiempo va plegada, entre «Seguimientos activos» y el registro.
- **Al tocar una campaña se abre su detalle**: el texto que salió y persona por
  persona en qué quedó. Los grupos van en orden de acción —fallaron, en cola,
  les llegó— porque los cuatro fallidos son lo único que hay que recuperar a
  mano y quedaban enterrados bajo diecinueve exitosos.
- El texto se toma de `campanas`, no de un mensaje: cada mensaje lleva su
  versión ya resuelta (nombre y snippets), y mostrar una al azar haría creer que
  a todos les llegó exactamente esa. La pantalla lo dice.

### Historial de invitados (segmentos)

Vive en `data.js` (`guardarHistorialSegmento`) porque lo alimentan **dos**
sitios: programar una actividad y enviar un masivo. Antes solo lo escribía
Seguimiento, así que una selección armada en Masivo no se podía reutilizar al
programar — y al revés sí, que es lo que no tenía sentido.

- **Se unifica por `clave`, no se apila una entrada por guardado.** El agente
  programa de a poquitos según le van confirmando; una entrada por tanda se
  comía el historial con ocho versiones incompletas de la misma lista. La clave
  es `act:<actividad_id>` o `cam:<campana_id>`, y hay índice parcial para ella.
- La unión es **acumulativa**: quien ya entró se queda aunque en la tanda
  siguiente no se le vuelva a marcar.
- Van **plegados** en un `<details>`, en Seguimiento y en Masivo: ocho chips con
  nombre de actividad empujaban fuera de pantalla la lista de personas, que es a
  lo que el agente vino.
- La poda a `MAX_HISTORIAL` solo corre al **crear** uno nuevo; al unificar no
  crece la cuenta.

### Mensaje de invitación propio de una actividad

`actividades.msg_invitacion`. Nulo = la plantilla del agente, que es lo de
siempre. Las plantillas de `plantillas_seguimiento` son **del agente** y valen
para todo lo que programa; un lanzamiento suele necesitar su propio texto, y
cambiarle la plantilla para una sola actividad le rompería las demás.

- **Solo la invitación, y solo en las puntuales.** Una del catálogo es
  recurrente y su invitación es justo la que ya está escrita. Los recordatorios,
  el enlace y la confirmación son iguales en todas partes.
- **El editor va plegado detrás de un botón.** Desplegar el texto de cinco
  mensajes convertía el formulario en un muro.
- Al abrirlo vacío **se siembra con la plantilla del agente**: retocar un texto
  existente es más fácil que escribir mirando una caja en blanco.
- Manda sobre `invitacion_extra`: quien escribió una invitación a mano quiere
  que salga esa.

### Avisos de novedad

`renderNovedad()` en `seguimiento.js`. **Se cierra y no vuelve**, porque un aviso
permanente termina como el de canal caído de Majo: se queda ahí para siempre,
deja de mirarse y tapa los que sí piden acción. Va en verde (`.alerta.nueva`)
justo por eso: si compartiera color con «canal caído», una buena noticia
gritaría igual que un problema.

La marca va en `localStorage` con la clave `nexus.novedad.<uid>.<version>` — es
una preferencia de lectura, no un dato del negocio: no merece tabla, migración
ni RLS. Para anunciar lo siguiente se sube la constante `NOVEDAD` y reaparece,
sin tocar nada más.

### La asistencia no retrocede (invariante)

`acc[servicio]` y `puntuales[act].acc` son la memoria de quién asistió. **Nada
automático puede moverlas hacia atrás.** Solo el agente, a mano, desde el perfil
o desde el ✕ de la vista por servicio.

Cuatro reglas que lo sostienen, y las cuatro nacieron de un defecto real:

- **Reinvitar a quien ya asistió no le toca NADA** (`programar()`): ni `acc` ni
  `conf`. Se queda en «asistió» y el repaso no vuelve a preguntar por él.
- **A quien todavía no ha asistido se le REFRESCA `conf` a hoy.** Antes solo se
  escribía si estaba vacía, y esa fecha vieja era el problema: el repaso
  preguntaba por la invitación de hace tres semanas y responder «no asistió»
  borraba la invitación que se acababa de hacer.
- **«No asistió» nunca destruye historial.** En una puntual hacía
  `delete pun[actId]` —el registro ENTERO, con la asistencia adentro—; ahora
  solo quita `conf`. En una del catálogo solo borra `conf` si no hay `acc`.
- **A quien ya asistió no se le PREGUNTA en qué estado queda** al cancelarle el
  seguimiento (`abrirCancelar()`). Reinvitar a alguien que ya asistió es normal
  —una clase que se repite, un lanzamiento al que vuelve—, y ahí las dos
  opciones mentían: «dejarla como invitada» la nombra por un estado que ya
  superó, y «volver a por invitar» insinúa que se le puede deshacer la
  asistencia. Se cae a una confirmación simple. La regla de dónde vive la
  asistencia está en `asistioA()`, que comparten este diálogo y el panel de
  entradas — antes estaba escrita solo dentro de `abrirEntradas`.

`acc` y `conf` son **un valor por servicio**, no por actividad: un servicio
recurrente no puede guardar «asistió en junio, invitado otra vez en julio». Por
eso la regla es no preguntar dos veces en vez de intentar representarlo.

### Asistencia de días pasados

Al cambiar el día la actividad se marca `cerrada` y sale de «Actividades del
día». El dato de quién entró **no se pierde** —vive en `seguimientos`— pero se
quedaba sin ninguna puerta por donde consultarlo, y el repaso de asistencias se
hace justo al día siguiente. La sección plegada «Asistencia de días pasados»
(`renderPasadas`) es esa puerta: 7 días, y abre el mismo panel de entradas.

- **Entra si tiene rastreo, o si es PUNTUAL con gente programada.** La
  asistencia a una puntual solo se puede revisar acá; la de una del catálogo
  además vive en la vista por servicio, así que una del catálogo sin rastreo no
  aporta nada y se deja fuera. En los dos casos hace falta al menos una persona
  programada.
- **El panel ya no filtra por token.** Desde que el rastreo se decide por tanda,
  una misma actividad puede tener gente rastreada y gente sin rastrear: los
  segundos van en su propio grupo («Sin enlace rastreado · márcalos a mano»),
  sin fingir que «no entraron». `contarEntradas` devuelve `prog` (todos) y `n`
  (solo con token) justo para poder distinguirlos.
- **`renderPasadas()` corre DESPUÉS de `cargarActividades()`**, porque es esta
  la que marca `cerrada` a las de ayer. Lanzadas a la vez, la actividad de
  anoche seguiría figurando como activa y no saldría en ninguna de las dos
  listas — justo el primer día que se abre el panel.

### Quiénes entraron (panel de la actividad)

El chip «N/M entraron» de la tarjeta se toca y abre la lista: entraron, abrieron
tarde, y sin abrir — con la asistencia editable en los dos sentidos. Hace falta
porque **el clic es buena señal pero no infalible**: quien ya tenía el enlace de
antes entra sin generar clic, y quien lo abre desde otro teléfono figura como
ausente. La fecha que se escribe es la del **inicio de la actividad**, no la de
hoy: corregir el lunes una clase del viernes debe anotar el viernes.

### Políticas por comando, no `FOR ALL`

`seguimientos` y `mensajes_programados` tenían una política `FOR ALL` cuyo
`WITH CHECK (owner_id = auth.uid())` —puesto para la regla de oro del INSERT— se
aplicaba también al UPDATE. Efecto: el director veía los seguimientos de sus
agentes pero no podía tocarlos, y propagar el enlace en una actividad compartida
**no hacía nada en silencio**. Ahora están separadas: crear sigue siendo solo
para uno mismo; actualizar y borrar siguen el alcance de la jerarquía.

### Mensajes programados (tiempos reales)

| tipo | cuándo sale |
|---|---|
| `invitacion` | al programar (o diferida con «Más tarde»); **omitible** |
| `rec_60` | inicio − 60 min |
| `rec_15` | inicio − **15** min |
| `enlace` | inicio; con rastreo, `enlace_url` es **distinto por persona** |
| `confirmacion` | inicio + **10** min |

Las etiquetas de la interfaz deben coincidir con esto. Ya estuvieron cruzadas
una vez (el registro decía «10 min» y el editor «15 min después»).

### Ventas y comisiones (`ventas.js`)

Todo en **dólares**. Módulo aditivo: no cambia nada de lo anterior.

- **La comisión es un monto fijo por producto**, no un porcentaje ($789 → $200).
  Se **congela** en la venta al crearla: va al revés que las imágenes del
  catálogo (que se resuelven vigentes al enviar) porque una comisión pactada no
  puede cambiar retroactivamente. `productos` es el valor por defecto al crear,
  no la fuente de verdad de lo ya vendido.
- **`comision = 0` significa SIN DEFINIR**, no «no comisiona». La interfaz lo
  marca y esa venta **no suma**: mejor un hueco visible que una cifra inventada.
- **Facturado = recaudado.** Para la empresa facturar es cobrar, así que no hay
  columna de facturación: es la suma de abonos y punto.
- **«Saldada» no se marca, se deduce** (abonos ≥ valor). La comisión se causa en
  el mes del abono que completó el valor. Ni «saldada» ni el total de comisión
  se guardan: una sola verdad.
- **Cada abono se corrige en su fila** (monto y fecha editables, ✕ para borrar).
  Hacía falta porque un abono de más dejaba la venta saldada, y saldada la
  tarjeta no muestra ningún control: quedaba sin salida. La fecha es editable
  porque decide en qué mes se causa la comisión. Poner cero no vale — para eso
  está la ✕, que es lo que de verdad se quiere decir.
- **Upgrade**: cobra la diferencia de precio y comisiona un **monto fijo**
  (`parametros.comision_upgrade`), no la comisión del producto — el pago inicial
  ya comisionó en su momento. **De Beca a membresía NO es upgrade**: la beca es
  gratis, así que no hay pago inicial que descontar ni comisión ya cobrada. Se
  cobra precio completo. El upgrade empieza en VIP (nivel 2).
- **Los FTD no se pagan uno por uno**: solo si se alcanza una meta mensual. Lo
  que sobra se acumula como «base» para el mes siguiente. `ftd_base` se guarda
  en vez de derivarse: derivarla dejaría que un FTD registrado tarde moviera la
  comisión de meses ya pagados.

### Resumen de meses anteriores

`abrirResumen()` en `ftd.js`, desde «📅 Ver meses anteriores» en la tarjeta de
FTD. El panel solo hablaba del mes en curso: al pasar el mes, lo hecho
desaparecía de la vista aunque los datos siguieran ahí.

- **No guarda nada nuevo**: recalcula con las mismas funciones del mes vivo
  (`comisionFtd`, `progresoMeta`, `resumenVentas`). Un resumen congelado sería
  una segunda verdad que se separa en cuanto se corrija un abono con fecha
  vieja — y la fecha del abono es editable justo por eso.
- Los meses que ofrece salen de donde hay algo: `ftd_base` propio o abonos con
  fecha de ese periodo. El mes en curso no entra; ese ya está en la tarjeta.

### FTD reales vs. cargados (`ftd.js`)

- **Tres números distintos, y confundirlos fue el defecto original**:
  `cargados` (los que están en la plataforma), `reales` (los que el agente dice
  que lleva, en `ftd_base.declarado`) y `sin subir` (la resta). **El que manda
  para las metas es `reales`.** Se toma `max(declarado, cargados)` para que
  subir de más no deje el número corto.
- **La casilla «ya lo conté» no marca nada en `clientes`.** Desmarcarla sube
  `declarado` en 1 y ya; al subir uno de los que faltaban, `cargados` sube solo
  y «sin subir» baja. Por eso la casilla **solo aparece si hay deuda**: cuando
  «sin subir» llega a 0 desaparece del formulario.
- **La base se escribe a mano una sola vez**, para arrancar. Del mes siguiente
  en adelante la siembra el cierre: `sobra = efectivos − meta alcanzada`.
- **La meta que el agente se pone se mide SIN la base** (`progresoMeta`), y la
  comisión SÍ la cuenta (`comisionFtd`). Son dos cosas distintas y mezclarlas
  le decía «meta cumplida» a alguien que llegó con base y no hizo nada este
  mes — justo lo contrario de para lo que sirve una meta. En la tarjeta la base
  va en una línea aparte que dice que no cuenta para la meta.
- **Un mes cerrado no se reabre** (`cerrado = true` bloquea el UPDATE en RLS,
  salvo admin). Lo que se pagó, se pagó.
- **La meta del agente es libre**, no una de las cinco de la tabla: se elige con
  deslizador (1 → la meta más alta) y los atajos son solo eso, atajos. Por eso
  `pagoDeMeta(n)` busca **la mayor meta que `n` alcanza**, no coincidencia
  exacta: con una meta de 70 la búsqueda exacta devolvía $0.
- Al arrastrar el deslizador **no se vuelve a pintar el paso**, solo la lectura
  y qué atajo queda marcado: repintar mata el gesto a mitad de arrastre.
- El bloque vive en **Personas**, no en Ventas: es donde el agente pasa el día.
  Su comisión sigue sumando al encabezado de Ventas.
- El cierre se ofrece **al entrar, si el mes anterior quedó sin cerrar** — no
  estrictamente el día 1. Si se pospone, vuelve a aparecer.
- **Los zooms son etapas con fecha y estado.** No mandan WhatsApp. Programar
  recordatorios sigue siendo cosa de Seguimiento.
- **El embudo es del CLIENTE, no de la venta** (`clientes.zooms`, 04/08).
  Estaba en `ventas` y fallaba por los dos lados: la **presentación pasa antes
  de que exista una venta**, así que la etapa más temprana era justo la que no
  se podía anotar; y con un upgrade había dos filas repitiendo un embudo que le
  pasó una sola vez. La tarjeta de venta lo lee del cliente.
- **Una actividad puntual puede SER un zoom** (`actividades.zoom_tipo`).
  Marcarle la asistencia a alguien marca su etapa: es el mismo hecho, no dos.
  Solo en las puntuales — una del catálogo es recurrente. El tipo se copia al
  registro de `puntuales` al programar (`z`), para que siga siendo
  auto-contenido: los sitios que tocan la asistencia no van a buscar la
  actividad, que puede estar cerrada o borrada.
- **`syncZoom()` solo empuja hacia adelante.** Asistió → etapa «hecha»; no
  asistió → «no asistió» con su fecha, que es como se sabe a quién reagendar.
  Quitar la asistencia **no** borra la etapa: pudo ponerse a mano desde Ventas
  antes de que la actividad existiera. Para vaciarla está el embudo del perfil.
  La fecha es la de la ACTIVIDAD, no la de hoy.
- El embudo va **plegado en todos los perfiles**: la presentación puede pasarle
  a cualquiera, pero 300+ clientes de comunidad no lo usan y no tiene por qué
  estorbarles.
- **`productos.categoria` tiene tres valores**: `membresia`, `servicio` y
  `bot`. Los bots van aparte porque son nueve de dieciséis productos y
  mezclados con los servicios tapaban todo lo demás en el selector.
- Cliente y producto se eligen con **buscador**, no con `<select>`: son 200+
  clientes. Filtra con `norm()`, la misma de Personas, así que «cesar»
  encuentra a «César».
- Se venden solo clientes **propios**, por lo mismo que la regla de envíos: la
  venta quedaría a nombre de quien la registra.
- **Las dos comisiones van separadas**: la de FTD en su tarjeta de Personas y la
  de ventas en la suya. Mezclarlas en un solo número escondía cuál de las dos
  estaba floja. El total de ambas va discreto, abajo a la derecha (`.totalmes`).
- **La lista empieza por «Falta que paguen»**, ordenada por urgencia de cobro.
  Lo ya causado es historia y baja al final.
- El panel lleva un **aviso legal obligatorio**: son cifras de guía, no un dato
  oficial de Nexus para reclamar pagos.

### RLS de ventas y FTD: probado

Se corrió el 27/07 simulando sesiones (dos agentes del mismo director), en una
transacción revertida. Los siete casos pasan:

| prueba | resultado |
|---|---|
| agente ve ventas propia + ajena | 1 de 2 → solo la suya |
| agente ve abonos de venta ajena | 0 filas |
| agente edita venta ajena | sin efecto |
| agente escribe `ftd_base` ajena | sin efecto |
| agente reabre su mes cerrado | sin efecto |
| agente crea producto (precios) | bloqueado |
| director ve las ventas de sus agentes | 2 de 2 |

`abonos` no tiene `owner_id`: hereda el alcance por `venta_id` con un `exists`
contra `ventas`. Funciona, y se comprobó que no filtra.

### Alertas por fecha de pago

`alertaPago(v)` clasifica cada venta viva y da el `orden` de cobro:

| nivel | cuándo | se ve |
|---|---|---|
| `vencida` | `fecha_pago` ya pasó | filo rojo + chip «Vencida hace N días» |
| `hoy` | vence hoy | filo dorado |
| `pronto` | faltan ≤ `ALERTA_PRONTO` (3) días | filo dorado tenue |
| `ok` | más lejos | sin filo, solo la fecha |
| `sinfecha` | no tiene `fecha_pago` | filo gris, va de último |

- El **aviso rojo de arriba solo sale si hay vencidas o vence algo hoy**. Si
  saliera siempre, dejaría de mirarse.
- Los días se restan **en UTC** (`fecha + "T00:00:00Z"`). Con fechas locales, en
  Colombia (UTC−5) el mismo día daba distinto según la hora.

---

## Trampas que ya costaron caro

- **Postgres: en un `UPDATE`, la fila resultante debe seguir siendo visible para
  quien la edita.** No se puede actualizar una fila hasta sacarla de la propia
  vista. Rechazar una cuenta poniendo `director_id = null` fallaba por esto, con
  un mensaje que señalaba a la política de UPDATE cuando la culpable era la de
  SELECT. Por eso rechazar marca `rechazado_en` en vez de romper el vínculo, y
  por eso **mover un agente de director queda reservado al admin**.
- **A los helpers de RLS no se les puede revocar `EXECUTE` de `authenticated`.**
  Vale para `is_director()`, `mi_rol()`, `es_admin()`, `puede_ver_de()` y
  `aprobado()`: las políticas las invocan, y sin permiso el agente pierde
  acceso hasta a sus propios clientes (`permission denied for function`).
  Probado y revertido. El linter las marca como aviso; es un falso positivo:
  solo revelan algo del que llama, y para `anon` devuelven null o false.
- **Las dos vistas SECURITY DEFINER son deliberadas — no ponerles
  `security_invoker`.** El linter las marca como ERROR, pero:
  - `clientes_directorio` **tiene** que saltar el RLS de `clientes`: es la única
    forma de que el admin vea nombres ajenos. El filtro real es su
    `where es_admin()`.
  - `salud_canales` decide su alcance adentro (propio / mis agentes / todo si es
    admin) porque el admin ya no ve los mensajes de los demás.
  Ponerles `security_invoker = true` no da un error: simplemente devuelven cero
  filas y el panel del admin queda en blanco. Verificado que hoy filtran bien.
- **Una validación en la base no puede estar atada a algo que decide la
  interfaz.** `abrir_enlace()` empezó con `length(t) < 10`, copiado del largo
  que tenían los tokens ese día. Al acortarlos siguió andando de casualidad: con
  un carácter menos, TODOS los enlaces habrían devuelto «este enlace ya no
  sirve», a cada cliente, sin un error en ningún lado. Ahora solo rechaza vacío.
- **La `anon key` es pública.** Toda validación que importe va en RLS o en el
  worker. Lo que esté solo en el navegador no es un límite, es una sugerencia.
- **Tres listas describen qué archivo se puede adjuntar, y tienen que decir lo
  mismo**: el `accept` del `<input>`, `TIPOS_OK` en `masivo.js` y
  `allowed_mime_types` del bucket `mensajes`. Cuando se separan, el selector
  deja elegir un archivo que el Storage rechaza y el agente ve un error en
  inglés («mime type video/quicktime is not supported») que no le dice qué
  hacer. Pasó al agregar video. Lo mismo con el tamaño: `MAX_VIDEO_MB` y
  `file_size_limit` del bucket son el mismo número (16 MB) — la pantalla llegó a
  ofrecer 16 cuando el bucket aceptaba 10.
- **Tres columnas de imagen en `mensajes_programados`**, y solo dos sirven:
  - `imagen_url` → **muerta**, 0 filas en toda la tabla.
  - `media_url` → funciona, incluso en invitaciones (hay envíos exitosos con
    `servicio_id` nulo). Es la vía para la imagen propia de una actividad.
  - `servicio_id` → el worker resuelve la imagen **vigente** del catálogo al
    enviar, así no se congela si se cambia después.
  Se manda **una sola**, nunca ambas, para no depender de cómo el worker
  resolvería el empate.
- **`progreso()` solo recorre el catálogo.** Por eso las llaves extra en
  `acc`/`conf` y el mapa `clientes.puntuales` no ensucian los porcentajes.
- **El CSV solo INSERTA**, nunca actualiza. No hay riesgo de que pise datos.
- **Contar FTD por `membresia = 'Beca'` está mal.** `membresia` es el nivel de
  HOY: en cuanto alguien sube a VIP desaparecería de los FTD de meses ya
  cerrados y pagados. Se cuentan por **`comunidad_desde`**, que no se mueve
  nunca — todo el que hoy es Oro entró en su momento como FTD.
- **Al calcular un upgrade, usar el PRECIO DE LISTA del nivel que tiene, no lo
  que pagó.** Si su venta anterior ya era un upgrade, su monto es una
  diferencia, y encadenar diferencias regala un descuento que nadie concedió.
- **Cuidado con la especificidad al reusar `.frow`.** `.frow label` (0,1,1) le
  gana a cualquier clase suelta (0,1,0): la casilla «Ya pagó completo» salía en
  mayúsculas de etiqueta. Se arregló nombrando el elemento (`.frow
  label.chkline`), no subiendo a `!important`. **Volvió a pasar** con
  `.segtoggle` dentro del formulario de actividad: «Compartir con mi equipo»
  llevaba meses saliendo como título de campo y nadie lo había visto hasta
  montar el banco de pruebas. Mismo arreglo (`.frow label.segtoggle`), y ojo
  con resetear **todo** lo que impone `.frow label` (mayúsculas, tamaño,
  `letter-spacing`, `font-weight`, `margin`), no solo el `text-transform`.
- **`.tabbar` y `.overlay` comparten `z-index: 30`.** Funciona solo porque en
  `index.html` la barra va ANTES de los overlays. Al montar un banco de pruebas
  que los agregue en otro orden, la barra tapa el modal: es artefacto del banco,
  no del producto.

---

### Vista de escritorio

`@media (min-width:1040px)` al final de `styles.css`. El panel nació en celular
y estaba tapado a 760 px en todas las pestañas menos Seguimiento.

- **1040, no 1180.** Es lo que este contenido llena de verdad: 28 clientes con
  filas cortas. Más ancho solo agrega aire.
- **Ensanchar NO es acomodar.** El primer intento subió el ancho y ya, y se veía
  peor: el selector de módulo y el buscador se estiraban a todo lo ancho, y
  entre el nombre y las cifras quedaba un océano. Hubo que revertirlo.
- **Lo que se apilaba por falta de sitio, va en FILA**: selector + buscador;
  tarjeta de FTD + cifras (`.cliresumen`); filtros + orden (`.clifiltros`). Los
  envoltorios `.headctl`, `.cliresumen` y `.clifiltros` existen solo para eso —
  en celular son bloques normales.
- **La lista NO se parte en columnas, y es una decisión.** Los clientes van en
  orden por progreso y las ventas por urgencia de cobro; en dos columnas hay que
  leer en zigzag y ese orden deja de leerse.
- **La fila de persona se vuelve horizontal.** Apilada y estirada seguía igual
  de alta pero con aire de sobra: cabían menos personas que en celular.
- **El botón flotante se va al margen** (`right: max(18px, calc(50vw - 520px -
  72px))`). Pegado al borde del contenido tapaba el final de la fila.
- Todo dentro de la media query: **en celular no cambia nada**.

### La fila de persona: qué se quitó y por qué

Cuatro recortes, todos por lo mismo — cada fila repetía datos que ya estaban a
la vista, y con 200+ clientes eso se paga 200 veces.

- **La bandera reemplaza a «📍 Colombia»**, y sube a la línea del nombre: es un
  dato de la persona, no de su progreso. `pais` es texto libre, así que
  `bandera(pais, tel)` (`state.js`) normaliza el nombre y, si no lo reconoce,
  lo deduce del **prefijo del teléfono** antes de rendirse. Devolver `""` es
  una respuesta válida: entonces se pinta el texto tal cual, no se inventa una
  bandera. El nombre del país queda en el `title`.
- **El número no se imprime**; queda el 📋, que es para lo único que se usaba.
  El número real va en el `title` y en `data-num` (lo que copia `copyNum`).
- **«WhatsApp» pasa a ser el logo**, SVG en línea (`ICO_WA` en `ui.js`). No hay
  build ni CDN propio: un `<img>` externo serían 200+ peticiones por pantalla y
  una dependencia de un dominio ajeno.
- **Fuera el porcentaje** de `.pct`: la barra de al lado ya lo dice y `1/3` es
  el mismo dato por tercera vez. Queda lo exacto y lo accionable.

`.cfoot button` (0,1,1) le metía subrayado al emoji de `.copynum` (0,1,0) — la
trampa de `.frow label` otra vez. Se arregla nombrando el elemento
(`.cfoot button.copynum`), nunca con `!important`.

**El banco de pruebas ya no copia el marcado, lo extrae.** El generador saca de
`ui.js` el texto literal de `cardHTML()` y sus ayudantes y lo pega en el banco,
e importa `state.js` de verdad. Un banco con marcado copiado a mano envejece sin
avisar y comprueba una tarjeta que ya no existe.

## Estructura

```
public/
  index.html          Marcado de la app (login, vistas, modales)
  i.html              Puente del enlace rastreado: registra el clic y redirige.
                      Página aparte y sin el SDK a propósito: está en el camino
                      de alguien que quiere entrar a una clase que ya empezó.
  css/styles.css      Todos los estilos
  js/
    config.js         Credenciales de Supabase + NIVEL + BASE_URL (dominio de
                      los enlaces rastreados)
    supabase.js       Cliente
    state.js          Estado compartido + utilidades + lógica de negocio
    data.js           Consultas y escrituras (sin render)
    auth.js           Login, registro, sesión, roles, espera de aprobación
    ui.js             Render de vistas, perfil y catálogo
    csv.js            Importar / exportar
    seguimiento.js    Actividades, programación, plantillas, registro
    masivo.js         Compositor de mensaje masivo
    canal.js          «Mi WhatsApp»: estado y vinculación por agente
    salud.js          Alertas de canal caído + panel de agentes
    repaso.js         Repaso diario de asistencias
    ventas.js         Ventas, abonos y comisiones
    ftd.js            Bloque de FTD en Personas, metas y cierre mensual
    stats.js, main.js
sql/                  Migraciones documentadas (el estado real está en la base)
mcp/oracle/           Servidor MCP de solo lectura contra la API de Oracle
                      Cloud: instancias, cupo Always Free, métricas y costos.
                      Python sin dependencias. Ver su README.
contexto-worker.md    Cómo corre worker.py en la VM (no vive en este repo):
                      systemd, arquitectura paralelo-por-agente, parámetros,
                      enrutamiento por canales_wa, registro de bridges, salud
```

Flujo de dependencias sin ciclos. El estado mutable vive en un único objeto
`state` (`state.js`) que todos importan.

---

## Lo que NO está aquí

**El worker que envía por WhatsApp no vive en este repo.** Es `worker.py`, un
proceso Python en otro repositorio. Lo de abajo lo describió el dueño el 04/08;
**no se ha leído su código desde aquí**. Si algo depende de un detalle fino de su
comportamiento, decirlo en vez de asumirlo. **El detalle completo vive en
`contexto-worker.md`** (raíz de este repo) — acá solo lo esencial.

### Cómo funciona el worker (descrito por el dueño, 04/08 — detalle en `contexto-worker.md`)

| | |
|---|---|
| Dónde | Oracle Cloud VM `nexus-cloud`, Ubuntu 22.04, 1 GB, Always Free · `141.148.40.31` |
| Cómo arranca | systemd `nexus-worker` (enabled) · `/home/ubuntu/nexus-worker/` |
| Credencial | `.env` con la `SUPABASE_SERVICE_KEY` — por eso puede escribir las doce filas de `canales_wa` |
| Ciclo | cada `CICLO_SEG=20` s trae hasta 600 pendientes, agrupa por `owner_id` y lanza **un hilo por agente** |
| Ritmo | `PAUSA_MIN/MAX=4–8` s entre mensajes del **mismo** agente · `ARRANQUE_MAX=45` s de desfase inicial |
| Topes | `LOTE_MAX=40` por agente y ciclo · `TOPE_DIARIO=220` por agente y día |

- **El worker LE MARCA al bridge** (API REST, enrutado por **`owner_id → (host,
  puerto)`** desde `canales_wa`, desde el 08-08). Con dos VM ya en uso arma
  `http://{host}:{puerto}`: `localhost` para VM1 y `10.0.0.23` para VM2. Se había
  deducido de la base antes de saberlo —los canales muertos tenían `actualizado`
  avanzando cada ~30 s, y un proceso muerto no reescribe su propia fila— y quedó
  confirmado.
- **Un solo worker, siempre.** `mensajes_programados` no tiene columna de
  reclamo (ni `tomado_por`, ni lease, ni `intentos`), así que dos procesos
  leyendo la misma cola toman la misma fila y el cliente recibe el mensaje dos
  veces — que es justo la señal por la que WhatsApp restringe un número. Un
  worker por VM solo sería seguro filtrando por `owner_id`, con cada agente
  asignado a exactamente una máquina; es más frágil que la alternativa.
- **Solo envía si el canal del dueño está `vinculado`**; si no, marca el mensaje
  como `error`. Nunca manda desde otro número — la regla de oro, aplicada donde
  de verdad cuenta.
- **`TOPE_DIARIO` solo frena lo nuevo** (`invitacion`, masivo); nunca corta
  `rec_60`/`rec_15`/`enlace`/`confirmacion`, para no dejar a nadie sin el enlace
  de una actividad que ya arrancó.
- **La RAM aprieta, pero no es lo que decide.** Con los **12** bridges de hoy:
  356 de 956 MB, ~389 MB de RSS entre bridges y worker → **~29 MB por bridge**,
  más 2 GB de swap. 15 agentes caben holgados; 20 quedan apretados (~600 MB solo
  de bridges) pero viables. *(Una medición anterior con 9 bridges daba ~16 MB
  cada uno y se quedó corta — vale la de 12.)* Lo que de verdad obliga a una
  segunda máquina es la **IP**: 20 sesiones de WhatsApp saliendo de
  `141.148.40.31`. El propio worker ya lo reconoce — `ARRANQUE_MAX` existe para
  que varios agentes no disparen en el mismo segundo *desde la misma IP*.
- `canales_wa.host` (04/08) **ya se usa** (08-08): el worker la lee y arma
  `http://{host}:{puerto}`. Junto con la copia SSH del temporal de imagen al
  bridge remoto, es lo que hizo operativa la VM2. El índice único de `puerto` se
  mantiene como red de seguridad contra colisiones entre las dos VM.
- El bridge 8080 no entra en el barrido (su `actualizado` quedó congelado el
  22/07) porque es **el bridge viejo de Santiago**. Ya no es un misterio.
- **La tabla de puertos que anda circulando está desactualizada**: dice «8081
  Tatiana» y la base dice Evelin Gómez. La verdad es `canales_wa`, no el
  documento.
- El reintento de México **ya existe** en el worker (alterna el `1` tras el `52`
  cuando da `no LID found`). Que aun así haya causado 18 % de fallos significa
  que el reintento no alcanza, no que falte.

## Mirar Oracle en vivo (`mcp/oracle/`)

Servidor MCP de **solo lectura** contra la API de OCI, para preguntar por las VM
sin abrir la consola: instancias, cupo Always Free, métricas y costos. Puesta en
marcha y permisos, en `mcp/oracle/README.md`.

- **Sin dependencias, a propósito.** El SDK `oci` pesa 36 MB y obliga a un
  `pip install` en cada sitio donde corra (portátil, VM, entorno efímero de
  Claude, que se reconstruye en cada sesión). La firma es RSA-SHA256 sobre un
  texto armado a mano y Python trae de fábrica todo lo que hace falta.
- **El límite real lo pone la política de Oracle, no este código.** El usuario
  de API es de grupo `observadores` con `inspect`/`read` y nada más. Que aquí no
  haya herramientas de escritura es la segunda capa, no la primera.
- **La firma se probó verificándola con `cryptography`**, una implementación
  ajena, porque desde el entorno de Claude no se puede llamar a Oracle. Es más
  estricto que un «funcionó una vez».
- **`*.oraclecloud.com` está BLOQUEADO en el entorno remoto de Claude** (el
  proxy responde 403 al CONNECT). El servidor funciona desde el portátil; para
  usarlo en la web hay que permitir ese dominio en la política de red del
  entorno. Comprobado, no supuesto.
- **El cupo se responde CONTANDO las instancias**, y solo después se contrasta
  con la API de límites. Así «¿cabe otra VM gratis?» se contesta aunque esa API
  cambie de ruta — que es lo único que no se pudo verificar contra Oracle.
- **Las versiones de cada API viven juntas en la constante `API`**, porque son
  lo único que envejece. Si algo da 404, el primer sospechoso es esa tabla y
  `oci_get` sirve para tantear la ruta correcta sin editar código a ciegas.

### La cuenta de Oracle: qué caducó y qué no (08-10)

Llegó un correo de Oracle el 07/08 anunciando el fin del **Free Trial**. No
afecta a las VM:

- Lo que expiró son los **créditos de prueba** (los $300 / 30 días). **Always
  Free es otra cosa y no caduca**, mientras la cuenta siga activa y los recursos
  no lleven mucho tiempo ociosos (los bridges corriendo 24/7 bastan).
- Las dos VM son `VM.Standard.E2.1.Micro`, que es justo el shape Always Free de
  AMD. El tope de ese shape son **2**, así que **ese cupo está lleno**: no cabe
  una tercera VM AMD gratis.
- **Sí queda cupo ARM**: Ampere A1 regala 4 OCPU y 24 GB repartibles en hasta 4
  instancias. Una VM3 saldría de ahí, con dos salvedades: el bridge habría que
  compilarlo para **ARM**, y traería **otra IP** — que es precisamente el
  recurso escaso, no la RAM.
- Lo que sí se reclama a los 30 días es cualquier recurso creado con el crédito
  de prueba que **no** sea Always Free. `oci_cupo_gratis` lo señala: lista
  aparte lo que esté fuera de Always Free.

## Decisiones de seguridad que se relajaron a propósito

- **El agente escribe su propia `ftd_base`** (antes solo director y admin).
  Hacía falta para que declare sus FTD reales y cierre su mes. Se acepta porque
  **este panel no es la fuente de pago**: lo dice el aviso legal de la pantalla.
  Si algún día se paga contra estos números, hay que devolver la escritura al
  director. Queda como el único sitio donde alguien puede mover una cifra que
  le afecta a él mismo.

## Pendientes conocidos

- **Falta `parametros.comision_upgrade`**, todavía en 0. Los 16 productos ya
  tienen su comisión confirmada (30/07). Los bots comisionan **el 30 % del
  precio**, pero se guarda el MONTO: si cambia el precio de un bot hay que
  recalcularlo a mano (`sql/2026-07-30_10_...`).
- **Meta mensual de facturación** (distinta de las metas de FTD): pedida el
  29/07 y aplazada a propósito hasta que lo demás funcione.
- **Guardar la base de FTD al cerrar el mes** no tiene interfaz todavía: la app
  la calcula y la muestra, pero escribirla en `ftd_base` es manual.

- **Apagar «Confirm email»** en Supabase → Authentication. Con la aprobación
  manual ese paso sobra y provoca `email rate limit exceeded` al probar.
- **«Olvidé mi contraseña» necesita SMTP propio.** El de Supabase es de
  desarrollo y limita a unos pocos correos por hora. Cambiar la contraseña
  desde dentro (Más → Cambiar mi contraseña) ya funciona: usa
  `updateUser`, que va con la sesión abierta y **no manda ningún correo**.
  Falta la pantalla de recuperación, que además necesita atender el enlace de
  `type=recovery` al abrir la app.
- **Bug de números de México en el worker**: `no LID found for 52…` con y sin el
  `1` tras el código de país. Causó el 18 % de fallos de un agente.
- **La nota de voz en Masivo está oculta, no arreglada.** Sube bien al Storage
  y el worker la manda, pero WhatsApp la recibe como «Este audio ya no está
  disponible». Se probaron tres perfiles de opus, whatsmeow actualizada y el
  bucket `ptt` del CDN; nada lo resolvió. El botón vive en `index.html` detrás
  de un `hidden` (no se borró el código, para no perder el trabajo de grabar).
- **El video en Masivo está DESACTIVADO: el worker lo manda como nota de voz.**
  Comprobado con dos envíos reales (31/07, un `.mp4` y un `.mov`). El archivo
  sube perfecto —`storage.objects` guarda `video/mp4` y `video/quicktime`
  correctos— y el worker marca el mensaje `enviado`, pero al cliente le llega
  como PTT. **La regla del worker, inferida de los datos: reconoce extensiones
  de imagen y manda todo lo demás como nota de voz.** No tiene rama de video.
  Es el mismo agujero que ya rompió la nota de voz, visto desde el otro lado.
  Lo que falta es una línea en el worker (que no vive acá): detectar
  `video/*` y mandarlo como video. Del lado del panel ya está todo hecho —
  previsualización, validación y el bucket acepta los tipos—; para reactivarlo
  se devuelven `video/mp4,video/quicktime` al `accept` del input y a `TIPOS_OK`.
- **El CSV no lleva las asistencias puntuales** (`clientes.puntuales`).
- **El worker YA lee `canales_wa.host` y enruta por `owner_id`** (08-08). La
  columna dejó de ser inerte: Leonardo y María José envían desde la VM2
  (`10.0.0.23`). Detalle en `contexto-worker.md`.
- **Dos canales de VM1 siguen caídos** a medio vincular: Valery (28/07), Majo
  (30/07). No pueden enviar hasta revincular. (Felipe Narvaez se dio de baja; su
  bridge se apagó.)
- **La VM2 está operativa** (08-10). Leonardo y María José corren allá; probado
  hoy con tráfico real que texto e imágenes salen bien y solo a los clientes de
  cada quien (los dos defectos que costaron el número de Sofía están resueltos:
  enrutamiento por `owner_id` + copia SSH de la imagen al bridge remoto). El
  índice único de `canales_wa.puerto` se mantiene como red de seguridad. Falta
  solo: (a) el primer envío real de María José como confirmación —su config es
  idéntica a la ya probada de Leonardo—, y (b) que Laura escanee el QR para pasar
  de VM1 a VM2 (su sesión no era portable). El instructivo de alta de agentes en
  VM2 quedó en `contexto-worker.md`.
- **Cobro por uso**: la medición ya existe (`mensajes_programados` por
  `owner_id`) y el worker ya trae un tope duro por agente (`TOPE_DIARIO=220`),
  pero ese es de protección, igual para todos. Falta tabla de suscripción, que
  la cuota **salga del plan de cada quien** (aplicada en el worker, nunca en el
  navegador) y pasarela. El costo real es por puesto —cada agente necesita su
  bridge 24/7— así que el modelo sano es base por agente + cuota + excedente.
- **Riesgo de fondo del negocio**: se envía desde los WhatsApp personales de los
  agentes. Ya le restringieron el número a una. Los snippets `{a|b|c}` y el
  goteo ayudan pero no lo eliminan.

---

## Mantener este archivo

Actualizarlo al cerrar cada cambio con: decisiones de diseño con su porqué,
trampas nuevas, y pendientes que aparezcan o se resuelvan. Que siga siendo
denso y escaneable — se carga en cada sesión, así que cada línea tiene que
ganarse el sitio.
