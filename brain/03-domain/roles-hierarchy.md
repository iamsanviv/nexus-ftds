# Roles y jerarquía

## Roles

### `agente`

Ve y opera sus propios datos.

### `director`

Ve sus propios datos y los de los agentes cuyo `director_id` apunta a él. Esa visibilidad es de supervisión y no equivale a propiedad operativa para envíos.

### `admin`

Administra usuarios y funciones especiales. Sobre clientes ajenos no obtiene permiso general de operación por el mero hecho de ser admin; existe una vista de directorio específica para exposición limitada cuando corresponde.

## Regla única de alcance

`puede_ver_de(owner)` concentra la regla de visibilidad por jerarquía. Si la jerarquía cambia, la solución correcta es revisar esa función y las políticas que dependen de ella, no repartir excepciones por consultas del frontend.

## Aprobación

- Las cuentas nuevas nacen con `aprobado = false` y esperan autorización.
- Un admin puede aprobar usuarios según sus permisos administrativos.
- Un director solo debe aprobar agentes que pertenecen a su propia línea y no debe poder elevar roles.
- Rechazar conserva la relación jerárquica necesaria para trazabilidad; no se debe borrar `director_id` como efecto lateral de un rechazo.

## Cambio de rol

El rol solo lo modifica un admin. Permitir que un director eleve el rol de un subordinado abre una ruta de escalamiento de privilegios.

## Invariante

**Visibilidad no es propiedad.** Un director puede ver datos de sus agentes para supervisar; eso no significa que pueda ejecutar acciones que deban salir desde la identidad/canal del agente.

## Código y datos relacionados

- `public/js/auth.js`
- `public/js/data.js`
- `public/js/state.js`
- tabla `profiles`
- funciones/políticas RLS de Supabase

## Relacionado

- [[../02-architecture/security-rls]]
- [[messaging-rules]]