# Asuntos conocidos

Este archivo separa defectos abiertos o históricamente abiertos de invariantes ya resueltas. **Verificar estado real antes de afirmar que siguen abiertos.**

## KI-001 — Tope diario del worker y zona horaria · CERRADO 06/10/2026

El worker contaba el día en UTC. En Colombia eso cambia de fecha a las 19:00, así que lo enviado de 7pm a medianoche se cobraba al día siguiente y bloqueaba a quien trabaja de noche (fue justo lo que cortó un seguimiento de leads: 232 mensajes de la noche anterior «contaban» contra el día).

**Arreglo aplicado en producción (VM, worker reiniciado):** el arranque del día en `enviados_hoy` usa UTC-5 fijo. Parche idempotente y copia de referencia en `vm/worker/tope_colombia.py` (reemplaza `datetime.now(timezone.utc).replace(hour=0…)` por `datetime.now(timezone(timedelta(hours=-5))).replace(hour=0…)`). Se verificó que el cupo volvió a 220/220. UTC-5 fijo a propósito: Colombia no tiene horario de verano.

**Aviso en la plataforma (`main`):** `data.cuotaDiaria()` (TOPE_DIARIO=220) muestra en el footer del masivo y del seguimiento lo que llevas hoy y, si la tanda no cabe, cuántos no saldrán; el confirm lo repite. Es solo aviso: el enforcement real es del worker.

### La lección, que sobrevive al defecto

El «día» de cualquier tope/corte es el de Colombia, no UTC. Cualquier cálculo de ventana diaria en el worker (que corre en UTC) debe fijar la zona a UTC-5 explícitamente, no asumir la del servidor.

---

## KI-002 — Audio/nota de voz

La UI ha ocultado o restringido audio porque existieron fallos de reproducción/entrega aunque el worker tuviera conversión PTT.

### Regla

No habilitar audio solo porque exista código parcial. Probar subida, envío, recepción y reproducción real.

---

## KI-003 — Video llega como nota de voz · CERRADO 20/08/2026

**Causa:** en `worker.py` de la VM, `.mp4` estaba dentro de `AUDIO_EXTS`. Todo mp4 se clasificaba como audio y pasaba por `convertir_a_ogg`, que lleva `-vn` y le arranca la pista de video. `.mov` no estaba en la lista, por eso MOV sí salía como video.

**Arreglo aplicado en producción:** `es_audio()` recibe ahora la ruta ya descargada y, para las extensiones ambiguas (`.mp4`, `.webm`), decide con `ffprobe` según el archivo traiga o no una pista de video. Se ignora `attached_pic` para que la carátula de un mp3 no lo convierta en video. Si `ffprobe` falla se conserva el comportamiento anterior (audio): degradar un video es peor que romper las notas de voz que ya funcionaban.

Respaldo: `worker.py.bak-video-2026-08-20-1826`.

**Verificado antes de reiniciar** sobre archivos reales del bucket: los tres videos → no audio; una nota de voz `.webm` real → sigue siendo audio. Y después, con un envío real: llegó como video reproducible.

### Lo que dejó de paso

El texto que acompaña a un adjunto viaja como **pie** en el mismo mensaje; solo el audio lo manda aparte, porque una nota de voz no admite pie. Mientras el video se clasificaba como audio, su texto salía como mensaje suelto — eso también quedó arreglado.

### La lección, que sobrevive al defecto

Bridge y worker deciden el tipo de mensaje por la **extensión**, y `.mp4`/`.webm` son contenedores que valen para audio y para video. Cualquier regla basada solo en la extensión se equivoca con ellos.

Y verificar un componente no dice nada del otro: el 20/08 se leyó el bridge, se dio el caso por cerrado, y el `-vn` estaba un paso antes.

## KI-004 — Estado de bridges/canales

Los nombres, hosts, puertos y estados de bridges cambian con frecuencia. Cualquier tabla estática de agentes/canales se vuelve obsoleta.

### Regla

Para diagnóstico operativo, consultar `canales_wa`, `salud_canales` y/o Oracle. No tomar una lista histórica del brain como inventario vivo.

---

## KI-005 — README desactualizado respecto al sistema actual

El README conserva una descripción más pequeña del producto que el conjunto actual de módulos de FTD, ventas, masivos, seguimiento, tema y canales.

### Acción

Actualizar README en una tarea documental separada una vez validado el brain.

---

## KI-006 — Recuperación de contraseña

Históricamente el cambio de contraseña con sesión abierta funciona, pero la ruta de "olvidé mi contraseña" necesita flujo `recovery` y SMTP apropiado para producción.

### Verificar

- configuración actual de Supabase Auth;
- SMTP actual;
- manejo de enlaces `type=recovery`;
- pantalla de establecimiento de nueva contraseña.

Ver [[../04-features/authentication-approval]].

---

## KI-007 — Números de México

El worker ya incorporó un reintento alternando el `1` después del código 52 cuando aparece `no LID found`, pero históricamente siguió existiendo una tasa relevante de fallos.

No implementar "el reintento" otra vez sin revisar el worker: ya existía. Diagnosticar por qué no cubre todos los casos.

---

## KI-008 — CSV y asistencias puntuales

La documentación histórica indica que el CSV no incluye `clientes.puntuales`.

Verificar comportamiento vigente de `public/js/csv.js` antes de extenderlo. El importador históricamente inserta y no actualiza registros existentes.

---

## KI-009 — Cierre/base FTD

Históricamente la app calcula la base que debe pasar al siguiente mes, pero parte del cierre/base todavía requería intervención manual.

Verificar la UI y la base vigentes antes de implementar automatización. Un mes ya cerrado no debe reescribirse retroactivamente por un agente normal.

---

## KI-010 — Meta mensual de facturación

La meta comercial de facturación es distinta de las metas de FTD. Fue pedida y aplazada mientras se estabilizaban ventas/FTD.

No confundir esta funcionalidad pendiente con el sistema actual de metas FTD.

---

## KI-011 — Cobro por uso / planes de mensajería

La infraestructura ya permite medir mensajes por `owner_id` y el worker tiene topes de protección. Eso no equivale a un sistema de suscripción o billing.

Para convertirlo en producto por uso faltaría, como mínimo, una fuente de plan/cuota por agente y enforcement en el worker/backend, no solo en navegador.

---

## KI-012 — Riesgo operativo de WhatsApp personal

El sistema envía desde números reales de los agentes. La variación de texto y el goteo reducen patrones, pero no eliminan riesgo de restricciones de WhatsApp.

Tratar cualquier cambio que aumente volumen, simultaneidad o destinatarios desconocidos como cambio de riesgo, no solo de UX.

---

## KI-013 — Video `.mov` no llega aunque el worker diga «enviado» (06/10/2026)

Un video subido como `.mov` (contenedor QuickTime, aunque adentro sea H.264/AAC) se sube al CDN de
WhatsApp y el bridge reporta `Media uploaded OK` + `Message sent true`, pero **el destinatario no
recibe nada** — ni un recuadro de error. El cliente de WhatsApp descarta en silencio el video que no
viene en contenedor MP4 válido. La fila queda `enviado`: no es un bug de estado. Los mensajes de
texto del mismo flujo (serie de seguimiento) sí llegan, por eso se nota como «el mensaje del video
desapareció».

Apareció con el módulo de seguimiento a leads, pero NO es del módulo: el adjunto viaja idéntico al
masivo (misma `subirImagenMensaje`, misma URL `.mov`, mismo `media_url`). Fue la primera vez que se
mandó un `.mov` real a un teléfono y se verificó la recepción. La nota «solo MP4 y MOV» de
`media-attachments.md` solo decía que el filtro los admite, no que ambos lleguen.

**Mitigado en la subida (08/10/2026):** ya no se puede subir un video que no sea MP4. Tres capas,
todas en producción: `TIPOS_ADJUNTO` (state.js) sin `video/quicktime`; `validarAdjunto` exige además
extensión `.mp4` para video (por si el navegador reporta un `.mov` como `video/mp4`); y el bucket
`mensajes` solo acepta `video/mp4` (se le quitaron `video/quicktime` y `video/webm`). El agente que
intente subir un `.mov` ve «El video debe ser .mp4 — conviértelo a MP4» en vez de un envío fantasma.

**Arreglo de fondo, opcional (no aplicado):** que `worker.py` remuxee a MP4 limpio
(`ffmpeg -c copy -movflags +faststart`) para poder volver a aceptar `.mov` sin que el agente convierta
a mano, y fijar `Width/Height/Seconds` + miniatura en el `VideoMessage` para la vista previa. Ya no es
urgente: con el bloqueo de subida el defecto no puede llegar a un destinatario. Se deja como mejora de
UX, no como defecto abierto.

---

## Cómo cerrar un issue

Cuando se confirme que un asunto fue corregido:

1. registrar qué cambió y dónde;
2. mover la lección permanente a `dangerous-patterns.md`, `database-security-traps.md` o una decisión si todavía protege arquitectura;
3. retirar el asunto de esta lista para no hacer que Claude diagnostique defectos fantasmas.

---

## KI-007 — Plantillas guardadas que dicen «hoy» a mano

Las plantillas por defecto ya usan `{dia}`, pero **cada agente puede tener la suya guardada**, y esa manda. Al 21/08/2026:

- Santiago: dice «El día de hoy» — hay que restaurar para adoptar `{dia}`;
- Daniel: dice «Esta noche tenemos» — mismo problema, y encima falla también si la actividad es de mañana por la tarde.

Mientras no las actualicen, la red que los protege es el aviso del diálogo de programación, que detecta «hoy», «esta noche», «esta tarde» y «esta mañana».

Se cierra cuando las dos plantillas guardadas usen `{dia}`.


---

## KI-008 — `bajas.py`: instalado, falta ver una baja real de punta a punta

Desplegado el 2026-10-03 como timer `nexus-bajas` (cada 2 min) en **ambas VMs** (`vm/bajas/`, `WorkingDirectory=/home/ubuntu/nexus-bajas` con su propio `.env`). Dry-run (`--simulacro`) limpio y las 20 pruebas unitarias en verde en las dos máquinas; credenciales y conexión verificadas.

**Lo único sin observar** es una baja real ejecutada por el timer (stop + disable + archivar `.baja-…` + liberar puerto): las 5 bajas del 2026-10-03 se hicieron a mano antes de instalarlo, así que no quedaban pendientes para que las tomara. Se cierra cuando la próxima baja real corra sola y limpia.
