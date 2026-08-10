# Mirar las VM de Oracle desde Claude

Servidor MCP de **solo lectura** contra la API de Oracle Cloud. Sirve para
preguntar en lenguaje normal «¿cómo van las VM?», «¿cuánto queda del cupo
gratis?», «¿me están cobrando algo?» y que la respuesta salga de la cuenta real,
no de un documento que envejece.

| Herramienta | Para qué |
|---|---|
| `oci_diagnostico` | Comprueba credenciales y lista región, zonas y compartimentos. **Es lo primero que hay que correr.** |
| `oci_instancias` | Qué VM hay: shape, encendida o apagada, OCPU, RAM, IP pública y privada |
| `oci_cupo_gratis` | Cuánto queda de Always Free y si cabe otra VM gratis |
| `oci_metricas` | CPU, memoria y red de las últimas horas |
| `oci_costos` | Cuánto lleva facturado la cuenta este mes |
| `oci_get` | GET firmado a cualquier ruta, para lo que no cubran las demás |

---

## Puesta en marcha

### 1. Crear un usuario de API de SOLO LECTURA

**No uses tu usuario de administrador.** Estas credenciales van a vivir en un
archivo; si algún día se filtran, que lo único que permitan sea mirar.

En la consola de Oracle (`cloud.oracle.com`):

1. **Identity & Security → Domains → Default domain → Users → Create user**
   Nombre: `claude-lectura`. Sin contraseña de consola.
2. **Groups → Create group**: `observadores`. Mete a `claude-lectura` dentro.
3. **Identity & Security → Policies → Create policy**, en el compartimento raíz.
   Estas tres reglas dan lectura y **nada más**:

   ```
   Allow group observadores to inspect all-resources in tenancy
   Allow group observadores to read instances in tenancy
   Allow group observadores to read metrics in tenancy
   ```

   Si además quieres que responda `oci_costos`, añade:

   ```
   Allow group observadores to read usage-report in tenancy
   ```

   `inspect` y `read` no permiten crear, apagar ni borrar. Es el límite de
   verdad: lo que impide un accidente no es este código, es la política.

4. Entra al usuario `claude-lectura` → **API keys → Add API key → Generate API
   key pair** → **descarga la llave privada** y pulsa Add.
5. Oracle muestra entonces un recuadro de configuración. **Cópialo**: trae el
   `tenancy`, el `user`, el `fingerprint` y la `region` ya escritos.

### 2. Dejar la configuración donde el servidor la encuentre

La vía cómoda es el archivo que la propia consola te dio:

```bash
mkdir -p ~/.oci
chmod 700 ~/.oci
nano ~/.oci/config          # pega aquí el recuadro de la consola
mv ~/Descargas/*.pem ~/.oci/oci_api_key.pem
chmod 600 ~/.oci/oci_api_key.pem
```

El archivo queda así (el `key_file` apunta a la llave descargada):

```ini
[DEFAULT]
user=ocid1.user.oc1..xxxx
fingerprint=aa:bb:cc:dd:...
tenancy=ocid1.tenancy.oc1..xxxx
region=sa-saopaulo-1
key_file=~/.oci/oci_api_key.pem
```

La otra vía, para meterlo en un servicio o un contenedor, son variables de
entorno: `OCI_TENANCY`, `OCI_USER`, `OCI_FINGERPRINT`, `OCI_REGION` y
`OCI_KEY_FILE` (o `OCI_KEY` con el PEM entero). Si están, mandan sobre el
archivo.

**La llave privada nunca entra al repo.** El `.gitignore` rechaza `*.pem`,
`*.key` y `.oci/` justo para eso.

### 3. Probar

```bash
python3 mcp/oracle/prueba_firma.py     # la firma (necesita `cryptography`)
python3 mcp/oracle/prueba_servidor.py  # protocolo MCP y herramientas
```

Con eso listo, en Claude Code el servidor arranca solo: está declarado en el
`.mcp.json` de la raíz del repo. Pide `oci_diagnostico` y debería contestar con
el nombre de tu cuenta.

---

## El servidor tiene que correr donde haya salida a Oracle

Esto es lo que decide dónde vive, y conviene tenerlo claro antes de pelearse con
un error de red:

- **Claude Code en tu portátil (app o terminal):** funciona directo. Es el sitio
  natural.
- **Claude Code en la web (el entorno remoto):** **hoy no funciona.** La
  política de red de este entorno bloquea `*.oraclecloud.com`: el proxy contesta
  403 al CONNECT. No es un fallo del código —se comprobó— y no se arregla desde
  aquí: hay que permitir ese dominio en la política de red del entorno, o correr
  el servidor desde el portátil.
- **En la VM:** funciona, pero solo tiene sentido si algún día quieres que un
  proceso de allá consulte esto.

## Qué NO puede hacer

- **Nada que escriba.** No hay ninguna herramienta que cree, modifique, apague o
  borre. `oci_get` es GET por construcción.
- **Ver métricas de una VM sin el agente.** Si `oci_metricas` sale vacío, casi
  siempre es que a la instancia le falta el plugin de Monitoring del Oracle
  Cloud Agent (se enciende en la consola, en la propia instancia).
- **Saber nada del bridge de WhatsApp.** Esto mira la infraestructura de Oracle:
  si la VM está viva y cuántos recursos usa. El estado de los canales sigue
  estando en `canales_wa` (Supabase), y el detalle operativo en
  `contexto-worker.md`.

## Si algo falla

| Síntoma | Causa habitual |
|---|---|
| `401 NotAuthenticated` | El reloj de la máquina está desfasado más de 5 min, o el fingerprint no corresponde a la llave |
| `404 NotAuthorizedOrNotFound` | Casi siempre es permiso que falta, no ruta mal: Oracle devuelve 404 para no revelar qué existe |
| `403` del proxy | El entorno bloquea `*.oraclecloud.com` (ver arriba) |
| No aparecen las VM | Están en otro compartimento: mira los que lista `oci_diagnostico` y pásalo en `compartimento` |
| Una ruta devuelve 404 real | Las versiones de cada API están juntas en la constante `API` de `servidor.py`. No se pudieron probar contra Oracle desde donde se escribió esto; `oci_get` sirve para tantear la correcta |

## Cómo está hecho

- `firma.py` — firma RSA-SHA256 de las peticiones, **solo con la librería
  estándar**. El SDK oficial de Oracle pesa 36 MB y obliga a un `pip install` en
  cada máquina; aquí no hace falta instalar nada.
- `servidor.py` — protocolo MCP (JSON-RPC por stdin/stdout) y las seis
  herramientas.
- `prueba_firma.py` — firma con la implementación propia y **verifica con
  `cryptography`**, que es código de otra gente. Es la forma de comprobar la
  firma sin poder llamar a Oracle.
- `prueba_servidor.py` — lanza el servidor de verdad como subproceso y le habla
  por stdin/stdout, y prueba las herramientas con respuestas enlatadas.
