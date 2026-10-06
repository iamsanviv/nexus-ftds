#!/usr/bin/env python3
# Parche idempotente para worker.py: el "día" del tope diario se cuenta en hora
# de COLOMBIA (UTC-5 fijo), no en UTC. Con UTC la medianoche cae a las 19:00 de
# Bogotá, así que todo lo enviado entre las 7pm y la medianoche se le cobraba al
# día siguiente y bloqueaba a quien trabaja de noche (defecto abierto desde
# agosto). Solo cambia la línea del arranque del día en `enviados_hoy`.
import ast, shutil, sys, time

RUTA = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/nexus-worker/worker.py"

VIEJO = "    inicio = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)"
NUEVO = (
    "    # El \"día\" del tope es el de COLOMBIA (UTC-5 fijo), no UTC: con UTC la\n"
    "    # medianoche cae a las 19:00 de Bogotá y lo enviado de 7pm a medianoche se\n"
    "    # cobraba al día siguiente, bloqueando a quien trabaja de noche.\n"
    "    from datetime import timedelta as _td\n"
    "    inicio = datetime.now(timezone(_td(hours=-5))).replace(hour=0, minute=0, second=0, microsecond=0)"
)

src = open(RUTA, encoding="utf-8").read()

if "timezone(_td(hours=-5))" in src:
    print("Ya estaba parchado. No toco nada.")
    sys.exit(0)

if src.count(VIEJO) != 1:
    print(f"ABORTO: no encontré exactamente una vez la línea esperada "
          f"(apariciones={src.count(VIEJO)}). No cambio nada.")
    sys.exit(1)

nuevo = src.replace(VIEJO, NUEVO)
ast.parse(nuevo)   # no dejar el servicio con un archivo roto

bak = RUTA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(RUTA, bak)
open(RUTA, "w", encoding="utf-8").write(nuevo)
print(f"OK. Respaldo en {bak}")
print("Reinicia el worker:  sudo systemctl restart nexus-worker")
