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

## Recuperación de contraseña

La recuperación desde "olvidé mi contraseña" requiere:

- envío de correo de recuperación;
- configuración SMTP apropiada para producción;
- manejar al volver a la app el enlace/evento de recuperación de Supabase;
- pantalla para establecer la nueva contraseña.

El SMTP de desarrollo de Supabase no debe asumirse suficiente para uso real o pruebas repetidas.

## Seguridad

- nunca confiar en rol/aprobación solo porque la UI oculta una pantalla;
- RLS y funciones de autorización sostienen el acceso real;
- un director no puede otorgar roles que le permitan ampliar indirectamente sus privilegios.

## Relacionado

- [[../03-domain/roles-hierarchy]]
- [[../02-architecture/security-rls]]
- [[../08-memory/database-security-traps]]