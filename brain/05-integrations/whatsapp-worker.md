# Worker de WhatsApp

## Alcance

El worker de envíos no vive en este repositorio. Corre como proyecto/proceso separado en Oracle Cloud. Este documento conserva únicamente el contrato y las invariantes que Nexus FTDs necesita conocer para programar y diagnosticar envíos.

Si esta documentación contradice el estado verificado de Supabase o de la VM, manda el estado real.

## Flujo

```text
Nexus FTDs
  -> mensajes_programados (Supabase)
  -> worker Python
  -> agrupación por owner_id
  -> canal_wa del owner
  -> host + puerto
  -> bridge WhatsApp
  -> destinatario
```

## Ejecución

Históricamente el worker opera como servicio systemd `nexus-worker` en Oracle Cloud y revisa periódicamente mensajes `pendiente` cuyo `enviar_en` ya venció.

No asumir datos de infraestructura estáticos —IP, bridges activos, nombres y hosts cambian— sin verificarlos cuando la tarea sea operativa.

## Un solo consumidor

La cola no fue diseñada originalmente con mecanismo de lease/reclamo por mensaje. Ejecutar dos workers sobre la misma cola puede duplicar envíos. No levantar una segunda instancia del consumidor como arreglo improvisado.

## Paralelismo

El worker procesa por agente. La independencia entre agentes existe para que un volumen grande de un usuario no bloquee a los demás.

El ritmo y los límites deben aplicarse por agente cuando esa sea la intención de negocio; no convertir accidentalmente un límite local en cuello de botella global.

## Enrutamiento

**La identidad del bridge se resuelve por `owner_id`.**

Nunca usar únicamente el puerto como identificador global. Un puerto solo identifica un endpoint dentro de un host; dejó de ser único cuando aparecieron varias máquinas.

El worker debe resolver:

```text
owner_id -> host + puerto
```

Si no puede resolver el host/canal correcto, debe fallar cerrado y no caer silenciosamente a otro bridge.

## Defensa adicional de puertos

Existe/ha existido una restricción de unicidad de puerto como cinturón adicional frente a regresiones de enrutamiento. Aunque `owner_id` sea la identidad correcta, no retirar esa protección sin auditar el worker real y valorar el riesgo.

## Canales

`canales_wa` contiene el vínculo entre dueño y bridge, incluido estado y ubicación. Para diagnósticos, leer el estado actual de la tabla; una tabla copiada en documentación puede quedar obsoleta.

Un mensaje nunca debe salir por el canal de otro owner cuando el canal esperado esté caído.

## Multimedia

El worker resuelve recursos al enviar según su implementación vigente. Históricamente:

- el `worker.py` es **agnóstico al tipo**: baja el archivo a un temporal conservando la extensión de la URL y le pasa la ruta al bridge. Quien decide si algo va como imagen, video, nota de voz o documento es el **bridge**, y lo decide por la **extensión**;
- imágenes están soportadas;
- video (`mp4`, `mov`) funciona de extremo a extremo desde el 20/08/2026, comprobado en teléfono. El worker distingue audio de video con `ffprobe` cuando la extensión es ambigua;
- `webm` no tiene rama y cae en `DocumentMessage`, lo que probablemente explica el defecto de las notas de voz;
- notas de voz han tenido restricciones de reproducción.

No habilitar una capacidad de frontend porque el formulario la acepte si el worker no sabe entregarla correctamente.

## Dónde vive de verdad (verificado 20/08/2026)

- VM: `ubuntu@141.148.40.31`, llave `~/.ssh/nexus_oracle`;
- worker: servicio `nexus-worker` en `/home/ubuntu/nexus-worker`;
- bridges: un servicio por agente con plantilla `nexus-bridge@<slug>`, directorio por agente en `/home/ubuntu/nexus-bridges/<slug>` y `provisionar.sh` para dar de alta uno nuevo (tiene guardia anti-duplicados por owner y por puerto);
- **los nueve bridges comparten un único ejecutable**: `/home/ubuntu/whatsapp-mcp/whatsapp-bridge/whatsapp-bridge-mt`. Cambiarlo los afecta a todos y exige recompilar y reiniciar los nueve servicios;
- la copia de `whatsapp-mcp` que hay en WSL es de desarrollo y **no** es la que corre en producción; no confundirlas al leer código.

## Tope diario y zona horaria

Existe antecedente de un defecto donde el tope diario se calculaba con el día UTC. En Colombia la medianoche UTC ocurre a las 19:00, por lo que consumos nocturnos podían contarse contra el día siguiente y bloquear invitaciones legítimas.

Antes de tocar límites diarios, verificar cómo calcula actualmente la fecha el `worker.py` real. No asumir que el defecto sigue abierto ni que ya fue corregido sin comprobar la VM.

## MCP Oracle

El repositorio define un servidor MCP local en `.mcp.json`:

```text
python3 mcp/oracle/servidor.py
```

El brain describe el sistema. El MCP sirve para verificar/operar la infraestructura. No confundir memoria con estado en vivo.

## Fuente histórica

`contexto-worker.md` conserva contexto detallado anterior. Debe tratarse como documentación histórica hasta verificar los puntos operativos variables.

## Relacionado

- [[../03-domain/messaging-rules]]
- [[../08-memory/dangerous-patterns]]
- [[../08-memory/known-issues]]