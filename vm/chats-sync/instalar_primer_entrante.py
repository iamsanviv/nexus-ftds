#!/usr/bin/env python3
# Instala en la VM la versión de chats_sync.py que publica `primer_entrante_dia`
# (primer mensaje que la persona te escribió hoy). Uso, desde la raíz del repo
# copiado a la VM:
#
#   python3 vm/chats-sync/instalar_primer_entrante.py [ruta del chats_sync.py en uso]
#   sudo systemctl restart nexus-worker
#
# Reemplaza el archivo entero en vez de parchar bloques, pero SOLO si el que
# está corriendo es exactamente la versión anterior conocida (la del parche de
# `entrante_en`, 05/10/2026). Si alguien lo cambió a mano en la VM no se pisa:
# aborta y hay que mirar la diferencia.
import ast, hashlib, os, shutil, sys, time

# La copia que corría en VM1 al 28/10/2026 era la misma versión pero sin el
# comentario de cabecera de `entrante_en`: diff revisado, se acepta igual.
ANTERIORES = {
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
          "(alguien lo modificó o le falta el parche de entrante_en). No cambio nada; "
          f"compáralo con {NUEVO}.")
    sys.exit(1)

# No romper el servicio: validar sintaxis antes de escribir.
ast.parse(nuevo.decode("utf-8"))

bak = RUTA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(RUTA, bak)
open(RUTA, "wb").write(nuevo)
print(f"OK. Respaldo en {bak}")
print("Reinicia el worker:  sudo systemctl restart nexus-worker")
