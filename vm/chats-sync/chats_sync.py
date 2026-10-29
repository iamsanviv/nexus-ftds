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
import base64
import hashlib
import hmac
import json
import os
import re
import sqlite3
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone

import requests

BRIDGES_DIR = os.environ.get("BRIDGES_DIR", "/home/ubuntu/nexus-bridges")
VENTANA_DIAS = 30          # cuánto hacia atrás se ofrece
MAX_POR_AGENTE = 300       # tope por bridge, del más reciente al más viejo
TEXTOS_HORAS = 12          # ventana de `entrantes_txt` (pregunta antes del link)
TEXTOS_MAX = 15            # mensajes por chat, los más recientes
TEXTO_LARGO = 200          # caracteres por mensaje: basta para leer «sí» o «no puedo»
# Audios de quien tiene la pregunta del link pendiente: se transcriben con
# Cloudflare Workers AI para leerlos como texto. Tope por vuelta porque en VM1
# esto corre DENTRO del worker y mientras tanto no se envía nada.
AUDIOS_MAX = 8
AUDIO_INTENTOS = 3         # un audio que falla 3 vueltas seguidas se deja
WHISPER = "@cf/openai/whisper-large-v3-turbo"
TRANSCRIPCIONES = os.environ.get(
    "NEXUS_TRANSCRIPCIONES", os.path.expanduser("~/.nexus-transcripciones.json"))


def _env_de(dirbase, clave):
    """Un valor del `env` del bridge, leyendo SOLO esa línea a propósito: ese
    mismo archivo lleva la service key, y no hay razón para cargarla en
    memoria aquí."""
    try:
        with open(os.path.join(dirbase, "env")) as f:
            for linea in f:
                if linea.startswith(clave + "="):
                    return linea.partition("=")[2].strip() or None
    except OSError:
        return None
    return None


def _owner_de(dirbase):
    """El uuid del agente dueño del bridge."""
    return _env_de(dirbase, "WA_OWNER")


def _inicio_dia_utc():
    """Medianoche de HOY en Colombia (UTC-5 fijo, sin horario de verano, la
    misma regla que `hoyISO()` del panel), en UTC y con el formato de
    `datetime()` de SQLite para comparar texto con texto."""
    co = datetime.now(timezone.utc) - timedelta(hours=5)
    ini = co.replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(hours=5)
    return ini.strftime("%Y-%m-%d %H:%M:%S")


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


def _textos_de(cm):
    """Lo que cada chat NOS ESCRIBIÓ en las últimas TEXTOS_HORAS, por jid.

    Existe para la «pregunta antes del link»: a quien no respondió la
    invitación se le pregunta si quiere el link, y solo se le manda si contesta
    que sí. Saber QUE escribió no basta: «no puedo asistir» también es una
    respuesta, y mandarle el link a esa persona no tiene sentido.

    Devuelve None si la tabla no tiene la columna `content` (otra versión del
    bridge): así la base sabe que en este WhatsApp no se puede leer la respuesta
    y manda el recordatorio de siempre en vez de preguntar."""
    try:
        cols = {r[1] for r in cm.execute("PRAGMA table_info(messages)")}
    except sqlite3.Error:
        return None
    if "content" not in cols:
        return None
    # Un audio llega con `content` vacío: se marca con `_audio` (id y chat) para
    # poder transcribirlo si esa persona tiene la pregunta pendiente. La marca
    # es interna y se quita antes de subir.
    audio = "media_type" in cols
    por_jid = {}
    for jid, ts, txt, mid, media in cm.execute(
        f"""
        SELECT chat_jid, datetime(timestamp), content, id,
               {"media_type" if audio else "NULL"}
          FROM messages
         WHERE is_from_me = 0
           AND datetime(timestamp) >= datetime('now', ?)
           AND (chat_jid LIKE '%@lid' OR chat_jid LIKE '%@s.whatsapp.net')
         ORDER BY timestamp
        """,
        (f"-{TEXTOS_HORAS} hours",),
    ):
        if not ts:
            continue
        lst = por_jid.setdefault(jid, [])
        m = {"en": f"{ts}+00:00", "t": (txt or "")[:TEXTO_LARGO]}
        if media == "audio" and not txt:
            m["_audio"] = [mid, jid]
        lst.append(m)
        if len(lst) > TEXTOS_MAX:
            lst.pop(0)
    return por_jid


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
    #
    # `primero_dia` = MIN de los recibidos DESDE la medianoche de Colombia: el
    # primer mensaje del día. `datetime()` normaliza a UTC el texto que guarda
    # el bridge (con su desfase), así que ni el filtro ni el MIN ni la mezcla de
    # dos chats dependen del huso en que se escribió. Si no lo pudiera leer daría
    # NULL: «no escribió hoy».
    #
    # UNA sola pasada agrupada sobre `messages`, no subconsultas por chat:
    # `messages` no tiene índice que empiece por `chat_jid` (su PK es
    # `id, chat_jid`) y la base es de solo lectura, así que cada subconsulta
    # correlacionada recorría la tabla entera por cada chat. En VM2 eso costaba
    # ~3 min de CPU por vuelta (28/10/2026). El JOIN conserva la regla del
    # antiguo EXISTS: solo chats con al menos un entrante.
    cm = _abrir_ro(mdb)
    try:
        filas = cm.execute(
            """
            SELECT c.jid, c.last_message_time, e.entrante, e.primero_dia
              FROM chats c
              JOIN (SELECT chat_jid,
                           MAX(timestamp) AS entrante,
                           MIN(CASE WHEN datetime(timestamp) >= ?
                                    THEN datetime(timestamp) END) AS primero_dia
                      FROM messages
                     WHERE is_from_me = 0
                     GROUP BY chat_jid) e ON e.chat_jid = c.jid
             WHERE c.last_message_time >= datetime('now', ?)
               AND (c.jid LIKE '%@lid' OR c.jid LIKE '%@s.whatsapp.net')
             ORDER BY c.last_message_time DESC
             LIMIT ?
            """,
            (_inicio_dia_utc(), f"-{VENTANA_DIAS} days", MAX_POR_AGENTE),
        ).fetchall()
        textos = _textos_de(cm)
    finally:
        cm.close()

    # --- resolver a teléfono ---
    # La misma persona puede tener chat por LID y por número: se queda el más
    # reciente, pero sin perder un nombre o un entrante que solo tuviera el otro.
    por_tel = {}
    for jid, ts, ent, pdia in filas:
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
        # None = este bridge no deja leer textos; [] = los lee y no hay recientes.
        # La base distingue las dos: sin textos no se pregunta por el link.
        txt = None if textos is None else textos.get(jid, [])
        pdia = f"{pdia}+00:00" if pdia else None   # datetime() lo dejó en UTC
        prev = por_tel.get(tel)
        if prev is None:
            por_tel[tel] = {"telefono": tel, "nombre_wa": nom,
                            "ultimo_en": str(ts), "entrante_en": ent,
                            "primer_entrante_dia": pdia, "lid": lid,
                            "entrantes_txt": txt}
            continue
        # El nombre y el entrante más reciente se conservan de cualquiera de los
        # dos chats; `ultimo_en` y `lid` los define el del último mensaje más
        # nuevo (el que de verdad representa «el chat» en el selector).
        if nom and not prev.get("nombre_wa"):
            prev["nombre_wa"] = nom
        if ent and (not prev.get("entrante_en") or ent > prev["entrante_en"]):
            prev["entrante_en"] = ent
        # El primero del día es el MÁS ANTIGUO de los dos chats (LID y número).
        if pdia and (not prev.get("primer_entrante_dia") or pdia < prev["primer_entrante_dia"]):
            prev["primer_entrante_dia"] = pdia
        # Mismos mensajes repartidos en dos chats (LID y número): se juntan.
        if txt is not None:
            junt = sorted((prev.get("entrantes_txt") or []) + txt, key=lambda m: m["en"])
            prev["entrantes_txt"] = junt[-TEXTOS_MAX:]
        if str(ts) > str(prev["ultimo_en"]):
            prev["ultimo_en"] = str(ts)
            prev["lid"] = lid
    return list(por_tel.values())


def _clave_tel(t):
    """La misma normalización que `public.clave_tel` en la base: WhatsApp guarda
    México como 521… y Argentina como 549…; la ficha no."""
    d = re.sub(r"\D", "", t or "")
    return re.sub(r"^549(\d{10})$", r"54\1", re.sub(r"^521(\d{10})$", r"52\1", d))


def _pendientes_audio(rest, headers, log):
    """Credenciales de Workers AI y a quién hay que transcribirle los audios:
    las personas con la pregunta del link enviada y el link aún retenido, con
    la hora desde la que cuenta su respuesta. None si no hay IA configurada."""
    try:
        r = requests.post(f"{rest}/rpc/transcripcion_pendiente", headers=headers,
                          json={}, timeout=20)
        r.raise_for_status()
        d = r.json()
    except Exception as e:
        log(f"    ⚠ no pude leer los audios por transcribir: {e}")
        return None
    if not d or not d.get("token") or not d.get("cuenta") or not d.get("pendientes"):
        return None
    pend = {}
    for p in d["pendientes"]:
        tel = _clave_tel(p.get("telefono"))
        try:
            desde = datetime.fromisoformat(p["desde"])
        except (KeyError, TypeError, ValueError):
            continue
        if tel and p.get("owner_id"):
            pend[(p["owner_id"], tel)] = desde
    return {"cuenta": d["cuenta"], "token": d["token"], "pend": pend}


def _cache_leer():
    try:
        with open(TRANSCRIPCIONES) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _cache_guardar(cache):
    # Solo hace falta mientras dura la ventana de textos: lo viejo se poda.
    corte = (datetime.now(timezone.utc) - timedelta(hours=TEXTOS_HORAS + 1)).isoformat()
    cache = {k: v for k, v in cache.items() if v.get("visto", "") >= corte}
    tmp = TRANSCRIPCIONES + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cache, f)
    os.replace(tmp, TRANSCRIPCIONES)


def _descifrar(enc, media_key, info=b"WhatsApp Audio Keys"):
    """Descifra un adjunto de WhatsApp (el `.enc` de su CDN) con su `media_key`.

    Es el esquema público de WhatsApp: HKDF-SHA256 de la clave → IV, clave AES y
    clave del MAC; los últimos 10 bytes son el MAC (HMAC-SHA256 truncado) y el
    resto, AES-256-CBC con relleno PKCS7. Se verifica el MAC antes de descifrar:
    un archivo corrupto no debe convertirse en una transcripción inventada."""
    prk = hmac.new(b"\0" * 32, media_key, hashlib.sha256).digest()
    okm, t, i = b"", b"", 1
    while len(okm) < 80:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm, i = okm + t, i + 1
    iv, clave, clave_mac = okm[:16], okm[16:48], okm[48:80]
    datos, mac = enc[:-10], enc[-10:]
    if not hmac.compare_digest(hmac.new(clave_mac, iv + datos, hashlib.sha256).digest()[:10], mac):
        raise RuntimeError("el MAC del audio no cuadra")
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        d = Cipher(algorithms.AES(clave), modes.CBC(iv)).decryptor()
        plano = d.update(datos) + d.finalize()
        return plano[:-plano[-1]]
    except ImportError:
        # Sin la librería (no está garantizada en VM2), openssl hace lo mismo.
        return subprocess.run(["openssl", "enc", "-d", "-aes-256-cbc", "-K", clave.hex(),
                               "-iv", iv.hex()], input=datos, capture_output=True,
                              check=True, timeout=60).stdout


def _transcribir(base, mid, jid, ia):
    """Baja el audio directo del CDN de WhatsApp, lo descifra y lo transcribe.

    No se usa `/api/download` del bridge: con el bridge `-mt` devuelve 403
    (probado en VM1 el 29/10/2026), mientras que la URL guardada en
    `messages.url` responde 200. La base del bridge ya tiene la clave
    (`media_key`) y el hash del cifrado, así que no hace falta el bridge.

    Se pasa a WAV 16 kHz mono con ffmpeg antes de enviarlo: las notas de voz
    de WhatsApp son OGG/Opus y la documentación de Whisper en Workers AI no
    dice qué formatos acepta; WAV no deja dudas. Sin ffmpeg se manda tal cual."""
    cm = _abrir_ro(os.path.join(base, "store", "messages.db"))
    try:
        fila = cm.execute("SELECT url, media_key, file_enc_sha256 FROM messages "
                          "WHERE id = ? AND chat_jid = ?", (mid, jid)).fetchone()
    finally:
        cm.close()
    if not fila or not fila[0] or not fila[1]:
        raise RuntimeError("el mensaje no tiene URL o clave del audio")
    url, media_key, enc_sha = fila
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    enc = r.content
    if enc_sha and hashlib.sha256(enc).digest() != bytes(enc_sha):
        raise RuntimeError("el archivo bajado no es el del mensaje (hash distinto)")
    ogg = _descifrar(enc, bytes(media_key))
    fd, ruta = tempfile.mkstemp(suffix=".ogg")
    wav = ruta[:-4] + ".wav"
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(ogg)
        try:
            ok = subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", ruta, "-ar", "16000",
                                 "-ac", "1", wav], timeout=60).returncode == 0
        except (OSError, subprocess.SubprocessError):
            ok = False
        with open(wav if ok else ruta, "rb") as f:
            datos = f.read()
    finally:
        for x in (ruta, wav):
            if os.path.exists(x):
                os.remove(x)
    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{ia['cuenta']}/ai/run/{WHISPER}",
        headers={"Authorization": f"Bearer {ia['token']}"},
        json={"audio": base64.b64encode(datos).decode(), "language": "es"},
        timeout=90)
    if r.status_code != 200:
        raise RuntimeError(f"Workers AI respondió {r.status_code}: {r.text[:300]}")
    return ((r.json().get("result") or {}).get("text") or "").strip()


def _audios(base, owner, chats, ia, cache, cupo, log):
    """Transcribe los audios de quien tiene la pregunta pendiente y los deja en
    `entrantes_txt` como texto («🎤 …»). Devuelve cuántos transcribió."""
    hechos = 0
    for c in chats:
        desde = ia["pend"].get((owner, _clave_tel(c["telefono"])))
        for m in c.get("entrantes_txt") or []:
            aud = m.get("_audio")
            if not aud or not desde or datetime.fromisoformat(m["en"]) <= desde:
                continue
            mid, jid = aud
            k = f"{owner}:{mid}"
            e = cache.get(k) or {}
            e["visto"] = datetime.now(timezone.utc).isoformat()
            cache[k] = e
            if e.get("t") is None and e.get("intentos", 0) < AUDIO_INTENTOS and hechos < cupo:
                try:
                    e["t"] = _transcribir(base, mid, jid, ia)
                    hechos += 1
                except Exception as ex:
                    e["intentos"] = e.get("intentos", 0) + 1
                    log(f"    ⚠ no pude transcribir un audio de {c['telefono']}: {str(ex)[:200]}")
            if e.get("t"):
                m["t"] = ("🎤 " + e["t"])[:TEXTO_LARGO]
    return hechos


def _sin_marcas(chats):
    for c in chats:
        for m in c.get("entrantes_txt") or []:
            m.pop("_audio", None)


def sincronizar(rest, headers, log, dry_run=False):
    """Recorre los bridges y publica sus chats recientes en Supabase."""
    if not os.path.isdir(BRIDGES_DIR):
        return
    porAgente, total, ok = {}, 0, 0
    # Un fallo de la transcripción nunca puede cortar la sincronización.
    ia = None if dry_run else _pendientes_audio(rest, headers, log)
    cache = _cache_leer() if ia else {}
    transcritos = 0
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
        if ia:
            try:
                transcritos += _audios(base, owner, chats, ia, cache,
                                       AUDIOS_MAX - transcritos, log)
            except Exception as e:
                log(f"    ⚠ audios de {nombre}: {e}")
        _sin_marcas(chats)
        if chats:
            porAgente[nombre] = chats
            total += len(chats)

    if ia:
        try:
            _cache_guardar(cache)
        except OSError as e:
            log(f"    ⚠ no pude guardar las transcripciones: {e}")
        if transcritos:
            log(f"  🎤 {transcritos} audio(s) transcrito(s)")

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
