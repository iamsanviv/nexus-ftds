# Cloudflare Workers

## Publicación

`wrangler.toml` define el proyecto `nexus-ftds` y sirve `./public` como assets estáticos.

El flujo configurado de producción parte de `main`. Antes de llevar cambios a esa rama deben probarse en una rama/preview cuando el cambio lo justifique.

## Rutas

`not_found_handling = "single-page-application"` hace que rutas desconocidas puedan caer en `index.html`.

`html_handling = "auto-trailing-slash"` está escrito explícitamente porque la ruta corta `/i` forma parte del enlace rastreado y debe resolver el puente `i.html`.

No eliminar esa configuración como "default redundante" sin revisar [[../04-features/tracked-links]]. Un fallo silencioso podría mostrar el panel principal a una persona que esperaba entrar a una sala.

## BASE_URL y previews

Los enlaces rastreados para clientes se construyen con una URL canónica configurada, no con `location.origin`. Una preview de Cloudflare no debe filtrarse en mensajes reales.

## Rollback

La infraestructura permite volver a un deployment anterior desde Cloudflare. Para cambios con impacto operativo, conservar una ruta clara de rollback.

## Relacionado

- [[../04-features/tracked-links]]
- [[../02-architecture/overview]]