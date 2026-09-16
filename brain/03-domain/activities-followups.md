# Actividades y seguimientos

## Tipos de actividad

`servicio_id` puede ser nulo. En ese caso la actividad es puntual: lanzamiento, clase única u otro evento que no pertenece al catálogo y no debe contar para el progreso del servicio.

Una actividad `compartida` pertenece al director y puede ser utilizada por sus agentes para programar a sus propios clientes. El agente no adquiere permiso para editar o borrar la actividad del director.

## Lista visible

La operación normal muestra:

- actividades propias;
- actividades compartidas por el director.

No mezclar aquí las actividades de los agentes del director; esa información corresponde a supervisión.

## Ciclo de vida

### Eliminar

Antes de borrar una actividad se cancelan sus seguimientos activos y los mensajes pendientes asociados. El orden inverso puede dejar huérfanos difíciles de identificar.

### Cambiar la hora

Reprogramar los recordatorios pendientes respecto de la nueva hora. Regenerar el texto dependiente de la hora. Si un recordatorio queda en el pasado, cancelarlo.

La invitación no cambia su instante original de envío solo porque cambió la hora de la actividad, pero sí puede necesitar texto actualizado.

### Actividad compartida

El agente que no es dueño no la borra. Debe existir una operación separada para desmontar únicamente sus propios seguimientos.

## Seguimiento único activo

Un cliente no puede tener más de un seguimiento `activo` para la misma actividad. La base contiene una restricción/índice parcial para convertir esta regla en invariante y no en mera advertencia de UI.

Cancelar o completar libera la posibilidad de programar un nuevo seguimiento legítimo.

## Programación segura

- La selección nace vacía.
- Buscar oculta filas, pero nunca debe dejar una selección invisible sin que el usuario la conozca.
- Antes de programar se confirma la cantidad real de seleccionados.
- Los duplicados activos se omiten, no se dejan a decisión del usuario.

## Qué mensajes de la secuencia se programan

La secuencia son cinco: `invitacion` (cuelga de cuándo se invita) y cuatro
hitos que cuelgan del **inicio** de la actividad — `rec_60`, `rec_15`,
`enlace`, `confirmacion`.

Dos mecanismos distintos deciden cuáles salen, y no se deben mezclar:

1. **La regla (inapelable).** Nada sale antes que la invitación: un hito cuya
   hora cae en o antes del primer contacto no se programa aunque esté marcado.
   Existe porque pasó en producción — actividad de las 19:00, invitación
   diferida a las 18:01, y 61 personas leyeron «en 1 hora empieza X» sin haber
   sido invitadas.
2. **La preferencia del agente (16/09/2026).** Un selector por tanda permite
   desmarcar cualquiera de los cuatro hitos. Resuelve el caso que la regla no
   ve: invitar a las 17:48 para una actividad de las 19:00 deja el recordatorio
   de una hora a las 18:00 — técnicamente válido, pero doce minutos después de
   la invitación y por tanto redundante.

Arranca **todo marcado**: el estado anterior del sistema era ese, y apagar algo
por iniciativa propia sería la misma falta que mandarlo de más, solo que en
silencio. Se reinicia al cambiar de actividad, para no heredar el apagado de
una tanda a otra.

El selector muestra **la hora de cada mensaje**, que es lo que hace la decisión
obvia sin explicarla. El aviso de «N min después» solo aplica a `rec_60` y
`rec_15`: el enlace y la confirmación se cuelgan del inicio a propósito, así
que salir poco después de la invitación no es un defecto sino lo que pasa al
invitar sobre la hora.

Invariantes al tocar esto:

- lo omitido por regla y lo desmarcado a mano se dicen **por separado** en el
  confirm; llamarle a uno lo del otro le miente al agente sobre su propia
  decisión;
- si no queda ningún mensaje, no se programa nada: un seguimiento sin mensajes
  es una fila «activa» que nadie va a recibir y que además bloquea volver a
  programar a esa persona para esa actividad;
- desmarcar `enlace` deja a la gente sin poder entrar y sin rastreo de
  asistencia. Se permite —hay quien reparte el enlace por otra vía— pero se
  advierte aparte del resto.

## Orden del bloque de programación

El bloque se agrupa por **qué se manda** y luego **a quién**, y ese orden es
deliberado:

1. *Qué mensajes se programan* — si va invitación, si el enlace se rastrea, qué
   hitos salen, la invitación propia del agente.
2. *Elige a quién incluir* — incluir asistidos/inactivas, **buscador, filtros**,
   barra de selección y la lista.

El buscador y los filtros van **pegados a la lista que filtran**. Habían quedado
a cinco bloques de distancia —y el selector de hitos (16/09) lo empeoró—, así
que escribir un nombre y ver el efecto exigía desplazarse. Entre el buscador y
la lista solo puede quedar lo que actúe sobre el mismo conjunto: los filtros y
«Marcar visibles», que operan justamente sobre lo que el buscador deja ver.

## Buscar dentro de lo ya programado

«Seguimientos activos» tiene su propio buscador (16/09/2026), que aparece a
partir de **5 seguimientos en curso**: por debajo, la lista entra de un vistazo
y el control solo estorba.

Busca por nombre **o por teléfono**. El teléfono se compara solo por dígitos en
las dos puntas: en la base está como `+573229859521` y quien busca suele pegar
`322 985 9521` desde WhatsApp. Sin normalizar ambos lados, la búsqueda que más
falta hace —la del número que acabas de recibir— no encontraría nada.

El nombre usa `normBusqueda`, igual que el selector: ignora tildes, mayúsculas y
**puntuación** (`ma jose` encuentra a «Ma. José»), pero no casa prefijos de
palabra (`ma jose` no encuentra a «María José»). La misma regla en los dos
buscadores, a propósito.

Mientras hay texto se muestra «N de M en curso». No es decorativo: cancelar
actúa sobre lo que se ve, y hay que saber que detrás quedan otros escondidos por
el filtro.

El filtrado es **en memoria** (`pintarActivos`), sobre lo que `renderActivos`
dejó en caché. Volver a consultar por cada tecla serían decenas de consultas por
búsqueda para un filtro que no necesita la base.

## Rastreo

Cada seguimiento rastreado tiene su propio `clic_token`. El token identifica a esa persona dentro de esa actividad y debe sobrevivir a reprogramaciones de mensajes.

Ver [[../04-features/tracked-links]] para reglas completas.

## Código relacionado

- `public/js/seguimiento.js`
- `public/js/repaso.js`
- `public/js/data.js`
- `public/js/state.js`
- migraciones históricas de actividades/seguimientos en `sql/`

## Relacionado

- [[messaging-rules]]
- [[../04-features/tracked-links]]
- [[../08-memory/dangerous-patterns]]