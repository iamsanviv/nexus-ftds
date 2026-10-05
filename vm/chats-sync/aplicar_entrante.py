#!/usr/bin/env python3
# Parche idempotente para chats_sync.py: agrega `entrante_en` (último mensaje
# entrante) a la consulta y a la fila publicada, para «bajaron hoy» en Leads.
# Solo cambia esas dos partes; si no encuentra el texto exacto, no toca nada.
import ast, os, shutil, sys, time

RUTA = sys.argv[1] if len(sys.argv) > 1 else "/home/ubuntu/nexus-worker/chats_sync.py"

SELECT_VIEJO = """            SELECT c.jid, c.last_message_time
              FROM chats c"""
SELECT_NUEVO = """            SELECT c.jid, c.last_message_time,
                   (SELECT MAX(m2.timestamp) FROM messages m2
                     WHERE m2.chat_jid = c.jid AND m2.is_from_me = 0) AS entrante
              FROM chats c"""

LOOP_VIEJO = """    por_tel = {}
    for jid, ts in filas:
        usuario = jid.split("@")[0].split(":")[0]
        if jid.endswith("@lid"):
            pn, lid = lidmap.get(usuario), usuario
        else:
            pn, lid = usuario, None
        # Tiene que ser un número marcable de verdad. Apareció un chat cuyo
        # LID resolvía a "0": sin este filtro esa sola fila rompía el CHECK de
        # la tabla y se perdía la sincronización de TODO ese agente.
        if not pn or not pn.isdigit() or not (7 <= len(pn) <= 15) or pn.startswith("0"):
            continue
        tel = "+" + pn
        nom = nombres.get(usuario) or nombres.get(pn)
        prev = por_tel.get(tel)
        if prev is None or str(ts) > str(prev["ultimo_en"]):
            por_tel[tel] = {"telefono": tel, "nombre_wa": nom,
                            "ultimo_en": str(ts), "lid": lid}
        elif nom and not prev.get("nombre_wa"):
            prev["nombre_wa"] = nom
    return list(por_tel.values())"""
LOOP_NUEVO = """    por_tel = {}
    for jid, ts, ent in filas:
        usuario = jid.split("@")[0].split(":")[0]
        if jid.endswith("@lid"):
            pn, lid = lidmap.get(usuario), usuario
        else:
            pn, lid = usuario, None
        # Tiene que ser un número marcable de verdad. Apareció un chat cuyo
        # LID resolvía a "0": sin este filtro esa sola fila rompía el CHECK de
        # la tabla y se perdía la sincronización de TODO ese agente.
        if not pn or not pn.isdigit() or not (7 <= len(pn) <= 15) or pn.startswith("0"):
            continue
        tel = "+" + pn
        nom = nombres.get(usuario) or nombres.get(pn)
        ent = str(ent) if ent else None
        prev = por_tel.get(tel)
        if prev is None:
            por_tel[tel] = {"telefono": tel, "nombre_wa": nom,
                            "ultimo_en": str(ts), "entrante_en": ent, "lid": lid}
            continue
        # El nombre y el entrante más reciente se conservan de cualquiera de los
        # dos chats; ultimo_en y lid los define el del ultimo mensaje mas nuevo.
        if nom and not prev.get("nombre_wa"):
            prev["nombre_wa"] = nom
        if ent and (not prev.get("entrante_en") or ent > prev["entrante_en"]):
            prev["entrante_en"] = ent
        if str(ts) > str(prev["ultimo_en"]):
            prev["ultimo_en"] = str(ts)
            prev["lid"] = lid
    return list(por_tel.values())"""

src = open(RUTA, encoding="utf-8").read()

if "entrante_en" in src:
    print("Ya estaba parchado (encontré 'entrante_en'). No toco nada.")
    sys.exit(0)

for viejo in (SELECT_VIEJO, LOOP_VIEJO):
    if src.count(viejo) != 1:
        print(f"ABORTO: no encontré exactamente una vez un bloque esperado "
              f"(apariciones={src.count(viejo)}). El archivo no coincide con el "
              f"que esperaba; no cambio nada.")
        sys.exit(1)

nuevo = src.replace(SELECT_VIEJO, SELECT_NUEVO).replace(LOOP_VIEJO, LOOP_NUEVO)

# No romper el servicio: validar sintaxis antes de escribir.
ast.parse(nuevo)

bak = RUTA + ".bak-" + time.strftime("%Y%m%d-%H%M%S")
shutil.copy2(RUTA, bak)
open(RUTA, "w", encoding="utf-8").write(nuevo)
print(f"OK. Respaldo en {bak}")
print("Reinicia el worker:  sudo systemctl restart nexus-worker")
