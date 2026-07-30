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
- **Se puede apagar por actividad** (`actividades.rastrear`, por defecto sí):
  cambiar un `zoom.us` reconocible por un enlace nuestro resta confianza y es
  señal de spam, y aquí ya hubo un número restringido.
- Lo que **no** puede saber, y está dicho en pantalla: un clic es que abrió, no
  que se quedó; si reenvía el mensaje el clic queda a nombre de quien lo
  recibió; quien entre con un enlace que ya tenía no genera clic; y el agente
  que abra el enlace para probarlo le marca asistencia a ese cliente.

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
```

Flujo de dependencias sin ciclos. El estado mutable vive en un único objeto
`state` (`state.js`) que todos importan.

---

## Lo que NO está aquí

**El worker que envía por WhatsApp no vive en este repo.** Consume
`mensajes_programados` y habla con un bridge por agente (`canales_wa`). Todo lo
que se sabe de él es inferencia desde la base. Si algo depende de su
comportamiento, decirlo en vez de asumirlo.

## Decisiones de seguridad que se relajaron a propósito

- **El agente escribe su propia `ftd_base`** (antes solo director y admin).
  Hacía falta para que declare sus FTD reales y cierre su mes. Se acepta porque
  **este panel no es la fuente de pago**: lo dice el aviso legal de la pantalla.
  Si algún día se paga contra estos números, hay que devolver la escritura al
  director. Queda como el único sitio donde alguien puede mover una cifra que
  le afecta a él mismo.

## Pendientes conocidos

- **Faltan valores de comisión**: `parametros.comision_upgrade` y once productos
  quedaron en 0 («por confirmar» en la lista del 29/07). Mientras sigan en cero,
  esas ventas se registran pero no suman.
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
- **El CSV no lleva las asistencias puntuales** (`clientes.puntuales`).
- **Cobro por uso**: la medición ya existe (`mensajes_programados` por
  `owner_id`). Falta tabla de suscripción, cuota **aplicada en el worker** (no
  en el navegador) y pasarela. El costo real es por puesto —cada agente necesita
  su bridge 24/7— así que el modelo sano es base por agente + cuota + excedente.
- **Riesgo de fondo del negocio**: se envía desde los WhatsApp personales de los
  agentes. Ya le restringieron el número a una. Los snippets `{a|b|c}` y el
  goteo ayudan pero no lo eliminan.

---

## Mantener este archivo

Actualizarlo al cerrar cada cambio con: decisiones de diseño con su porqué,
trampas nuevas, y pendientes que aparezcan o se resuelvan. Que siga siendo
denso y escaneable — se carga en cada sesión, así que cada línea tiene que
ganarse el sitio.
