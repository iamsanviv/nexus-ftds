"""
Prueba del servidor MCP: protocolo y herramientas, sin tocar Oracle.

DOS NIVELES, A PROPÓSITO
------------------------
1. El PROTOCOLO se prueba lanzando el servidor de verdad como subproceso y
   hablándole por stdin/stdout. Es la única forma de detectar el fallo clásico
   de un servidor MCP —algo escrito en stdout que no es JSON-RPC— porque en
   pruebas dentro del proceso ese fallo no se ve. Funciona sin credenciales
   porque `initialize` y `tools/list` no las necesitan: se cargan tarde, solo al
   llamar una herramienta.

2. Las HERRAMIENTAS se prueban dentro del proceso, sustituyendo la llamada a
   Oracle por respuestas enlatadas. Comprueban lo que de verdad puede salir mal
   aquí: que el cupo se cuente bien y que una API caída no tumbe la respuesta.

    python3 mcp/oracle/prueba_servidor.py
"""

import json
import os
import subprocess
import sys
import types

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firma      # noqa: E402
import servidor   # noqa: E402

AQUI = os.path.dirname(os.path.abspath(__file__))
fallos = []


def revisar(nombre, condicion, detalle=""):
    print(f"  {'OK  ' if condicion else 'FALLA'}  {nombre}")
    if not condicion:
        fallos.append(f"{nombre}: {detalle}")


# ---------------------------------------------------------------------------
print("\n1. Protocolo MCP contra el servidor real (subproceso)")
# ---------------------------------------------------------------------------

entrada = "\n".join(json.dumps(m) for m in [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {"protocolVersion": "2025-06-18", "capabilities": {}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
    {"jsonrpc": "2.0", "id": 3, "method": "ping"},
    {"jsonrpc": "2.0", "id": 4, "method": "metodo/inventado"},
    {"jsonrpc": "2.0", "id": 5, "method": "tools/call",
     "params": {"name": "no_existe", "arguments": {}}},
]) + "\n"

proc = subprocess.run(
    [sys.executable, os.path.join(AQUI, "servidor.py")],
    input=entrada, capture_output=True, text=True, timeout=60,
    # Entorno sin credenciales ni ~/.oci/config, para comprobar que initialize
    # y tools/list funcionan igual: un cliente MCP hace eso al arrancar y no
    # debe fallar solo porque falte configurar Oracle.
    env={**os.environ, "OCI_CONFIG_FILE": "/no/existe", "HOME": "/no/existe",
         "OCI_TENANCY": "", "OCI_USER": "", "OCI_FINGERPRINT": "",
         "OCI_REGION": "", "OCI_KEY": "", "OCI_KEY_FILE": ""})

lineas = [l for l in proc.stdout.strip().splitlines() if l.strip()]
respuestas = {}
todo_json = True
for linea in lineas:
    try:
        msg = json.loads(linea)
        respuestas[msg.get("id")] = msg
    except json.JSONDecodeError:
        todo_json = False
        fallos.append(f"stdout tenía una línea que no es JSON: {linea[:120]}")

revisar("cada línea de stdout es JSON-RPC válido", todo_json)
revisar("no contesta a la notificación (que no lleva id)", len(respuestas) == 5,
        f"contestó {len(respuestas)}: {sorted(respuestas)}")

ini = respuestas.get(1, {}).get("result", {})
revisar("initialize responde", bool(ini), json.dumps(respuestas.get(1)))
revisar("initialize devuelve la versión que pidió el cliente",
        ini.get("protocolVersion") == "2025-06-18", json.dumps(ini))
revisar("initialize anuncia capacidad de tools",
        "tools" in (ini.get("capabilities") or {}), json.dumps(ini))
revisar("initialize se identifica",
        (ini.get("serverInfo") or {}).get("name") == "oracle-nexus", json.dumps(ini))

herramientas = (respuestas.get(2, {}).get("result") or {}).get("tools", [])
nombres = [h["name"] for h in herramientas]
revisar("tools/list devuelve las 6 herramientas", len(herramientas) == 6, str(nombres))
for esperada in ("oci_diagnostico", "oci_instancias", "oci_cupo_gratis",
                 "oci_metricas", "oci_costos", "oci_get"):
    revisar(f"expone {esperada}", esperada in nombres, str(nombres))
revisar("todas traen descripción y esquema",
        all(h.get("description") and h.get("inputSchema") for h in herramientas))
revisar("tools/list funciona SIN credenciales configuradas", bool(herramientas))

revisar("ping responde", respuestas.get(3, {}).get("result") == {})
revisar("un método inventado da error -32601",
        (respuestas.get(4, {}).get("error") or {}).get("code") == -32601,
        json.dumps(respuestas.get(4)))
revisar("una herramienta inexistente da error, no tumba el servidor",
        "error" in respuestas.get(5, {}), json.dumps(respuestas.get(5)))
revisar("el servidor terminó limpio", proc.returncode == 0,
        f"código {proc.returncode}, stderr: {proc.stderr[:300]}")


# ---------------------------------------------------------------------------
print("\n2. Herramientas contra respuestas de Oracle enlatadas")
# ---------------------------------------------------------------------------

CRED = types.SimpleNamespace(
    tenancy="ocid1.tenancy.oc1..aaa", usuario="ocid1.user.oc1..bbb",
    fingerprint="aa:bb", region="sa-saopaulo-1", n=1, d=1,
    compartimento="ocid1.tenancy.oc1..aaa")

INSTANCIAS = [
    {"id": "ocid1.instance..vm1", "displayName": "nexus-cloud",
     "shape": "VM.Standard.E2.1.Micro", "lifecycleState": "RUNNING",
     "availabilityDomain": "AD-1", "timeCreated": "2026-05-01T10:00:00Z"},
    {"id": "ocid1.instance..vm2", "displayName": "nexus-vm2",
     "shape": "VM.Standard.E2.1.Micro", "lifecycleState": "RUNNING",
     "availabilityDomain": "AD-1", "timeCreated": "2026-08-01T10:00:00Z"},
    {"id": "ocid1.instance..vieja", "displayName": "borrada",
     "shape": "VM.Standard.E2.1.Micro", "lifecycleState": "TERMINATED",
     "availabilityDomain": "AD-1", "timeCreated": "2026-01-01T10:00:00Z"},
]


def falsa_api(respuestas_por_ruta):
    """Sustituye la llamada a Oracle. Un valor Exception se lanza."""
    def _falsa(cred, metodo, url_pedida, cuerpo=None, timeout=30):
        for aguja, respuesta in respuestas_por_ruta.items():
            if aguja in url_pedida:
                if isinstance(respuesta, Exception):
                    raise respuesta
                return respuesta
        raise firma.ErrorFirma(f"ruta no prevista en la prueba: {url_pedida}")
    return _falsa


original = firma.peticion_firmada

# --- cupo: dos micros ocupadas, ARM libre, y la API de límites caída ---------
firma.peticion_firmada = falsa_api({
    "/instances": INSTANCIAS,
    "/resourceAvailability": firma.ErrorFirma("Oracle respondió 404 a GET ..."),
})
texto = servidor.h_cupo_gratis(CRED, {})
revisar("cuenta 2 de 2 micros (ignora la TERMINATED)",
        "VM.Standard.E2.1.Micro : 2 de 2" in texto, texto)
revisar("dice que no cabe otra micro", "CUPO LLENO" in texto, texto)
revisar("ve el cupo ARM libre", "0 de 4 OCPU" in texto, texto)
revisar("avisa de que ARM necesita compilar para esa arquitectura",
        "ARM" in texto and "arquitectura" in texto, texto)
revisar("si la API de límites falla, la respuesta principal sigue en pie",
        "no se pudo consultar" in texto and "CUPO LLENO" in texto, texto)

# --- cupo con una instancia de pago: tiene que gritarlo ----------------------
firma.peticion_firmada = falsa_api({
    "/instances": INSTANCIAS + [
        {"id": "ocid1.instance..cara", "displayName": "grande",
         "shape": "VM.Standard3.Flex", "lifecycleState": "RUNNING",
         "availabilityDomain": "AD-1", "timeCreated": "2026-08-01T10:00:00Z",
         "shapeConfig": {"ocpus": 2, "memoryInGBs": 16}}],
    "/resourceAvailability": firma.ErrorFirma("404"),
})
texto = servidor.h_cupo_gratis(CRED, {})
revisar("avisa de instancias FUERA de Always Free",
        "FUERA DE ALWAYS FREE" in texto and "grande" in texto, texto)

# --- cupo con ARM ya en uso -------------------------------------------------
firma.peticion_firmada = falsa_api({
    "/instances": [
        {"id": "a", "displayName": "arm1", "shape": "VM.Standard.A1.Flex",
         "lifecycleState": "RUNNING", "availabilityDomain": "AD-1",
         "timeCreated": "2026-08-01T10:00:00Z",
         "shapeConfig": {"ocpus": 1, "memoryInGBs": 6}}],
    "/resourceAvailability": firma.ErrorFirma("404"),
})
texto = servidor.h_cupo_gratis(CRED, {})
revisar("suma OCPU y GB de ARM en uso", "1 de 4 OCPU" in texto and "6 de 24 GB" in texto, texto)
revisar("calcula lo que queda de ARM", "Caben 3 OCPU y 18 GB" in texto, texto)

# --- instancias con IPs -----------------------------------------------------
firma.peticion_firmada = falsa_api({
    "/instances": INSTANCIAS,
    "/vnicAttachments": [{"vnicId": "ocid1.vnic..x", "lifecycleState": "ATTACHED"}],
    "/vnics/": {"publicIp": "141.148.40.31", "privateIp": "10.0.0.23"},
})
texto = servidor.h_instancias(CRED, {})
revisar("lista solo las instancias vivas", "2 vivas" in texto and "borrada" not in texto, texto)
revisar("muestra las IPs", "141.148.40.31" in texto and "10.0.0.23" in texto, texto)
revisar("marca el estado", "[RUNNING]" in texto, texto)

# --- instancias cuando la VNIC falla: no debe romperse ----------------------
firma.peticion_firmada = falsa_api({
    "/instances": INSTANCIAS,
    "/vnicAttachments": firma.ErrorFirma("403 sin permiso de red"),
})
texto = servidor.h_instancias(CRED, {})
revisar("sin permiso de red sigue listando las VM",
        "nexus-cloud" in texto and "nexus-vm2" in texto, texto)

# --- compartimento vacío: mensaje que orienta -------------------------------
firma.peticion_firmada = falsa_api({"/instances": []})
texto = servidor.h_instancias(CRED, {})
revisar("compartimento vacío sugiere correr el diagnóstico",
        "oci_diagnostico" in texto, texto)

# --- métricas ---------------------------------------------------------------
firma.peticion_firmada = falsa_api({
    "/summarizeMetricsData": [{
        "dimensions": {"resourceDisplayName": "nexus-cloud"},
        "aggregatedDatapoints": [{"value": 10.0}, {"value": 30.0}, {"value": 20.0}],
    }],
})
texto = servidor.h_metricas(CRED, {"horas": 3})
revisar("métricas: último, media y máximo",
        "ahora 20.0" in texto and "media 20.0" in texto and "máx 30.0" in texto, texto)
revisar("métricas: nombra la instancia", "nexus-cloud" in texto, texto)

firma.peticion_firmada = falsa_api({"/summarizeMetricsData": []})
texto = servidor.h_metricas(CRED, {})
revisar("sin datos explica que falta el plugin del agente",
        "Oracle Cloud Agent" in texto, texto)

# --- costos -----------------------------------------------------------------
firma.peticion_firmada = falsa_api({"/usage": {"items": []}})
texto = servidor.h_costos(CRED, {})
revisar("costo cero se explica como Always Free",
        "0.00" in texto and "Always Free" in texto, texto)

firma.peticion_firmada = falsa_api({"/usage": {
    "items": [{"computedAmount": 12.5, "currency": "USD", "service": "COMPUTE"}]}})
texto = servidor.h_costos(CRED, {})
revisar("costo con consumo lo desglosa",
        "12.50 USD" in texto and "COMPUTE" in texto, texto)

# --- oci_get: es GET y solo GET ---------------------------------------------
metodos_usados = []


def espia(cred, metodo, url_pedida, cuerpo=None, timeout=30):
    metodos_usados.append(metodo)
    return {"ok": True}


firma.peticion_firmada = espia
servidor.h_get(CRED, {"servicio": "compute", "ruta": "/shapes"})
revisar("oci_get usa GET", metodos_usados == ["GET"], str(metodos_usados))

for args, aguja in (({"servicio": "inventado", "ruta": "/x"}, "desconocido"),
                    ({"servicio": "compute", "ruta": "sin-barra"}, "empezar por")):
    try:
        servidor.h_get(CRED, args)
        revisar(f"oci_get rechaza {args}", False, "no lanzó nada")
    except servidor.ErrorConfig as exc:
        revisar(f"oci_get rechaza {args}", aguja in str(exc), str(exc))

firma.peticion_firmada = original

# --- la URL de facturación lleva `.oci.` en medio ---------------------------
print("\n3. Detalles de las URL que son fáciles de escribir mal")
revisar("usage: host usageapi.{region}.oci.oraclecloud.com",
        servidor.url("usage", CRED, "/usage") ==
        "https://usageapi.sa-saopaulo-1.oci.oraclecloud.com/20200107/usage",
        servidor.url("usage", CRED, "/usage"))
revisar("compute: iaas.{region}.oraclecloud.com/20160918",
        servidor.url("compute", CRED, "/instances").startswith(
            "https://iaas.sa-saopaulo-1.oraclecloud.com/20160918/instances"),
        servidor.url("compute", CRED, "/instances"))
revisar("monitoring: telemetry + 20180401",
        "telemetry.sa-saopaulo-1.oraclecloud.com/20180401" in
        servidor.url("monitoring", CRED, "/metrics"),
        servidor.url("monitoring", CRED, "/metrics"))
revisar("los parámetros nulos no ensucian la query",
        servidor.url("compute", CRED, "/instances", a="1", b=None) ==
        "https://iaas.sa-saopaulo-1.oraclecloud.com/20160918/instances?a=1",
        servidor.url("compute", CRED, "/instances", a="1", b=None))

print()
if fallos:
    print(f"FALLARON {len(fallos)} comprobaciones:")
    for f in fallos:
        print(f"  - {f}")
    sys.exit(1)
print("Todo correcto: el protocolo MCP responde y las herramientas formatean bien.")
print("Sigue sin probarse la respuesta REAL de Oracle (este entorno la bloquea).")
