#!/usr/bin/env python3
"""Ejecutor de bajas de canal.

El panel no alcanza la VM. Cuando un admin retira a un agente, la base queda con
`canales_wa.baja_en` puesto y `puerto` TODAVÍA puesto: esa combinación ES el
trabajo pendiente. Este script lo ejecuta y cierra la baja poniendo `puerto` en
null.

Va aparte de `worker.py` a propósito: enviar mensajes es lo único que no puede
fallar, y una baja ocurre unas pocas veces al año y aguanta dos minutos. Además
así se instala en cualquier máquina con bridges, corra o no el worker en ella.

SE INSTALA EN LAS DOS MÁQUINAS. Cada ejecutor resuelve el bridge recorriendo
`nexus-bridges/*/env` en busca de `WA_OWNER=<uuid>`; una fila cuyo bridge vive
en la otra VM no encuentra nada y se deja pendiente para que la tome la otra.

Solo biblioteca estándar: este script tiene que correr en las dos máquinas sin
instalar nada.
"""

import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

BRIDGES = Path(os.environ.get("NEXUS_BRIDGES", "/home/ubuntu/nexus-bridges"))
SERVICIO = "nexus-bridge@{slug}"

# Un UUID de la base solo se usa como TEXTO a comparar contra el contenido de un
# `env`, nunca llega a una línea de comandos. Aun así se valida: es la frontera
# entre un dato remoto y este disco.
RE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

# Esto SÍ llega a la línea de comandos (`systemctl stop nexus-bridge@<slug>`) y
# a un `mv`. `ubuntu` tiene NOPASSWD: ALL, así que el nombre del directorio es
# la superficie que hay que cerrar. Se exige la misma forma que produce
# `provisionar.sh`; cualquier otra cosa se salta.
RE_SLUG = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")


def log(msg):
    print(f"[bajas] {msg}", flush=True)


# ---------------------------------------------------------------- credenciales

def credenciales():
    """URL y service_role. Del entorno, o del `.env` que ya usa el worker.

    Nunca se imprime la clave, ni siquiera truncada.
    """
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("SUPABASE_KEY")
    if url and key:
        return url.rstrip("/"), key

    for ruta in (Path("/home/ubuntu/nexus-worker/.env"), Path(__file__).resolve().parent / ".env"):
        if not ruta.exists():
            continue
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
        if url and key:
            return url.rstrip("/"), key

    log("ERROR: faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY "
        "(ni en el entorno ni en /home/ubuntu/nexus-worker/.env)")
    sys.exit(1)


URL, KEY = credenciales()
CAB = {
    "apikey": KEY,
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
}


def rest(metodo, ruta, cuerpo=None, prefer=None):
    cab = dict(CAB)
    if prefer:
        cab["Prefer"] = prefer
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else None
    req = urllib.request.Request(f"{URL}/rest/v1/{ruta}", data=datos, headers=cab, method=metodo)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            crudo = r.read().decode() or "[]"
            return json.loads(crudo)
    except urllib.error.HTTPError as e:
        # El cuerpo del error de PostgREST explica la causa; la clave no viaja ahí.
        log(f"ERROR HTTP {e.code} en {metodo} {ruta}: {e.read().decode()[:300]}")
        raise


# ------------------------------------------------------------------- el bridge

def bridge_de(owner):
    """Directorio local cuyo `env` declara WA_OWNER=<owner>, o None.

    None significa «no es de esta máquina», no «no existe»: la fila se deja
    pendiente para que la tome el ejecutor de la otra VM.
    """
    if not BRIDGES.is_dir():
        return None
    for env in sorted(BRIDGES.glob("*/env")):
        # Un directorio ya archivado empieza por punto y `Path.glob` SÍ lo
        # devuelve (al revés que bash). Se excluye a mano, o una baja ya hecha
        # se volvería a "encontrar".
        if env.parent.name.startswith("."):
            continue
        try:
            texto = env.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for linea in texto.splitlines():
            linea = linea.strip()
            if linea.startswith("WA_OWNER=") and linea.split("=", 1)[1].strip().strip("'\"") == owner:
                return env.parent
    return None


def correr(cmd):
    """shell=False siempre: nada de esto se interpola en una shell."""
    r = subprocess.run(cmd, shell=False, capture_output=True, text=True)
    if r.returncode != 0:
        log(f"  aviso: {' '.join(cmd)} -> {r.returncode} {r.stderr.strip()[:200]}")
    return r.returncode == 0


# ---------------------------------------------------------------------- la baja

def ejecutar(fila, seco):
    owner = str(fila.get("owner_id") or "")
    puerto = fila.get("puerto")

    if not RE_UUID.match(owner):
        log(f"owner_id con forma inesperada, se salta: {owner!r}")
        return False

    d = bridge_de(owner)
    if d is None:
        log(f"{owner}: su bridge no está en esta máquina, se deja pendiente")
        return False

    slug = d.name
    # ANTES de reclamar. Si se reclamara primero, un nombre raro dejaría la fila
    # en 'bajando' para siempre: sin ejecutar y sin poder deshacerse.
    if not RE_SLUG.match(slug):
        log(f"{owner}: nombre de directorio no admitido ({slug!r}), se salta sin reclamar")
        return False

    log(f"{owner}: bridge {slug}, puerto {puerto}")
    if seco:
        log("  (simulacro) no se toca nada")
        return False

    # Reclamo de dos fases. El filtro `estado=neq.bajando` es lo que lo hace un
    # reclamo: si otra pasada del timer ya la tomó, esta no recibe filas.
    tomada = rest(
        "PATCH",
        f"canales_wa?owner_id=eq.{owner}&baja_en=not.is.null&puerto=not.is.null&estado=neq.bajando",
        {"estado": "bajando"},
        prefer="return=representation",
    )
    if not tomada:
        log("  otra pasada ya la tenía reclamada, se deja")
        return False

    correr(["sudo", "systemctl", "stop", SERVICIO.format(slug=slug)])
    correr(["sudo", "systemctl", "disable", SERVICIO.format(slug=slug)])

    # Archivar con PUNTO DELANTE es lo que libera el puerto de verdad:
    # `provisionar.sh` rechaza un puerto que aparezca en algún `*/env`, y el
    # glob `*/` de bash incluye `fabian.bak/` pero NO `.baja-fabian-.../`.
    # Un `.bak` no libera nada. Se archiva y no se borra: dentro va `store/`,
    # la sesión de WhatsApp, por si hay que revertir.
    sello = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    destino = d.parent / f".baja-{slug}-{sello}"
    try:
        d.rename(destino)
        log(f"  archivado en {destino.name}")
    except OSError as e:
        # La fila queda en 'bajando' y el panel lo avisa a los 15 minutos. Es
        # preferible a soltar el puerto con el directorio todavía en su sitio:
        # `provisionar.sh` se lo daría a otro agente y chocarían.
        log(f"  ERROR archivando, el puerto NO se libera: {e}")
        return False

    rest("PATCH", f"canales_wa?owner_id=eq.{owner}",
         {"puerto": None, "estado": "baja", "comando": None, "qr": None})
    log(f"  listo: puerto {puerto} libre")
    return True


def main():
    seco = "--simulacro" in sys.argv or "--dry-run" in sys.argv
    filas = rest("GET", "canales_wa?baja_en=not.is.null&puerto=not.is.null"
                        "&select=owner_id,puerto,host,estado")
    if not filas:
        log("sin bajas pendientes")
        return
    log(f"{len(filas)} baja(s) pendiente(s)" + (" — SIMULACRO" if seco else ""))
    hechas = sum(1 for f in filas if ejecutar(f, seco))
    log(f"ejecutadas en esta máquina: {hechas}")


if __name__ == "__main__":
    main()
