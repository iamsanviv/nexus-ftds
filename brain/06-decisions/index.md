# Decisiones vigentes

Estas decisiones tienen fuerza superior a notas históricas. No rediscutirlas por preferencia estética o comodidad local; exigir evidencia de que cambió el contexto.

## ADR-001 — Mantener frontend sin build

**Estado:** vigente.

HTML, CSS y JavaScript vanilla con ES Modules. No introducir framework, bundler o pipeline de compilación como efecto lateral de una tarea.

## ADR-002 — `owner_id` define identidad de envío

**Estado:** vigente.

La visibilidad jerárquica no equivale a permiso de mensajería. Cada canal escribe a clientes del mismo `owner_id`.

## ADR-003 — Enrutar WhatsApp por `owner_id`, no por puerto

**Estado:** vigente.

El puerto no es identificador global cuando existen múltiples hosts. Resolver `owner_id -> host + puerto` y fallar cerrado si no existe mapeo.

## ADR-004 — Un seguimiento activo por cliente y actividad

**Estado:** vigente.

La base impide duplicados activos; la UI también los omite. Una advertencia aceptable por el usuario no es suficiente para una situación que nunca es deseable.

## ADR-005 — Rastreo por seguimiento, no por actividad

**Estado:** vigente.

La presencia de `clic_token` en el seguimiento determina si esa persona usa enlace rastreado. Una misma actividad puede mezclar tandas rastreadas y directas.

## ADR-006 — Resolver enlace vigente al abrir

**Estado:** vigente.

El enlace rastreado devuelve el destino actual de la actividad en el momento del clic. No propagar copias innecesarias de URL a todos los seguimientos.

## ADR-007 — Progreso de campaña derivado de mensajes

**Estado:** vigente.

No mantener un contador paralelo del progreso si los estados reales de `mensajes_programados` ya son la fuente de verdad.

## ADR-008 — Seguridad en Supabase, no en la UI

**Estado:** vigente.

RLS/constraints deben sostener invariantes incluso frente a llamadas directas o carreras concurrentes.

## ADR-009 — SQL como historia documentada, no fotografía absoluta

**Estado:** vigente.

`sql/` documenta cambios; Supabase real decide el estado efectivo de producción.

## ADR-010 — Diferenciar desktop y móvil cuando el diseño lo exige

**Estado:** vigente mientras siga la arquitectura actual.

No eliminar gates responsive que protegen la experiencia móvil sin validar ambas variantes.

## Revisión

Si una tarea necesita cambiar una decisión, crear un ADR específico o actualizar este índice explicando:

- qué contexto cambió;
- qué decisión se reemplaza;
- consecuencias;
- prueba/migración necesaria.