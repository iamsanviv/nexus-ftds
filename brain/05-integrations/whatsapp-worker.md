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
- **la clave conserva la extensión.** El bridge decide imagen/video/nota de voz
  por la extensión: una caché que guarde sin ella manda todo como documento.

La caché es en disco y no en memoria porque el servicio puede reiniciarse entre
lotes, justo entre las dos campañas que más se benefician.


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

## Relacionado

- [[../03-domain/messaging-rules]]
- [[../08-memory/dangerous-patterns]]
- [[../08-memory/known-issues]]