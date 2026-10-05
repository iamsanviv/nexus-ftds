# Worker de WhatsApp

## Alcance

El worker de envíos no vive en este repositorio. Corre como proyecto/proceso separado en Oracle Cloud. Este documento conserva únicamente el contrato y las invariantes que Nexus FTDs necesita conocer para programar y diagnosticar envíos.

Si esta documentación contradice el estado verificado de Supabase o de la VM, manda el estado real.

## Flujo

```text
Nexus FTDs
  -> mensajes_programados (Supabase)
  -> worker Python
  -> agrupación por owner_id
  -> canal_wa del owner
  -> host + puerto
  -> bridge WhatsApp
  -> destinatario
```

## Ejecución

Históricamente el worker opera como servicio systemd `nexus-worker` en Oracle Cloud y revisa periódicamente mensajes `pendiente` cuyo `enviar_en` ya venció.

No asumir datos de infraestructura estáticos —IP, bridges activos, nombres y hosts cambian— sin verificarlos cuando la tarea sea operativa.

## Un solo consumidor

La cola no fue diseñada originalmente con mecanismo de lease/reclamo por mensaje. Ejecutar dos workers sobre la misma cola puede duplicar envíos. No levantar una segunda instancia del consumidor como arreglo improvisado.

## Paralelismo

El worker procesa por agente. La independencia entre agentes existe para que un volumen grande de un usuario no bloquee a los demás.

El ritmo y los límites deben aplicarse por agente cuando esa sea la intención de negocio; no convertir accidentalmente un límite local en cuello de botella global.

## Enrutamiento

**La identidad del bridge se resuelve por `owner_id`.**

Nunca usar únicamente el puerto como identificador global. Un puerto solo identifica un endpoint dentro de un host; dejó de ser único cuando aparecieron varias máquinas.

El worker debe resolver:

```text
owner_id -> host + puerto
```

Si no puede resolver el host/canal correcto, debe fallar cerrado y no caer silenciosamente a otro bridge.

## Defensa adicional de puertos

Existe/ha existido una restricción de unicidad de puerto como cinturón adicional frente a regresiones de enrutamiento. Aunque `owner_id` sea la identidad correcta, no retirar esa protección sin auditar el worker real y valorar el riesgo.

## Canales

`canales_wa` contiene el vínculo entre dueño y bridge, incluido estado y ubicación. Para diagnósticos, leer el estado actual de la tabla; una tabla copiada en documentación puede quedar obsoleta.

Un mensaje nunca debe salir por el canal de otro owner cuando el canal esperado esté caído.

## Multimedia

El worker resuelve recursos al enviar según su implementación vigente. Históricamente:

- el `worker.py` es **agnóstico al tipo**: baja el archivo a un temporal conservando la extensión de la URL y le pasa la ruta al bridge. Quien decide si algo va como imagen, video, nota de voz o documento es el **bridge**, y lo decide por la **extensión**;
- imágenes están soportadas;
- video (`mp4`, `mov`) funciona de extremo a extremo desde el 20/08/2026, comprobado en teléfono. El worker distingue audio de video con `ffprobe` cuando la extensión es ambigua;
- `webm` no tiene rama y cae en `DocumentMessage`, lo que probablemente explica el defecto de las notas de voz;
- notas de voz han tenido restricciones de reproducción.

No habilitar una capacidad de frontend porque el formulario la acepte si el worker no sabe entregarla correctamente.

### Caché de multimedia (04/09/2026)

El worker bajaba el archivo **una vez por destinatario**. Un video de 9 MB a 60
personas eran 540 MB de egress para mandar 9 MB. En agosto de 2026 eso consumió
~4 GB de los 5 GB/mes del plan free de Supabase y disparó el aviso de cuota: el
81 % del egress lo generaron 337 envíos de video, el 11 % de los envíos.

Se preparó `media_cache.py` (caché en disco, junto al worker, sin dependencias
nuevas). Los mismos envíos de agosto habrían costado 118 MB: 84 archivos
distintos en vez de 3.571 descargas.

Dos invariantes al integrarla:

- **quien envía NO borra la ruta.** El worker borraba el temporal al terminar;
  con caché eso hay que quitarlo, o no sirve de nada y además puede destruir el
  archivo mientras otro envío lo lee;
- **la clave conserva la extensión**, incluido el fallback `.jpg` que tenía
  `descargar_media`. El bridge decide imagen/video/nota de voz por la
  extensión: una caché que guarde sin ella manda todo como documento;
- **el audio NO se convierte desde el archivo cacheado.** `convertir_a_ogg`
  arma su salida como `ruta + ".conv.ogg"` y ffmpeg corre con `-y`. Con la
  caché, la entrada pasa a ser una ruta COMPARTIDA, así que dos envíos
  simultáneos de la misma nota de voz escribirían y borrarían el mismo `.ogg`
  y uno de los dos saldría corrupto. Se convierte desde una copia local de
  nombre único (`mkstemp`), que no cuesta egress. Antes no podía ocurrir
  porque cada descarga era un `mkstemp` distinto: la caché es la que
  introduce el recurso compartido;
- **la copia a un bridge en OTRA máquina también comparte la ruta, y esta sí
  se rompió en producción.** `_copiar_media()` copia el archivo al mismo
  camino absoluto en el host remoto (`scp ruta ubuntu@host:ruta`). Mientras
  `descargar_media` bajaba a `/tmp`, ese camino existía en las dos máquinas.
  Desde la caché (07/09), el origen es
  `/home/ubuntu/nexus-worker/cache-media/...`, que **no existe en la otra
  VM**, y el `scp` fallaba con «No such file or directory». Se rompió en
  silencio: la última multimedia hacia esa máquina antes del defecto fue el
  05/09 y la siguiente fue el 15/09 — diez días dormido — y esa vez costó 17
  invitaciones de un Zoom que no salieron. Arreglado el 15/09: la copia
  remota vuelve a ir a `/tmp` con nombre único por envío (mismo motivo que el
  `.ogg`: la clave es un hash del contenido, no del destinatario).

La caché es en disco y no en memoria porque el servicio puede reiniciarse entre
lotes, justo entre las dos campañas que más se benefician.


## Sondeo adaptativo (12/09/2026)

`main()` sondeaba la cola cada `CICLO_SEG` (20 s) SIEMPRE, 24/7. Como `ciclo()`
corta con `return` apenas la cola viene vacía, en reposo cada vuelta solo
gastaba dos llamadas —`caducar_comandos()` (PATCH) y `pendientes()` (GET)—,
pero eran ~4.320 vueltas al día. Ese es el gasto PLANO que se vio en la gráfica
de egress: un domingo de 5 mensajes costaba lo mismo que un jueves de 984,
porque no dependía de los mensajes sino del reloj.

El arreglo NO toca esas dos funciones: cuando no hay cola, `main()` duerme
hasta el próximo `enviar_en` (`proximo_pendiente()`), con piso `SLEEP_MIN` (5 s)
y techo por franja de Colombia —`TOPE_DIA` 60 s entre 8 y 22 h, `TOPE_NOCHE`
300 s de madrugada—. Con cola, drena a `CICLO_SEG`. Así las dos llamadas de
reposo bajan de frecuencia solas.

Lo que NO se hizo, a propósito:

- **`cargar_canales()` no se cachea.** Solo se pide cuando SÍ hay mensajes, y
  su frescura sostiene la regla de enrutar por `owner_id`: una lista de canales
  vieja podría mandar por el bridge de un agente que acaba de desvincularse.
- **`chats_sync` pasó a cadencia por RELOJ** (`SYNC_SEG`, 300 s) en vez de por
  número de vueltas. Con el sondeo durmiendo distinto cada vez, atarlo a las
  vueltas lo volvía impredecible; por reloj mantiene su comportamiento de hoy
  (~cada 5 min). Sigue siendo un origen de egress de fondo: si tras esto el
  gasto no baja lo suficiente, es el siguiente a medir.

La franja usa hora de Colombia fijando UTC-5 (sin horario de verano), la misma
regla que `hoyISO()`.

## Dónde vive de verdad (verificado 20/08/2026)

- VM: `ubuntu@141.148.40.31`, llave `~/.ssh/nexus_oracle`;
- worker: servicio `nexus-worker` en `/home/ubuntu/nexus-worker`;
- bridges: un servicio por agente con plantilla `nexus-bridge@<slug>`, directorio por agente en `/home/ubuntu/nexus-bridges/<slug>` y `provisionar.sh` para dar de alta uno nuevo (tiene guardia anti-duplicados por owner y por puerto);
- **los nueve bridges comparten un único ejecutable**: `/home/ubuntu/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge-mt`. Cambiarlo los afecta a todos y exige recompilar y reiniciar los nueve servicios;
- la copia de `whatsapp-mcp` que hay en WSL es de desarrollo y **no** es la que corre en producción; no confundirlas al leer código.

## Identidades ocultas (LID) y nombres de usuario

WhatsApp está retirando el teléfono como identificador visible. Con LID —y con los nombres de usuario, en despliegue por países desde julio de 2026— quien escribe llega identificado por una identidad oculta y la app **no muestra su número**.

Medido el 26/08/2026 en los doce bridges: 9.157 chats `@lid` frente a 967 con número. El 99% de esos LID se resuelve a un teléfono real porque whatsmeow mantiene la tabla `whatsmeow_lid_map` (`lid` → `pn`) en el `whatsapp.db` de cada bridge.

**No existe forma de escribirle a alguien conociendo solo su nombre de usuario.** Verificado en whatsmeow: no hay servidor de JID para usernames, `IsOnWhatsApp()` solo acepta teléfonos y no hay función que resuelva un handle a una identidad enviable. Lo único disponible es leer el username de alguien cuyo JID ya se conoce. Lo que sí se puede es registrar a quien **ya escribió**, resolviendo su LID.

## Sincronización de chats recientes

El worker corre además `chats_sync.py`, que cada `SYNC_CHATS` ciclos (15, ~5 min) lee los SQLite de los bridges en **solo lectura** y publica en `chats_recientes` los chats 1:1 de los últimos 30 días con su teléfono ya resuelto.

Decisiones que conviene no deshacer:

- **Lee los SQLite; no le pregunta al bridge.** Los doce bridges comparten un ejecutable: añadirle un endpoint obliga a recompilar y reiniciar los doce, y cada sesión caída se revincula por QR. El worker ya es vecino de los bridges y corre como el mismo usuario.
- **Sube un agente por petición.** Un lote único se cae entero por una sola fila mala. Pasó de verdad: el bridge `juan_narvaez` apunta a un `owner_id` que ya no existe en `auth.users` y viola la FK; aislado, solo falla ese.
- **Filtra números degenerados.** Un LID resolvía a `0`; sin filtro esa fila rompía el CHECK y perdía la sincronización de todo su agente.
- **La poda calcula el corte explícitamente**, no a partir de lo sincronizado: un bridge caído no aporta filas y deducirlo de los datos daría un corte equivocado. El `DELETE` **siempre** lleva filtro.
- **Abre las bases con `nolock=1`, no solo con `mode=ro`.** Los SQLite de los bridges están en `journal_mode=delete`, donde un lector toma candado compartido y **bloquea al escritor**. Con solo `mode=ro` se vio al bridge de Santiago Viveros fallar al guardar una clave de remitente con «database is locked», y ese mensaje se quedó sin descifrar (26/08/2026). Enviar y recibir es lo que no puede fallar; esta sincronización es accesoria. El precio de `nolock=1` es leer a mitad de una escritura: por eso cada bridge va en su propio `try/except` y una lectura corrupta solo salta a ese agente hasta el ciclo siguiente.

`WA_OWNER` del archivo `env` de cada bridge es lo que mapea directorio → agente.

### `entrante_en`: último mensaje entrante (Leads F4, 2026-10-05)

`chats_recientes.entrante_en` guarda el último mensaje que la persona NOS escribió
(`is_from_me=0`), para «bajaron hoy a tu WhatsApp» y la temperatura en Leads. `ultimo_en`
(= `chats.last_message_time`) no sirve para eso: es el último mensaje del chat en cualquier
dirección, así que se mueve también cuando el agente escribe.

Se calcula en la MISMA consulta de `_chats_de` con una subconsulta
`(SELECT MAX(m2.timestamp) FROM messages m2 WHERE m2.chat_jid=c.jid AND m2.is_from_me=0)`.
Como el `EXISTS (is_from_me=0)` ya exige al menos un entrante, nunca sale NULL. **No agrega
ninguna petición**: es una columna más en el upsert que ya se hacía, a la misma cadencia.
Parche idempotente y copia de referencia en `vm/chats-sync/` del repo.

## `comando`: la orden de desvincular se queda encolada

`canales_wa.comando` es cómo el panel le habla al bridge («desvincular»). El bridge la consume y la borra.

**Un bridge que no lee esa columna deja la orden viva indefinidamente.** Pasó el 26/08/2026: Santiago Viveros corría el bridge original de un solo agente, que ni escribe estado/QR ni consume `comando`. Su «Desvincular» quedó guardado; al migrarlo al bridge multi-agente, este arrancó, se emparejó correctamente a las 00:39:34 y **cuatro segundos después consumió la orden vieja y cerró la sesión**. El panel mostró «vinculado» durante esos segundos y luego se congeló.

Antes de vincular a alguien que venía de un bridge que no consumía comandos, comprobar que `comando is null`.

**Arreglado el 27/08/2026** en tres capas, porque una sola no bastaba:

1. `canales_wa.comando_en` guarda cuándo se pidió la orden. La sella un **trigger** (`sellar_comando_canal`), no el panel: `authenticated` solo tiene UPDATE sobre `comando`, y dejarle escribir la fecha permitiría antedatar una orden para que pareciera fresca. El trigger solo la toca cuando el comando CAMBIA, así que un latido del bridge no rejuvenece una orden vieja.
2. El panel (`canal.js`) no acepta la orden si el bridge no da señales de vida, y si a los 20 s nadie la recogió **la retira** y lo dice. Antes volvía a «Vinculado» sin explicar nada: ese era el bug que veía el agente.
3. El worker caduca cada ciclo las órdenes de más de `COMANDO_TTL` (180 s) sin recoger. Cubre el caso de que el agente cierre el panel y no quede nadie del lado del navegador para limpiarla.

`canales_wa.actualizado` es el **latido**: los bridges `-mt` lo reescriben cada ~30 s aunque no pase nada. El panel lo usa para no afirmar «vinculado» sobre una fila congelada — el 26/08/2026 la de Santiago Viveros llevaba un mes sin tocarse y el panel la mostraba como verdad mientras todos los envíos fallaban.

## No todos los canales viven en la misma máquina

`canales_wa` tenía 18 filas el 26/08/2026 y esta VM solo alberga 12 bridges; el resto corre en `10.0.0.23`. El constraint de unicidad de `puerto` es **global**, así que «el siguiente puerto libre en esta VM» no basta: al provisionar hay que elegir uno libre en la TABLA. Un intento de usar el 8093 chocó con el de María José, que corre en la otra máquina.

## Bajas de canal: `bajas.py` (15/09/2026)

Cuando alguien deja la empresa hay que apagar su bridge y devolver su puerto al conjunto disponible. El panel no alcanza la VM, así que lo hace un ejecutor local que sondea la base.

- Unidad: `nexus-bajas.service` + `nexus-bajas.timer`, oneshot cada 2 min, `User=ubuntu`.
- Archivo: `/home/ubuntu/nexus-worker/bajas.py`, solo biblioteca estándar (urllib, no `requests`).
- Consulta: `canales_wa?baja_en=not.is.null&puerto=not.is.null`. Que `puerto` siga puesto ES lo pendiente; ponerlo en `null` es lo que cierra la baja.

**Va aparte de `worker.py` a propósito.** Enviar mensajes es lo único que no puede fallar; una baja ocurre unas pocas veces al año y aguanta dos minutos. Además así se instala en cualquier máquina con bridges, corra o no el worker en ella.

**Hay que instalarlo en LAS DOS máquinas.** Cada ejecutor resuelve el bridge recorriendo `/home/ubuntu/nexus-bridges/*/env` en busca de `WA_OWNER=<uuid>`; una fila cuyo bridge vive en la otra VM no encuentra nada y se deja pendiente. Si solo se instala en una, las bajas de la otra quedan sin ejecutar (el panel lo avisa a los 15 minutos, pero nadie las hace).

**Liberar el puerto = renombrar con punto delante.** `provisionar.sh` rechaza un puerto que aparezca en algún `*/env`, y su glob es `*/`: bash SÍ incluye `fabian.bak/` y NO `.baja-fabian-20260915/`. El `mv $d $d.bak` que sugiere el propio script **no libera nada**. El directorio se archiva, no se borra: dentro va `store/`, la sesión de WhatsApp, por si hay que revertir.

**Seguridad del `sudo`.** `ubuntu` tiene `NOPASSWD: ALL`, así que el ejecutor puede hacer cualquier cosa. Lo que lo contiene: de la base solo se acepta un UUID (validado por regex, usado únicamente como texto a comparar); lo que llega a la línea de comandos es un nombre de directorio de este disco, validado contra `^[a-z0-9][a-z0-9_-]{0,31}$`, con `subprocess.run([...], shell=False)`. Un directorio con nombre raro se salta **antes** de reclamar la fila, para no dejarla en `bajando` sin salida.

### La baja NO quita el dispositivo del teléfono (hecho 05/10/2026)

Apagar y archivar el bridge deja la sesión **viva en el WhatsApp personal del ex-agente**: sigue
como «dispositivo vinculado» hasta que WhatsApp lo caduca solo (~14 días sin conexión). `canales_wa.estado`
queda congelado en `vinculado`, pero es un valor viejo, no una verdad viva (mirar `actualizado`/`ultimo_visto`).

Para cerrarlo del lado del servidor sin depender del ex-agente, se **revive el bridge archivado un momento**
(tiene la sesión en `store/`, reconecta sin QR) y se le manda `desvincular`; whatsmeow hace `Logout()` y el
dispositivo desaparece de su teléfono. Procedimiento, con el directorio archivado `.`<slug> y su puerto (libre):

1. `mv .<slug> <slug>` y `systemctl start nexus-bridge@<slug>`; esperar a que reconecte (en el log entran mensajes).
2. `update canales_wa set comando='desvincular' where owner_id=<uuid>` — DESPUÉS de que reconecte, para que
   el bridge lo consuma antes de que el worker lo caduque (`COMANDO_TTL` 180 s; el bridge sondea cada 60 s).
3. Confirmar: en la base `comando` vuelve a `null` (lo consumió) y `actualizado` se congela (cerró y enmudeció).
4. `systemctl disable --now nexus-bridge@<slug>` y `mv <slug> .<slug>` para restaurar la baja. El puerto sigue libre.

Verificar antes de revivir que no haya `mensajes_programados` en `pendiente` para ese `owner_id`: al reconectar,
el worker podría enviar a su nombre. El único testigo real de que el dispositivo ya no está es la lista de
dispositivos de su teléfono; el log/`Logout()` es la prueba del lado del servidor. Si hubo un bridge duplicado
(`.dup-*`), su sesión suele estar muerta, pero puede quedar como otro dispositivo: cerrarlo igual si aparece.

## Tope diario y zona horaria

Existe antecedente de un defecto donde el tope diario se calculaba con el día UTC. En Colombia la medianoche UTC ocurre a las 19:00, por lo que consumos nocturnos podían contarse contra el día siguiente y bloquear invitaciones legítimas.

Antes de tocar límites diarios, verificar cómo calcula actualmente la fecha el `worker.py` real. No asumir que el defecto sigue abierto ni que ya fue corregido sin comprobar la VM.

## MCP Oracle

El repositorio define un servidor MCP local en `.mcp.json`:

```text
python3 mcp/oracle/servidor.py
```

El brain describe el sistema. El MCP sirve para verificar/operar la infraestructura. No confundir memoria con estado en vivo.

## Fuente histórica

`contexto-worker.md` conserva contexto detallado anterior. Debe tratarse como documentación histórica hasta verificar los puntos operativos variables.

## Bridge: `comando` y latido a 60 s (2026-10-02)

El bridge (`vigilarComandos` en `main.go`, **REST puro**, sin driver de Postgres)
sondeaba `comando` cada **2 s** (~40.000 req/día por bridge) y latía cada 30 s.
Ese sondeo en vacío era el ~77% del egress y agotó el cupo gratis de Supabase
(5 GB): la API REST empezó a devolver **402** en todo (bridges, worker, panel).
El `execute_sql` del MCP seguía entrando por otra vía, por eso la base se
consultaba pero los bridges no podían leer/escribir.

**Decisión: NO push (LISTEN/NOTIFY), sí subir el sondeo a 60 s.** El bridge es
REST puro; meterle pgx + conexión permanente + credenciales en ~18 VMs no
compensa, porque a escala el que domina es el **latido** (que ambos caminos
mantienen), no el comando. A 50 agentes el push ahorra solo ~1.200 req/día por
agente y además mete 50 conexiones permanentes (de 200 del pooler). El 2 s→60 s
se lleva el ~90% del gasto del bucle con una línea.

Cambio (en el bucle de `vigilarComandos`): latido a `ticks%30==0` (60 s) y
comando con `if ticks%30 != 0 || leerComando()...` (60 s, por corto-circuito de
`||`). Panel (`canal.js`): `LATIDO_VIVO_SEG` 90→180 y `ESPERA_DESV_SEG` 20→90,
o el panel mostraría "sin señal" en falso y "Desvincular" roto. Para el agente
solo cambia que desvincular tarda hasta ~60 s (antes ~2 s).

El trigger `avisar_comando_canal` (NOTIFY en `canal_comando`, migración
`sql/2026-10-02_26_aviso_comando.sql`) quedó creado y probado pero **DORMIDO**:
el bridge no escucha. Es base lista por si se retoma el push; inofensivo (solo
dispara en un cambio real de `comando`) y se puede eliminar sin efecto.
LISTEN/NOTIFY **sí** funciona por el pooler en modo **Session** (5432), no por
Transaction (6543). Verificado 2026-10-02.

**Supabase pasó a Pro (2026-10-02)** para destapar el 402 al instante (el ciclo
gratis no reiniciaba hasta ~el 11). Pro = 250 GB egress (~26× el uso real), así
que el límite deja de ser preocupación; el arreglo de 60 s es holgura/limpieza.

### Trampas del despliegue (si se repite)

- `create`/`drop trigger` sobre `canales_wa` necesita SHARE ROW EXCLUSIVE, que
  choca con cada escritura. Con los bridges vivos el DDL se starva y expira;
  hacerlo con producción detenida o con `lock_timeout` + reintentos.
- Topología: **VM1** = `ubuntu@141.148.40.31` (`nexus-cloud`), 10 bridges, con
  Go+gcc. **VM2** = `10.0.0.23` (`nexus-cloud-2`), 8 bridges, **sin** Go/gcc; se
  alcanza desde VM1 con `~/.ssh/vm2.key`. VM2 recibe el binario por `scp`.
- En VM2 el dir `/home/ubuntu/whatsapp-mcp/whatsapp-bridge` es de **root** →
  escribir ahí con `sudo` (`scp` a `/tmp` + `sudo mv`).
- Binario compartido por todos los bridges de una VM. Se promueve con `mv`
  atómico (seguro con el binario en uso) y se reinicia cada servicio. Un
  reinicio **no** borra sesión (vive en el `store/` de cada agente): reconecta
  sin QR. Los que piden QR ya estaban sin sesión desde antes.
- Build: `export PATH=$PATH:/usr/local/go/bin; CGO_ENABLED=1 go build -o
  whatsapp-bridge-mt.new .` (CGO por `go-sqlite3`). Respaldos:
  `whatsapp-bridge-mt.bak-<fecha>` y `.prev`. Probar siempre en 1 bridge con un
  override de systemd apuntando al `.new` antes de promover.

## Runbook: dar de baja / desactivar un agente

`bajas.py` está instalado como timer de systemd (cada 2 min) en **ambas VMs**
desde el 2026-10-03 (código en `vm/bajas/`), así que la **baja de canal es
automática**: basta marcar `baja_en` y el ejecutor de ESA VM apaga/deshabilita
el bridge, archiva la carpeta (`.baja-<slug>-<fecha>`, lo único que libera el
puerto) y pone `puerto=null`, todo en ≤2 min. La desactivación del **perfil**
sigue siendo un paso aparte en la base.

**Identificar siempre por `owner_id`, NO por el nombre de la carpeta.** Los slugs
mienten: en VM1 `daniela_duarte` sirve a *Sofía Muñoz*, `tatiana` a *Evelin
Gomez*, y hay carpetas sobrantes (`juan_narvaez`, `leonardo_angarita`) sin
servicio. Mapa real:
`for d in /home/ubuntu/nexus-bridges/*/; do grep '^WA_OWNER=' "$d/env"; done`
cruzado con `canales_wa`/`profiles` por `owner_id`.

### A) El agente SE VA — quitar acceso + apagar infraestructura
1. **(Solo si está vinculado)** desvincular su WhatsApp ANTES de la baja:
   `update canales_wa set comando='desvincular' where owner_id='<uuid>';`, esperar
   ~60 s a que el bridge haga logout. Si no, el dispositivo queda
   emparejado-pero-muerto en su teléfono (se quita a mano desde «Dispositivos
   vinculados»).
2. **Baja del canal** — marcar la fila y dejar que el timer la ejecute. **NO
   pongas `puerto=null` a mano:** el timer necesita ver `puerto` todavía puesto
   para tomar la baja.
   `update canales_wa set baja_en=now(), baja_por='<admin uuid>' where owner_id='<uuid>';`
   En ≤2 min `bajas.py` de esa VM apaga/deshabilita/archiva y libera el puerto.
3. **Desactivar el perfil:**
   `update profiles set aprobado=false, rechazado_en=now() where id='<uuid>';`
   El trigger `impedir_cambio_de_rol` se salta cuando `auth.uid() is null`
   (service role). **Baja ≠ borrar:** clientes, ventas, seguimientos e historial
   se conservan.

**Fallback (timer caído):** hacer a mano lo que hace el ejecutor —
`sudo systemctl stop/disable nexus-bridge@<slug>`, `sudo mv
/home/ubuntu/nexus-bridges/<slug> /home/ubuntu/nexus-bridges/.<slug>`
(con punto delante; un `.bak` NO libera el puerto), y luego
`update canales_wa set puerto=null, estado='baja' where owner_id='<uuid>';`.

### B) El agente SE QUEDA pero no usará WhatsApp por ahora — solo dejar de sondear
- Únicamente `sudo systemctl stop nexus-bridge@<slug>` + `disable`. **No**
  archivar la carpeta, **no** tocar `canales_wa` ni `profiles`. Para reactivar:
  `enable` + `start`, y el agente re-escanea el QR desde el panel.

### Revertir — reactivar a alguien dado de baja
1. Perfil: `update profiles set aprobado=true, rechazado_en=null where id='<uuid>';`
2. Canal: `update canales_wa set baja_en=null, baja_por=null, puerto=<n_libre> where owner_id='<uuid>';`
   (elegir un puerto libre **en la tabla**, el constraint de unicidad es global
   entre las dos VMs).
3. Bridge: des-archivar la carpeta (`sudo mv /home/ubuntu/nexus-bridges/.<slug>
   /home/ubuntu/nexus-bridges/<slug>`), `sudo systemctl enable` + `start`, y el
   agente re-escanea el QR desde el panel.

Reactivar a un agente del caso B (solo apagado) es aún más simple: `enable` +
`start` su servicio y re-escanear; no se tocó ni perfil ni canal.

Lo ideal es **instalar `bajas.py`** (timer cada 2 min por VM): automatiza el caso
A desde el panel vía RPC `dar_de_baja_canal`, sin SSH. Ver
`sql/2026-09-15_23_baja_de_canal.sql`. Mientras no esté, este runbook es el
camino.

## Relacionado

- [[../03-domain/messaging-rules]]
- [[../08-memory/dangerous-patterns]]
- [[../08-memory/known-issues]]