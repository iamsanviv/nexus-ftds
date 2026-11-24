#!/usr/bin/env python3
# =====================================================================
#  resumir.py — necesidad y recomendación de venta de cada cliente,
#  leídas de su conversación de WhatsApp (23/11/2026, pedido de Sanviv)
#
#  QUÉ HACE
#
#  Una vez por noche (timer `nexus-resumen-ia`, 23:00 Colombia), para los
#  agentes de `resumen_ia_agentes`:
#    1. pide a la base sus clientes de Comunidad (`resumen_ia_pendiente`);
#    2. busca, en el SQLite del bridge de cada agente, a los clientes que le
#       ESCRIBIERON desde la vuelta anterior;
#    3. transcribe los audios nuevos de esos clientes (Whisper, Workers AI);
#    4. le pasa a la IA la conversación completa (texto + audios transcritos)
#       y escribe `clientes.necesidad` y `clientes.recomendacion`.
#    Además entran, después de quienes escribieron, los que quedaron
#    pendientes de una vuelta anterior y los que nunca tuvieron resumen.
#    Cada vuelta tiene un presupuesto de neuronas (`NEURONAS_POR_NOCHE`) y se
#    detiene al primer 429: la cuota es compartida con chats_sync.
#
#  Decisiones de Sanviv (23/11/2026): cada noche y solo quien escribió; la IA
#  REEMPLAZA siempre lo que haya, aunque se haya editado a mano; los audios
#  viejos no se transcriben (la URL de WhatsApp caduca a las semanas), los
#  nuevos sí, y quedan en caché para las noches siguientes.
#
#  POR QUÉ EN LA VM Y NO EN LA BASE
#
#  Supabase solo tiene lo que la gente escribió en las últimas 12 h
#  (`chats_recientes.entrantes_txt`). El historial completo vive en el
#  `messages.db` de cada bridge. Se lee en SOLO LECTURA y sin candado, igual
#  que `chats_sync.py` (ver `_abrir_ro` allá: el bridge nunca espera por
#  nosotros).
#
#  Uso:  python3 resumir.py [--simulacro] [--todos] [--tel 57300…]
#    --simulacro  no escribe nada en la base; imprime lo que guardaría
#    --todos      ignora «escribió desde la última vuelta» (primera carga)
#    --tel        solo ese cliente (dígitos)
# =====================================================================
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests

AQUI = Path(__file__).resolve().parent
# Reutiliza el descifrado y la transcripción de audios de chats_sync.py.
sys.path.insert(0, os.environ.get("CHATS_SYNC_DIR", "/home/ubuntu/nexus-worker"))
sys.path.insert(0, str(AQUI))
import chats_sync  # noqa: E402

BRIDGES_DIR = os.environ.get("BRIDGES_DIR", "/home/ubuntu/nexus-bridges")
ESTADO = Path(os.environ.get("NEXUS_RESUMEN_ESTADO", os.path.expanduser("~/.nexus-resumen-ia.json")))
AUDIOS = Path(os.environ.get("NEXUS_RESUMEN_AUDIOS", os.path.expanduser("~/.nexus-resumen-ia-audios.json")))
MODELO = "@cf/meta/llama-3.3-70b-instruct-fp8-fast"
# Llama 3.3 en Workers AI acepta ~24k tokens. En español son ~3,3 caracteres
# por token: 45k caracteres de conversación dejan sitio a las instrucciones y
# a la respuesta. Si no cabe, se guarda el COMIENZO (cómo llegó, qué buscaba)
# y sobre todo el FINAL (lo que está pasando ahora).
MAX_CHARS = 45000
COMIENZO_CHARS = 8000
AUDIOS_POR_NOCHE = 60      # tope de transcripciones por vuelta
# La cuota gratis de Workers AI (10.000 neuronas al día, se reinicia a las
# 00:00 UTC) es la MISMA que usa chats_sync para transcribir los audios de la
# pregunta del link de TODOS los agentes. La primera carga del 23/11/2026 la
# agotó con 67 resúmenes. Por eso cada vuelta gasta como mucho este
# presupuesto (estimado antes de llamar) y se detiene al primer 429.
NEURONAS_POR_NOCHE = int(os.environ.get("NEXUS_RESUMEN_NEURONAS", "4000"))
# Precio de Llama 3.3 70B fp8-fast en neuronas por token (entrada / salida).
NEURONAS_ENTRADA, NEURONAS_SALIDA = 26668 / 1e6, 204805 / 1e6
LARGO_CAMPO = 600          # la base acepta 1000; la celda se lee mejor corta

INSTRUCCIONES = (
    "Eres el asistente comercial de un asesor de Nexus, una comunidad que enseña trading. "
    "Los niveles de membresía, de menor a mayor, son Beca, VIP, Platino y Oro (Oro es el máximo). "
    "El embudo de venta es: Básica (clase Nivel 0 a Avanzado), Operativa en Vivo, clase Avanzada, "
    "Presentación de Membresías, 1 a 1 con el asesor y pago.\n"
    "Abajo está la conversación de WhatsApp entre el asesor y un cliente, del más viejo al más nuevo. "
    "Los audios transcritos van marcados con 🎤; [audio], [imagen] y [video] son adjuntos sin texto.\n"
    "Responde SOLO un objeto JSON con dos campos, en español, concretos y sin inventar:\n"
    '  "necesidad": qué quiere lograr el cliente (en sus palabras cuando se pueda) y qué lo frena '
    "(dinero, tiempo, confianza, pareja, salud…), en máximo 2 frases;\n"
    '  "recomendacion": el siguiente paso concreto que debe dar el asesor para venderle o '
    "acompañarlo, con fecha si hay algo pendiente, en máximo 2 frases. Si el cliente pasa por un "
    "problema serio, la recomendación es no presionar.\n"
    "Si la conversación no da para saberlo, escribe \"No aparece en el chat\". "
    "NUNCA copies contraseñas, correos, números de documento, datos bancarios ni detalles médicos: "
    "a lo sumo di «por salud» o «por dinero»."
)


def log(msg):
    print(f"[resumen-ia] {msg}", flush=True)


def credenciales():
    """URL y service_role, del entorno o de un `.env` junto a este script (el
    mismo formato que `chats-sync/correr.py`). Nunca se imprime la clave."""
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


def _leer_json(ruta, defecto):
    try:
        return json.loads(ruta.read_text())
    except (OSError, ValueError):
        return defecto


def _guardar_json(ruta, datos):
    tmp = ruta.with_suffix(ruta.suffix + ".tmp")
    tmp.write_text(json.dumps(datos, ensure_ascii=False))
    os.replace(tmp, ruta)


def bridge_de(owner):
    """Directorio del bridge del agente, por `WA_OWNER` y no por el nombre de la
    carpeta (los slugs no siempre coinciden con el nombre). Las carpetas con
    punto delante son bajas archivadas."""
    for d in sorted(Path(BRIDGES_DIR).iterdir()):
        if d.name.startswith(".") or not d.is_dir():
            continue
        if chats_sync._owner_de(str(d)) == owner:
            return str(d)
    return None


def chats_por_tel(base):
    """{clave_tel: [jid…]} de los chats 1:1 del bridge. Un cliente puede tener
    el chat por número y también por identidad oculta (@lid): se juntan."""
    lidmap = {}
    cw = chats_sync._abrir_ro(os.path.join(base, "store", "whatsapp.db"))
    try:
        try:
            lidmap = {l.split("@")[0]: p.split("@")[0] for l, p in cw.execute("SELECT lid, pn FROM whatsmeow_lid_map")}
        except Exception:
            lidmap = {}
    finally:
        cw.close()
    idx = {}
    cm = chats_sync._abrir_ro(os.path.join(base, "store", "messages.db"))
    try:
        for (jid,) in cm.execute("SELECT jid FROM chats"):
            if jid.endswith("@g.us") or "@" not in jid:
                continue
            usuario, dominio = jid.split("@", 1)
            usuario = usuario.split(":")[0]
            num = lidmap.get(usuario) if dominio == "lid" else usuario
            if num:
                idx.setdefault(chats_sync._clave_tel(num), []).append(jid)
    finally:
        cm.close()
    return idx


def mensajes(base, jids):
    cm = chats_sync._abrir_ro(os.path.join(base, "store", "messages.db"))
    try:
        marcas = ",".join("?" * len(jids))
        return cm.execute(
            f"SELECT id, chat_jid, content, datetime(timestamp), is_from_me, media_type "
            f"FROM messages WHERE chat_jid IN ({marcas}) ORDER BY datetime(timestamp)", jids).fetchall()
    finally:
        cm.close()


def escribio_desde(base, jids, desde):
    cm = chats_sync._abrir_ro(os.path.join(base, "store", "messages.db"))
    try:
        marcas = ",".join("?" * len(jids))
        return cm.execute(
            f"SELECT 1 FROM messages WHERE chat_jid IN ({marcas}) AND NOT is_from_me "
            f"AND datetime(timestamp) >= ? LIMIT 1", [*jids, desde]).fetchone() is not None
    finally:
        cm.close()


def transcribir_nuevos(base, owner, filas, desde, ia, audios, cupo):
    """Transcribe los audios del CLIENTE posteriores a `desde`. Los resultados
    quedan en caché por id: la noche siguiente el audio ya no se puede bajar,
    pero su texto sigue entrando en la conversación."""
    hechos = 0
    for mid, jid, content, ts, mio, tipo in filas:
        if mio or (tipo or "") != "audio" or (content or "").strip():
            continue
        k = f"{owner}:{mid}"
        e = audios.get(k) or {}
        if e.get("t") is not None or e.get("intentos", 0) >= 3 or ts < desde or hechos >= cupo:
            continue
        try:
            e["t"] = chats_sync._transcribir(base, mid, jid, ia)
            hechos += 1
        except Exception as ex:
            if "respondió 429" in str(ex):
                raise SinCuota(str(ex)) from ex
            e["intentos"] = e.get("intentos", 0) + 1
            log(f"    ⚠ audio sin transcribir: {str(ex)[:160]}")
        audios[k] = e
    return hechos


ADJUNTOS = {"audio": "audio", "image": "imagen", "video": "video", "document": "documento"}


def conversacion(owner, filas, audios):
    """Texto plano «dd/mm HH:MM Asesor|Cliente: …», en hora de Colombia."""
    lineas, previo = [], None
    for mid, jid, content, ts, mio, tipo in filas:
        txt = (content or "").strip()
        if not txt:
            t = (audios.get(f"{owner}:{mid}") or {}).get("t") if tipo == "audio" else None
            txt = f"🎤 {t}" if t else "[" + ADJUNTOS.get(tipo or "", "adjunto") + "]"
        quien = "Asesor" if mio else "Cliente"
        if txt.startswith("[") and previo == (quien, txt):
            continue   # diez fotos seguidas no aportan diez líneas
        previo = (quien, txt)
        try:
            co = datetime.strptime(ts, "%Y-%m-%d %H:%M:%S") - timedelta(hours=5)
            cuando = co.strftime("%d/%m/%y %H:%M")
        except (TypeError, ValueError):
            cuando = ""
        lineas.append(f"{cuando} {quien}: " + re.sub(r"\s+", " ", txt)[:1500])
    texto = "\n".join(lineas)
    if len(texto) > MAX_CHARS:
        texto = texto[:COMIENZO_CHARS] + "\n[… parte del medio omitida …]\n" + texto[-(MAX_CHARS - COMIENZO_CHARS):]
    return texto


def contexto(c):
    z = c.get("zooms") or {}
    hechas = [n for k, n in (("avanzada", "Avanzada"), ("pres", "Presentación"), ("uno", "1 a 1"))
              if (z.get(k) or {}).get("e") == "hecha"]
    return (f"Cliente: {c['nombre']}. Membresía actual: {c['membresia']}. "
            f"En la comunidad desde: {c.get('comunidad_desde') or 'sin dato'}. "
            f"Etapas de venta hechas: {', '.join(hechas) or 'ninguna registrada'}. "
            f"Hoy es {(datetime.now(timezone.utc) - timedelta(hours=5)).strftime('%d/%m/%Y')}.")


class SinCuota(RuntimeError):
    """Workers AI respondió 429: se acabó la cuota del día. Seguir solo
    quitaría transcripciones a los demás agentes."""


def costo(c, texto):
    """Neuronas estimadas de un resumen (≈3,3 caracteres por token en español,
    y el máximo de salida)."""
    entrada = (len(INSTRUCCIONES) + len(contexto(c)) + len(texto)) / 3.3
    return entrada * NEURONAS_ENTRADA + 400 * NEURONAS_SALIDA


def preguntar_ia(ia, c, texto):
    r = requests.post(
        f"https://api.cloudflare.com/client/v4/accounts/{ia['cuenta']}/ai/run/{MODELO}",
        headers={"Authorization": f"Bearer {ia['token']}"},
        json={"messages": [{"role": "system", "content": INSTRUCCIONES},
                           {"role": "user", "content": contexto(c) + "\n\nConversación:\n" + texto}],
              "max_tokens": 400, "temperature": 0.2},
        timeout=120)
    if r.status_code == 429:
        raise SinCuota(f"Workers AI respondió 429: {r.text[:200]}")
    if r.status_code != 200:
        raise RuntimeError(f"Workers AI respondió {r.status_code}: {r.text[:200]}")
    res = (r.json() or {}).get("result") or {}
    out = res.get("response")
    if isinstance(out, dict):
        d = out
    else:
        # Workers AI a veces responde en formato OpenAI (`choices`).
        if out is None and res.get("choices"):
            out = res["choices"][0].get("message", {}).get("content")
        m = re.search(r"\{.*\}", out or "", re.S)
        if not m:
            raise RuntimeError("la IA no devolvió JSON")
        d = json.loads(m.group(0))
    nec = str(d.get("necesidad") or "").strip()[:LARGO_CAMPO]
    rec = str(d.get("recomendacion") or d.get("recomendación") or "").strip()[:LARGO_CAMPO]
    if not nec or not rec:
        raise RuntimeError("respuesta incompleta de la IA")
    return nec, rec


def main():
    seco = "--simulacro" in sys.argv
    todos = "--todos" in sys.argv
    solo_tel = sys.argv[sys.argv.index("--tel") + 1] if "--tel" in sys.argv else None
    url, key = credenciales()
    cab = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    rest = f"{url}/rest/v1"

    r = requests.post(f"{rest}/rpc/resumen_ia_pendiente", headers=cab, json={}, timeout=30)
    r.raise_for_status()
    d = r.json() or {}
    if not d.get("token") or not d.get("cuenta"):
        log("ERROR: no hay credenciales de Workers AI en la base")
        sys.exit(1)
    ia = {"cuenta": d["cuenta"], "token": d["token"]}

    estado = _leer_json(ESTADO, {})
    audios = _leer_json(AUDIOS, {})
    ahora = datetime.now(timezone.utc)
    # «Escribió desde la última vuelta», no «escribió hoy»: si una noche el
    # timer no corre, la siguiente recoge los dos días. Primera vez: 24 h.
    por_owner = {}
    for c in d.get("clientes") or []:
        por_owner.setdefault(c["owner_id"], []).append(c)

    cupo = AUDIOS_POR_NOCHE
    gastado = 0.0
    sin_cuota = False
    pendientes = estado.setdefault("pendientes", {})
    for owner, clientes in por_owner.items():
        base = bridge_de(owner)
        if not base:
            log(f"{owner}: no tiene bridge en esta VM")
            continue
        desde = estado.get(owner) or (ahora - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        # Quien quedó sin resumen en una vuelta anterior (tope, 429 o error) y
        # quien nunca tuvo uno entran aunque no hayan vuelto a escribir.
        deuda = set(pendientes.get(owner) or []) | nunca_resumidos(rest, cab, owner)
        idx = chats_por_tel(base)
        candidatos = []
        for c in clientes:
            tel = chats_sync._clave_tel(c.get("telefono"))
            if solo_tel and tel != chats_sync._clave_tel(solo_tel):
                continue
            jids = idx.get(tel)
            if not jids:
                continue
            escribio = escribio_desde(base, jids, desde)
            if todos or solo_tel or escribio or c["id"] in deuda:
                # Primero quien escribió (lo más fresco), luego la deuda. La
                # conversación se lee después, de a una: VM1 tiene poca RAM.
                candidatos.append((0 if escribio else 1, c, jids))
        candidatos.sort(key=lambda x: x[0])
        hechos = fallos = 0
        quedan = []
        for i, (_, c, jids) in enumerate(candidatos):
            if sin_cuota:
                quedan.append(c["id"])
                continue
            try:
                filas = mensajes(base, jids)
                cupo -= transcribir_nuevos(base, owner, filas, desde, ia, audios, cupo)
                texto = conversacion(owner, filas, audios)
                if not texto.strip():
                    continue
                n = costo(c, texto)
                if gastado + n > NEURONAS_POR_NOCHE:
                    log(f"  presupuesto de la noche alcanzado ({gastado:.0f} neuronas): "
                        f"{len(candidatos) - i} cliente(s) quedan para la próxima")
                    sin_cuota = True
                    quedan.append(c["id"])
                    continue
                gastado += n
                nec, rec = preguntar_ia(ia, c, texto)
                if seco:
                    log(f"  {c['nombre']}\n    necesidad: {nec}\n    recomendación: {rec}")
                else:
                    p = requests.patch(f"{rest}/clientes?id=eq.{c['id']}", headers=cab,
                                       json={"necesidad": nec, "recomendacion": rec}, timeout=20)
                    p.raise_for_status()
                hechos += 1
            except SinCuota as ex:
                log(f"  ⛔ sin cuota de Workers AI, me detengo: {str(ex)[:160]}")
                sin_cuota = True
                quedan.append(c["id"])
            except Exception as ex:
                fallos += 1
                quedan.append(c["id"])
                log(f"  ⚠ {c['nombre']}: {str(ex)[:200]}")
        log(f"{os.path.basename(base)}: {hechos} resumen(es), {fallos} fallo(s), "
            f"{len(quedan)} pendiente(s), ~{gastado:.0f} neuronas")
        if not seco and not solo_tel:
            estado[owner] = ahora.strftime("%Y-%m-%d %H:%M:%S")
            pendientes[owner] = quedan
    if not seco:
        _guardar_json(AUDIOS, audios)
        if not solo_tel:
            _guardar_json(ESTADO, estado)


def nunca_resumidos(rest, cab, owner):
    """Ids de los clientes del agente sin necesidad guardada: la primera carga
    de cada uno va con todo su historial, repartida en varias noches."""
    r = requests.get(f"{rest}/clientes", headers=cab, timeout=30,
                     params={"select": "id", "owner_id": f"eq.{owner}", "necesidad": "is.null"})
    r.raise_for_status()
    return {x["id"] for x in r.json() or []}


if __name__ == "__main__":
    main()
