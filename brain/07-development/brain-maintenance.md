# Mantenimiento del brain

## Objetivo

El brain debe reducir reconstrucción de contexto, no convertirse en otro `CLAUDE.md` gigante repartido en carpetas.

La métrica conceptual es **densidad de conocimiento útil**, no cantidad de notas.

## Cuándo actualizar

Actualizar un documento existente cuando cambie:

- regla de negocio;
- contrato de datos;
- arquitectura;
- autorización/RLS;
- integración externa;
- fuente de verdad;
- comportamiento que no es obvio leyendo un único archivo;
- causa de un incidente que puede repetirse;
- estado funcional relevante y relativamente estable.

## Cuándo no actualizar

No documentar automáticamente:

- cambios de formato;
- nombres triviales;
- logs;
- experimentos descartados;
- código que se entiende directamente en pocos segundos;
- cada commit o sesión;
- estado operativo que puede cambiar mañana si existe una fuente viva mejor.

## Promover, no copiar

Cuando una sesión descubre conocimiento nuevo:

1. identificar su naturaleza;
2. llevarlo al documento canónico correcto;
3. reemplazar historia larga por una regla compacta y su razón;
4. referenciar archivos/SQL en vez de copiar código;
5. enlazar otras notas solo si la relación ayuda a recuperar contexto.

No pegar conversaciones completas dentro del brain.

## Estados temporales

Un defecto que puede resolverse pronto vive en `08-memory/known-issues.md`.

Cuando se cierre:

- retirarlo de `known-issues.md`;
- conservar solo la lección permanente si evita regresión;
- llevar esa lección a `dangerous-patterns.md`, `database-security-traps.md` o una decisión.

Así Claude no diagnostica bugs fantasma meses después.

## Decisiones

Una decisión merece registro cuando tiene alternativas razonables y volver a discutirla sin contexto costaría tiempo o riesgo.

Una decisión debe expresar:

- contexto;
- decisión;
- por qué;
- alternativas rechazadas si importan;
- condición bajo la cual se revisaría.

No crear ADR para cada detalle de implementación.

## Referencias a código

Preferir:

`Principal: public/js/seguimiento.js`

sobre copiar bloques completos.

Si la lógica cambia, la referencia sigue llevando al código vigente; una copia de código dentro de Markdown se vuelve una segunda versión obsoleta.

## Auditoría periódica

Cuando el brain crezca, revisar:

1. notas sin enlaces ni uso claro;
2. reglas duplicadas;
3. asuntos conocidos ya resueltos;
4. referencias a archivos que ya no existen;
5. descripciones que contradicen producción/código;
6. documentos demasiado grandes que mezclan dominios diferentes.

Dividir solo cuando una separación permita que Claude evite leer contexto no relacionado.

## Protocolo al terminar una tarea

Preguntar internamente:

> ¿Aprendimos algo persistente que una sesión futura tendría que redescubrir de forma costosa o peligrosa?

Si no, no tocar el brain.

Si sí:

1. localizar el documento canónico mediante `00-index.md`;
2. editar el mínimo necesario;
3. actualizar enlaces/rutas si cambió el mapa;
4. comprobar que no se duplicó la regla en otro lugar.

## Legacy

El `CLAUDE.md` histórico no se carga por defecto.

Si aparece una laguna:

1. recuperar la versión antigua desde Git;
2. verificar la regla contra código/producción;
3. promoverla a un documento modular;
4. no volver a inflar `CLAUDE.md`.

## Relacionado

- [[../00-index]]
- [[../08-memory/known-issues]]
- [[../08-memory/dangerous-patterns]]
- [[../06-decisions/index]]