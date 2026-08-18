# Enlaces rastreados y asistencia

## Objetivo

Permitir saber si el destinatario abrió el enlace de una actividad sin enviar directamente la URL final de la sala.

## Modelo

Cada seguimiento rastreado recibe `clic_token`. El mensaje contiene una ruta corta del tipo:

```text
https://nexus-ftds.nexus-pro.workers.dev/i?<token>
```

La RPC `abrir_enlace(t)` registra la apertura y devuelve el destino vigente de la actividad.

## Token

- Longitud actual: 10 caracteres.
- El token pertenece al seguimiento, no al mensaje.
- Tener `clic_token` es la señal de que ese seguimiento usa rastreo; no mantener una segunda bandera redundante.

## BASE_URL

El dominio se construye desde `BASE_URL` en `public/js/config.js`, no desde `location.origin`.

Razón: una preview de Cloudflare no debe terminar enviando enlaces de preview a clientes.

Cambiar `BASE_URL` puede inutilizar enlaces ya enviados; no hacerlo durante actividades con seguimientos vivos.

## Resolución de `/i`

`wrangler.toml` mantiene `html_handling = "auto-trailing-slash"`. `/i` debe resolver a la página puente `i.html`. Existe además una defensa en `index.html` para evitar que una variación del comportamiento de Cloudflare termine mostrando la SPA al cliente.

## Navegador, no 302 del servidor

La redirección se ejecuta en JavaScript del navegador. Las previsualizaciones automáticas de WhatsApp no ejecutan ese JS, por lo que no deben contar como clic humano.

## Asistencia

La ventana automática válida es una hora desde el inicio de la actividad.

- dentro de la ventana: el clic puede marcar asistencia;
- fuera de la ventana: se registra la apertura y se redirige, pero no se inventa asistencia;
- una asistencia manual previa no debe sobrescribirse.

Semántica:

- `clics`: todas las aperturas registradas;
- `clic_en`: primera apertura que contó como asistencia.

Por ello `clics > 0` y `clic_en IS NULL` significa que hubo apertura fuera de la ventana de asistencia.

## Valores de retorno

La resolución distingue deliberadamente:

- `null`: token inexistente;
- `''`: seguimiento válido pero la actividad todavía no tiene enlace de sala;
- URL: destino disponible.

No colapsar estos estados porque producen mensajes de error diferentes para el cliente.

## Enlace vigente

El clic debe resolver el enlace actual de la actividad. No congelar innecesariamente una copia que obligue a propagar cambios a todos los mensajes pendientes.

## Limitaciones conocidas

El rastreo demuestra apertura, no permanencia en la sesión. Reenvíos del enlace atribuyen la apertura al destinatario original. Abrir un enlace de prueba puede marcar asistencia al cliente asociado.

## Código relacionado

- `public/i.html`
- `public/js/config.js`
- `public/js/seguimiento.js`
- `wrangler.toml`
- RPC `abrir_enlace`
- `sql/2026-07-30_09_enlace_rastreado.sql` y cambios posteriores relacionados

## Relacionado

- [[../03-domain/activities-followups]]
- [[../05-integrations/cloudflare]]