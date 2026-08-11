# Contexto: worker de envíos de Nexus (VM Oracle)

> Última actualización: 2026-08-10

**El worker no vive en este repositorio** — es otro proyecto, en otra VM — pero
lo de acá decide cosas de este lado (el RLS de `canales_wa`, la columna `host`,
los topes de envío), así que se documenta igual que `sql/`.

Dos fuentes, y conviene no mezclarlas:

- **Descrito por quien administra la VM** — casi todo este archivo. No sale de
  leer `worker.py`.
- **Confirmado en Supabase** — solo la tabla de bridges de abajo. Eso se puede
  releer en `canales_wa` en cualquier momento, sin depender de nadie.

Si el documento y la base se contradicen, **manda la base**.

## Qué es

`worker.py` es un proceso Python que vacía la cola de mensajes de WhatsApp. Lee de
Supabase (tabla `mensajes_programados`, estado `pendiente` con `enviar_en` ya
vencida) y los envía llamando a la API REST del bridge del agente dueño. Corre
24/7 en la nube, no en ningún PC.

## Dónde y cómo corre

- **VM** `nexus-cloud` (Oracle Cloud, Ubuntu 22.04, 1 GB RAM + 2 GB swap, Always Free). IP `141.148.40.31`.
- **Servicio** systemd `nexus-worker` — `active`, `enabled` para boot. **Un solo proceso** para toda la oficina.
- **Ruta**: `/home/ubuntu/nexus-worker/` (`worker.py` + `.env` con `SUPABASE_SERVICE_KEY` + `venv/`). Respaldo del worker anterior (envío en serie): `worker.py.bak-serial`.
- **Comandos**: `sudo systemctl status|restart nexus-worker`; logs en vivo `journalctl -u nexus-worker -f`.

La `SUPABASE_SERVICE_KEY` del `.env` explica algo que se había deducido leyendo
la base antes de tener este documento: por qué el worker puede reescribir las
doce filas de `canales_wa` cuando ningún agente, por RLS, puede tocar más que la
suya.

**Un solo worker, siempre.** `mensajes_programados` no tiene columna de reclamo
(ni `tomado_por`, ni lease, ni `intentos`), así que dos procesos leyendo la misma
cola toman la misma fila y el cliente recibe el mensaje dos veces — que es justo
la señal por la que WhatsApp restringe un número.

## Arquitectura de envío (paralelo por agente, desde 2026-07-24)

Cada ciclo (cada `CICLO_SEG` = 20 s):

1. Trae la cola de todos los agentes (hasta 600).
2. La **agrupa por `owner_id`** y lanza **un hilo por agente** (`procesar_agente`).
3. Cada agente envía por SU propio bridge (enrutado por **`owner_id → (host, puerto)`** vía tabla `canales_wa`), con su propio ritmo humano. Los agentes no hacen fila entre ellos.

Antes había un solo carril global (una pausa entre mensajes de toda la oficina),
lo que hacía que con varias actividades a la misma hora el enlace saliera hasta
~1 hora tarde. Con el paralelo, 200+ mensajes se drenan en pocos minutos.

## Parámetros (encabezado de `worker.py`)

| Parámetro | Valor | Significado |
|---|---|---|
| `CICLO_SEG` | 20 | Cada cuánto revisa la cola. |
| `PAUSA_MIN` / `PAUSA_MAX` | 4 / 8 | Pausa aleatoria entre mensajes **de un mismo agente** (no global). |
| `ARRANQUE_MAX` | 45 | Desfase inicial al azar por agente (evita que todos disparen en el mismo segundo desde la misma IP). |
| `LOTE_MAX` | 40 | Máximo de mensajes por agente **por ciclo**; el resto va al ciclo siguiente. |
| `TOPE_DIARIO` | 220 | Máximo por agente y por día. **Solo frena tipos nuevos (`invitacion`, `masivo`); nunca corta `rec_60`/`rec_15`/`enlace`/`confirmacion`** para no dejar a nadie sin el enlace de una actividad en marcha. |

`ARRANQUE_MAX` es la prueba de que el propio worker ya trata **la IP**, no la
memoria, como el recurso escaso de la VM.

## Enrutamiento multi-agente

La tabla `canales_wa` mapea `owner_id → (puerto, estado, host)`. El worker solo envía si
el canal del dueño está `vinculado`; si no, marca el mensaje como error (nunca
manda desde otro número). Cada bridge es un binario Go (whatsmeow) que mantiene la
sesión de WhatsApp en su carpeta `store/`.

**Desde el 08-08 el worker lee `host` y enruta por `owner_id`** (ver «Repartir
bridges en dos VM», más abajo): arma la URL como `http://{host}:{puerto}`. Con eso
un bridge puede vivir en otra máquina. Hoy hay dos VM en juego:

- **VM1** `nexus-cloud` (`141.148.40.31`) — el worker y la mayoría de bridges. `host = localhost`.
- **VM2** (`10.0.0.23`, red privada) — bridges de Juana. `host = 10.0.0.23`.

### Bridges — confirmado en `canales_wa` (2026-08-10)

| Puerto | Host | Agente | Estado | Nota |
|---|---|---|---|---|
| 8080 | localhost | Santiago Viveros (bridge viejo) | vinculado | no entra en el barrido (señal congelada 22/07) |
| 8081 | localhost | Evelin Gomez | vinculado | VM1, vivo |
| 8082 | localhost | Juan Pablo Castro | vinculando | VM1 |
| 8083 | localhost | fabian florez | vinculado | VM1, vivo |
| 8084 | localhost | Daniel | vinculado | VM1, vivo (envió imágenes hoy) |
| 8085 | localhost | Majo Guzman | **solicitado** | caído |
| 8087 | localhost | Valery Gallo | **vinculando** | caído |
| 8088 | localhost | Brayan Monje | vinculado | VM1, vivo |
| 8091 | localhost | Laura Daniela Duarte | vinculado | **sigue en VM1** — su sesión no era portable, falta que escanee QR para pasar a VM2 |
| 8092 | **10.0.0.23** | Jose Leonardo Angarita Lara | vinculado | **VM2** — probado hoy: texto e imágenes OK, a sus propios clientes |
| 8093 | **10.0.0.23** | María José L | vinculado | **VM2** — bridge vivo; config idéntica a la de Leonardo, pendiente su primer envío real |
| 8192 | localhost | Sofía Muñoz | vinculando | **número bloqueado por WhatsApp** (ver DEFECTO 1); aislada aquí para que no colisione |

- **Felipe Narvaez (juan_narvaez, 8086) ya no está** — dado de baja; su bridge se apagó.
- **Sofía (8192)**: se movió de 8092 a 8192 tras el incidente. Su número sigue
  bloqueado, por eso no pasa de `vinculando`.

**Dos canales de VM1 siguen caídos** a medio vincular (Valery, Majo). Esos
agentes no pueden enviar nada hasta revincular.

**Ojo con los nombres.** La tabla de puertos que circula por fuera dice «8081 →
Tatiana» y «8090 → María José Lamilla»; la base dice **Evelin Gómez** y
**María José L**. Cuando no coincidan, manda `canales_wa`.

## Detalles de envío

- **México**: reintento automático que alterna el `1` tras el código 52 si da "no LID found". Ya existe — que aun así haya causado 18 % de fallos en un agente significa que **el reintento no alcanza**, no que falte.
- **Imágenes**: se resuelve la imagen actual del servicio al enviar (no se congela al programar). Si el bridge del dueño está en otra VM, el temporal se copia por SSH antes de mandar (ver DEFECTO 2).
- **Enlace**: el token `{enlace}` se resuelve al enviar; si a esa hora no hay enlace, el mensaje se omite.
- **Nota de voz**: la conversión a ogg/opus (PTT) existe en el worker, pero la UI está **oculta en producción** porque WhatsApp rechaza el audio al reproducir (bug pendiente).
- **Video**: el worker **no tiene rama de video** — reconoce extensiones de imagen y manda todo lo demás como nota de voz, así que un `.mp4` le llega al cliente como PTT. Por eso el video está desactivado en Masivo. Falta una línea acá: detectar `video/*` y mandarlo como video.

## Salud del VM (2026-08-04)

RAM 356/956 MB usada (447 libres); los 12 bridges + worker suman ~389 MB de RSS.
Carga 0.01. Swap de 2 GB puesto (protección de picos; sin él, un `go build`
congeló la máquina una vez).

A ~29 MB por bridge, **15 agentes caben holgados** y 20 quedarían apretados
(~600 MB solo de bridges) pero viables con el swap. **La memoria no es lo que
obliga a una segunda máquina: es la IP** — 20 sesiones de WhatsApp saliendo de
`141.148.40.31`. El propio `ARRANQUE_MAX` ya reconoce ese riesgo.

> Medición anterior, para no confundirse: con **9** bridges eran 279/956 MB y
> ~180 MB entre todos. De ahí salió un cálculo de «16 MB por bridge» que se
> quedó corto — la cifra buena es la de arriba, con los 12 ya corriendo.

## Formato de log

```
[14:44:38] → 3 mensaje(s) en 1 agente(s)              ← abre un ciclo
[14:45:14]   ✓ invitacion → +573122203384 (:8080)      ← enviado OK (tipo → número (:puerto))
[15:36:44]   ⨯ e8e81143 ya no está pendiente ...        ← saltado / cancelado
[15:36:36]     ↻ reintento MX: 527... → 5217...         ← alternó variante de México
```

`✓` = enviado · `⚠` = error · `⨯` = saltado/cancelado · `↻` = reintento MX.

## Repartir bridges en dos VM: qué se hizo y qué costó

El paso de `host` se aplicó el 06/08 y la migración de tres agentes a la VM2
destapó dos defectos que costaron un número de WhatsApp. **Los dos ya están
resueltos y probados con tráfico real el 08-10** (ver «Estado al 08-10»); se
dejan escritos porque explican por qué el worker quedó como quedó.

### DEFECTO 1 — el mapa de máquinas se indexó por PUERTO (le costó un número) · RESUELTO

El primer cambio guardaba el host en un diccionario indexado por puerto:

```python
HOST_POR_PUERTO = {c.get("puerto"): (c.get("host") or "localhost") for c in filas}
```

**Indexar por puerto solo es válido con UNA máquina.** Con dos, Sofía Muñoz quedó
en `localhost:8092` y Leonardo en `10.0.0.23:8092`: una entrada pisó a la otra y
los mensajes de Leonardo salieron **por el WhatsApp de Sofía**, a 35 contactos que
ella no tenía. 173 mensajes. WhatsApp le bloqueó el número.

- **Venda (sigue puesta)**: índice único sobre `canales_wa.puerto`
  (`sql/2026-08-06_13_canales_wa_puerto_unico.sql`). Un puerto repetido ahora
  falla al escribir en vez de cruzar envíos en silencio.
- **Cura (aplicada 08-08)**: el worker enruta por `owner_id`, que es lo único
  único de verdad. El mapa pasó a `HOST_POR_OWNER = {c["owner_id"]: host …}` y el
  host viaja al hilo del agente por un `threading.local()` (`_ctx.host`), fijado
  en `procesar_agente()`. Si un agente no resuelve host, **no se envía** (`return
  False, "sin host resuelto…"`) en vez de caer a un `localhost` que podría ser el
  bridge de otro.

**Decisión: el índice único se QUEDA**, aunque el plan original era quitarlo al
enrutar por dueño. Con el enrutamiento por `owner_id` ya no hace falta para que
el sistema sea correcto, pero es una red barata contra la falla exacta que costó
un número: mientras los puertos sean únicos entre las dos VM (trivial con <20
agentes), una regresión en la lógica de enrutamiento no puede volver a cruzar
envíos. El único costo es no reutilizar el mismo número de puerto en VM1 y VM2 —
que no cuesta nada. Si algún día se auditara `worker.py` y se confirmara el
enrutamiento por dueño a prueba de balas, se puede reconsiderar.

La lección general: **un identificador solo es único dentro del alcance donde se
creó.** El puerto identificaba un bridge mientras hubo un solo host.

### DEFECTO 2 — worker y bridge compartían disco sin que nadie lo dijera · RESUELTO

El worker baja la imagen a un temporal **suyo** (`descargar_media()` →
`/tmp/nexus_media_*.jpeg`) y le pasa al bridge la RUTA. Funcionaba porque eran
vecinos. Con el bridge en otra máquina:

```
Error reading media file: open /tmp/nexus_media__3hdp8gh.jpeg: no such file
```

Los mensajes de solo texto salen bien; **los que llevan imagen fallan al 100 %**.

Confirmado leyendo el bridge de `lharries/whatsapp-mcp`, de donde salió el
binario: su API **solo acepta una ruta local**, ni URL ni subida multipart.

```go
type SendMessageRequest struct {
    Recipient string `json:"recipient"`
    Message   string `json:"message"`
    MediaPath string `json:"media_path,omitempty"`
}
```

Así que la única vía sin recompilar el bridge es **copiarle el archivo antes**.

#### Parche aplicado (08-08) — probado el 08-10

Leonardo (VM2) envió **37 imágenes el 08-10, todas `enviado` y a clientes
suyos**, después de que el 07/08 y el 08/08 fallaran al 100 % con «no such file».
Esa es la prueba de que la copia funciona de punta a punta contra un bridge
remoto. El código quedó así:

En el encabezado, junto a los demás `import`:

```python
import subprocess
LLAVE_SSH = os.environ.get("LLAVE_SSH", "/home/ubuntu/.ssh/vm2.key")
```

Una función nueva, antes de `_post_bridge`:

```python
def _copiar_media(host, ruta):
    """Deja el archivo temporal en la MISMA ruta de la otra máquina. El bridge
    solo sabe leer rutas locales, así que sin esto una imagen a un bridge remoto
    falla siempre. Se copia a /tmp, que se limpia solo."""
    try:
        subprocess.run(
            ["scp", "-i", LLAVE_SSH,
             "-o", "StrictHostKeyChecking=accept-new",
             "-o", "UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts",
             "-o", "ConnectTimeout=10",
             ruta, f"ubuntu@{host}:{ruta}"],
            check=True, capture_output=True, timeout=60)
        return True, None
    except Exception as e:
        return False, str(e)[:200]
```

Y dentro de `_post_bridge`, justo después de resolver el host **por dueño** (el
host lo dejó `procesar_agente()` en el contexto del hilo, no se busca por puerto):

```python
    host = getattr(_ctx, "host", None)
    if not host:
        # Sin host resuelto no se envía: caer a "localhost" podría mandar por el
        # bridge de otro agente. Es exactamente la falla que costó el número.
        return False, "sin host resuelto para este agente; no se envía por seguridad"
    # Si el bridge vive en otra máquina, el temporal que bajó ESTE worker no
    # existe allá. Copiarlo primero; si no se puede, fallar con un motivo claro
    # en vez de dejar que el bridge diga "no such file".
    if media_path and host not in ("localhost", "127.0.0.1"):
        ok, err = _copiar_media(host, media_path)
        if not ok:
            return False, f"no pude copiar la imagen a {host}: {err}"
    url = f"http://{host}:{puerto}/api/send"
```

**Requisitos**: que `/home/ubuntu/.ssh/vm2.key` exista en la VM1 y que el worker
(corre como `ubuntu`) pueda leerla. Ya está puesta.

**Riesgo asumido**: mete una llamada a `scp` dentro del camino de envío. Con
`ConnectTimeout=10` y `timeout=60` acotados, un fallo de red demora a ESE agente,
no a los demás (cada uno va en su propio hilo).

### Estado al 08-10: la VM2 está operativa

Las tres verificaciones se cubrieron con **tráfico real de hoy**, no con envíos
de prueba forzados:

| Prueba | Evidencia (08-10) | Resultado |
|---|---|---|
| Texto desde VM2 | Leonardo, 51 textos `enviado` el 08-08 | ✅ |
| **Imagen desde VM2** | Leonardo, 37 imágenes `enviado`, **las 37 a clientes suyos** | ✅ |
| Sin regresión en VM1 | Daniel, 40 imágenes `enviado` (localhost) | ✅ |
| Regla de oro | 0 mensajes de Leonardo a clientes ajenos | ✅ |
| Sin colisión de puertos | índice único puesto, 0 puertos repetidos | ✅ |
| Cola limpia | 0 mensajes `pendiente` represados | ✅ |

Queda un hueco menor, no de mecanismo:

- **María José (8093, VM2)**: bridge vivo y `vinculado`, con la MISMA config que la
  de Leonardo (host `10.0.0.23`, puerto propio, mismo worker parcheado). Su
  enrutamiento funcionará igual; falta solo su primer masivo/actividad para verlo
  con datos.
- **Laura (8091)**: sigue en VM1. Su sesión de WhatsApp no era portable (bridge
  suelto, sin carpeta `store/` copiable), así que **falta que escanee el QR** del
  bridge nuevo en VM2. Mientras tanto envía normal desde VM1.

## Alta de un agente nuevo en la VM2 (runbook)

Probado de punta a punta el **11-08** dando de alta a Seleny Quintero (8096) y
Luis Muñoz (8095). Los tres tropiezos de esa vez están abajo: los tres eran
silenciosos y ninguno estaba escrito.

**Cómo se llega a la VM2**: no tiene IP pública. Se entra a la VM1
(`ssh -i <llave> ubuntu@141.148.40.31`) y desde allí se salta con
`ssh -i /home/ubuntu/.ssh/vm2.key ubuntu@10.0.0.23`. El hostname es
`nexus-cloud-2`.

**Cómo está montado un bridge** (plantilla `/etc/systemd/system/nexus-bridge@.service`):

| | |
|---|---|
| Servicio | `nexus-bridge@<slug>`, slug `nombre_apellido` (`leonardo_angarita`) |
| Carpeta | `/home/ubuntu/nexus-bridges/<slug>/` con `env` y `store/` |
| Binario | `/home/ubuntu/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge-mt` (común) |
| `env` | `WA_PORT`, `WA_OWNER` (= `profiles.id`), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` |

Solo `WA_PORT` y `WA_OWNER` cambian por agente. **No hay script de alta**: las
carpetas se crean a mano copiando el `env` de un bridge que ya ande y cambiando
esas dos líneas (así la `SERVICE_KEY` no pasa por pantalla).

Pasos, en orden:

1. **Elegir puerto libre — mirando la VM2, NO solo `canales_wa`** (ver TRAMPA 1).
2. **Crear la carpeta**: `mkdir -p .../<slug>/store` y el `env` derivado de otro.
   El `store/` va **vacío**: copiar el de otro agente arrancaría la sesión de
   WhatsApp de esa otra persona.
3. **Abrir el puerto en el firewall** si hace falta (ver TRAMPA 2).
4. **Arrancar**: `sudo systemctl enable --now nexus-bridge@<slug>`.
5. **Corregir `puerto` y `host` en `canales_wa`** (ver TRAMPA 3). El bridge crea
   su fila pero deja el puerto nulo y el host en `localhost`.
6. **Escanear el QR** desde el WhatsApp del agente, en «Más → Mi WhatsApp». Sin
   esto el canal se queda en `vinculando` y el worker no le envía nada (marca
   error, nunca manda por otro).
7. **Verificar la señal**: `actualizado` debe avanzar cada ~30 s y `estado` llegar
   a `vinculado`. Recién ahí está listo.
8. **Confirmar con un envío real** (una invitación o un masivo chico) y revisar en
   `mensajes_programados` que quede `enviado` y que el teléfono sea de un cliente
   suyo. Para imágenes, que **no** aparezca «no such file» (probaría que la copia
   SSH al `host` falló — revisar la llave `LLAVE_SSH` y la red privada).

### TRAMPA 1 — el puerto libre NO se deduce de `canales_wa`

Una carpeta ya provisionada **reserva** un puerto que la base todavía no conoce.
Laura tenía `/nexus-bridges/laura_daniela/env` con `WA_PORT=8094` desde el 10-08,
esperando a que escaneara, mientras su fila seguía diciendo `8091`/`localhost`.
Se asignó el 8094 a Seleny mirando solo la base; de haber arrancado así, Seleny
habría registrado ese puerto primero y **el bridge de Laura ya no habría podido
escribir su fila** (índice único) — su traslado roto en silencio y sin un error
que lo dijera.

La verdad de los puertos de la VM2 es **la unión de las dos fuentes**:

```bash
grep -h '^WA_PORT' /home/ubuntu/nexus-bridges/*/env | sort   # en la VM2
```
más los de `canales_wa`. Comprobar antes de arrancar que hay tantos puertos
distintos como carpetas.

### TRAMPA 2 — el firewall de la VM2 abre por RANGO

La regla era `-A INPUT -s 10.0.0.74/32 -p tcp --dport 8092:8094 -j ACCEPT`:
solo desde la IP privada de la VM1 (`10.0.0.74`) y solo hasta el **8094**. Un
bridge en el 8095 habría arrancado perfecto y el worker no lo habría alcanzado
nunca — el peor tipo de fallo, porque todo se ve bien. Se amplió con:

```bash
sudo iptables -I INPUT -s 10.0.0.74/32 -p tcp -m tcp --dport 8095:8100 -j ACCEPT
sudo netfilter-persistent save
```

Se **agregó** una regla en vez de tocar la que funcionaba, y con margen hasta el
8100 para que los próximos no vuelvan a chocar. `ufw` está inactivo: manda
iptables.

### TRAMPA 3 — el bridge NO escribe `puerto` ni `host`

Al arrancar, el bridge crea su fila en `canales_wa` y mantiene `estado`, `qr`,
`telefono` y `actualizado`. Pero **`puerto` queda nulo y `host` en su valor por
defecto, `localhost`**. Los de Leonardo y María José los había puesto alguien a
mano y por eso parecía que el bridge lo hacía.

Un canal así, al vincularse, manda al worker a buscar un bridge de la VM2 en
`localhost` con puerto nulo. Hay que corregirlo **antes de que el agente escanee**:

```sql
update canales_wa set puerto = <puerto>, host = '10.0.0.23'
where owner_id = '<uuid del agente>';
```

**Requisitos de red que no cambian**: las dos VM se ven por **red privada**
(`10.0.0.0/24`); el puerto del bridge **nunca** se expone a internet — es un
endpoint que manda WhatsApp a nombre del agente. La llave `LLAVE_SSH`
(`/home/ubuntu/.ssh/vm2.key`) debe seguir permitiendo a la VM1 copiar temporales
a la VM2 para las imágenes.

**Límite real de la VM2**: como en la VM1, lo que aprieta no es la RAM sino la
**IP** — cuántas sesiones de WhatsApp salen de `10.0.0.23`. Repartir por IP es
justo para lo que existe la segunda máquina.
