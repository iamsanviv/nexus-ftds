# Contexto: worker de envíos de Nexus (VM Oracle)

> Última actualización: 2026-08-04

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
3. Cada agente envía por SU propio bridge (enrutado por puerto vía tabla `canales_wa`), con su propio ritmo humano. Los agentes no hacen fila entre ellos.

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

Hoy el worker le marca al bridge por `localhost:<puerto>` porque los dos viven en
la misma VM. La columna `canales_wa.host`
(`sql/2026-08-04_11_canales_wa_host.sql`) existe para el día en que deje de ser
así — hoy vale `localhost` en las doce filas y **el worker todavía no la lee**.

### 12 bridges — confirmado en `canales_wa` (2026-08-04, 22:26 UTC)

| Puerto | Agente | Estado | Última señal |
|---|---|---|---|
| 8080 | Santiago Viveros (bridge viejo) | vinculado | — no entra en el barrido |
| 8081 | Evelin Gomez | vinculado | hoy 22:26 |
| 8082 | Juan Pablo Castro | vinculado | hoy 22:26 |
| 8083 | fabian florez | vinculado | hoy 22:26 |
| 8084 | Daniel | vinculado | hoy 22:26 |
| 8085 | Majo Guzman | **vinculando** | 30/07 — caído |
| 8086 | Felipe Narvaez | **vinculando** | 31/07 — caído |
| 8087 | Valery Gallo | **vinculando** | 28/07 — caído |
| 8088 | Brayan Monje | vinculado | hoy 22:26 |
| 8089 | Jose Leonardo Angarita Lara | vinculado | hoy 22:26 |
| 8090 | María José L | vinculado | hoy 22:26 |
| 8091 | Laura Daniela Duarte | vinculado | hoy 22:26 |

Próximo puerto libre: **8092**.

Los últimos tres (8089–8091) son los agentes que pasaron a colgar de Juana
Lamilla el 04/08: ya tienen bridge propio y vinculado, operativos sin nada
pendiente de este lado.

**Tres canales llevan días caídos** a medio vincular (Valery, Majo, Felipe).
Esos tres agentes no pueden enviar nada.

**Ojo con los nombres.** La tabla de puertos que circula por fuera dice «8081 →
Tatiana» y «8090 → María José Lamilla»; la base dice **Evelin Gómez** y
**María José L**. Cuando no coincidan, manda `canales_wa`.

## Detalles de envío

- **México**: reintento automático que alterna el `1` tras el código 52 si da "no LID found". Ya existe — que aun así haya causado 18 % de fallos en un agente significa que **el reintento no alcanza**, no que falte.
- **Imágenes**: se resuelve la imagen actual del servicio al enviar (no se congela al programar).
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

El paso de `host` **ya está aplicado** (06/08). Pero la migración de tres agentes
a la VM2 destapó dos defectos que hay que entender antes de volver a intentarlo.

### DEFECTO 1 — el mapa de máquinas se indexó por PUERTO (le costó un número)

El cambio aplicado guarda el host en un diccionario aparte:

```python
HOST_POR_PUERTO = {c.get("puerto"): (c.get("host") or "localhost") for c in filas}
```

**Indexar por puerto solo es válido con UNA máquina.** Con dos, Sofía Muñoz quedó
en `localhost:8092` y Leonardo en `10.0.0.23:8092`: una entrada pisó a la otra y
los mensajes de Leonardo salieron **por el WhatsApp de Sofía**, a 35 contactos que
ella no tenía. 173 mensajes. WhatsApp le bloqueó el número.

- **Venda aplicada**: índice único sobre `canales_wa.puerto`
  (`sql/2026-08-06_13_canales_wa_puerto_unico.sql`). Un puerto repetido ahora
  falla al escribir en vez de cruzar envíos en silencio.
- **Cura pendiente**: que el worker enrute por `owner_id`, que es lo único único
  de verdad. Requiere tocar `puerto_de()` y `procesar_agente()` para que el host
  viaje junto al puerto. Cuando se haga, **quitar el índice**: con enrutamiento
  por dueño, dos máquinas pueden reutilizar números de puerto sin problema.

La lección general: **un identificador solo es único dentro del alcance donde se
creó.** El puerto identificaba un bridge mientras hubo un solo host.

### DEFECTO 2 — worker y bridge compartían disco sin que nadie lo dijera

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

#### Parche listo para aplicar (no aplicado aún)

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

Y dentro de `_post_bridge`, justo después de resolver el host:

```python
    host = HOST_POR_PUERTO.get(puerto) or "localhost"
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

### Estado al 07/08: la VM2 está en pausa

Los tres agentes de Juana volvieron a la VM1 salvo Leonardo, que quedó en la VM2
(texto sí, imágenes no). **No mover a nadie más allá hasta aplicar el parche de
media y, preferiblemente, el enrutamiento por `owner_id`.**

## Lo que falta para repartir bridges en dos VM

Está confirmado que **el worker le marca al bridge** (no al revés), así que el
camino es el de `sql/2026-08-04_11_canales_wa_host.sql`:

1. En el `select` que trae `canales_wa`, pedir también `host`.
2. Donde arma la URL del bridge, cambiar `f"http://localhost:{puerto}"` por
   `f"http://{host or 'localhost'}:{puerto}"` — el `or 'localhost'` es la red de
   seguridad para no romper nada si `host` llegara vacío.
3. Que las dos VM se vean por **red privada**. Nunca exponer el puerto de un
   bridge a internet: es un endpoint que manda WhatsApp a nombre de un agente.

Del lado de la base ya está todo hecho. Falta solo el paso 1–2, y vive en
`worker.py`.
