# Notificaciones push al agente

Avisos en la PC y el teléfono del agente aunque el panel esté cerrado. Web Push estándar, sin app nativa (14/10/2026).

## Piezas

- `public/sw.js` — service worker: solo `push` y `notificationclick`. **Sin manejador `fetch` a propósito**: un SW que cachea serviría paneles viejos tras cada despliegue.
- `public/js/notificaciones.js` — fila «🔔 Notificaciones» en Más, modal para activar por dispositivo, elegir tipos y «Enviar una prueba». Al entrar renueva la suscripción si ya hay permiso; al cerrar sesión la quita (`olvidarDispositivo`).
- `supabase/functions/enviar-push/index.ts` — Edge Function (verify_jwt) que reclama la cola y envía con `web-push`. Se despliega con el MCP de Supabase; no hay CLI en el repo.
- SQL: `sql/2026-10-14_34_notificaciones_push.sql` (aplicado).

## Flujo

```text
evento → notificar() → notificaciones (cola + dedupe por owner_id+clave)
       → trigger de sentencia → pg_net → enviar-push → push_suscripciones del dueño
cron «notificaciones» (pg_cron, cada minuto) → generar_notificaciones() + reintentos
```

`notificar()` no encola si el dueño no tiene dispositivos o apagó el tipo (`notif_apagadas`). `reclamar_notificaciones()` evita doble envío entre trigger y cron. Un aviso con más de 2 h sin entregarse se abandona.

## Eventos

| tipo | origen | clave (dedupe) |
|---|---|---|
| `zoom` | cron: actividad `activa` que empieza en ≤60 min; al dueño y a quien tenga seguimientos no cancelados en ella | actividad + inicio (reprogramar vuelve a avisar) |
| `canal` | trigger `canales_wa`: `vinculado` → otro estado, sin `comando`/baja | por hora |
| `canal` | cron: `vinculado` pero sin latido >10 min (y <1 día) | último `actualizado` |
| `canal` | cron: ≥3 errores en 30 min y ≥ enviados | por día (Bogotá) |
| `respondio` / `temperatura` / `escribio_hoy` | trigger `chats_recientes` al cambiar `entrante_en` | cliente + `entrante_en` |

WhatsApp entrante: **un aviso por mensaje**, combinando los hechos nuevos (respondió a tu último envío de ≤3 días, subió de temperatura, primer mensaje del día). El tipo es el más importante encendido: respondió > temperatura > escribió hoy. Solo clientes propios (`owner_id` del chat). Escribió hoy y temperatura solo para leads y pendientes de depósito (lo que lista «Hoy»). Hereda la demora de ~5 min y los huecos de `chats_sync` (ver [[../05-integrations/whatsapp-worker]]: un bridge que no sincroniza no genera avisos).

## Regla de temperatura duplicada

`temp_base()` / `temp_con_entrante()` son una **copia en SQL** de `base()` / `calcTemp()` de `public/js/leads.js`. Si cambian las reglas de temperatura en el panel, hay que cambiar también estas funciones, o el aviso dirá «subió» cuando el panel no lo muestra.

## Seguridad

- Todo es solo del propio (`owner_id = auth.uid()`), como `chats_recientes`: un director no recibe los avisos de su equipo.
- Suscripciones solo por RPC (`registrar_push` reasigna el endpoint al usuario que inicia sesión en ese navegador).
- `notificar`, `reclamar_notificaciones`, `vapid_claves`, `guardar_vapid`, `disparar_push` sin grant a clientes.
- Llaves VAPID: las generó la Edge Function y viven en Vault (`vapid_publica`, `vapid_privada`). La privada nunca salió de Supabase. Rotarlas invalida todas las suscripciones (cada dispositivo debe reactivar).

## Plataformas

- PC (Chrome/Edge/Firefox) y Android: directo desde el navegador.
- iPhone/iPad: solo con el panel agregado a la pantalla de inicio (iOS 16.4+). El modal lo explica.

## Pendientes conocidos

- `notificaciones` no se purga sola (el MCP exige confirmación para DELETE masivos). Volumen bajo; purgar a mano si crece.
- La prueba de punta a punta del 14/10/2026 usó un endpoint falso (respuesta 201): la entrega real en cada navegador se confirma con «Enviar una prueba».

## Relacionado

- [[leads-followup]] · [[channel-health]] · [[../03-domain/activities-followups]]
