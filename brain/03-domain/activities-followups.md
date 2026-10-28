# Actividades y seguimientos

## Tipos de actividad

`servicio_id` puede ser nulo. En ese caso la actividad es puntual: lanzamiento, clase única u otro evento que no pertenece al catálogo y no debe contar para el progreso del servicio.

Una actividad `compartida` pertenece al director y puede ser utilizada por sus agentes para programar a sus propios clientes. El agente no adquiere permiso para editar o borrar la actividad del director.

Una actividad `para_todos` (20/10/2026) es lo mismo un nivel más arriba: la crea el admin y la ven todos los usuarios aprobados de todos los equipos (RLS `actividades_sel`: `para_todos and aprobado()`). Solo un admin puede marcarla (`actividades_ins`/`actividades_upd` exigen `not para_todos or es_admin()`). Nadie más la edita, la borra ni puede ocultarla. El interruptor nace **apagado** (al revés que el del director): el admin también arma clases para sus propios clientes. Etiqueta «🌐 Global» para todos (pedido de Sanviv), y tiene prioridad sobre «De tu director»: el admin puede tener director. SQL: `sql/2026-10-20_43_actividades_para_todos.sql`.

## Nombre para las personas (26/10/2026)

`actividades.nombre` es el nombre del panel, pensado para los agentes (puede llevar notas
internas). `actividades.nombre_publico` (opcional, pedido de Sanviv) es el que llena
`{actividad}` en invitación, recordatorios y serie; nulo = `nombre`. Todo lo que se le manda a
una persona pasa por `nombreParaPersonas(a)` (`seguimiento.js`); lo interno (tarjetas, registro,
`puntuales[].n`, segmentos, avisos push) sigue con `nombre`. CHECK: vacío no vale, se guarda nulo.
SQL: `sql/2026-10-26_46_actividades_nombre_publico.sql`.

Si cambia al editar, `renombrarPendientes` reemplaza el nombre viejo por el nuevo en los
mensajes **pendientes** visibles (reemplazo, no regeneración: no re-sortea el texto ni pisa
invitaciones propias). Los que el editor no ve (otros equipos de una `para_todos`) los corrige el
trigger `actividades_ajenos_nombre` (AFTER UPDATE OF nombre, nombre_publico) con el mismo
reemplazo. SQL: `sql/2026-10-28_47_nombre_publico_ajenos.sql`.

## Lista visible

La operación normal muestra:

- actividades propias;
- actividades compartidas por el director;
- actividades del admin para todos los equipos.

No mezclar aquí las actividades de los agentes del director; esa información corresponde a supervisión.

## Ciclo de vida

### Eliminar

Antes de borrar una actividad se cancelan sus seguimientos activos y los mensajes pendientes asociados. El orden inverso puede dejar huérfanos difíciles de identificar (el FK es `ON DELETE SET NULL`).

El panel solo alcanza los seguimientos que el RLS le deja ver (`puede_ver_de`): el admin no ve los de otros equipos. Por eso el trigger `actividades_ajenos_del` (BEFORE DELETE) cancela en la base todos los activos, y el aviso cuenta con la RPC `seguimientos_de_mi_actividad` (solo responde al dueño).

### Cambiar la hora

Reprogramar los recordatorios pendientes respecto de la nueva hora. Regenerar el texto dependiente de la hora. Si un recordatorio queda en el pasado, cancelarlo.

Los seguimientos que el editor no ve (`not puede_ver_de`, p. ej. otros equipos en una `para_todos`) los mueve el trigger `actividades_ajenos_upd` con la misma regla que el panel aplica a los de un agente: corrige la hora, no reescribe el texto, respeta los congelados y cancela lo que caería antes de la invitación pendiente o en el pasado. También propaga el enlace nuevo a los que no tienen token. Panel y trigger cubren conjuntos disjuntos.

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

**La invitación es una fila más del selector** (17/09/2026). Antes tenía su
propia casilla, «No enviar invitación», en otro punto de la pantalla: dos
controles para la misma decisión, separados, que tarde o temprano se
contradicen. Ahora se apaga donde se ve su efecto sobre el resto de la
secuencia. El estado sigue siendo `segSinInvitacion` —todo lo de abajo lo lee
así— y `alternarInvitacion()` concentra los efectos de arrastre: esconder «Más
tarde» (diferir algo que no se envía no significa nada) y el editor de la
invitación propia.

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
2. *Elige a quién incluir* — incluir asistidos/inactivas, **buscador, filtros,
   segmentos guardados**, barra de selección y la lista.

Los segmentos guardados («Invitados recientes») van **pegados a los filtros**:
son otra forma de lo mismo —acotar a quién— y arriba del bloque quedaban lejos
de la lista sobre la que actúan.

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

## Editar los mensajes de un seguimiento ya programado (13/10/2026)

Cada tarjeta de «Seguimientos activos» tiene **«✎ Mensajes»** (`abrirEditarMensajes`,
reusa el modal `repOverlay`). Lista los mensajes de ESA tanda (`invitacion`, `rec_60`,
`rec_15`, `enlace`, `confirmacion`) con su hora y estado, y permite **silenciar o
reactivar cada hito por separado** sin cancelar el seguimiento entero: pendiente →
`cancelado` («No enviar») y cancelado → `pendiente` («Volver a enviar»). Resuelve el
caso «ya programé pero no quiero que le llegue el recordatorio de 1 h ni el de 15».

Reglas de lo que se puede tocar:
- `enviado` / `error`: no se tocan (lo enviado no se recoge).
- `pendiente`: se puede silenciar.
- `cancelado` cuya hora ya pasó: NO se ofrece reactivar (el worker no lo mandaría);
  se muestra «silenciado · ya pasó su hora».

Generaliza lo que antes era solo «silenciar la confirmación» (`confBoton`, un botón
por tarjeta): ese control se retiró y su función vive ahora dentro del editor, para
no tener dos mecanismos para lo mismo. El update va por `seguimiento_id` + `tipo` +
`estado` previo, así un doble clic no pisa un estado que ya cambió.

## Congelar el enlace cuando la actividad se demora (14/10/2026)

El enlace sale a la hora de inicio; si la actividad arranca tarde, la gente recibe
el link (y entra a una sala vacía) antes de tiempo. En la tarjeta de la actividad
hay **«❄ Congelar enlace»** / **«▶ Enviar enlace»** (`congelarEnlace` /
`descongelarEnlace`, `seguimiento.js`), que operan sobre **todos MIS seguimientos**
de esa actividad (`owner_id = me`; un director no congela los de su equipo).

- **Congelar** retiene el **enlace Y la confirmación** pendientes: empuja su
  `enviar_en` al centinela `2999-01-01` (el worker solo manda lo vencido). NO cambia
  el `estado` (siguen `pendiente`): no es cancelar. **Sin tocar el worker.**
- **Liberar** («▶ Enviar enlace»): el enlace pasa a `now` y la confirmación a `now + CONF_OFFSET_MIN` (10 min, el mismo desfase de
  `HITOS`). Solo toca los congelados (`enviar_en >= 2900`), no un pendiente normal.
- **Eliminar por completo** sigue siendo el cancelar de siempre (congelar ≠ cancelar).

Detección: `esCongelado(ts)` compara el **año por string** (`Number(ts.slice(0,4)) >=
2900`), no con `Date`, porque el offset del timestamp (`+00`, `Z`, con espacio) hacía
que `new Date()` devolviera Invalid Date y la detección fallara. `estadoEnlace(actIds)`
clasifica cada actividad en `congelable` / `congelado` (2 consultas, como
`contarEntradas`). La tarjeta muestra el chip «❄ Enlace congelado» cuando aplica, y el
editor por persona («✎ Mensajes») muestra «❄ congelado» en vez de la fecha centinela.

**Invariante:** `reprogramarPorHora` (cambio de hora de la actividad) **salta** los
mensajes congelados (`esCongelado`), para no liberar sin querer un enlace retenido a
propósito. Solo se libera desde «▶ Enviar enlace».

**Invariante (15/10/2026):** `renderActivos` cierra como `completado` todo seguimiento
pasado `inicio + 10 min`, y `descongelarEnlace` solo libera seguimientos `activo`. Sin
excepción, congelar y liberar más de 10 min después del inicio no liberaba nada (el
botón desaparecía). Por eso `renderActivos` **no cierra** un seguimiento con enlace o
confirmación congelados, ni uno liberado tarde cuyo enlace/confirmación sigan por salir.
Un congelado que nadie libera caduca a las `CONGELADO_VIDA_H` (6 h) del inicio: se cierra
y lo congelado se cancela con motivo, para no bloquear el índice de seguimiento único.

**Liberar no es instantáneo.** El worker vuelve a leer la cola solo cuando termina el
lote en curso de TODOS los agentes (hasta `LOTE_MAX` 40 por agente, 4–8 s entre
mensajes) y cada agente arranca con un desfase al azar de hasta 45 s. El 14/10 a las
19:02 se liberaron 20 enlaces mientras se drenaban ~60 recordatorios de 1 h de otra
actividad: el primero salió a las 19:07:53. No es un fallo del congelado.

## «Respondió» en «Quiénes entraron» (14/10/2026)

El panel de entradas de una actividad marca «💬 respondió <fecha>» a quien te escribió por
WhatsApp DESPUÉS del primer mensaje enviado de su seguimiento (`mensajes_programados.enviado_en`
mínimo con `estado='enviado'`), y el subtítulo cuenta cuántos. Solo seguimientos propios: los
chats visibles son los de tu WhatsApp. Usa `entrantes.js`, el mismo cruce que Leads.

## Cancelar a quien no contestó la invitación (14/10/2026)

En la tarjeta de la actividad, **«🔕 Sin respuesta»** (`abrirSinRespuesta`, `seguimiento.js`)
aparece si hay seguimientos MÍOS activos y la actividad aún no empieza. Lista a quienes no
contestaron, todos marcados (se puede desmarcar a quien se sabe que va), y cancela esos
seguimientos con sus mensajes pendientes.

«No contestó» = su primer mensaje ya salió (`enviado`) y no te escribió por WhatsApp
después (`escribioTras`, la misma regla que «💬 respondió»). Quedan fuera quien todavía no
recibe nada y quien abrió su enlace. **No se mira la asistencia**: en catálogo `acc` es por
servicio y sacaría a quien fue a una clase anterior aunque a esta no conteste.

- Solo `owner_id = me`: los chats visibles son los de mi WhatsApp; un director no poda la
  lista de su agente.
- La persona queda «invitada» (`conf` no se toca).
- La regla está duplicada en SQL (`sin_respuesta_de`) para el aviso push de 15 min antes
  del recordatorio de 1 h (ver [[../04-features/notifications]]). Cambiar las dos juntas.

## Los leads no aparecen de primeras (21/10/2026)

Pedido de Sanviv: al programar una actividad la lista arranca **sin leads**; la casilla
«Incluir leads · N» los suma para esa tanda (se apaga al elegir otra actividad). Solo en este
selector: Leads, Comunidad, Masivo y el resto los muestran igual. El filtro vive en `mios()`
(cuello del envío), como las inactivas, para que un segmento guardado no los marque sin
verse; al apagar la casilla, los leads marcados salen de la selección con aviso (DP-001).

## Temperatura y orden de la lista de invitados (21/10/2026)

Cada fila dice, bajo el nombre, **Caliente / Tibio / Frío** y el motivo («te escribió hace
2 d · asistió ayer»), diseño B elegido por Sanviv. Se deriva al pintar (`temperaturaInvitado`,
`seguimiento.js`), no se guarda: la última señal entre el último mensaje entrante a tu WhatsApp
(`entranteDe`, solo personas propias) y la última asistencia (`acc` por servicio y `pun[].acc`,
fechas). Cortes (Sanviv): hasta `TEMP_CALIENTE_D` (5) días caliente, hasta `TEMP_TIBIO_D` (21) tibio,
después o sin señal frío.

Orden (selector «Ordenar» + botón de dirección, que dice en palabras qué queda arriba):
Recientes, Temperatura, A–Z, Membresía. Por defecto **Recientes descendente**, y se reinicia al
elegir otra actividad. «Recientes» = entró a la comunidad (`comunidadDesde`, primer FTD),
elegido por Sanviv; quien no la tiene (leads) va al final en las dos direcciones. Al cambiar de
criterio, la dirección vuelve a la natural de ese criterio (A–Z ascendente, el resto descendente).
Ordenar no toca la selección: solo cambia el orden de lo visible.

Límites conocidos: el mensaje entrante solo cuenta en personas propias (los chats son los de
TU WhatsApp) y depende de que el worker publique `chats_recientes` (~5 min de demora; un canal
sin `chats_sync` deja la temperatura solo con asistencia). `acc` guarda una fecha por servicio
(la última marcada), así que la «última asistencia» es la más reciente entre servicios y
actividades puntuales. Ver [[../05-integrations/whatsapp-worker]].

## «Sin imagen» en la tarjeta y ayuda de la imagen (28/10/2026)

La tarjeta de «Actividades del día» lleva la etiqueta roja **«Sin imagen»** cuando la invitación saldría
solo con texto (ni imagen ni video): sin adjunto propio del agente (en ajenas), sin `actividades.imagen`
y sin imagen del servicio en el catálogo. Misma precedencia que `programar()` (`adjuntoInvitacion`).

En el formulario, el texto de ayuda de la imagen dice si el servicio elegido **tiene o no** imagen en
el catálogo (`pintarAyudaImg`), para saber antes de guardar si la invitación saldrá con imagen.

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