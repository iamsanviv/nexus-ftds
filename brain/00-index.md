# Nexus FTDs — Índice del cerebro

Este directorio contiene la memoria persistente y modular del proyecto. `CLAUDE.md` contiene instrucciones de trabajo; `brain/` contiene conocimiento del sistema.

Guía para abrir el repositorio en Obsidian: `brain/README.md`.

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
- `03-domain/activities-followups.md` — actividades, seguimientos, programación y cancelación.
- `03-domain/ftd-sales-commissions.md` — reglas conceptuales de FTD, ventas y comisiones.

## Funcionalidades

- `04-features/authentication-approval.md` — registro, aprobación, roles y recuperación de contraseña.
- `04-features/people-followup.md` — Personas, clientes, filtros y seguimiento.
- `04-features/invitations-attendance.md` — precedencia de invitaciones, asistencia y zooms.
- `04-features/segments-history.md` — historial reutilizable de invitados entre Seguimiento y Masivo.
- `04-features/mass-messaging.md` — campañas masivas y sus protecciones.
- `04-features/media-attachments.md` — imágenes, audio, video, Storage y contratos MIME.
- `04-features/tracked-links.md` — enlaces rastreados, clics y ventana de asistencia.
- `04-features/ftd-sales.md` — comportamiento detallado de FTD, ventas, abonos, upgrades y cierres.
- `04-features/channel-health.md` — vinculación, salud y supervisión de canales WhatsApp.
- `04-features/ui-theme-responsive.md` — modo claro/oscuro y diferencias escritorio/móvil.

## Integraciones

- `05-integrations/whatsapp-worker.md` — cola Supabase, worker Oracle y bridges WhatsApp.
- `05-integrations/oracle-mcp.md` — MCP de solo lectura para consultar OCI.
- `05-integrations/cloudflare.md` — publicación y comportamiento de rutas estáticas.

## Decisiones

- `06-decisions/index.md` — decisiones que no deben rediscutirse sin evidencia nueva.

## Desarrollo

- `07-development/testing.md` — protocolo de pruebas visuales y RLS.
- `07-development/database-changes.md` — relación entre Supabase real y `sql/`.
- `07-development/brain-maintenance.md` — cómo actualizar, depurar y evitar que la memoria vuelva a inflarse.

## Memoria operativa

- `08-memory/dangerous-patterns.md` — errores que ya causaron daño o riesgo real.
- `08-memory/database-security-traps.md` — trampas de Postgres, RLS, helpers y SECURITY DEFINER.
- `08-memory/ui-css-traps.md` — especificidad CSS, harnesses visuales y responsive.
- `08-memory/known-issues.md` — defectos o trabajos históricamente abiertos; verificar antes de asumir vigencia.

## Legacy

- `09-legacy/README.md` — cómo recuperar conocimiento del `CLAUDE.md` monolítico anterior si aparece una laguna real. No cargar legacy por defecto.

## Router rápido por tipo de tarea

| Si la tarea toca… | Leer primero |
|---|---|
| login, registro, aprobación, contraseña | `04-features/authentication-approval.md` |
| roles, permisos, RLS | `02-architecture/security-rls.md` + `08-memory/database-security-traps.md` |
| personas/clientes | `04-features/people-followup.md` |
| actividad/seguimiento | `03-domain/activities-followups.md` |
| texto de invitación/asistencia | `04-features/invitations-attendance.md` |
| programar destinatarios | `03-domain/messaging-rules.md` + `08-memory/dangerous-patterns.md` |
| segmento/historial de invitados | `04-features/segments-history.md` |
| campaña masiva | `04-features/mass-messaging.md` |
| imagen/audio/video | `04-features/media-attachments.md` |
| enlace rastreado `/i` | `04-features/tracked-links.md` + `05-integrations/cloudflare.md` |
| FTD/meta/cierre | `04-features/ftd-sales.md` |
| venta/abono/upgrade/comisión | `04-features/ftd-sales.md` + `03-domain/ftd-sales-commissions.md` |
| canal caído/QR/bridge | `04-features/channel-health.md` + `05-integrations/whatsapp-worker.md` |
| VM/cupo/métricas Oracle | `05-integrations/oracle-mcp.md` |
| cambio visual | `04-features/ui-theme-responsive.md` + `08-memory/ui-css-traps.md` |
| mantener/depurar la memoria | `07-development/brain-maintenance.md` |

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