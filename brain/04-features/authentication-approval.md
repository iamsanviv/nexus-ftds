# Autenticación, aprobación y recuperación

## Archivo principal

`public/js/auth.js`

Supabase Auth administra identidad/sesión; `profiles` agrega rol, jerarquía y aprobación del producto.

## Alta de cuenta

Una cuenta nueva se considera pendiente hasta que el perfil sea aprobado.

Reglas de negocio documentadas:

- nuevas cuentas nacen con `aprobado = false`;
- mientras no exista aprobación, la interfaz muestra estado de espera;
- admin puede aprobar cuentas dentro de sus facultades;
- un director solo aprueba a sus propios agentes y no debe poder convertir ese flujo en escalación de rol;
- cambiar roles queda bajo control de admin;
- rechazar registra `rechazado_en` en lugar de romper `director_id`, porque eliminar la relación durante el UPDATE históricamente chocó con RLS/visibilidad.

## Confirmación de correo

La aprobación manual del producto y la confirmación de correo de Supabase son mecanismos distintos.

Históricamente se recomendó desactivar `Confirm email` porque añadía fricción y límites de correo sin aportar una aprobación de negocio adicional. **Verificar la configuración real en Supabase antes de afirmar que sigue activo o desactivado.**

## Cambio de contraseña con sesión abierta

Cambiar contraseña desde la propia aplicación usa la sesión autenticada (`updateUser`) y no necesita enviar un correo de recuperación.

## Recuperación de contraseña (implementada 17/09/2026)

Todo el mecanismo es de Supabase y **no necesita backend**:
`resetPasswordForEmail(email, { redirectTo })` manda el correo y `updateUser`
cierra el cambio.

**Límite que decide si sirve:** con el SMTP de fábrica, Supabase Auth
**solo entrega correos a direcciones del equipo del proyecto**. Para los
demás agentes falla *en silencio* — el correo no llega y `resetPasswordForEmail`
no devuelve error, porque no revelar si una dirección existe es justamente lo
que evita que se puedan enumerar cuentas probando correos. Sin SMTP propio
configurado, el botón existe pero no sirve para 19 de 20 personas.

Piezas y por qué:

- **`HASH_ENTRADA` se captura en `supabase.js` ANTES de crear el cliente.**
  `detectSessionInUrl` viene activado por defecto: consume el `#...type=recovery`
  y lo borra. Si se lee después, ya no hay rastro, `getSession()` ve una sesión
  válida y `entrar()` mete a la persona al panel — el enlace "funcionaría" pero
  nunca pediría la contraseña nueva, y la olvidada seguiría siendo la única que
  sirve. `onAuthStateChange('PASSWORD_RECOVERY')` queda como red de seguridad,
  pero puede dispararse antes de que el módulo llegue a escucharlo.
- **`redirectTo` usa `BASE_URL`**, no `location.origin`, y **tiene que estar en
  la lista de *Redirect URLs*** de Supabase. Si no está, Supabase lo descarta
  sin avisar y usa el **Site URL** en su lugar. Pasó el 17/09/2026 en la primera
  prueba real: el correo llegó, el enlace era válido y `/verify` devolvió 303
  con login correcto — pero el Site URL todavía apuntaba al subdominio anterior
  de Cloudflare, ya sin DNS, así que el navegador terminaba en
  `ERR_NAME_NOT_RESOLVED`. Nada en los registros de Supabase marca error: hay
  que mirar a qué dominio aterriza el navegador.
  `BASE_URL`, Site URL y Redirect URLs son **tres copias del mismo dato** y se
  cambian juntas o no se cambian.
- **«Volver al inicio» hace `signOut()`.** Dejar viva la sesión de recuperación
  permitiría entrar al panel con solo el enlace del correo.
- El aviso tras enviar **no dice si el correo existe** y sí dice a quién avisar
  si no llega, que es la única salida honesta mientras el SMTP no esté puesto.

## Ver la contraseña (el «ojito»)

`ponerOjo(id)` envuelve el campo y le agrega un botón que alterna
`type=password/text`. Se arma desde JS y no en el HTML porque son cuatro campos
en tres pantallas (`auPass`, `pass1`, `pass2`, `recu1`, `recu2`): repetir el
marcado garantiza que algún día uno quede sin él. Se alterna `type` y no
`-webkit-text-security` porque este último no existe en Firefox y el campo
quedaría visible sin que nadie lo pidiera. `ocultarOjos()` lo revierte al cerrar
cada pantalla, para no dejar una contraseña a la vista en la próxima apertura.

## Seguridad

- nunca confiar en rol/aprobación solo porque la UI oculta una pantalla;
- RLS y funciones de autorización sostienen el acceso real;
- un director no puede otorgar roles que le permitan ampliar indirectamente sus privilegios.

## Relacionado

- [[../03-domain/roles-hierarchy]]
- [[../02-architecture/security-rls]]
- [[../08-memory/database-security-traps]]