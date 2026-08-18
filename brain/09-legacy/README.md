# Memoria legacy

El `CLAUDE.md` monolítico anterior fue reemplazado por una memoria modular en la rama de migración del brain.

La versión anterior sigue íntegra en el historial Git de `main` anterior a esta migración; no se copia dentro de `brain/` porque hacerlo volvería a introducir decenas de KB de contexto duplicado.

## Auditoría inicial

En la segunda auditoría se promovieron al brain, entre otros, estos bloques que aún estaban demasiado resumidos:

- autenticación, aprobación y recuperación;
- invitaciones específicas y precedencia de textos;
- asistencia que no retrocede y revisión de días pasados;
- segmentos/historial reutilizable;
- FTD, ventas, abonos, upgrades y zooms;
- salud de canales;
- medios adjuntos;
- MCP Oracle;
- trampas de RLS/Postgres;
- trampas de CSS/harnesses;
- pendientes conocidos.

Esto reduce considerablemente la probabilidad de que una regla vigente importante dependa únicamente del archivo histórico.

## Cuándo consultar legacy

**No cargar legacy por defecto.**

Recuperarlo solo si:

1. aparece un comportamiento no explicado por el brain actual;
2. una tarea hace referencia explícita a una decisión antigua;
3. código/SQL contiene una forma extraña y ninguna nota actual explica el porqué;
4. existe evidencia concreta de que falta una regla histórica.

## Procedimiento

1. recuperar el `CLAUDE.md` anterior desde Git;
2. localizar únicamente la sección relacionada;
3. verificarla contra código y, si importa, producción;
4. si sigue vigente, promover una versión compacta al documento canónico del brain;
5. si está obsoleta, no preservarla como regla.

## Regla

El historial es archivo forense, no contexto base.

Ver [[../07-development/brain-maintenance]].