# Historial de invitados y segmentos

## Propósito

El historial permite reutilizar grupos de personas entre Seguimiento y Masivo sin reconstruir la selección manualmente.

La escritura vive en `data.js`, función `guardarHistorialSegmento`, porque dos áreas alimentan la misma memoria:

- programar una actividad;
- enviar una campaña masiva.

No duplicar la persistencia en cada módulo.

## Identidad de un segmento

No crear una entrada nueva por cada tanda.

La identidad lógica se expresa mediante `clave`:

- `act:<actividad_id>` para una actividad;
- `cam:<campana_id>` para una campaña.

La base tiene protección para esa identidad mediante el índice correspondiente.

## Unión acumulativa

Cuando se vuelve a guardar la misma clave, la selección se une con la existente.

Una persona que ya pertenecía al segmento permanece aunque no vuelva a seleccionarse en una tanda posterior. Esto refleja cómo trabajan los agentes: suelen programar poco a poco según van confirmando personas.

## Poda

`MAX_HISTORIAL` limita la cantidad de segmentos guardados.

La poda se ejecuta cuando aparece una clave nueva. Actualizar/unificar una clave existente no aumenta el número de entradas y no debe disparar una poda como si fuera un segmento adicional.

## Interfaz

Los segmentos históricos se muestran plegados. Con muchos grupos, desplegarlos permanentemente desplaza la lista de personas que es la tarea principal del agente.

El mismo concepto debe ser reutilizable desde Seguimiento y Masivo.

## Invariante

No convertir cada tanda de una misma actividad o campaña en una versión independiente. Fragmentar el historial destruye el valor del segmento como representación acumulada del público real.

## Asistentes de una actividad (2/11/2026)

Pedido de Sanviv: escribir (ej. «¿cómo les fue?») solo a quienes asistieron a una actividad **en esa fecha**, no a quienes alguna vez asistieron a ese servicio.

- Regla única: `asistioEseDia(s, c, a)` en `state.js`. Cuenta el clic a tiempo (`seguimientos.clic_en`) o una marca de asistencia: en puntuales `puntuales[actividad].acc`; en catálogo `acc[servicio]` con fecha entre el día en que se creó el seguimiento y el día de la actividad (el repaso marca con la fecha de la invitación y el panel con la del inicio). Medido en producción: de 533 marcas en seguimientos de 10 días, 178 eran de clases anteriores y quedan fuera.
- Dos entradas, un solo envío (Masivo): botón «💬 Escribir a quienes asistieron (N)» en «Quiénes entraron» (solo si la actividad ya empezó y hay asistentes propios), y el grupo plegado «Asistieron · últimos 7 días» en los segmentos de Masivo.
- Llegan todos marcados (como al elegir un segmento) y el envío lo hace el agente; no sale solo.
- No se guarda en `segmentos`: se calcula al abrir Masivo, porque la asistencia se sigue marcando después de la clase.
- Solo seguimientos propios (`owner_id` = yo) y luego el filtro normal de Masivo (`pool()`).
- Ojo: el «✓ asistió» de cada fila del panel sigue usando `asistioA` (= alguna vez, en catálogo), así que puede mostrar más ✓ que el número del botón.

## Código relacionado

- `public/js/data.js`
- `public/js/seguimiento.js`
- `public/js/masivo.js`

## Relacionado

- [[mass-messaging]]
- [[../03-domain/activities-followups]]