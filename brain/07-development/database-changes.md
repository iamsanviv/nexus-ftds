# Cambios de base de datos

## Fuente real

La base Supabase en producción es la fuente de verdad del esquema y las políticas activas.

El directorio `sql/` cumple dos funciones:

1. dejar registro reproducible de cambios;
2. documentar por qué se hicieron y cómo se probaron.

No debe tratarse automáticamente como un sistema de migraciones aplicado en orden ni como fotografía infalible del estado actual.

## Procedimiento para cambios

1. Leer la documentación de dominio/arquitectura relacionada.
2. Inspeccionar estado real de Supabase si la tarea depende de tablas, funciones, vistas o RLS vigentes.
3. Diseñar el cambio con una sola fuente de verdad y sin columnas redundantes innecesarias.
4. Aplicar el cambio mediante la herramienta autorizada/MCP disponible.
5. Probar RLS y restricciones con sesiones representativas.
6. Añadir SQL documentado en `sql/` cuando corresponda.
7. Actualizar el brain si cambió una regla persistente.

## Restricciones

- No debilitar RLS para hacer funcionar una consulta del frontend.
- No introducir flags que dupliquen estados derivables sin una razón fuerte.
- Preferir constraints/índices cuando una regla nunca debe violarse, en vez de confiar solo en un `confirm()` de UI.
- Antes de borrar una columna aparentemente sin uso, buscar lectores, RPC, vistas y dependencias reales.

## Ejemplo de invariante

La regla "un seguimiento activo por cliente y actividad" pertenece a la base además de la interfaz porque dos pestañas pueden competir y saltarse una validación previa.

## Relacionado

- [[../02-architecture/security-rls]]
- [[testing]]
- [[../08-memory/dangerous-patterns]]