# Arquitectura general

## Stack

Nexus FTDs es una aplicación web sin proceso de build.

- HTML.
- CSS.
- JavaScript vanilla con ES Modules.
- Supabase: PostgreSQL, Auth, RLS, vistas y RPC.
- Cloudflare Workers sirve los assets estáticos de `public/`.
- Un worker Python externo, alojado en Oracle Cloud, consume la cola de mensajes y entrega WhatsApp mediante bridges por agente.

## Estructura principal

```text
public/
  index.html
  css/
  js/
sql/
mcp/
wrangler.toml
.mcp.json
```

## JavaScript

Módulos nucleares actuales:

- `public/js/config.js` — constantes y configuración pública.
- `public/js/supabase.js` — cliente Supabase.
- `public/js/state.js` — estado compartido y lógica reutilizable.
- `public/js/data.js` — acceso y mutaciones en Supabase.
- `public/js/auth.js` — autenticación, registro, sesión, aprobación y aplicación de rol.
- `public/js/main.js` — arranque.

Módulos funcionales relevantes:

- `seguimiento.js` — Personas/seguimientos y buena parte de la operación diaria.
- `ftd.js` — FTD, metas y cálculos asociados.
- `masivo.js` — envío masivo.
- `repaso.js` — repaso y asistencia.
- `salud.js` y `canal.js` — estado y operación de canales.
- `stats.js` — estadísticas.
- `tema.js` — tema visual.
- `csv.js` — importación/exportación.

## Restricciones arquitectónicas

- No introducir React, Vue, Angular, bundler, TypeScript ni build step sin una decisión explícita.
- Las dependencias externas ligeras se cargan en runtime; no convertir el proyecto en una aplicación npm como solución incidental.
- No mover lógica de autorización al frontend: la seguridad real debe sostenerse en Supabase/RLS.
- El estado real de producción de la base no se infiere únicamente leyendo `sql/`.

## Flujo de mensajes

```text
UI Nexus
  -> Supabase
  -> mensajes_programados
  -> worker Python en Oracle
  -> canal del owner_id
  -> bridge WhatsApp
  -> cliente
```

## Despliegue

`wrangler.toml` sirve `./public` como assets. Un push a `main` dispara el despliegue configurado en Cloudflare Workers Builds.

## Documentos relacionados

- [[security-rls]]
- [[../03-domain/messaging-rules]]
- [[../05-integrations/whatsapp-worker]]
- [[../05-integrations/cloudflare]]