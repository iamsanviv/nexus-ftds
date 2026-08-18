# Trampas de base de datos y seguridad

Este documento conserva fallas silenciosas que ya aparecieron en Supabase/Postgres. Consultarlo cuando una tarea toque RLS, funciones de seguridad, vistas o autorización.

## UPDATE y visibilidad de la fila resultante

En Postgres/RLS, una actualización puede fallar si la fila resultante deja de ser visible para quien la modifica.

Caso histórico: rechazar una cuenta eliminando `director_id` sacaba la fila del alcance del propio director durante el UPDATE.

Decisión vigente:

- rechazar marca `rechazado_en`;
- no rompe automáticamente la relación de director;
- mover un agente de director queda reservado al admin.

No interpretar un error de UPDATE de RLS únicamente mirando `WITH CHECK`; la política de SELECT/visibilidad también puede ser la causa.

## Helpers usados por políticas necesitan EXECUTE

Funciones como:

- `is_director()`
- `mi_rol()`
- `es_admin()`
- `puede_ver_de()`
- `aprobado()`

son invocadas por las propias políticas. Revocar `EXECUTE` a `authenticated` puede romper el acceso incluso a filas propias.

No "arreglar" un aviso de linter revocando permisos sin probar el flujo real.

## SECURITY DEFINER deliberado

Existen vistas cuya razón de existir es precisamente atravesar RLS de la tabla base y aplicar un alcance controlado dentro de la vista.

Casos históricos:

- `clientes_directorio`: permite al admin consultar el directorio limitado que necesita sin abrir `clientes` completo.
- `salud_canales`: calcula alcance propio/equipo/admin para salud operativa.

Convertir estas vistas mecánicamente a `security_invoker` puede devolver cero filas sin un error evidente.

La seguridad no se evalúa por una regla de linter aislada; se evalúa por el contrato completo de la vista y pruebas simulando roles.

## Políticas por comando

Evitar una política `FOR ALL` cuando INSERT, UPDATE y DELETE tienen contratos distintos.

Caso histórico: `WITH CHECK (owner_id = auth.uid())` era correcto para INSERT de seguimiento/mensaje propio, pero aplicado también al UPDATE impedía operaciones legítimas de supervisión dentro de la jerarquía.

Diseñar políticas por comando cuando las invariantes difieren.

## El frontend no es frontera de seguridad

La `anon key` de Supabase es pública por diseño.

Todo límite importante debe sostenerse mediante:

- RLS;
- constraints/índices;
- funciones seguras;
- worker/backend cuando corresponda.

Una validación solo en JavaScript es experiencia de usuario, no autorización.

## No atar validaciones de base a detalles accidentales de UI

Caso histórico: `abrir_enlace()` validaba una longitud mínima del token copiada del tamaño usado por la interfaz en ese momento. Al cambiar la longitud, la base podía rechazar enlaces válidos.

La base debe validar propiedades semánticas, no una decisión de presentación que pueda evolucionar independientemente.

## RLS de ventas/FTD

`abonos` no necesita `owner_id` propio si su alcance se deriva correctamente de la venta mediante `venta_id`.

No agregar propiedad duplicada solamente para simplificar una consulta si crea una segunda fuente de verdad.

## Prueba obligatoria

Cuando se modifique cualquiera de estas áreas, simular sesiones reales dentro de `begin ... rollback` y verificar explícitamente:

- propietario;
- agente ajeno;
- agente del mismo director;
- director correspondiente;
- admin cuando aplique.

## Relacionado

- [[../02-architecture/security-rls]]
- [[dangerous-patterns]]
- [[../07-development/testing]]