# MCP Oracle

## Propósito

El repositorio contiene `mcp/oracle/`, un servidor MCP de **solo lectura** para consultar Oracle Cloud Infrastructure sin abrir manualmente la consola.

Configuración del proyecto:

`.mcp.json`

lanza:

`python3 mcp/oracle/servidor.py`

La documentación de instalación y permisos vive en `mcp/oracle/README.md`.

## Separación de responsabilidades

El brain documenta cómo funciona la infraestructura y qué invariantes conocemos.

El MCP sirve para verificar el estado real cuando una pregunta depende de datos vivos de Oracle.

No convertir una observación devuelta por el MCP en memoria permanente si es solo estado temporal de una VM.

## Solo lectura por dos capas

La intención de solo lectura no depende únicamente de que el servidor MCP exponga herramientas de consulta.

La política/usuario de OCI utilizado debe tener permisos de observación (`inspect`/`read`) y no permisos generales de mutación. Esta es la frontera principal; la ausencia de herramientas de escritura en el MCP es una segunda defensa.

## Implementación deliberadamente liviana

El servidor evita depender del SDK `oci` para no cargar una dependencia grande en cada entorno efímero donde se ejecute Claude Code.

La firma de solicitudes se implementa con primitivas disponibles en Python y se validó históricamente contra una implementación criptográfica independiente.

No reemplazar esta decisión por una dependencia grande sin medir el beneficio y el costo operativo.

## Restricción de red

El hecho de que el MCP funcione localmente no garantiza que un entorno remoto de Claude pueda llegar a `*.oraclecloud.com`. La política de red del entorno puede bloquear esos hosts.

Cuando falle una consulta:

1. distinguir autenticación/firma de conectividad;
2. comprobar acceso de red al dominio;
3. revisar versiones/rutas de API si aparece 404;
4. no asumir automáticamente que las credenciales están dañadas.

## APIs y versiones

Las versiones/rutas de OCI pueden cambiar. La implementación concentra esas rutas en la constante correspondiente del servidor.

Ante un 404 de OCI, revisar primero la ruta/API antes de reescribir la lógica general.

## Capacidad Always Free

La capacidad disponible es información temporal de la cuenta. Consultarla en vivo cuando sea relevante.

No guardar en este brain cantidades actuales de instancias, OCPU o RAM como una garantía permanente: Oracle puede cambiar los límites y la cuenta puede cambiar de recursos.

## Seguridad de llaves

`.gitignore` protege patrones como:

- `*.pem`
- `*.key`
- `oci_api_key*`
- `.oci/`

No mover llaves privadas al brain ni a documentación versionada.

## Relacionado

- [[whatsapp-worker]]
- `../../mcp/oracle/README.md`
- `../../.mcp.json`