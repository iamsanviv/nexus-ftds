#!/usr/bin/env python3
# Parche idempotente para worker.py: enviar a quien no tiene número visible.
#
# Desde SQL 70, un mensaje sin teléfono trae `destino_lid` (la identidad oculta
# de WhatsApp, derivada por la base desde la ficha del cliente). El bridge
# acepta un JID completo como destinatario, así que se le pasa `<lid>@lid`.
#
# Tres reglas que este parche sostiene:
# - el teléfono manda: si la fila tiene teléfono, se usa como siempre;
# - la identidad NUNCA se convierte en número: sus dígitos serían el teléfono
#   de otra persona. Por eso el JID va entero y no pasa por el filtro de dígitos;
# - el reintento de México (52 ↔ 521) no aplica a un JID: cambiarle un dígito
#   apuntaría a otra identidad.
#
# ORDEN: primero sql/2026-11-17_70_envio_por_lid.sql. Sin la columna, el
# `select` del worker falla y no sale NINGÚN mensaje de nadie.
#
# Uso (VM1):  python3 destino_lid.py /home/ubuntu/nexus-worker/worker.py
#             sudo systemctl restart nexus-worker
import ast, shutil, sys, time

RUTA = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/nexus-worker/worker.py"

CAMBIOS = [
    (
        '            "select": "id,owner_id,seguimiento_id,tipo,telefono,texto,media_url,enlace_url,servicio_id",\n',
        '            "select": "id,owner_id,seguimiento_id,tipo,telefono,destino_lid,texto,media_url,enlace_url,servicio_id",\n',
    ),
    (
        '    numero = "".join(ch for ch in telefono if ch.isdigit())\n',
        '    # Un JID de identidad oculta («…@lid») va ENTERO: sus dígitos no son un\n'
        '    # teléfono y mandarlos como número le escribiría a otra persona.\n'
        '    if telefono.endswith("@lid"):\n'
        '        numero = telefono\n'
        '    else:\n'
        '        numero = "".join(ch for ch in telefono if ch.isdigit())\n',
    ),
    (
        '    if "no LID found" in (err or ""):\n',
        '    if "no LID found" in (err or "") and "@" not in numero:\n',
    ),
    (
        '            enviar_whatsapp(m["telefono"], texto, media, puerto)\n',
        '            # Sin teléfono, la identidad oculta que puso la base (SQL 70).\n'
        '            destino = m.get("telefono") or (\n'
        '                f\'{m["destino_lid"]}@lid\' if m.get("destino_lid") else None)\n'
        '            if not destino:\n'
        '                raise RuntimeError("sin teléfono ni identidad de WhatsApp")\n'
        '            enviar_whatsapp(destino, texto, media, puerto)\n',
    ),
]

src = open(RUTA, encoding="utf-8").read()

if "destino_lid" in src:
    print("Ya estaba parchado. No toco nada.")
    sys.exit(0)

for viejo, _ in CAMBIOS:
    if src.count(viejo) != 1:
        print(f"ABORTO: no encontré exactamente una vez este bloque "
              f"(apariciones={src.count(viejo)}):\n{viejo}No cambio nada.")
        sys.exit(1)

nuevo = src
for viejo, reemplazo in CAMBIOS:
    nuevo = nuevo.replace(viejo, reemplazo)
ast.parse(nuevo)   # no dejar el servicio con un archivo roto

bak = RUTA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(RUTA, bak)
open(RUTA, "w", encoding="utf-8").write(nuevo)
print(f"OK. Respaldo en {bak}")
print("Reinicia el worker:  sudo systemctl restart nexus-worker")
