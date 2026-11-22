# `chats-sync` — chats recientes y mensajes entrantes

Código **del lado de la VM**, no servido por Cloudflare. Despliegue manual.

- `chats_sync.py`: lee los SQLite de los bridges **locales** y publica
  `chats_recientes` (incluye `entrante_en` y `primer_entrante_dia`). En VM1 lo
  llama el worker cada ~5 min.
- `correr.py` + `nexus-chats-sync.{service,timer}`: lo mismo como timer
  independiente, **solo para VM2**, donde no corre el worker. Sin esto los agentes
  de VM2 no tienen «te escribió hoy» ni temperatura por mensajes (KI-014).
- `instalar_chats_sync.py`: actualiza el `chats_sync.py` en uso (VM1 dentro del worker, VM2
  junto al timer) si es una versión anterior conocida. Uso y orden en su cabecera.

## Instalar en VM2 (`10.0.0.23`, desde VM1 con `ssh -i ~/.ssh/vm2.key ubuntu@10.0.0.23`)

1. `python3 -c "import requests"` debe salir sin error (si no: `sudo apt install python3-requests`).
2. `mkdir -p ~/nexus-chats-sync` y copiar ahí `chats_sync.py` y `correr.py`
   (verificar `sha256sum` == el de este repo).
3. Crear `~/nexus-chats-sync/.env` con las líneas `SUPABASE_URL` y
   `SUPABASE_SERVICE_KEY` copiadas con `grep` del `env` de cualquier bridge, sin
   imprimirlas; `chmod 600`.
4. Simulacro: `python3 ~/nexus-chats-sync/correr.py --simulacro` (lista los agentes y cuántos chats tiene cada uno; no escribe).
5. Copiar los `.service`/`.timer` a `/etc/systemd/system/`, `sudo systemctl daemon-reload`,
   `sudo systemctl enable --now nexus-chats-sync.timer`.
6. Verificar: `journalctl -u nexus-chats-sync -n 20` y en la base
   `select count(*) from chats_recientes r join canales_wa c using (owner_id) where c.host='10.0.0.23'` > 0.

**No instalar en VM1** el timer de 5 min: allí ya lo corre el worker.

## Vuelta urgente cada minuto (VM1 y VM2, 22/11/2026)

`nexus-chats-urgente.{service,timer}` corre `correr.py --urgente` cada minuto a
los :30. Pregunta a la base (`sync_urgente`, sql/2026-11-22_72) qué agentes
tienen una decisión en los próximos minutos (pregunta del link, soltar el link,
confirmación) y relee solo esos bridges; sin nada urgente no abre ningún bridge.
Requiere el SQL 72 aplicado (sin él solo registra un error en el journal).

- VM2: ya tiene `~/nexus-chats-sync`; copiar el `correr.py` nuevo, los dos
  archivos `nexus-chats-urgente.*` a `/etc/systemd/system/`, `daemon-reload` y
  `enable --now nexus-chats-urgente.timer`.
- VM1: crear `~/nexus-chats-sync` como en VM2 (pasos 1–3 de arriba, con el
  `.env` copiado del worker o de un bridge) y luego lo mismo que en VM2. Aquí
  solo se instala el timer **urgente**: la vuelta completa la sigue haciendo el worker.
- Verificar: `journalctl -u nexus-chats-urgente -n 20` (solo escribe cuando
  hay algo urgente: «urgente: N agente(s)»).
