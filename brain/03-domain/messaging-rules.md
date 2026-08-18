# Reglas de mensajería

## Regla de oro

Cada usuario escribe únicamente a los clientes que él mismo agregó. Para enviar, no basta con que el cliente sea visible por RLS.

```text
destinatario válido de envío
=> cliente.owner_id == auth.uid()
```

Un director puede supervisar clientes de sus agentes. No debe enviarles desde su propio WhatsApp porque el canal y la relación comercial pertenecen al agente dueño.

## Cola

Los mensajes se programan en Supabase y un worker externo los consume. La UI no entrega WhatsApp directamente.

## Protección contra duplicados

No pueden coexistir dos seguimientos `activo` del mismo cliente para la misma actividad. La base debe sostener esta regla además del filtro de interfaz, porque dos pestañas o carreras concurrentes pueden saltarse la comprobación visual.

Los estados `cancelado` y `completado` no bloquean una programación posterior legítima.

## Selección de destinatarios

- La selección debe comenzar vacía.
- Un filtro visual no puede interpretarse como selección.
- "Marcar visibles" debe operar solamente sobre las filas que cumplen el filtro actual.
- Antes de encolar una tanda se debe confirmar cantidad real y mostrar nombres representativos.

## Mensajes y cambios de actividad

Al cambiar la hora de una actividad:

- los recordatorios pendientes recalculan `enviar_en`;
- se regenera el texto que anuncia la hora;
- si con la nueva hora un recordatorio queda en el pasado, se cancela en vez de programarse retroactivamente;
- la invitación conserva su momento de envío, pero su texto puede necesitar actualización;
- nunca sobrescribir texto de seguimientos ajenos con las plantillas del director.

## Eliminación de actividad

Cancelar seguimientos y mensajes activos **antes** de borrar la actividad. Si se borra primero, quedan dependencias sin un punto fiable desde el cual cancelarlas.

## Envío compartido

Una actividad compartida permite a los agentes programar a sus propios clientes. Compartir la actividad no transfiere propiedad de destinatarios ni de plantillas.

## Código relacionado

- `public/js/seguimiento.js`
- `public/js/masivo.js`
- `public/js/data.js`
- `public/js/state.js`
- worker externo documentado en `05-integrations/whatsapp-worker.md`

## Relacionado

- [[roles-hierarchy]]
- [[activities-followups]]
- [[../02-architecture/security-rls]]
- [[../08-memory/dangerous-patterns]]