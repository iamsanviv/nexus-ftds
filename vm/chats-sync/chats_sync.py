#!/usr/bin/env python3
# =====================================================================
#  chats_sync.py — llena `chats_recientes` para «registrar desde un chat»
#
#  POR QUÉ EXISTE
#
#  WhatsApp dejó de mostrar el número de quien escribe: con LID (y con la
#  función de nombres de usuario, que se desplegó por países desde julio
#  de 2026) el chat llega identificado por una identidad oculta. El agente
#  no puede copiar el número para crear la persona en Nexus porque no lo ve.
#
#  El bridge SÍ lo sabe: whatsmeow mantiene `whatsmeow_lid_map`
#  (lid → teléfono). Esto lee ese mapa y publica el resultado en Supabase
#  para que el panel pueda ofrecer «registrar desde un chat reciente».
#
#  Además publica `entrante_en`: el último mensaje que la persona NOS
#  ESCRIBIÓ (is_from_me=0). Leads lo usa para «bajaron hoy a tu WhatsApp» y
#  para la temperatura. `ultimo_en` NO sirve para eso: es el último mensaje
#  del chat en cualquier dirección, así que también se mueve cuando el agente
#  escribe. Las dos salen de la MISMA lectura: no agrega ninguna petición.
#
#  POR QUÉ LEE LOS SQLite EN VEZ DE PREGUNTARLE AL BRIDGE
#
#  Los doce bridges comparten UN ejecutable. Añadirle un endpoint obliga a
#  recompilar y reiniciar los doce, y cada sesión que se cae hay que
#  revincularla por QR. Este proceso ya corre en la misma máquina y como el
#  mismo usuario, así que puede leer sus bases en SOLO LECTURA sin tocarlos.
# =====================================================================
import os
import sqlite3
from datetime import datetime, timedelta, timezone

import requests

BRIDGES_DIR = os.environ.get("BRIDGES_DIR", "/home/ubuntu/nexus-bridges")
VENTANA_DIAS = 30          # cuánto hacia atrás se ofrece
MAX_POR_AGENTE = 300       # tope por bridge, del más reciente al más viejo


def _owner_de(dirbase):
    """El uuid del agente dueño del bridge, desde su `env`.

    Se lee SOLO esa línea a propósito: ese mismo archivo lleva la service
    key, y no hay razón para cargarla en memoria aquí."""
    try:
        with open(os.path.join(dirbase, "env")) as f:
            for linea in f:
                if linea.startswith("WA_OWNER="):
                    return linea.partition("=")[2].strip() or None
    except OSError:
        return None
    return None


def _abrir_ro(ruta):
    """Abre la base de un bridge SIN TOMAR NINGÚN CANDADO (`nolock=1`).

    `mode=ro` no basta: estas bases están en `journal_mode=delete`, donde un
    lector toma candado COMPARTIDO y con eso **bloquea al escritor**. Con solo
    `mode=ro` se vio al bridge fallar al guardar una clave de remitente con
    «database is locked», y ese mensaje se quedó sin descifrar.

    Enviar y recibir es lo que no puede fallar; esta sincronización es
    accesoria. Con `nolock=1` el bridge nunca espera por nosotros. El precio es
    que podemos leer la base a mitad de una escritura: por eso cada bridge va
    en su propio try/except y, si sale una lectura corrupta, se salta ese
    agente hasta el ciclo siguiente."""
    return sqlite3.connect(f"file:{ruta}?mode=ro&nolock=1", uri=True, timeout=2)


def _chats_de(dirbase):
    """Chats 1:1 recientes de UN bridge, con el teléfono ya resuelto."""
    mdb = os.path.join(dirbase, "store", "messages.db")
    wdb = os.path.join(dirbase, "store", "whatsapp.db")
    if not (os.path.exists(mdb) and os.path.exists(wdb)):
        return []

    # --- mapa de identidades ocultas y nombres, desde el store de whatsmeow ---
    lidmap, nombres = {}, {}
    cw = _abrir_ro(wdb)
    try:
        try:
            lidmap = dict(cw.execute("SELECT lid, pn FROM whatsmeow_lid_map"))
        except sqlite3.Error:
            # Un bridge vinculado antes de que existiera la tabla no la tiene.
            # No es un error: sus chats con número siguen sirviendo.
            lidmap = {}
        # Los contactos están indexados por LID *y* por número, así que el
        # nombre se busca por cualquiera de los dos.
        for jid, full, push, biz in cw.execute(
            "SELECT their_jid, full_name, push_name, business_name FROM whatsmeow_contacts"
        ):
            nom = (full or biz or push or "").strip()
            # Hay push names que son solo un punto o un emoji suelto: como
            # etiqueta no distinguen a nadie, y el panel muestra mejor el número.
            if nom and any(ch.isalnum() for ch in nom):
                nombres[jid.split("@")[0].split(":")[0]] = nom
    finally:
        cw.close()

    # --- chats: solo 1:1, solo los que NOS ESCRIBIERON ---
    # `is_from_me = 0` es lo que separa «alguien nos escribió» de «abrimos un
    # chat nosotros»: para lo segundo ya teníamos el número.
    #
    # `entrante` = MAX(timestamp) de los mensajes recibidos. Como el EXISTS ya
    # exige que haya al menos uno, nunca sale NULL para las filas devueltas.
    # Sale de la misma consulta: no cuesta una lectura más.
    cm = _abrir_ro(mdb)
    try:
        filas = cm.execute(
            """
            SELECT c.jid, c.last_message_time,
                   (SELECT MAX(m2.timestamp) FROM messages m2
                     WHERE m2.chat_jid = c.jid AND m2.is_from_me = 0) AS entrante
              FROM chats c
             WHERE c.last_message_time >= datetime('now', ?)
               AND (c.jid LIKE '%@lid' OR c.jid LIKE '%@s.whatsapp.net')
               AND EXISTS (SELECT 1 FROM messages m
                            WHERE m.chat_jid = c.jid AND m.is_from_me = 0)
             ORDER BY c.last_message_time DESC
             LIMIT ?
            """,
            (f"-{VENTANA_DIAS} days", MAX_POR_AGENTE),
        ).fetchall()
    finally:
        cm.close()

    # --- resolver a teléfono ---
    # La misma persona puede tener chat por LID y por número: se queda el más
    # reciente, pero sin perder un nombre o un entrante que solo tuviera el otro.
    por_tel = {}
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
        # dos chats; `ultimo_en` y `lid` los define el del último mensaje más
        # nuevo (el que de verdad representa «el chat» en el selector).
        if nom and not prev.get("nombre_wa"):
            prev["nombre_wa"] = nom
        if ent and (not prev.get("entrante_en") or ent > prev["entrante_en"]):
            prev["entrante_en"] = ent
        if str(ts) > str(prev["ultimo_en"]):
            prev["ultimo_en"] = str(ts)
            prev["lid"] = lid
    return list(por_tel.values())


def sincronizar(rest, headers, log, dry_run=False):
    """Recorre los bridges y publica sus chats recientes en Supabase."""
    if not os.path.isdir(BRIDGES_DIR):
        return
    porAgente, total, ok = {}, 0, 0
    for nombre in sorted(os.listdir(BRIDGES_DIR)):
        # Los `.dup-*.bak` son bridges retirados: su cola ya no es de nadie.
        if nombre.startswith("."):
            continue
        base = os.path.join(BRIDGES_DIR, nombre)
        if not os.path.isdir(base):
            continue
        owner = _owner_de(base)
        if not owner:
            continue
        try:
            chats = _chats_de(base)
        except Exception as e:
            log(f"    ⚠ chats de {nombre}: {e}")
            continue
        for c in chats:
            c["owner_id"] = owner
        if chats:
            porAgente[nombre] = chats
            total += len(chats)

    if dry_run:
        log(f"  [dry-run] {total} chat(s) en {len(porAgente)} agente(s)")
        return porAgente

    # Se sube UN AGENTE POR PETICIÓN, no todo junto. Un bridge cuyo dueño ya
    # no existe en `auth.users` viola la clave foránea, y en un lote único esa
    # sola fila tumbaba la sincronización de los otros once. Aislado, ese
    # bridge falla ruidosamente y los demás entran igual.
    for nombre, filas in porAgente.items():
        try:
            r = requests.post(
                f"{rest}/chats_recientes",
                headers={**headers, "Prefer": "resolution=merge-duplicates"},
                params={"on_conflict": "owner_id,telefono"},
                json=filas,
                timeout=45,
            )
            r.raise_for_status()
            ok += len(filas)
        except Exception as e:
            detalle = getattr(getattr(e, "response", None), "text", "") or str(e)
            log(f"    ⚠ no pude subir los chats de {nombre}: {detalle[:200]}")

    # Poda: lo que salió de la ventana deja de ofrecerse. El corte se calcula
    # explícitamente y no a partir de lo sincronizado: si un bridge está caído
    # y no aportó filas, deducirlo de los datos daría un corte equivocado.
    # El filtro NO es opcional — un DELETE sin él vaciaría la tabla entera.
    corte = (datetime.now(timezone.utc) - timedelta(days=VENTANA_DIAS)).isoformat()
    try:
        requests.delete(
            f"{rest}/chats_recientes",
            headers=headers,
            params={"ultimo_en": f"lt.{corte}"},
            timeout=30,
        )
    except Exception as e:
        log(f"    ⚠ no pude podar los chats viejos: {e}")

    if ok:
        log(f"  ↻ {ok} chat(s) recientes de {len(porAgente)} agente(s)")
