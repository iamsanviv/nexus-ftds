#!/usr/bin/env python3
# Prueba de punta a punta de la transcripción de audios, ANTES de instalar el
# chats_sync.py nuevo: toma el último audio que le escribieron a un agente,
# lo descarga con su bridge y lo transcribe con Workers AI. No escribe nada en
# la base; solo imprime el texto.
#
#   python3 vm/chats-sync/probar_transcripcion.py santiago_viveros
#
# Requiere la migración sql/2026-10-29_52_transcripcion_audios.sql y el token
# de Cloudflare en Vault.
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import requests
import chats_sync as cs

slug = sys.argv[1] if len(sys.argv) > 1 else sys.exit("Uso: probar_transcripcion.py <carpeta del bridge>")
base = os.path.join(cs.BRIDGES_DIR, slug)
url = cs._env_de(base, "SUPABASE_URL")
key = cs._env_de(base, "SUPABASE_SERVICE_KEY") or cs._env_de(base, "SUPABASE_KEY")
if not (url and key):
    sys.exit(f"No encontré SUPABASE_URL/SUPABASE_SERVICE_KEY en {base}/env")
h = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
r = requests.post(f"{url.rstrip('/')}/rest/v1/rpc/transcripcion_pendiente", headers=h, json={}, timeout=20)
r.raise_for_status()
d = r.json()
if not (d.get("token") and d.get("cuenta")):
    sys.exit("La base no tiene el token o el Account ID de Cloudflare en Vault.")

cm = cs._abrir_ro(os.path.join(base, "store", "messages.db"))
fila = cm.execute("SELECT id, chat_jid, datetime(timestamp) FROM messages "
                  "WHERE is_from_me = 0 AND media_type = 'audio' "
                  "ORDER BY timestamp DESC LIMIT 1").fetchone()
cm.close()
if not fila:
    sys.exit("Ese agente no tiene audios recibidos.")
print(f"Audio {fila[0]} del {fila[2]} UTC…")
texto = cs._transcribir(base, fila[0], fila[1], {"cuenta": d["cuenta"], "token": d["token"]})
print(f"Transcripción: {texto!r}")
