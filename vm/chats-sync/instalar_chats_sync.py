#!/usr/bin/env python3
# Instala en la VM la versión de chats_sync.py de este repo (la última:
# transcribe los audios de quien tiene la pregunta del link pendiente).
# Uso, desde la raíz del repo copiado a la VM:
#
#   VM1:  python3 vm/chats-sync/instalar_chats_sync.py /home/ubuntu/nexus-worker/chats_sync.py
#         sudo systemctl restart nexus-worker
#   VM2:  python3 vm/chats-sync/instalar_chats_sync.py /home/ubuntu/nexus-chats-sync/chats_sync.py
#         (el timer lo toma en la vuelta siguiente; no hay que reiniciar nada)
#
# Reemplaza el archivo entero en vez de parchar bloques, pero SOLO si el que
# está corriendo es una versión anterior conocida. Si alguien lo cambió a mano
# en la VM no se pisa: aborta y hay que mirar la diferencia.
#
# ORDEN: primero las migraciones sql/2026-10-28_48_pregunta_link.sql (columna
# `entrantes_txt`; al revés, Supabase rechaza la columna desconocida y se corta
# la sincronización de chats de todos los agentes de esa VM) y
# sql/2026-10-29_52_transcripcion_audios.sql (sin ella solo se avisa en el log
# y no se transcribe nada).
import ast, hashlib, os, shutil, sys, time

# La primera es la de una pasada (instalada en VM1 y VM2 el 28/10/2026). Las
# otras dos, la de `entrante_en` (la de VM1 sin el comentario de cabecera,
# diff revisado), previas a `primer_entrante_dia`.
ANTERIORES = {
    "9aa59656d44a7f697cc79989ab2d25d9659cc3d332a8f740adf1ef9ee945340d",  # audios, sin recorte (VM1, 29/10/2026)
    "ad0489f3ae41ab8b9b4648a1a90ced26228fb37cbb8d186c2b1b6ba00a581b47",  # entrantes_txt (28/10/2026)
    "da2c697923043bbe3bc81294049ba3b96c5610c9d6adda48b45c30504341dcf2",  # una pasada (28/10/2026)
    "a446f8a13d3a3b7785b8c41d43bc8d779302171a1d11229b44ea5d27dabefe7b",
    "27b2450056803ffae2f6eef1ca4ae2c4a0e1b2f0d8d59a2505a4744e67cf4d34",
}
RUTA = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/nexus-worker/chats_sync.py"
NUEVO = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chats_sync.py")

actual = open(RUTA, "rb").read()
nuevo = open(NUEVO, "rb").read()

if actual == nuevo:
    print("Ya estaba instalado. No toco nada.")
    sys.exit(0)

if hashlib.sha256(actual).hexdigest() not in ANTERIORES:
    print("ABORTO: el chats_sync.py de la VM no es la versión anterior conocida "
          "(alguien lo modificó). No cambio nada; "
          f"compáralo con {NUEVO}.")
    sys.exit(1)

# No romper el servicio: validar sintaxis antes de escribir.
ast.parse(nuevo.decode("utf-8"))

bak = RUTA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(RUTA, bak)
open(RUTA, "wb").write(nuevo)
print(f"OK. Respaldo en {bak}")
print("En VM1 reinicia el worker:  sudo systemctl restart nexus-worker")
