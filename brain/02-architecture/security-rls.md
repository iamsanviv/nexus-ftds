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