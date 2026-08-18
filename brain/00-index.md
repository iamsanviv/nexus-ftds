# Nexus FTDs — Índice del cerebro

Este directorio contiene la memoria persistente y modular del proyecto. `CLAUDE.md` contiene instrucciones de trabajo; `brain/` contiene conocimiento del sistema.

## Regla de lectura

Claude no debe leer todo `brain/` por defecto. Debe identificar la tarea, abrir únicamente los documentos relevantes y después inspeccionar el código citado en esos documentos.

## Producto

- `01-product/current-state.md` — estado funcional y técnico actual del sistema.

## Arquitectura

- `02-architecture/overview.md` — stack, estructura y flujo general.
- `02-architecture/security-rls.md` — autoridad, propiedad, alcance y reglas RLS.

## Dominio

- `03-domain/roles-hierarchy.md` — agente, director, admin y jerarquía.
- `03-domain/messaging-rules.md` — invariantes de envío y propiedad de clientes.
- `03-domain/activities-followups.md` — actividades, seguimientos, programación, cancelación y rastreo.
- `03-domain/ftd-sales-commissions.md` — FTD, ventas, metas y comisiones.

## Funcionalidades

- `04-features/people-followup.md` — Personas, clientes, filtros y seguimiento.
- `04-features/mass-messaging.md` — envíos masivos y sus protecciones.
- `04-features/tracked-links.md` — enlaces rastreados y asistencia.
- `04-features/ui-theme-responsive.md` — modo claro/oscuro y diferencias escritorio/móvil.

## Integraciones

- `05-integrations/whatsapp-worker.md` — cola Supabase, worker Oracle y bridges WhatsApp.
- `05-integrations/cloudflare.md` — publicación y comportamiento de rutas estáticas.

## Decisiones

- `06-decisions/index.md` — decisiones que no deben rediscutirse sin evidencia nueva.

## Desarrollo

- `07-development/testing.md` — protocolo de pruebas visuales y RLS.
- `07-development/database-changes.md` — relación entre Supabase real y `sql/`.

## Memoria operativa

- `08-memory/dangerous-patterns.md` — errores que ya causaron daño o riesgo real.
- `08-memory/known-issues.md` — defectos abiertos conocidos.

## Jerarquía de verdad

Cuando dos fuentes se contradigan, usar este orden:

1. instrucción explícita de la tarea actual;
2. estado verificado de producción (Supabase, Oracle, Cloudflare);
3. código actual;
4. decisiones vigentes de `brain/06-decisions/`;
5. documentación modular de `brain/`;
6. archivos SQL históricos;
7. notas de sesiones o documentación antigua.

No convertir una observación temporal en regla permanente sin verificarla.