"""
Firma de peticiones a la API de Oracle Cloud (OCI), solo con la librería estándar.

POR QUÉ A MANO Y NO CON EL SDK `oci`
------------------------------------
El SDK oficial pesa 36 MB y obliga a un `pip install` en cada sitio donde corra
esto: el portátil, la VM y el entorno efímero de Claude (que se reconstruye en
cada sesión). Un paso de instalación es un paso que falla justo el día que hace
falta mirar las VM. Firmar es RSA-SHA256 sobre un texto armado a mano — unas
cien líneas — y Python trae de fábrica `hashlib`, `base64` y enteros grandes,
que es todo lo que se necesita.

El riesgo de escribir criptografía a mano es bajo aquí porque solo se FIRMA con
llave propia; no se verifica nada de terceros. Si estuviera mal, Oracle
responde 401 y se ve: no hay forma de que falle en silencio dejando un agujero.
Aun así la firma se comprueba en `prueba_firma.py` verificándola con la librería
`cryptography`, que es una implementación independiente.

La especificación es la de OCI («Request Signatures»): se firma un texto con una
línea por encabezado, `nombre: valor`, en el mismo orden que declara `headers=`.
"""

import base64
import email.utils
import hashlib
import json
import urllib.parse
import urllib.request

# Encabezados que OCI exige firmar. En GET basta identificar la petición; en los
# que llevan cuerpo hay que firmar además su hash, para que nadie lo altere.
CABECERAS_GET = ("(request-target)", "host", "date")
CABECERAS_CUERPO = ("(request-target)", "host", "date",
                    "content-length", "content-type", "x-content-sha256")

# Prefijo DigestInfo de SHA-256 (RFC 8017, EMSA-PKCS1-v1_5). Es constante: la
# codificación DER de {OID sha256, NULL} seguida del OCTET STRING del hash.
DIGESTINFO_SHA256 = bytes.fromhex("3031300d060960864801650304020105000420")


class ErrorFirma(Exception):
    """Problema con la llave o con la firma, antes de salir a la red."""


# ---------------------------------------------------------------------------
#  Lectura de la llave privada (PEM → módulo y exponente privado)
# ---------------------------------------------------------------------------

def _leer_der(datos, pos):
    """Lee un elemento DER en `pos`. Devuelve (etiqueta, contenido, siguiente).

    DER es tipo-longitud-valor. La longitud viene en corto (un byte < 0x80) o en
    largo (el byte dice cuántos bytes ocupa la longitud). Solo hace falta esto:
    una llave RSA son SECUENCIAS y ENTEROS, nada exótico.
    """
    etiqueta = datos[pos]
    largo = datos[pos + 1]
    pos += 2
    if largo & 0x80:
        n_bytes = largo & 0x7F
        largo = int.from_bytes(datos[pos:pos + n_bytes], "big")
        pos += n_bytes
    return etiqueta, datos[pos:pos + largo], pos + largo


def _enteros_de_secuencia(cuerpo):
    """Devuelve los INTEGER de una SECUENCIA DER, en orden."""
    enteros, pos = [], 0
    while pos < len(cuerpo):
        etiqueta, contenido, pos = _leer_der(cuerpo, pos)
        if etiqueta == 0x02:  # INTEGER
            enteros.append(int.from_bytes(contenido, "big"))
        elif etiqueta == 0x30:  # SEQUENCE anidada (AlgorithmIdentifier)
            enteros.append(None)
    return enteros


def cargar_llave(pem):
    """Saca (n, d) de una llave privada RSA en PEM.

    Acepta los dos formatos que entrega la consola de Oracle:
      - PKCS#8  «BEGIN PRIVATE KEY»      (el que da la consola al generar)
      - PKCS#1  «BEGIN RSA PRIVATE KEY»  (el de `openssl genrsa`)

    Una llave con contraseña se rechaza con un mensaje claro: OCI no la pide y
    soportarla obligaría a arrastrar un descifrador entero.
    """
    if not pem or "PRIVATE KEY" not in pem:
        raise ErrorFirma(
            "La llave privada no parece un PEM. Debe empezar por "
            "'-----BEGIN PRIVATE KEY-----' e incluir los saltos de línea.")
    if "ENCRYPTED" in pem:
        raise ErrorFirma(
            "La llave tiene contraseña y no se admite. Genera una llave de API "
            "sin passphrase desde la consola de Oracle (Perfil → API Keys).")

    # Se descartan encabezados y líneas en blanco. Los espacios internos también
    # se quitan: un PEM que pasó por un cuadro de texto o por un correo puede
    # volver con espacios metidos dentro del base64, y son inofensivos.
    lineas = [l.strip() for l in pem.strip().splitlines()]
    cuerpo_b64 = "".join(
        l.replace(" ", "").replace("\t", "")
        for l in lineas
        if l and "-----" not in l)

    # `validate=True` a propósito: por defecto b64decode DESCARTA en silencio lo
    # que no sea del alfabeto, así que un PEM corrupto se decodificaba a vacío y
    # reventaba después con un IndexError del parser DER que no decía nada.
    try:
        der = base64.b64decode(cuerpo_b64, validate=True)
    except Exception as exc:
        # Segundo intento en base64url ('-' y '_' en vez de '+' y '/'). Algunas
        # herramientas guardan así. No es un riesgo aceptar las dos variantes:
        # el resultado tiene que seguir siendo DER de una llave RSA válida, y si
        # no fuera la llave correcta Oracle la rechaza con 401. Traducir a ciegas
        # una llave rota no la vuelve buena, solo mueve el error un paso.
        if set(cuerpo_b64) & {"-", "_"}:
            try:
                der = base64.b64decode(
                    cuerpo_b64.replace("-", "+").replace("_", "/"),
                    validate=True)
                return _numeros_rsa(der)
            except Exception:  # noqa: BLE001
                pass
        # El mensaje tiene que DECIR qué estorba. «No está en base64 válido» deja
        # a oscuras delante de un archivo que uno no puede leer a ojo, y abrir la
        # llave privada para inspeccionarla es justo lo que no conviene hacer.
        # Se muestran los caracteres intrusos y dónde están, nunca la llave.
        validos = set(
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
        intrusos = sorted({c for c in cuerpo_b64 if c not in validos})
        pista = ", ".join(f"{c!r} (U+{ord(c):04X})" for c in intrusos[:8]) or "ninguno"

        sospecha = ""
        if "﻿" in cuerpo_b64:
            sospecha = ("\n  El archivo empieza con una marca BOM: lo guardó un "
                        "editor de Windows. Vuelve a descargar el .pem de Oracle "
                        "sin abrirlo con el Bloc de notas.")
        elif "\x00" in cuerpo_b64:
            sospecha = ("\n  El archivo tiene bytes nulos: está en UTF-16, "
                        "seguramente por haberlo copiado con `>` en PowerShell. "
                        "Cópialo con `copy` o vuelve a descargarlo.")
        elif "-" in intrusos or "_" in intrusos:
            sospecha = ("\n  Tiene '-' o '_': parece base64url, no el PEM que "
                        "descarga Oracle.")

        raise ErrorFirma(
            f"El contenido de la llave no es base64 válido.\n\n"
            f"  Primera línea      : {lineas[0][:60] if lineas else '(vacío)'}\n"
            f"  Líneas de contenido: {len([l for l in lineas if l and '-----' not in l])}\n"
            f"  Caracteres que sobran: {pista}\n"
            f"  Detalle: {exc}{sospecha}\n\n"
            "Lo más seguro es volver a generar la llave en la consola de Oracle "
            "(Perfil → API keys → Add API key → Generate) y descargarla sin "
            "abrirla con ningún editor.") from exc
    return _numeros_rsa(der)


def _comprobar_coherencia(enteros):
    """Verifica que la llave sea internamente coherente: n = p·q.

    Es la red que hace segura la lectura tolerante de más arriba. Un archivo con
    un carácter cambiado puede decodificar igual y dar una llave que PARECE
    válida —estructura DER correcta, enteros en su sitio— pero que no es la
    llave. Sin esta comprobación eso sale como un 401 de Oracle, que manda a
    revisar permisos y fingerprint cuando lo que pasa es que el archivo está
    roto. El producto de los primos es la única prueba barata que lo distingue.

    RSAPrivateKey es: version, n, e, d, p, q, dp, dq, qinv — nueve enteros
    SIEMPRE. Por eso, si vienen menos, la conclusión no es «no se puede
    comprobar» sino «está rota»: no verificar cuando falta información es
    justamente como se cuela una llave equivocada.
    """
    aviso = (
        "\n\nHay que generar una llave nueva en la consola de Oracle "
        "(Perfil → API keys → Add API key → Generate) y descargarla sin "
        "abrirla con ningún editor.")

    if len(enteros) < 6 or not all(enteros[i] for i in (1, 4, 5)):
        raise ErrorFirma(
            "La llave está incompleta: se esperaban los nueve enteros de una "
            f"llave RSA y se encontraron {len(enteros)}. El archivo está "
            "truncado o alterado." + aviso)

    n, e, d, p, q = enteros[1], enteros[2], enteros[3], enteros[4], enteros[5]
    if p * q != n:
        raise ErrorFirma(
            "La llave está corrupta: sus dos primos no dan el módulo "
            "(n ≠ p·q). El archivo se alteró en algún momento — no es un "
            "problema de formato, le faltan o le sobran datos." + aviso)

    # n = p·q no basta: si el carácter alterado cae dentro del exponente
    # privado, los primos siguen cuadrando y la llave pasa el filtro siendo
    # otra. Esta prueba cierra el círculo sobre lo que de verdad se usa para
    # firmar: se firma un número y se verifica con el exponente público. Si
    # no vuelve al original, `n` y `d` no son pareja.
    if e and d:
        muestra = 0xC0FFEE
        if pow(pow(muestra, d, n), e, n) != muestra:
            raise ErrorFirma(
                "La llave está corrupta: su exponente privado no corresponde "
                "al módulo, así que cualquier firma saldría inválida. El "
                "archivo se alteró." + aviso)


def _numeros_rsa(der):
    """Saca (módulo, exponente privado) del DER de una llave RSA."""
    if len(der) < 8:
        raise ErrorFirma("El PEM está vacío o truncado tras decodificar.")

    etiqueta, contenido, _ = _leer_der(der, 0)
    if etiqueta != 0x30:
        raise ErrorFirma("El PEM no contiene una SECUENCIA DER en la raíz.")

    enteros = _enteros_de_secuencia(contenido)

    # PKCS#1: version, n, e, d, ...  → el módulo es el segundo entero.
    if len(enteros) >= 4 and enteros[0] == 0 and enteros[1] is not None:
        _comprobar_coherencia(enteros)
        return enteros[1], enteros[3]

    # PKCS#8: envuelve la RSAPrivateKey dentro de un OCTET STRING.
    pos = 0
    while pos < len(contenido):
        etiqueta, interno, pos = _leer_der(contenido, pos)
        if etiqueta == 0x04:  # OCTET STRING
            _, cuerpo_rsa, _ = _leer_der(interno, 0)
            enteros = _enteros_de_secuencia(cuerpo_rsa)
            if len(enteros) >= 4:
                _comprobar_coherencia(enteros)
                return enteros[1], enteros[3]

    raise ErrorFirma("No se pudo extraer la llave RSA del PEM (¿formato raro?).")


# ---------------------------------------------------------------------------
#  RSA-SHA256, PKCS#1 v1.5
# ---------------------------------------------------------------------------

def firmar_texto(texto, n, d):
    """Firma `texto` con RSA-SHA256 y devuelve los bytes de la firma.

    Es EMSA-PKCS1-v1_5 (RFC 8017 §9.2): al DigestInfo del hash se le antepone
    relleno 0xFF hasta llenar el tamaño del módulo, con el marco 0x00 0x01 …
    0x00. Luego la firma es sencillamente m^d mod n.
    """
    k = (n.bit_length() + 7) // 8
    digest = hashlib.sha256(texto.encode("utf-8")).digest()
    t = DIGESTINFO_SHA256 + digest
    if k < len(t) + 11:
        raise ErrorFirma("La llave RSA es demasiado corta para SHA-256.")
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    firma = pow(int.from_bytes(em, "big"), d, n)
    return firma.to_bytes(k, "big")


# ---------------------------------------------------------------------------
#  Petición firmada
# ---------------------------------------------------------------------------

def _texto_a_firmar(metodo, url, cabeceras, nombres):
    """Arma el texto que se firma: una línea `nombre: valor` por encabezado.

    `(request-target)` es un pseudo-encabezado: método en minúsculas y la ruta
    CON su query string. Si se firmara sin la query, cualquiera podría cambiar
    los filtros de la petición sin invalidar la firma.
    """
    partes = urllib.parse.urlsplit(url)
    destino = partes.path + (f"?{partes.query}" if partes.query else "")
    lineas = []
    for nombre in nombres:
        if nombre == "(request-target)":
            lineas.append(f"(request-target): {metodo.lower()} {destino}")
        else:
            lineas.append(f"{nombre}: {cabeceras[nombre]}")
    return "\n".join(lineas)


def peticion_firmada(cred, metodo, url, cuerpo=None, timeout=30):
    """Llama a la API de OCI con la firma puesta. Devuelve el JSON de respuesta.

    Los errores de Oracle se dejan subir con su mensaje y el código HTTP: son
    la única pista real cuando algo no cuadra (permiso que falta, región
    equivocada, ruta que cambió), y tragárselos deja el diagnóstico a ciegas.
    """
    partes = urllib.parse.urlsplit(url)
    fecha = email.utils.formatdate(usegmt=True)
    cabeceras = {"date": fecha, "host": partes.netloc}

    datos = None
    if cuerpo is None:
        nombres = CABECERAS_GET
    else:
        datos = json.dumps(cuerpo).encode("utf-8")
        cabeceras["content-length"] = str(len(datos))
        cabeceras["content-type"] = "application/json"
        cabeceras["x-content-sha256"] = base64.b64encode(
            hashlib.sha256(datos).digest()).decode("ascii")
        nombres = CABECERAS_CUERPO

    texto = _texto_a_firmar(metodo, url, cabeceras, nombres)
    firma = base64.b64encode(firmar_texto(texto, cred.n, cred.d)).decode("ascii")

    cabeceras["authorization"] = (
        'Signature version="1",'
        f'keyId="{cred.tenancy}/{cred.usuario}/{cred.fingerprint}",'
        'algorithm="rsa-sha256",'
        f'headers="{" ".join(nombres)}",'
        f'signature="{firma}"')

    peticion = urllib.request.Request(url, data=datos, method=metodo)
    for nombre, valor in cabeceras.items():
        if nombre != "host":  # urllib pone Host solo; duplicarlo da 400
            peticion.add_header(nombre, valor)

    try:
        with urllib.request.urlopen(peticion, timeout=timeout) as resp:
            texto_resp = resp.read().decode("utf-8")
            return json.loads(texto_resp) if texto_resp else {}
    except urllib.error.HTTPError as exc:
        detalle = exc.read().decode("utf-8", "replace")[:600]
        raise ErrorFirma(
            f"Oracle respondió {exc.code} a {metodo} {url}\n{detalle}") from exc
    except urllib.error.URLError as exc:
        raise ErrorFirma(
            f"No se pudo llegar a {partes.netloc}: {exc.reason}. "
            "Si es un 403 del proxy, este entorno tiene bloqueado "
            "*.oraclecloud.com (ver mcp/oracle/README.md).") from exc
