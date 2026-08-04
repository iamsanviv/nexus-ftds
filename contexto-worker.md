# Contexto: worker de envíos de Nexus (VM Oracle)

> Última actualización: 2026-08-04

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

## Enrutamiento multi-agente

La tabla `canales_wa` mapea `owner_id → (puerto, estado)`. El worker solo envía si
el canal del dueño está `vinculado`; si no, marca el mensaje como error (nunca
manda desde otro número). Cada bridge es un binario Go (whatsmeow) que mantiene la
sesión de WhatsApp en su carpeta `store/`.

**12 bridges activos (2026-08-04):**

| Puerto | Agente | Puerto | Agente |
|---|---|---|---|
| 8080 | Santiago (bridge viejo) | 8086 | Juan Narváez |
| 8081 | Tatiana | 8087 | Valery Gallo |
| 8082 | Juan Pablo Castro | 8088 | Brayan Monje |
| 8083 | Fabián Flórez | 8089 | Leonardo Angarita |
| 8084 | Daniel Laverde | 8090 | María José Lamilla |
| 8085 | María José Guzmán | 8091 | Daniela Duarte |

Próximo puerto libre: **8092**.

## Detalles de envío

- **México**: reintento automático que alterna el `1` tras el código 52 si da "no LID found".
- **Imágenes**: se resuelve la imagen actual del servicio al enviar (no se congela al programar).
- **Enlace**: el token `{enlace}` se resuelve al enviar; si a esa hora no hay enlace, el mensaje se omite.
- **Nota de voz**: la conversión a ogg/opus (PTT) existe en el worker, pero la UI está **oculta en producción** porque WhatsApp rechaza el audio al reproducir (bug pendiente).

## Salud del VM (2026-08-04)

RAM 356/956 MB usada (447 libres); los 12 bridges + worker suman ~389 MB de RSS.
Carga 0.01. Muy holgado — caben los 15 agentes de la meta. Swap de 2 GB puesto
(protección de picos; sin él, un `go build` congeló la máquina una vez).

## Formato de log

```
[14:44:38] → 3 mensaje(s) en 1 agente(s)              ← abre un ciclo
[14:45:14]   ✓ invitacion → +573122203384 (:8080)      ← enviado OK (tipo → número (:puerto))
[15:36:44]   ⨯ e8e81143 ya no está pendiente ...        ← saltado / cancelado
[15:36:36]     ↻ reintento MX: 527... → 5217...         ← alternó variante de México
```

`✓` = enviado · `⚠` = error · `⨯` = saltado/cancelado · `↻` = reintento MX.
