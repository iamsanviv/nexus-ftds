#!/usr/bin/env python3
"""
Servidor MCP de solo lectura para Oracle Cloud (OCI).

Sirve para mirar las VM del proyecto en tiempo real desde Claude: qué
instancias hay, cómo van de CPU y memoria, cuánto queda del cupo Always Free y
si a la cuenta le están cobrando algo.

PRINCIPIOS
----------
- **Sin dependencias.** Solo la librería estándar (ver `firma.py`). Corre igual
  en el portátil, en la VM y en el entorno efímero de Claude.
- **Solo lectura, por partida doble.** El usuario de API debe tener permisos de
  `inspect`/`read` en Oracle, y además aquí no existe ninguna herramienta que
  haga POST salvo las dos consultas que la API obliga a mandar por POST
  (métricas y costos). El comodín `oci_get` es GET y punto: no puede apagar,
  crear ni borrar nada aunque alguien se lo pida.
- **Los errores se cuentan, no se tragan.** Si una ruta cambió o falta un
  permiso, sale el código HTTP y el mensaje de Oracle. Un panel que miente
  «todo bien» es peor que no tenerlo.

CONFIGURACIÓN
-------------
Lee el `~/.oci/config` que entrega la consola de Oracle, o variables de entorno
si se prefiere (útil para meterlo en un servicio). Ver `README.md`.
"""

import configparser
import json
import os
import sys
import types
import urllib.parse
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import firma  # noqa: E402

VERSION = "1.0.0"

# Versiones de cada API de OCI. Van juntas y a la vista porque son lo único que
# puede envejecer: si Oracle publica una nueva, se cambia aquí y en ningún otro
# sitio. No se pudieron probar contra la API real desde el entorno donde se
# escribió esto (el proxy bloquea *.oraclecloud.com), así que si algo devuelve
# 404 el primer sospechoso es esta tabla.
API = {
    "compute": "20160918",    # iaas.{region}.oraclecloud.com
    "identity": "20160918",   # identity.{region}.oraclecloud.com
    "limits": "20181025",     # limits.{region}.oraclecloud.com
    "monitoring": "20180401", # telemetry.{region}.oraclecloud.com
    "usage": "20200107",      # usageapi.{region}.oci.oraclecloud.com
}

# Lo que Oracle regala de por vida en Always Free (cómputo). Está escrito aquí
# porque es la respuesta a «¿puedo crear otra VM gratis?» y se quiere contestar
# aunque la API de límites falle: basta contar lo que ya existe.
CUPO_GRATIS = {
    "VM.Standard.E2.1.Micro": {
        "maximo": 2, "unidad": "instancias",
        "nota": "AMD, 1/8 OCPU y 1 GB cada una. Es el shape de las VM actuales."},
    "VM.Standard.A1.Flex": {
        # Bajó de 4 OCPU/24 GB a esto — aviso de Oracle recibido el 2026-08-10.
        # Un límite Always Free no es una constante del universo: hay que
        # esperar que vuelva a moverse y no tratarlo como si no pudiera.
        "maximo_ocpu": 2, "maximo_gb": 12, "unidad": "OCPU y GB repartibles",
        "nota": "Ampere ARM. Se puede repartir en varias instancias más chicas."},
}


class ErrorConfig(Exception):
    """Falta configuración o está incompleta."""


# ---------------------------------------------------------------------------
#  Credenciales
# ---------------------------------------------------------------------------

def cargar_credenciales():
    """Lee la configuración de OCI del entorno o de `~/.oci/config`.

    Se admiten las dos vías a propósito: la consola de Oracle entrega un archivo
    `~/.oci/config` ya hecho (pegarlo y listo), pero un servicio o un contenedor
    se configura mejor con variables de entorno. Las variables mandan si están.
    """
    tenancy = os.environ.get("OCI_TENANCY")
    usuario = os.environ.get("OCI_USER")
    fingerprint = os.environ.get("OCI_FINGERPRINT")
    region = os.environ.get("OCI_REGION")
    pem = os.environ.get("OCI_KEY")
    archivo_llave = os.environ.get("OCI_KEY_FILE")
    compartimento = os.environ.get("OCI_COMPARTMENT")

    ruta = os.path.expanduser(os.environ.get("OCI_CONFIG_FILE", "~/.oci/config"))
    perfil = os.environ.get("OCI_PROFILE", "DEFAULT")
    existe = os.path.exists(ruta)

    if not (tenancy and usuario and fingerprint and region and (pem or archivo_llave)):
        if existe:
            # `utf-8-sig` porque el Bloc de notas de Windows guarda con BOM, y
            # con BOM configparser no reconoce ni el [DEFAULT] de la primera
            # línea: falla con «File contains no section headers», que no se
            # parece en nada a la causa. El editor por defecto de un sistema
            # entero no puede ser una trampa.
            cfg = configparser.ConfigParser(inline_comment_prefixes=("#",))
            cfg.read(ruta, encoding="utf-8-sig")
            if cfg.has_section(perfil) or perfil == "DEFAULT":
                sec = cfg[perfil] if cfg.has_section(perfil) else cfg.defaults()
                tenancy = tenancy or sec.get("tenancy")
                usuario = usuario or sec.get("user")
                fingerprint = fingerprint or sec.get("fingerprint")
                region = region or sec.get("region")
                archivo_llave = archivo_llave or sec.get("key_file")
                compartimento = compartimento or sec.get("compartment")

    faltan = [n for n, v in (("tenancy", tenancy), ("user", usuario),
                             ("fingerprint", fingerprint), ("region", region))
              if not v]
    if faltan:
        # El mensaje dice DÓNDE se buscó y si el archivo estaba. Sin eso, quien
        # tiene el config en otra carpeta se pone a revisar unas credenciales
        # que están perfectas, porque nada le indica que no se llegaron a leer.
        if not existe:
            raise ErrorConfig(
                f"No se encontró el archivo de configuración.\n\n"
                f"  Se buscó en : {ruta}\n"
                f"  Existe      : NO\n\n"
                "Si tu config está en otra carpeta, indícalo con la variable "
                "OCI_CONFIG_FILE. En PowerShell:\n"
                '  $env:OCI_CONFIG_FILE = "D:\\ruta\\a\\tu\\config"\n\n'
                "Ojo: esa variable solo dura mientras la ventana esté abierta. "
                "Si abriste otra, hay que volver a ponerla.\n"
                "También sirven OCI_TENANCY, OCI_USER, OCI_FINGERPRINT, "
                "OCI_REGION y OCI_KEY_FILE. Ver mcp/oracle/README.md.")
        raise ErrorConfig(
            f"El archivo de configuración se leyó pero le faltan datos: "
            f"{', '.join(faltan)}.\n\n"
            f"  Archivo : {ruta}\n"
            f"  Perfil  : [{perfil}]\n\n"
            "Revisa que el perfil tenga las cuatro líneas: tenancy, user, "
            "fingerprint y region. Ver mcp/oracle/README.md.")

    if not pem:
        if not archivo_llave:
            raise ErrorConfig("Falta la llave privada (OCI_KEY_FILE o key_file).")
        ruta_llave = os.path.expanduser(archivo_llave.strip())
        if not os.path.exists(ruta_llave):
            raise ErrorConfig(
                f"No existe el archivo de llave.\n\n"
                f"  key_file apunta a : {ruta_llave}\n"
                f"  Declarado en      : {ruta}\n\n"
                "Comprueba que la ruta sea la del .pem que descargaste de "
                "Oracle. En Windows va con la ruta completa, p. ej. "
                "key_file=D:\\carpeta\\oci_api_key.pem")
        with open(ruta_llave, "r", encoding="utf-8") as fh:
            pem = fh.read()

    n, d = firma.cargar_llave(pem)
    return types.SimpleNamespace(
        tenancy=tenancy, usuario=usuario, fingerprint=fingerprint,
        region=region, n=n, d=d,
        compartimento=compartimento or tenancy)


def url(servicio, cred, ruta, **query):
    """Arma la URL de un servicio de OCI para la región configurada."""
    hosts = {
        "compute": f"iaas.{cred.region}.oraclecloud.com",
        "identity": f"identity.{cred.region}.oraclecloud.com",
        "limits": f"limits.{cred.region}.oraclecloud.com",
        "monitoring": f"telemetry.{cred.region}.oraclecloud.com",
        # Ojo: facturación lleva `.oci.` en medio. No es una errata.
        "usage": f"usageapi.{cred.region}.oci.oraclecloud.com",
    }
    base = f"https://{hosts[servicio]}/{API[servicio]}{ruta}"
    limpio = {k: v for k, v in query.items() if v is not None}
    return f"{base}?{urllib.parse.urlencode(limpio)}" if limpio else base


# ---------------------------------------------------------------------------
#  Herramientas
# ---------------------------------------------------------------------------

def h_diagnostico(cred, args):
    """Comprueba que las credenciales sirven y describe la cuenta."""
    lineas = ["DIAGNÓSTICO DE LA CONEXIÓN CON ORACLE", ""]
    lineas.append(f"Región configurada : {cred.region}")
    lineas.append(f"Tenancy            : {cred.tenancy}")
    lineas.append(f"Usuario de API     : {cred.usuario}")
    lineas.append(f"Compartimento      : {cred.compartimento}")
    lineas.append("")

    # La llamada más barata que prueba credenciales de punta a punta: si la
    # firma o el reloj estuvieran mal, esto ya devuelve 401.
    datos = firma.peticion_firmada(
        cred, "GET", url("identity", cred, f"/tenancies/{cred.tenancy}"))
    lineas.append(f"Cuenta             : {datos.get('name', '?')}")
    lineas.append(f"Región de origen   : {datos.get('homeRegionKey', '?')}")
    lineas.append("→ Las credenciales funcionan y la firma es válida.")
    lineas.append("")

    try:
        ads = firma.peticion_firmada(
            cred, "GET",
            url("identity", cred, "/availabilityDomains",
                compartmentId=cred.tenancy))
        lineas.append("Dominios de disponibilidad:")
        for ad in ads:
            lineas.append(f"  · {ad.get('name')}")
    except firma.ErrorFirma as exc:
        lineas.append(f"No se pudieron leer los dominios: {exc}")
    lineas.append("")

    try:
        comps = firma.peticion_firmada(
            cred, "GET",
            url("identity", cred, "/compartments", compartmentId=cred.tenancy,
                compartmentIdInSubtree="true", accessLevel="ACCESSIBLE",
                limit="50"))
        activos = [c for c in comps if c.get("lifecycleState") == "ACTIVE"]
        lineas.append(f"Compartimentos accesibles ({len(activos)}):")
        lineas.append(f"  · (raíz) {cred.tenancy}")
        for c in activos:
            lineas.append(f"  · {c.get('name')} — {c.get('id')}")
        if activos:
            lineas.append("")
            lineas.append("Si una VM no aparece en `oci_instancias`, prueba con "
                          "el parámetro `compartimento` de la lista de arriba.")
    except firma.ErrorFirma as exc:
        lineas.append(f"No se pudieron listar los compartimentos: {exc}")

    return "\n".join(lineas)


def _ip_de_instancia(cred, compartimento, id_instancia):
    """Busca la IP pública y privada de una instancia por su VNIC."""
    try:
        adjuntos = firma.peticion_firmada(
            cred, "GET",
            url("compute", cred, "/vnicAttachments",
                compartmentId=compartimento, instanceId=id_instancia))
        for adj in adjuntos:
            if adj.get("lifecycleState") != "ATTACHED" or not adj.get("vnicId"):
                continue
            vnic = firma.peticion_firmada(
                cred, "GET", url("compute", cred, f"/vnics/{adj['vnicId']}"))
            return vnic.get("publicIp"), vnic.get("privateIp")
    except firma.ErrorFirma:
        pass  # Sin IP se sigue: es un adorno, no el dato que se vino a buscar.
    return None, None


def _listar_instancias(cred, compartimento):
    datos = firma.peticion_firmada(
        cred, "GET",
        url("compute", cred, "/instances", compartmentId=compartimento,
            limit="100"))
    return [i for i in datos if i.get("lifecycleState") != "TERMINATED"]


def h_instancias(cred, args):
    """Lista las VM con su shape, estado, recursos e IPs."""
    compartimento = args.get("compartimento") or cred.compartimento
    con_ips = args.get("con_ips", True)
    instancias = _listar_instancias(cred, compartimento)

    if not instancias:
        return ("No hay instancias vivas en este compartimento.\n"
                f"Compartimento consultado: {compartimento}\n"
                "Si esperabas ver las VM, corre `oci_diagnostico` para ver "
                "en qué compartimentos buscar.")

    lineas = [f"INSTANCIAS ({len(instancias)} vivas)", ""]
    for inst in instancias:
        cfg = inst.get("shapeConfig") or {}
        ocpu = cfg.get("ocpus")
        memoria = cfg.get("memoryInGBs")
        estado = inst.get("lifecycleState")
        marca = {"RUNNING": "●", "STOPPED": "○"}.get(estado, "◐")
        lineas.append(f"{marca} {inst.get('displayName')}  [{estado}]")
        lineas.append(f"    shape   : {inst.get('shape')}"
                      + (f"  ({ocpu} OCPU, {memoria} GB)" if ocpu else ""))
        lineas.append(f"    zona    : {inst.get('availabilityDomain')}")
        lineas.append(f"    creada  : {(inst.get('timeCreated') or '')[:10]}")
        if con_ips:
            publica, privada = _ip_de_instancia(cred, compartimento, inst["id"])
            if publica or privada:
                lineas.append(f"    IP      : pública {publica or '—'}"
                              f"  ·  privada {privada or '—'}")
        lineas.append(f"    id      : {inst.get('id')}")
        lineas.append("")

    lineas.append("El id sirve para `oci_metricas`.")
    return "\n".join(lineas)


def h_cupo_gratis(cred, args):
    """Responde si cabe otra VM gratis, contando lo que ya existe."""
    compartimento = args.get("compartimento") or cred.compartimento
    instancias = _listar_instancias(cred, compartimento)

    micros = [i for i in instancias if i.get("shape") == "VM.Standard.E2.1.Micro"]
    a1 = [i for i in instancias if "A1.Flex" in (i.get("shape") or "")]
    a1_ocpu = sum((i.get("shapeConfig") or {}).get("ocpus") or 0 for i in a1)
    a1_gb = sum((i.get("shapeConfig") or {}).get("memoryInGBs") or 0 for i in a1)

    otras = [i for i in instancias
             if i not in micros and i not in a1]

    lineas = ["CUPO ALWAYS FREE (cómputo)", ""]

    tope_micro = CUPO_GRATIS["VM.Standard.E2.1.Micro"]["maximo"]
    lineas.append(f"AMD  VM.Standard.E2.1.Micro : {len(micros)} de {tope_micro}")
    for i in micros:
        lineas.append(f"    · {i.get('displayName')} [{i.get('lifecycleState')}]")
    libres_micro = tope_micro - len(micros)
    lineas.append("    → " + ("CUPO LLENO: no cabe otra micro gratis."
                              if libres_micro <= 0
                              else f"Quedan {libres_micro} gratis."))
    lineas.append("")

    tope_ocpu = CUPO_GRATIS["VM.Standard.A1.Flex"]["maximo_ocpu"]
    tope_gb = CUPO_GRATIS["VM.Standard.A1.Flex"]["maximo_gb"]
    lineas.append(f"ARM  VM.Standard.A1.Flex    : {a1_ocpu:g} de {tope_ocpu} OCPU"
                  f"  ·  {a1_gb:g} de {tope_gb} GB   ({len(a1)} instancias)")
    for i in a1:
        cfg = i.get("shapeConfig") or {}
        lineas.append(f"    · {i.get('displayName')} "
                      f"({cfg.get('ocpus')} OCPU, {cfg.get('memoryInGBs')} GB)")
    if a1_ocpu < tope_ocpu:
        lineas.append(f"    → Caben {tope_ocpu - a1_ocpu:g} OCPU y "
                      f"{tope_gb - a1_gb:g} GB más, gratis. Es ARM: el binario "
                      "del bridge hay que compilarlo para esa arquitectura.")
    else:
        lineas.append("    → CUPO LLENO.")
    lineas.append("")

    if otras:
        lineas.append("FUERA DE ALWAYS FREE (esto sí se factura):")
        for i in otras:
            lineas.append(f"    · {i.get('displayName')} — {i.get('shape')} "
                          f"[{i.get('lifecycleState')}]")
        lineas.append("")

    # La API de límites es la versión de Oracle de lo mismo. Va después y en un
    # try: si su ruta cambió, la respuesta de arriba —que sale de contar lo que
    # existe— sigue siendo válida.
    lineas.append("Contraste con los límites que declara Oracle:")
    for nombre in ("vm-standard-e2-1-micro-count", "standard-a1-core-count"):
        try:
            datos = firma.peticion_firmada(
                cred, "GET",
                url("limits", cred, f"/resourceAvailability/compute/{nombre}",
                    compartmentId=cred.tenancy))
            lineas.append(f"  · {nombre}: usados {datos.get('used')}, "
                          f"disponibles {datos.get('available')}")
        except firma.ErrorFirma as exc:
            primera = str(exc).splitlines()[0]
            lineas.append(f"  · {nombre}: no se pudo consultar ({primera})")
    lineas.append("")
    lineas.append("Nota: el cupo de arriba es el que Oracle publica para Always "
                  "Free. Los recursos Always Free no caducan, pero Oracle puede "
                  "reclamar los que lleven mucho tiempo inactivos.")
    return "\n".join(lineas)


def h_metricas(cred, args):
    """CPU y memoria de una instancia (o de todas) en las últimas N horas."""
    compartimento = args.get("compartimento") or cred.compartimento
    horas = int(args.get("horas") or 6)
    id_instancia = args.get("id_instancia")

    fin = datetime.now(timezone.utc).replace(microsecond=0)
    inicio = fin - timedelta(hours=horas)

    filtro = f'{{resourceId = "{id_instancia}"}}' if id_instancia else ""
    lineas = [f"MÉTRICAS de las últimas {horas} h "
              f"({inicio.strftime('%d/%m %H:%M')} → {fin.strftime('%H:%M')} UTC)", ""]

    for metrica, etiqueta, unidad in (
            ("CpuUtilization", "CPU", "%"),
            ("MemoryUtilization", "Memoria", "%"),
            ("NetworksBytesOut", "Red saliente", "bytes/min")):
        cuerpo = {
            "namespace": "oci_computeagent",
            "query": f"{metrica}[5m]{filtro}.mean()",
            "startTime": inicio.isoformat().replace("+00:00", "Z"),
            "endTime": fin.isoformat().replace("+00:00", "Z"),
        }
        try:
            datos = firma.peticion_firmada(
                cred, "POST",
                url("monitoring", cred, "/metrics/actions/summarizeMetricsData",
                    compartmentId=compartimento),
                cuerpo=cuerpo)
        except firma.ErrorFirma as exc:
            lineas.append(f"{etiqueta}: no se pudo consultar")
            lineas.append(f"  {str(exc).splitlines()[0]}")
            lineas.append("")
            continue

        if not datos:
            lineas.append(f"{etiqueta}: sin datos.")
            continue

        for serie in datos:
            puntos = [p.get("value") for p in serie.get("aggregatedDatapoints", [])
                      if p.get("value") is not None]
            nombre = (serie.get("dimensions") or {}).get(
                "resourceDisplayName", serie.get("resourceId", "?"))
            if not puntos:
                lineas.append(f"{etiqueta} · {nombre}: sin puntos.")
                continue
            lineas.append(
                f"{etiqueta} · {nombre}: ahora {puntos[-1]:.1f}{unidad}  "
                f"· media {sum(puntos)/len(puntos):.1f}  "
                f"· máx {max(puntos):.1f}  ({len(puntos)} puntos)")
        lineas.append("")

    lineas.append(
        "Si sale «sin datos», casi siempre es que la instancia no tiene "
        "habilitado el plugin de Monitoring del Compute Agent: se enciende en "
        "la consola, en la propia instancia → Oracle Cloud Agent.")
    return "\n".join(lineas)


def h_costos(cred, args):
    """Cuánto lleva facturado la cuenta este mes. Responde al susto del correo."""
    hoy = datetime.now(timezone.utc)
    inicio = hoy.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    fin = (inicio + timedelta(days=32)).replace(day=1)

    cuerpo = {
        "tenantId": cred.tenancy,
        "timeUsageStarted": inicio.strftime("%Y-%m-%dT00:00:00Z"),
        "timeUsageEnded": fin.strftime("%Y-%m-%dT00:00:00Z"),
        "granularity": "MONTHLY",
        "queryType": "COST",
    }
    datos = firma.peticion_firmada(
        cred, "POST", url("usage", cred, "/usage"), cuerpo=cuerpo)

    items = datos.get("items", [])
    total = sum(i.get("computedAmount") or 0 for i in items)
    moneda = next((i.get("currency") for i in items if i.get("currency")), "USD")

    lineas = [f"COSTO DEL MES ({inicio.strftime('%B %Y')})", ""]
    lineas.append(f"Total facturado: {total:.2f} {moneda}")
    lineas.append("")
    if total == 0:
        lineas.append("Cero: todo lo que corre está dentro de Always Free.")
    else:
        lineas.append("Hay consumo facturable. Detalle:")
        for i in items:
            monto = i.get("computedAmount") or 0
            if monto:
                lineas.append(f"  · {i.get('service', '?')}: {monto:.2f} {moneda}")
    return "\n".join(lineas)


def h_get(cred, args):
    """GET firmado a cualquier ruta de OCI. El comodín para lo no previsto."""
    servicio = args.get("servicio")
    ruta = args.get("ruta")
    if servicio not in API:
        raise ErrorConfig(f"Servicio desconocido: {servicio}. "
                          f"Válidos: {', '.join(sorted(API))}")
    if not ruta or not ruta.startswith("/"):
        raise ErrorConfig("La ruta debe empezar por '/', p. ej. '/instances'.")

    query = dict(args.get("query") or {})
    query.setdefault("compartmentId", cred.compartimento)
    destino = url(servicio, cred, ruta, **query)
    datos = firma.peticion_firmada(cred, "GET", destino)
    return f"GET {destino}\n\n{json.dumps(datos, indent=2, ensure_ascii=False)[:12000]}"


HERRAMIENTAS = [
    {
        "name": "oci_diagnostico",
        "description": (
            "Comprueba que las credenciales de Oracle funcionan y describe la "
            "cuenta: región, dominios de disponibilidad y compartimentos "
            "accesibles. Es lo primero que hay que correr al configurar, y lo "
            "primero que hay que mirar si otra herramienta no encuentra las VM."),
        "handler": h_diagnostico,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "oci_instancias",
        "description": (
            "Lista las máquinas virtuales con su shape, estado (encendida o "
            "apagada), OCPU, memoria, fecha de creación e IPs pública y privada. "
            "Úsala para saber qué VM existen y si están corriendo."),
        "handler": h_instancias,
        "inputSchema": {
            "type": "object",
            "properties": {
                "compartimento": {
                    "type": "string",
                    "description": "OCID del compartimento. Por defecto, la raíz."},
                "con_ips": {
                    "type": "boolean",
                    "description": "Buscar las IPs (una llamada más por VM). Por defecto sí."},
            },
        },
    },
    {
        "name": "oci_cupo_gratis",
        "description": (
            "Dice cuánto queda del cupo Always Free de cómputo y si cabe crear "
            "otra VM gratis: cuántas VM.Standard.E2.1.Micro (AMD, tope 2) y "
            "cuántas OCPU/GB de Ampere A1 (ARM, tope 2 OCPU y 12 GB) están en "
            "uso. Avisa además si hay alguna instancia fuera de Always Free, "
            "que es lo que genera cobro."),
        "handler": h_cupo_gratis,
        "inputSchema": {
            "type": "object",
            "properties": {
                "compartimento": {
                    "type": "string",
                    "description": "OCID del compartimento. Por defecto, la raíz."},
            },
        },
    },
    {
        "name": "oci_metricas",
        "description": (
            "Uso real de CPU, memoria y red de las instancias en las últimas "
            "horas. Requiere que la instancia tenga encendido el plugin de "
            "Monitoring del Oracle Cloud Agent."),
        "handler": h_metricas,
        "inputSchema": {
            "type": "object",
            "properties": {
                "id_instancia": {
                    "type": "string",
                    "description": "OCID de una instancia. Si se omite, todas."},
                "horas": {
                    "type": "integer",
                    "description": "Ventana hacia atrás en horas (por defecto 6)."},
                "compartimento": {"type": "string"},
            },
        },
    },
    {
        "name": "oci_costos",
        "description": (
            "Cuánto lleva facturado la cuenta en el mes en curso. Si da cero, "
            "todo lo que corre está dentro de Always Free y no hay cobro."),
        "handler": h_costos,
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "oci_get",
        "description": (
            "GET firmado contra cualquier ruta de la API de OCI, para consultar "
            "algo que las demás herramientas no cubren. Solo lectura: no puede "
            "crear, modificar ni apagar nada."),
        "handler": h_get,
        "inputSchema": {
            "type": "object",
            "properties": {
                "servicio": {
                    "type": "string",
                    "enum": sorted(API),
                    "description": "Qué API: compute, identity, limits, monitoring o usage."},
                "ruta": {
                    "type": "string",
                    "description": "Ruta tras la versión, p. ej. '/instances' o '/shapes'."},
                "query": {
                    "type": "object",
                    "description": "Parámetros de query. compartmentId se pone solo."},
            },
            "required": ["servicio", "ruta"],
        },
    },
]


# ---------------------------------------------------------------------------
#  Protocolo MCP (JSON-RPC 2.0 por stdin/stdout, un mensaje por línea)
# ---------------------------------------------------------------------------

def log(mensaje):
    """Los diagnósticos van a stderr SIEMPRE.

    stdout es el canal del protocolo: un `print` suelto ahí corrompe el JSON-RPC
    y el cliente desconecta el servidor sin decir por qué.
    """
    print(mensaje, file=sys.stderr, flush=True)


def responder(id_msg, resultado=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_msg}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = resultado
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def atender(mensaje, estado):
    metodo = mensaje.get("method")
    id_msg = mensaje.get("id")

    # Las notificaciones no llevan id y no se contestan.
    if id_msg is None:
        return

    if metodo == "initialize":
        pedida = (mensaje.get("params") or {}).get("protocolVersion")
        responder(id_msg, {
            "protocolVersion": pedida or "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "oracle-nexus", "version": VERSION},
        })
        return

    if metodo == "ping":
        responder(id_msg, {})
        return

    if metodo == "tools/list":
        responder(id_msg, {"tools": [
            {k: h[k] for k in ("name", "description", "inputSchema")}
            for h in HERRAMIENTAS]})
        return

    if metodo == "tools/call":
        params = mensaje.get("params") or {}
        nombre = params.get("name")
        args = params.get("arguments") or {}
        herramienta = next((h for h in HERRAMIENTAS if h["name"] == nombre), None)
        if herramienta is None:
            responder(id_msg, error={"code": -32602,
                                     "message": f"Herramienta desconocida: {nombre}"})
            return
        try:
            if estado.get("cred") is None:
                estado["cred"] = cargar_credenciales()
            texto = herramienta["handler"](estado["cred"], args)
            responder(id_msg, {"content": [{"type": "text", "text": texto}]})
        except (ErrorConfig, firma.ErrorFirma) as exc:
            # Errores esperables (configuración, permisos, red): se devuelven
            # como resultado y no como error de protocolo, para que el mensaje
            # llegue entero a quien pueda arreglarlo.
            responder(id_msg, {"content": [{"type": "text", "text": f"ERROR\n\n{exc}"}],
                               "isError": True})
        except Exception as exc:  # noqa: BLE001
            log(f"fallo inesperado en {nombre}: {exc!r}")
            responder(id_msg, {"content": [{"type": "text",
                                            "text": f"ERROR inesperado: {exc!r}"}],
                               "isError": True})
        return

    responder(id_msg, error={"code": -32601, "message": f"Método no soportado: {metodo}"})


def main():
    estado = {"cred": None}
    log(f"servidor MCP de Oracle v{VERSION} en marcha")
    for linea in sys.stdin:
        linea = linea.strip()
        if not linea:
            continue
        try:
            mensaje = json.loads(linea)
        except json.JSONDecodeError:
            log(f"línea que no es JSON, se ignora: {linea[:120]}")
            continue
        try:
            atender(mensaje, estado)
        except Exception as exc:  # noqa: BLE001
            log(f"error atendiendo {mensaje.get('method')}: {exc!r}")
            if mensaje.get("id") is not None:
                responder(mensaje.get("id"),
                          error={"code": -32603, "message": repr(exc)})


if __name__ == "__main__":
    main()
