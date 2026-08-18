# Estado actual de Nexus FTDs

Última estructuración del brain: 2026-08-17.

Este documento describe el estado observado en el repositorio. Para datos operativos variables, verificar producción.

## Producto

Panel interno para que el equipo Nexus gestione personas/clientes, seguimiento de servicios y actividades, FTD, ventas, comisiones y automatización de mensajes de WhatsApp.

## Stack activo

- HTML + CSS + JavaScript vanilla.
- ES Modules sin build.
- Supabase: PostgreSQL, Auth, RLS, RPC y vistas.
- Cloudflare Workers sirve los assets estáticos.
- Worker Python externo en Oracle para WhatsApp.

## Roles

- `agente`
- `director`
- `admin`

Consultar [[../03-domain/roles-hierarchy]].

## Módulos frontend identificados

- configuración: `public/js/config.js`
- cliente Supabase: `public/js/supabase.js`
- autenticación/aprobación: `public/js/auth.js`
- estado/reglas compartidas: `public/js/state.js`
- persistencia: `public/js/data.js`
- render general/perfiles: `public/js/ui.js`
- seguimiento/actividades: `public/js/seguimiento.js`
- FTD: `public/js/ftd.js`
- ventas/abonos/comisiones: `public/js/ventas.js`
- masivos: `public/js/masivo.js`
- repaso/asistencia: `public/js/repaso.js`
- salud/canales: `public/js/salud.js`, `public/js/canal.js`
- estadísticas: `public/js/stats.js`
- tema: `public/js/tema.js`
- CSV: `public/js/csv.js`
- arranque: `public/js/main.js`

## Interfaz reciente

El repositorio incorpora un rediseño de escritorio separado del comportamiento móvil:

- barra lateral fija en escritorio;
- modo claro/oscuro;
- filtros de Personas rediseñados;
- tarjeta FTD adaptada a escritorio;
- filas de clientes horizontales en escritorio;
- búsqueda por nombre y teléfono.

La lógica está condicionada por ancho cuando corresponde; no asumir que un cambio desktop debe aplicarse a móvil.

## Seguimiento y actividades

El sistema soporta actividades de catálogo y puntuales, programación de mensajes, seguimientos, rastreo de enlaces, revisión de asistencia y cancelación/reprogramación con reglas de seguridad contra destinatarios invisibles y duplicados.

## Ventas y FTD

El producto incluye:

- FTD declarados/cargados/reales;
- metas y cierres mensuales;
- ventas y abonos;
- comisiones por producto;
- upgrades;
- embudo de zooms asociado al cliente;
- resumen de periodos anteriores.

Consultar [[../04-features/ftd-sales]].

## Persistencia

`sql/` contiene la historia documentada de cambios de base, seguridad, actividades, ventas, FTD, rastreo, canales y otras funciones. No funciona como migrador automático ni garantiza por sí solo describir el estado actual de producción.

## Mensajería

Los mensajes se encolan en Supabase y son entregados por un worker externo. El canal se selecciona por `owner_id`; la UI no debe usar el alcance del director como población de envío.

Existen campañas masivas, plantillas/invitaciones por actividad/agente, medios adjuntos y rastreo de entrada. Audio/video tienen restricciones históricamente abiertas que deben verificarse antes de habilitarse.

## Infraestructura del agente

`.mcp.json` declara un MCP `oracle` que ejecuta `python3 mcp/oracle/servidor.py`. Es una herramienta de operación/verificación, no la memoria del proyecto.

El worker real no vive en este repositorio. `contexto-worker.md` conserva detalles operativos históricos y el brain condensa sus invariantes estables.

## Despliegue

`main` está conectado al despliegue de Cloudflare. Esta rama `agent/obsidian-brain` contiene solo la migración documental/memoria y no debe mezclarse con `main` hasta revisar el PR.

## Obsidian

El repositorio completo se puede abrir como vault. `.obsidian/` está ignorado y `brain/` se versiona.

Ver [[../README]].

## Riesgos conocidos

Consultar:

- [[../08-memory/dangerous-patterns]]
- [[../08-memory/database-security-traps]]
- [[../08-memory/ui-css-traps]]
- [[../08-memory/known-issues]]

## Fuente de verdad

Para comportamiento de código, verificar implementación vigente. Para estado operativo de Supabase/Oracle, consultar los sistemas reales cuando la tarea lo requiera.