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

## Hora anunciada en el mensaje

La hora del mensaje es el único dato que depende de dónde vive quien lo recibe.

`clientes.tz_offset_min` guarda la diferencia con Colombia en minutos. `NULL` = desconocida, y entonces se anuncia hora Colombia, que es el comportamiento previo a esta columna.

Dos etiquetas que deben ir siempre juntas:

- `{dia}` dice «hoy», «mañana», «el martes» o la fecha. Se calcula contra la hora en que **sale** el mensaje, no contra ahora: la invitación se puede diferir. Y se mira en la hora de pared del cliente, igual que `{hora}` — si su hora se convierte, su día también;
- `{hora}` se resuelve **por persona**, no por actividad;
- también funcionan en un **masivo**, que no cuelga de ninguna actividad: ahí la hora la elige el agente en un campo que solo aparece cuando el texto menciona `{hora}`. Si la menciona y no la elige, no se puede enviar — un hueco donde iba la hora no lo revisaría nadie. La fecha para convertir husos es la del envío, no la de hoy;
- `{zona}` escribe `(hora de tu país)` solo cuando esa hora vino convertida. Sin desfase —el caso de casi todos— se va **vacía**, y con ella el espacio que la precede: aclarar «hora Colombia» en todos los mensajes es ruido para que lo aproveche casi nadie.

La sustitución vive en `rellenarEtiquetas()` de `state.js`, compartida por las plantillas de actividad y por el masivo. Ahí está el consumo del espacio vecino de `{zona}` y el colapso de puntos dobles; si se duplica en un módulo, ese módulo empieza a sacar mensajes con un espacio suelto antes del punto.

Una hora convertida sin avisar es peor que no convertir: el cliente la vuelve a convertir y llega tarde. Si se toca `{hora}`, revisar que `{zona}` viaje con ella — incluida la ruta de cambio de hora, que regenera el texto y necesita leer el desfase del cliente en su consulta.

Es un desfase fijo, no un huso: los países con horario de verano hay que corregirlos a mano dos veces al año. Las plantillas viejas que escribieron «(hora Colombia)» como literal siguen funcionando, pero no se adaptan.

## Los dos cuellos de envío

Todo mensaje a un cliente sale por una de dos funciones, y **solo dos**:

- `mios()` en `public/js/seguimiento.js` — actividades: alimenta `elegibles()`, la aplicación de segmentos guardados y la programación;
- `pool()` en `public/js/masivo.js` — campañas: alimenta lista, filtros, segmentos, conteo y el envío final.

Cualquier regla sobre **a quién se le puede escribir** va en esas dos funciones, no en cada pantalla. Hoy filtran por propiedad (`owner_id`), por tener teléfono y por estado.

Las personas inactivas quedan fuera por defecto en las dos, y en las dos se pueden incluir a propósito con un interruptor que **nace apagado**: en Masivo al abrir el panel, en actividades al elegir cada actividad. Incluirlas es una decisión de esa tanda, nunca una preferencia que sobrevive.

Cada flujo avisa donde se decide de verdad:

- **actividades**: el diálogo de confirmación las nombra con su motivo («😴 4 de ellas están inactivas: Dani (no responde)…»). Ahí se encolan cinco mensajes por persona;
- **masivo**: no hay diálogo, así que el aviso va en la barra de acción, junto al total («incluye 4 inactivas»).

En ambas, la lista muestra el motivo en cada fila.

Al apagar el interruptor hay que **sacar de la selección** a quien deja de verse, y decir cuántas salieron. Si no, quedarían marcadas y contadas sin aparecer en pantalla: la selección invisible de [[../08-memory/dangerous-patterns]] DP-001. Es la comprobación que no se puede omitir al tocar cualquiera de los dos.

Importa que el filtro esté en el envío y no solo en la lista: un segmento guardado hace meses puede traer gente que se marcó inactiva después.

Antes de agregar una tercera vía de envío, preguntar por qué no puede pasar por una de estas dos.

## Etiquetas antes que variantes

`aplicar()` sustituye las etiquetas **antes** de sortear los grupos `{a|b|c}`, no al revés. Es lo que permite escribir `{Hoy tenemos|{dia} tenemos}`: para cuando el sorteo mira el texto, la etiqueta ya es una palabra y el grupo no tiene llaves adentro.

Invertirlo rompe esa posibilidad y devuelve el texto crudo al cliente.

Todo pasa por `componerMensaje()` en `state.js`: etiquetas, luego variantes, y al final la mayúscula del día cuando la variante elegida abre la frase con él. Ese último paso **no se puede hacer antes**: mientras `{dia}` viva dentro de un grupo, no se sabe qué habrá delante.

## Orden de los mensajes

La invitación es el primer contacto del seguimiento. **Ningún otro mensaje puede salir antes que ella.**

Los recordatorios se cuelgan del inicio de la actividad; la invitación, de cuándo se invita. Son dos relojes distintos, y al diferir la invitación un recordatorio puede caer antes. Comparar solo contra `ahora` no lo evita — ver [[../08-memory/dangerous-patterns]] DP-009.

- al programar, el piso es la hora de la invitación (o `ahora` si no se envía invitación);
- al cambiar la hora de la actividad, el piso es `max(ahora, invitación pendiente)`;
- lo que quede por debajo del piso se omite o se cancela, nunca se adelanta;
- la omisión se informa al agente con el nombre del mensaje.

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