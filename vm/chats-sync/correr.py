#!/usr/bin/env python3
"""Corre UNA vuelta de `chats_sync` fuera del worker.

Existe por VM2: `chats_sync` lee los SQLite de los bridges en el disco LOCAL,
y el worker (que lo llama cada ~5 min) solo corre en VM1. Los bridges de VM2
nunca se leían, así que sus agentes no tenían filas en `chats_recientes`: ni
«te escribió hoy» ni subida de temperatura.

No se lee por red desde VM1 (sshfs o similar): `chats_sync` abre las bases con
`nolock=1` para no bloquear al bridge, y eso solo es seguro en disco local.
Tampoco se levanta un segundo worker en VM2: duplicaría envíos (un solo
consumidor de la cola).

En VM1 NO se instala: allí ya lo hace el worker y subirían dos veces lo mismo.

Uso:  python3 correr.py [--simulacro]
      python3 correr.py --urgente

`--urgente` (22/11/2026, pedido de Sanviv): la vuelta completa es cada 5 min,
y una respuesta de las 7:58 podía no llegar a la decisión de las 7:59. Esta
vuelta corre cada minuto (timer `nexus-chats-urgente`), pregunta a la base qué
agentes tienen una decisión en los próximos minutos (`sync_urgente`) y relee
solo esos bridges. Sin nada urgente no lee ningún bridge. Va en VM1 y VM2:
sube con la misma clave que la vuelta completa, así que repetir no duplica.
"""

import os
import sys

import requests
from pathlib import Path

AQUI = Path(__file__).resolve().parent
sys.path.insert(0, str(AQUI))

import chats_sync  # noqa: E402


def log(msg):
    print(f"[chats-sync] {msg}", flush=True)


def credenciales():
    """URL y service_role, del entorno o del `.env` junto a este script.

    Nunca se imprime la clave, ni siquiera truncada."""
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
    ruta = AQUI / ".env"
    if (not url or not key) and ruta.exists():
        for linea in ruta.read_text(encoding="utf-8", errors="replace").splitlines():
            linea = linea.strip()
            if not linea or linea.startswith("#") or "=" not in linea:
                continue
            k, _, v = linea.partition("=")
            k, v = k.strip(), v.strip().strip("'\"")
            if k == "SUPABASE_URL" and not url:
                url = v
            elif k in ("SUPABASE_SERVICE_KEY", "SUPABASE_KEY") and not key:
                key = v
    if not url or not key:
        log(f"ERROR: faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY (ni en el entorno ni en {ruta})")
        sys.exit(1)
    return url.rstrip("/"), key


def main():
    seco = "--simulacro" in sys.argv or "--dry-run" in sys.argv
    url, key = credenciales()
    cab = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    rest = f"{url}/rest/v1"
    solo = None
    if "--urgente" in sys.argv:
        try:
            r = requests.post(f"{rest}/rpc/sync_urgente", headers=cab, json={}, timeout=20)
            r.raise_for_status()
            solo = set(r.json() or [])
        except Exception as e:
            log(f"ERROR: no pude preguntar qué es urgente: {e}")
            sys.exit(1)
        if not solo:
            return
        log(f"urgente: {len(solo)} agente(s)")
    res = chats_sync.sincronizar(rest, cab, log, dry_run=seco, solo=solo)
    if seco and res:
        for nombre, filas in res.items():
            hoy = sum(1 for f in filas if f.get("primer_entrante_dia"))
            log(f"  {nombre}: {len(filas)} chat(s), {hoy} con mensaje de hoy")


if __name__ == "__main__":
    main()
