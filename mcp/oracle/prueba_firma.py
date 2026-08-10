"""
Prueba de la firma, sin tocar Oracle.

POR QUÉ EXISTE
--------------
Desde el entorno de Claude no se alcanza `*.oraclecloud.com` (el proxy responde
403 por política de red), así que no se puede comprobar la firma con una llamada
real. Se comprueba de la otra forma, que además es más estricta: se firma con la
implementación propia y se VERIFICA con `cryptography`, que es código de otra
gente. Si una firma hecha a mano valida contra un verificador independiente, la
matemática y el relleno están bien; lo único que queda sin probar es qué
responde Oracle.

    python3 mcp/oracle/prueba_firma.py

Necesita `cryptography` solo para la prueba. El servidor no la usa.
"""

import sys
import types

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

import firma

fallos = []


def revisar(nombre, condicion, detalle=""):
    print(f"  {'OK  ' if condicion else 'FALLA'}  {nombre}")
    if not condicion:
        fallos.append(f"{nombre}: {detalle}")


llave = rsa.generate_private_key(public_exponent=65537, key_size=2048)
numeros = llave.private_numbers()

pem_pkcs8 = llave.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.PKCS8,
    serialization.NoEncryption()).decode()
pem_pkcs1 = llave.private_bytes(
    serialization.Encoding.PEM,
    serialization.PrivateFormat.TraditionalOpenSSL,
    serialization.NoEncryption()).decode()

print("\n1. Lectura del PEM (los dos formatos que da la consola de Oracle)")
n8, d8 = firma.cargar_llave(pem_pkcs8)
revisar("PKCS#8 devuelve el módulo correcto", n8 == numeros.public_numbers.n)
revisar("PKCS#8 devuelve el exponente privado correcto", d8 == numeros.d)

n1, d1 = firma.cargar_llave(pem_pkcs1)
revisar("PKCS#1 devuelve el módulo correcto", n1 == numeros.public_numbers.n)
revisar("PKCS#1 devuelve el exponente privado correcto", d1 == numeros.d)

print("\n2. La firma valida contra `cryptography` (implementación ajena)")
for texto in ("(request-target): get /20160918/instances\nhost: iaas.sa-saopaulo-1.oraclecloud.com",
              "",
              "á é í ó ú — acentos y guiones largos",
              "x" * 5000):
    bytes_firma = firma.firmar_texto(texto, n8, d8)
    try:
        llave.public_key().verify(
            bytes_firma, texto.encode("utf-8"),
            padding.PKCS1v15(), hashes.SHA256())
        ok = True
    except Exception:
        ok = False
    revisar(f"verifica firma de un texto de {len(texto)} car.", ok)

bytes_firma = firma.firmar_texto("hola", n8, d8)
revisar("la firma ocupa exactamente el tamaño del módulo",
        len(bytes_firma) == 256, f"son {len(bytes_firma)} bytes")

print("\n3. Una firma alterada NO valida (la prueba no es un sí automático)")
alterada = bytearray(firma.firmar_texto("hola", n8, d8))
alterada[-1] ^= 0x01
try:
    llave.public_key().verify(bytes(alterada), b"hola",
                              padding.PKCS1v15(), hashes.SHA256())
    paso = False
except Exception:
    paso = True
revisar("rechaza una firma con un bit cambiado", paso)

print("\n4. El texto a firmar sale exactamente como pide OCI")
esperado_get = (
    "(request-target): get /20160918/instances?compartmentId=ocid1.tenancy.oc1..aaa\n"
    "host: iaas.sa-saopaulo-1.oraclecloud.com\n"
    "date: Mon, 10 Aug 2026 12:00:00 GMT")
obtenido_get = firma._texto_a_firmar(
    "GET",
    "https://iaas.sa-saopaulo-1.oraclecloud.com/20160918/instances?compartmentId=ocid1.tenancy.oc1..aaa",
    {"host": "iaas.sa-saopaulo-1.oraclecloud.com",
     "date": "Mon, 10 Aug 2026 12:00:00 GMT"},
    firma.CABECERAS_GET)
revisar("GET: método en minúsculas y ruta CON query", obtenido_get == esperado_get,
        f"\n--- esperado ---\n{esperado_get}\n--- obtenido ---\n{obtenido_get}")

obtenido_post = firma._texto_a_firmar(
    "POST",
    "https://telemetry.sa-saopaulo-1.oraclecloud.com/20180401/metrics/actions/summarizeMetricsData?compartmentId=x",
    {"host": "telemetry.sa-saopaulo-1.oraclecloud.com",
     "date": "Mon, 10 Aug 2026 12:00:00 GMT",
     "content-length": "42",
     "content-type": "application/json",
     "x-content-sha256": "abc="},
    firma.CABECERAS_CUERPO)
revisar("POST: firma también longitud, tipo y hash del cuerpo",
        obtenido_post.splitlines()[-3:] == [
            "content-length: 42", "content-type: application/json",
            "x-content-sha256: abc="],
        obtenido_post)
revisar("POST: el orden de las líneas es el mismo que declara headers=",
        [l.split(":")[0] for l in obtenido_post.splitlines()] ==
        ["(request-target)", "host", "date", "content-length", "content-type",
         "x-content-sha256"])

print("\n5. Llaves inválidas fallan con un mensaje que se entiende")
for descripcion, pem, aguja in (
        ("vacía", "", "no parece un PEM"),
        ("con contraseña", "-----BEGIN ENCRYPTED PRIVATE KEY-----\nxx\n-----END ENCRYPTED PRIVATE KEY-----", "contraseña"),
        ("base64 roto", "-----BEGIN PRIVATE KEY-----\n$$$$\n-----END PRIVATE KEY-----", "base64")):
    try:
        firma.cargar_llave(pem)
        revisar(f"llave {descripcion} da error claro", False, "no lanzó nada")
    except firma.ErrorFirma as exc:
        revisar(f"llave {descripcion} da error claro", aguja in str(exc), str(exc))

print("\n5b. Un PEM que pasó por Windows sigue cargando")
# Los tres salieron de configurarlo en un Windows real. Un editor que añade una
# marca invisible no puede costar una llave nueva.
for descripcion, texto in (
        ("con marca BOM del Bloc de notas", "﻿" + pem_pkcs8),
        ("con saltos de línea de Windows", pem_pkcs8.replace("\n", "\r\n")),
        ("con espacios metidos en el base64",
         "\n".join(l[:20] + " " + l[20:] if i == 2 else l
                   for i, l in enumerate(pem_pkcs8.splitlines()))),
        ("con líneas en blanco de sobra", pem_pkcs8.replace("\n", "\n\n")),
        ("con espacios al final de cada línea",
         "\n".join(l + "   " for l in pem_pkcs8.splitlines()))):
    try:
        n_x, d_x = firma.cargar_llave(texto)
        revisar(f"carga la llave {descripcion}", n_x == numeros.public_numbers.n)
    except firma.ErrorFirma as exc:
        revisar(f"carga la llave {descripcion}", False, str(exc))

print("\n5c. Cuando de verdad está rota, el error dice qué estorba")
try:
    firma.cargar_llave("-----BEGIN PRIVATE KEY-----\nAAAA@@@@BBBB\n-----END PRIVATE KEY-----")
    revisar("señala los caracteres intrusos", False, "no lanzó nada")
except firma.ErrorFirma as exc:
    revisar("señala los caracteres intrusos", "'@'" in str(exc), str(exc))
    revisar("muestra la primera línea del archivo",
            "BEGIN PRIVATE KEY" in str(exc), str(exc))
    revisar("dice qué hacer", "volver a generar" in str(exc), str(exc))

try:
    firma.cargar_llave("-----BEGIN PRIVATE KEY-----\nAA-_AA\n-----END PRIVATE KEY-----")
    revisar("reconoce base64url", False, "no lanzó nada")
except firma.ErrorFirma as exc:
    revisar("reconoce base64url", "base64url" in str(exc), str(exc))

print("\n6. La cabecera Authorization tiene la forma exacta de OCI")
cred = types.SimpleNamespace(
    n=n8, d=d8, tenancy="ocid1.tenancy.oc1..aaa",
    usuario="ocid1.user.oc1..bbb", fingerprint="aa:bb:cc")
capturado = {}


def falso_urlopen(peticion, timeout=None):
    capturado["cabeceras"] = dict(peticion.header_items())
    capturado["url"] = peticion.full_url

    class Resp:
        def read(self): return b"{}"
        def __enter__(self): return self
        def __exit__(self, *a): return False
    return Resp()


firma.urllib.request.urlopen = falso_urlopen
firma.peticion_firmada(cred, "GET", "https://iaas.sa-saopaulo-1.oraclecloud.com/20160918/instances")
auth = capturado["cabeceras"].get("Authorization", "")
revisar("lleva version=\"1\"", 'version="1"' in auth, auth)
revisar("keyId es tenancy/usuario/fingerprint",
        'keyId="ocid1.tenancy.oc1..aaa/ocid1.user.oc1..bbb/aa:bb:cc"' in auth, auth)
revisar("algorithm es rsa-sha256", 'algorithm="rsa-sha256"' in auth, auth)
revisar("headers declara los tres del GET",
        'headers="(request-target) host date"' in auth, auth)
revisar("no manda Host a mano (urllib lo pone)",
        "Host" not in capturado["cabeceras"], str(capturado["cabeceras"].keys()))

print()
if fallos:
    print(f"FALLARON {len(fallos)} comprobaciones:")
    for f in fallos:
        print(f"  - {f}")
    sys.exit(1)
print("Todo correcto. La firma es válida según una implementación independiente.")
print("Lo único sin probar es la respuesta de Oracle (este entorno no la alcanza).")
