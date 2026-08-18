# Memoria legacy

El `CLAUDE.md` monolítico anterior a esta migración no se copia dentro del brain porque hacerlo duplicaría decenas de KB y frustraría el objetivo de reducir contexto.

## Fuente preservada

El contenido completo permanece en el historial Git y en la rama `main` anterior a la migración.

Blob conocido durante la migración:

```text
a8c887b6650505335204cc4ebe2ef8648656340a
```

Para auditar una regla que parezca ausente, consultar la versión histórica de `CLAUDE.md`, clasificar la información y migrarla al documento modular correcto. No volver a inflar el `CLAUDE.md` raíz.

## Regla

La documentación legacy sirve para recuperar contexto perdido, no como fuente principal. Si contradice código actual, estado de producción o decisiones vigentes, manda la fuente superior indicada en `brain/00-index.md`.