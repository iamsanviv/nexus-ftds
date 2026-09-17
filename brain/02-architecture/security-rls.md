# Seguridad y RLS

## Principio

El frontend no es la frontera de seguridad. Supabase/PostgreSQL y sus políticas RLS deben impedir operaciones no autorizadas aunque alguien llame la API directamente.

## Propiedad y alcance

- `owner_id` representa al usuario dueño operativo del dato cuando aplica.
- `puede_ver_de(owner)` resuelve la visibilidad jerárquica de agente/director.
- No sustituir una comprobación de propiedad por una comprobación de visibilidad.

## Regla de envíos

Para acciones que envían mensajes desde el WhatsApp de una persona, el destinatario debe pertenecer al mismo dueño operativo:

```text
owner_id = auth.uid()
```

Que un registro sea visible por RLS al director no lo vuelve destinatario válido de su canal.

## Admin

El rol admin no debe convertirse en un bypass general de las políticas de clientes. Cuando necesita información ajena limitada se usa la superficie específica prevista para directorio/administración.

## Cambios de roles

Un director no puede ascender a sus agentes. El cambio de rol queda bajo autoridad administrativa porque permitir elevaciones dentro de la jerarquía crea escalamiento indirecto.

## Cómo probar RLS

No aprobar una política solo por lectura. Simular sesiones PostgreSQL dentro de una transacción y hacer rollback:

```sql
begin;
select set_config('request.jwt.claims', '...', true);
select set_config('role', 'authenticated', true);
-- prueba
rollback;
```

La identidad elegida para una prueba negativa debe ser realmente ajena a la jerarquía. Verificarlo antes; utilizar por error un usuario que sí cuelga del director produce falsos positivos.

## SQL histórico

`sql/` documenta cambios y razones, pero no es fuente absoluta del esquema actual. Antes de concluir que una política existe o tiene cierto texto, verificar Supabase cuando la tarea dependa del estado real.

## Prohibiciones

- Nunca exponer `service_role` en `public/`.
- Nunca desactivar RLS como arreglo rápido.
- Nunca ampliar una política para resolver un problema de UI sin analizar el dominio.
- Nunca asumir que `admin` significa acceso irrestricto a datos operativos.

## Relacionado

- [[../03-domain/roles-hierarchy]]
- [[../03-domain/messaging-rules]]
- [[../07-development/database-changes]]
## Auditoría de las 20 fallas comunes (17/09/2026)

Se revisaron las 20 fallas típicas de apps hechas con IA **contra el sistema
real**, no en abstracto: sesiones simuladas de `anon`, de agente y de cuenta sin
aprobar, más revisión de sumideros HTML en el frontend.

### Verificado sólido

- **Aislamiento entre agentes.** 13 ataques cruzados probados (leer, editar,
  borrar, apropiarse de clientes ajenos, encolar mensajes a nombre de otro,
  auto-ascenderse a admin, cambiarse de director): los 13 bloqueados **en la
  base**. Un anónimo con la clave pública ve **0 filas en las 21 tablas**.
- **Escalada de privilegios imposible por construcción.** `handle_new_user`
  fija `role = 'agente'` a mano en vez de copiarlo del metadata del registro, y
  valida que el `director_id` elegido sea un director real. `impedir_cambio_de_rol`
  bloquea después cualquier cambio de rol, aprobación o director que no venga de
  un admin o del director propio. Esto es lo que cierra el *mass assignment*.
- **Cuenta sin aprobar = inerte.** No ve nada y no puede insertar nada: las
  políticas de INSERT exigen `aprobado()`.
- **Sin SQL dinámico** en ninguna función; todas con `search_path` fijado.
- **Contraseñas**: 20/20 en bcrypt (las gestiona Supabase Auth).
- **Subida de archivos**: el límite de tamaño y la lista de MIME viven en el
  bucket (servidor). La validación del navegador es solo para dar buen mensaje.
- **Vistas `SECURITY DEFINER`** (`salud_canales`, `clientes_directorio`): el
  linter las marca, pero ambas filtran por dentro. Probado: un agente ve 1 fila
  de `salud_canales` y 0 de `clientes_directorio`.
- **CORS abierto en Supabase no es explotable aquí**: la sesión viaja como
  Bearer en una cabecera, no como cookie, así que otro origen no puede
  reutilizarla.

### Corregido

- **XSS real en la pantalla de registro.** `auth.js` pintaba el nombre de los
  directores sin escapar dentro de `innerHTML`. Confirmado explotable en
  navegador: un `full_name` con `</option><img src=x onerror=...>` **ejecutaba
  JavaScript**, y esa pantalla se sirve *sin sesión*, así que lo habría
  ejecutado cualquier visitante. Era el único `innerHTML` del panel con dato de
  usuario en crudo; el resto ya pasaba por `esc()`.

### Riesgo aceptado, con motivo

- **Token de sesión en `localStorage`.** Es lo que hace el SDK de navegador de
  Supabase y cambiarlo a cookie `httpOnly` exige un backend, que este panel no
  tiene (son assets estáticos en Cloudflare). La mitigación real es que no haya
  XSS: por eso el punto anterior importaba tanto.
- **Tres dependencias por CDN en tiempo de ejecución** (`esm.sh`:
  supabase-js, sortablejs, qrcode). `@supabase/supabase-js@2` no está fijado a
  versión exacta. Fijarlo corta las actualizaciones de seguridad automáticas;
  la mejora de fondo es servirlas desde el propio dominio.
- **44 sitios muestran el error crudo de Postgres** al usuario. Revela nombres
  de columnas y constraints, pero es un panel interno y esos mensajes son lo
  que permite diagnosticar rápido.
