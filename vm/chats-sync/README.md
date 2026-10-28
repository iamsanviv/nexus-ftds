# `chats-sync` — chats recientes y mensajes entrantes

Código **del lado de la VM**, no servido por Cloudflare. Despliegue manual.

- `chats_sync.py`: lee los SQLite de los bridges **locales** y publica
  `chats_recientes` (incluye `entrante_en` y `primer_entrante_dia`). En VM1 lo
  llama el worker cada ~5 min.
- `correr.py` + `nexus-chats-sync.{service,timer}`: lo mismo como timer
  independiente, **solo para VM2**, donde no corre el worker. Sin esto los agentes
  de VM2 no tienen «te escribió hoy» ni temperatura por mensajes (KI-014).
- `instalar_primer_entrante.py`: actualiza el `chats_sync.py` del worker de VM1.

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

**No instalar en VM1**: allí ya lo corre el worker.
