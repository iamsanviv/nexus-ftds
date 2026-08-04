# Contexto del worker de envíos (`worker.py`)

Este archivo documenta el proceso que manda los mensajes de WhatsApp. **No vive
en este repositorio** — es otro proyecto, en otra VM — pero lo que sigue afecta
decisiones de acá (RLS de `canales_wa`, la columna `host`, los topes de envío),
así que queda documentado aquí igual que el resto de `sql/`.

Dos fuentes, marcadas por separado:

- **Descrito por el dueño (04/08)**: lo que sigue viene de una descripción
  directa de quien administra la VM, no de leer el código de `worker.py`.
- **Confirmado en Supabase (04/08, 22:26 UTC)**: lo que se puede releer en
  `canales_wa` en cualquier momento, sin depender de nadie.

Si algo de acá cambia en la VM y no se actualiza este archivo, manda la base de
datos, no este documento — es la misma regla que ya rige para la tabla de
puertos y para `sql/`.

---

## Qué hace

`worker.py` vacía la cola de `mensajes_programados`: lee los que están en
`pendiente` con `enviar_en` ya cumplido, y los manda llamando a la API REST del
bridge de WhatsApp del agente dueño de cada mensaje. Corre 24/7 en la nube, no
en el computador de nadie.

## Dónde y cómo corre

| | |
|---|---|
| Servidor | Oracle Cloud VM `nexus-cloud` · Ubuntu 22.04 · 1 GB RAM · Always Free · `141.148.40.31` |
| Servicio | systemd `nexus-worker` — `active`, `enabled` (arranca solo si la VM reinicia) |
| Proceso | **uno solo** para toda la oficina — nunca dos a la vez (ver más abajo, por qué) |
| Ubicación | `/home/ubuntu/nexus-worker/` → `worker.py` + `.env` (con `SUPABASE_SERVICE_KEY`) + `venv/` |
| Uptime al 04/08 | ~11 días sin reinicios |
| Comandos | `sudo systemctl status\|restart nexus-worker` · logs en vivo: `journalctl -u nexus-worker -f` |

La `SUPABASE_SERVICE_KEY` en el `.env` es la explicación de algo que ya se
había deducido leyendo la base sin verla: por qué el worker puede reescribir
las nueve/doce filas de `canales_wa` cuando ningún agente, por RLS, puede tocar
más que la suya.

## Arquitectura: paralelo por agente (desde 2026-07-24)

Cada ciclo (`CICLO_SEG = 20` s):

1. Trae hasta 600 mensajes pendientes, de todos los agentes.
2. Los agrupa por `owner_id`.
3. Lanza **un hilo por agente** (`procesar_agente`).

Cada agente envía por *su propio* bridge, a su propio ritmo. Los agentes **no
hacen fila entre ellos** — un agente con 40 mensajes en cola no atrasa el envío
de otro que solo tiene 2.

## Parámetros (encabezado de `worker.py`)

| Parámetro | Valor | Qué controla |
|---|---|---|
| `CICLO_SEG` | 20 s | cada cuánto el worker vuelve a mirar la cola |
| `PAUSA_MIN` / `PAUSA_MAX` | 4–8 s | pausa aleatoria entre mensajes **del mismo agente** (no es un límite global) |
| `ARRANQUE_MAX` | 45 s | desfase inicial al azar por agente, para que varios no disparen en el mismo segundo **desde la misma IP** |
| `LOTE_MAX` | 40 | tope de mensajes por agente y por ciclo; el resto espera al ciclo siguiente |
| `TOPE_DIARIO` | 220 | tope por agente y por día — **solo frena tipos nuevos** (`invitacion`, masivo); nunca corta `rec_60` / `rec_15` / `enlace` / `confirmacion`, para no dejar a nadie sin el enlace de una actividad ya en marcha |

`ARRANQUE_MAX` es la prueba de que el propio worker ya trata **la IP**, no la
memoria, como el recurso escaso de la VM — el mismo motivo por el que una
segunda máquina tiene sentido al crecer el equipo.

## Enrutamiento: `canales_wa`

`canales_wa` mapea `owner_id → (puerto, estado, host)`. El worker **solo envía
si el canal del dueño está `vinculado`**; si no, marca el mensaje como `error`.
Nunca manda desde otro número — la regla de oro del panel, aplicada donde de
verdad se ejecuta el envío.

Hoy el worker le marca al bridge por `localhost:<puerto>` porque los dos viven
en la misma VM. La columna `canales_wa.host` (migración
`sql/2026-08-04_11_canales_wa_host.sql`) existe para el día en que deje de ser
así — hoy vale `localhost` en las doce filas y el worker todavía no la lee.

### Registro de bridges — confirmado en Supabase (04/08, 22:26 UTC)

12 bridges, puertos 8080–8091. Cada uno es un binario Go (`whatsmeow`) que
mantiene la sesión de WhatsApp de un agente en su propia carpeta `store/`.

| Puerto | Agente | Estado | Última señal |
|---|---|---|---|
| 8080 | Santiago Viveros (bridge viejo) | vinculado | — (no entra en el barrido) |
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

Los últimos tres (8089–8091) son los tres agentes que se pasaron hoy bajo
Juana Lamilla — ya tienen bridge propio y vinculado, así que están operativos
en la VM actual sin nada pendiente de este lado.

**La tabla de puertos que circulaba por fuera está desactualizada**: decía
«8081 → Tatiana» y la base dice Evelin Gómez. Manda `canales_wa`, no ningún
documento aparte — es la misma regla que aplica para todo lo demás del panel.

Los tres canales caídos (Majo, Felipe, Valery) siguen exactamente igual que
antes; no se tocaron en esta ronda porque el pendiente activo era el reparto
en varias VM, no la reparación de esos tres.

## Detalles de envío — descrito por el dueño (04/08)

- **México**: reintento automático — alterna el `1` tras el `52` si la primera
  entrega da `no LID found`. Ya existe en el worker. Que aun así haya causado
  18 % de fallos en un agente significa que el reintento **no alcanza**, no que
  falte — es un problema distinto al que estaba anotado como pendiente sin
  solución.
- **Imágenes**: se resuelve la imagen *vigente* del servicio al momento de
  enviar, nunca se congela la de cuando se programó.
- **Enlace**: el token `{enlace}` se resuelve al enviar; si a esa hora la
  actividad no tiene enlace todavía, se omite en vez de mandar un hueco.
- **Notas de voz**: se convierten a `ogg/opus` (PTT) — con el bug de
  reproducción ya conocido y documentado en `CLAUDE.md`.

## Salud de la VM — descrito por el dueño (04/08)

RAM: 279 de 956 MB usados (524 libres) + 2 GB de swap. Carga: 0.37. Con los 9
bridges de entonces más el worker, el consumo total era ~180 MB — unos 16 MB
por bridge. A ese ritmo, **20 bridges caben de sobra en 1 GB** (~320 MB): la
memoria no es el límite. Lo que empuja a repartir en más de una VM es la IP
saliendo de `141.148.40.31`, no la RAM — ver `ARRANQUE_MAX` arriba.

## Formato del log

```
[14:44:38] → 3 mensaje(s) en 1 agente(s)
[14:45:14]   ✓ invitacion → +573122203384 (:8080)
```

`→ N mensaje(s) en M agente(s)` abre un ciclo. Dentro de un ciclo:
`✓` = enviado bien · `⚠` = error · `⨯` = saltado o cancelado.

---

## Lo que falta para repartir bridges en dos VM

Ya está confirmado que el worker **le marca al bridge** (no al revés), así que
el camino es el descrito en `sql/2026-08-04_11_canales_wa_host.sql`:

1. En el `select` que trae `canales_wa`, pedir también `host`.
2. Donde arma la URL del bridge, cambiar `f"http://localhost:{puerto}"` por
   `f"http://{host or 'localhost'}:{puerto}"` — el `or 'localhost'` es la red
   de seguridad para no romper nada si `host` llegara vacío.
3. Que las dos VM se vean por red privada. **Nunca** exponer el puerto de un
   bridge a internet: es un endpoint que manda WhatsApp a nombre de un agente.

Del lado de la base ya está todo hecho. Este es el único cambio que falta, y
vive en `worker.py`, fuera de este repositorio.
