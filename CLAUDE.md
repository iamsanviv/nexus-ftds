# Seguimiento FTDs y Ventas

Panel para que un equipo de agentes gestione clientes y les automatice mensajes
de WhatsApp alrededor de actividades (clases, operativas, lanzamientos).

**Stack:** HTML + CSS + JS vanilla (módulos ES, **sin build**) · Supabase
(Postgres + Auth + RLS) · desplegado en Cloudflare Workers (assets estáticos).

---

## Cómo se trabaja aquí

- **Todo en español**: interfaz, comentarios y mensajes de commit. El equipo es
  colombiano y no todos leen inglés.
- **Los comentarios explican el *porqué***, no el qué. Si algo tiene una forma
  rara, casi siempre hay una razón: déjala escrita.
- **Sin build.** No agregar bundler, framework ni dependencias de npm. Lo poco
  externo entra por `esm.sh` en tiempo de ejecución (Sortable, qrcode).
- **Renderizar antes de dar algo por bueno.** Leer el código no basta: en esta
  sesión, montar un banco de pruebas con Playwright encontró defectos reales
  (formulario de 1180 px, nombre truncado, campo debajo del botón que lo
  necesita). El patrón: extraer el bloque de `index.html`, servirlo con
  `npx http-server public`, inyectar datos representativos y capturar a 1280 y
  390 px. Chromium está en `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`
  y Playwright en `/opt/node22/lib/node_modules/playwright`.
- **Diseño: mockup antes que código.** Para cambios visuales grandes, publicar
  primero un artifact con opciones y esperar la elección.
- **Probar el RLS simulando sesiones**, no razonando. Patrón:
  `set_config('request.jwt.claims', ...)` + `set_config('role','authenticated')`
  dentro de `begin; … rollback;`. Ojo: al elegir un usuario "ajeno" para una
  prueba, verificar que de verdad lo sea — dos veces se usó a alguien que sí
  colgaba del director y la prueba dio un falso positivo.

## Despliegue

`git push` a `main` dispara Cloudflare Workers Builds → producción. El repo se
desarrolla en la rama `main-jvpvtk` y se lleva a `main` con fast-forward.
Rollback: Cloudflare → Worker `nexus-ftds` → Deployments → versión anterior.

Las migraciones se aplican con el MCP de Supabase y **además** se documentan en
`sql/` con el porqué y las pruebas hechas. Ese directorio es documentación, no
un sistema de migraciones: el estado real está en la base.

---

## Modelo de dominio

### Roles y jerarquía (`profiles`)

| Rol | Ve |
|---|---|
| `agente` | solo lo suyo |
| `director` | lo suyo + lo de **sus** agentes (`director_id` apunta a él) |
| `admin` | administra; de clientes ajenos **solo el nombre** |

- Cada agente elige director al registrarse. Hoy todos cuelgan de Juan Camilo.
- **`puede_ver_de(owner)` es la regla única de alcance.** Todas las políticas de
  datos la usan. Si cambia la jerarquía, se toca ahí y en ningún otro lado.
- El admin **no** aparece en esa función a propósito: sobre `clientes` solo ve
  lo suyo. Para el resto existe la vista `clientes_directorio` (SECURITY
  DEFINER, filtrada por `es_admin()`), que expone solo nombre y dueño.
- Cuentas nuevas nacen con `aprobado = false` → pantalla de espera. Aprueban el
  admin (a cualquiera) o el director (solo a sus agentes, y solo con rol
  `agente`). Rechazar marca `rechazado_en`, **no** borra `director_id`.
- **El rol solo lo cambia un admin.** Si un director pudiera, ascendería a un
  agente suyo y escalaría a través de él.

### Regla de oro de los envíos

**Cada quien le escribe únicamente a los clientes que agregó** (`owner_id =
auth.uid()`), tanto en Seguimiento como en Masivo. Un director ve los de sus
agentes para supervisar, pero el mensaje saldría desde *su* WhatsApp a gente
que no lo agregó. Filtrar por lo que el RLS deja ver **no** es suficiente aquí.

### Actividades

- `servicio_id` puede ser nulo → **actividad puntual** (lanzamiento, clase
  única). No entra al catálogo y no cuenta para el progreso.
- `compartida` → un director la comparte con su equipo. Los agentes la ven y
  programan a sus clientes, pero no pueden editarla ni borrarla.
- La lista muestra **lo propio + lo compartido por mi director**. Nunca lo de
  mis agentes: eso es supervisión y vive en «Agentes y canales».

### Ciclo de vida de una actividad

- **Borrarla cancela sus seguimientos** activos y sus mensajes pendientes. Se
  cancela *antes* de borrar: al revés quedan huérfanos y ya no hay por dónde
  alcanzarlos. El aviso dice cuántos se van a cancelar.
- En una actividad **compartida** el agente no puede borrarla (no es suya) pero
  tiene «✕ Mis seguimientos» para desmontar lo que él programó.
- **Cambiar la hora reprograma los mensajes pendientes**: recalcula `enviar_en`
  y regenera el texto (que anuncia la hora). Los recordatorios que con la hora
  nueva quedarían en el pasado se cancelan en vez de programarse hacia atrás.
  La invitación no se re-temporiza —su hora es cuándo invitas— pero su texto sí
  se regenera. El texto solo se regenera en seguimientos **propios**: los de un
  agente se escribieron con *sus* plantillas y sobreescribirlos con las del
  director le cambiaría la redacción a otra persona.

### Políticas por comando, no `FOR ALL`

`seguimientos` y `mensajes_programados` tenían una política `FOR ALL` cuyo
`WITH CHECK (owner_id = auth.uid())` —puesto para la regla de oro del INSERT— se
aplicaba también al UPDATE. Efecto: el director veía los seguimientos de sus
agentes pero no podía tocarlos, y propagar el enlace en una actividad compartida
**no hacía nada en silencio**. Ahora están separadas: crear sigue siendo solo
para uno mismo; actualizar y borrar siguen el alcance de la jerarquía.

### Mensajes programados (tiempos reales)

| tipo | cuándo sale |
|---|---|
| `invitacion` | al programar (o diferida con «Más tarde»); **omitible** |
| `rec_60` | inicio − 60 min |
| `rec_15` | inicio − **15** min |
| `enlace` | inicio |
| `confirmacion` | inicio + **10** min |

Las etiquetas de la interfaz deben coincidir con esto. Ya estuvieron cruzadas
una vez (el registro decía «10 min» y el editor «15 min después»).

---

## Trampas que ya costaron caro

- **Postgres: en un `UPDATE`, la fila resultante debe seguir siendo visible para
  quien la edita.** No se puede actualizar una fila hasta sacarla de la propia
  vista. Rechazar una cuenta poniendo `director_id = null` fallaba por esto, con
  un mensaje que señalaba a la política de UPDATE cuando la culpable era la de
  SELECT. Por eso rechazar marca `rechazado_en` en vez de romper el vínculo, y
  por eso **mover un agente de director queda reservado al admin**.
- **`is_director()` no se puede revocar de `authenticated`.** Las políticas RLS
  la invocan; sin `EXECUTE`, el agente pierde acceso hasta a sus propios
  clientes. Probado y revertido.
- **La `anon key` es pública.** Toda validación que importe va en RLS o en el
  worker. Lo que esté solo en el navegador no es un límite, es una sugerencia.
- **Tres columnas de imagen en `mensajes_programados`**, y solo dos sirven:
  - `imagen_url` → **muerta**, 0 filas en toda la tabla.
  - `media_url` → funciona, incluso en invitaciones (hay envíos exitosos con
    `servicio_id` nulo). Es la vía para la imagen propia de una actividad.
  - `servicio_id` → el worker resuelve la imagen **vigente** del catálogo al
    enviar, así no se congela si se cambia después.
  Se manda **una sola**, nunca ambas, para no depender de cómo el worker
  resolvería el empate.
- **`progreso()` solo recorre el catálogo.** Por eso las llaves extra en
  `acc`/`conf` y el mapa `clientes.puntuales` no ensucian los porcentajes.
- **El CSV solo INSERTA**, nunca actualiza. No hay riesgo de que pise datos.

---

## Estructura

```
public/
  index.html          Marcado de la app (login, vistas, modales)
  css/styles.css      Todos los estilos
  js/
    config.js         Credenciales de Supabase + NIVEL
    supabase.js       Cliente
    state.js          Estado compartido + utilidades + lógica de negocio
    data.js           Consultas y escrituras (sin render)
    auth.js           Login, registro, sesión, roles, espera de aprobación
    ui.js             Render de vistas, perfil y catálogo
    csv.js            Importar / exportar
    seguimiento.js    Actividades, programación, plantillas, registro
    masivo.js         Compositor de mensaje masivo
    canal.js          «Mi WhatsApp»: estado y vinculación por agente
    salud.js          Alertas de canal caído + panel de agentes
    repaso.js         Repaso diario de asistencias
    stats.js, main.js
sql/                  Migraciones documentadas (el estado real está en la base)
```

Flujo de dependencias sin ciclos. El estado mutable vive en un único objeto
`state` (`state.js`) que todos importan.

---

## Lo que NO está aquí

**El worker que envía por WhatsApp no vive en este repo.** Consume
`mensajes_programados` y habla con un bridge por agente (`canales_wa`). Todo lo
que se sabe de él es inferencia desde la base. Si algo depende de su
comportamiento, decirlo en vez de asumirlo.

## Pendientes conocidos

- **Apagar «Confirm email»** en Supabase → Authentication. Con la aprobación
  manual ese paso sobra y provoca `email rate limit exceeded` al probar.
  Configurar SMTP propio antes de cobrar (el «olvidé mi contraseña» lo necesita).
- **Bug de números de México en el worker**: `no LID found for 52…` con y sin el
  `1` tras el código de país. Causó el 18 % de fallos de un agente.
- **El CSV no lleva las asistencias puntuales** (`clientes.puntuales`).
- **Cobro por uso**: la medición ya existe (`mensajes_programados` por
  `owner_id`). Falta tabla de suscripción, cuota **aplicada en el worker** (no
  en el navegador) y pasarela. El costo real es por puesto —cada agente necesita
  su bridge 24/7— así que el modelo sano es base por agente + cuota + excedente.
- **Riesgo de fondo del negocio**: se envía desde los WhatsApp personales de los
  agentes. Ya le restringieron el número a una. Los snippets `{a|b|c}` y el
  goteo ayudan pero no lo eliminan.

---

## Mantener este archivo

Actualizarlo al cerrar cada cambio con: decisiones de diseño con su porqué,
trampas nuevas, y pendientes que aparezcan o se resuelvan. Que siga siendo
denso y escaneable — se carga en cada sesión, así que cada línea tiene que
ganarse el sitio.
