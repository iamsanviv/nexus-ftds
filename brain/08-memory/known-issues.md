# Asuntos conocidos

Este archivo separa defectos abiertos o históricamente abiertos de invariantes ya resueltas. **Verificar estado real antes de afirmar que siguen abiertos.**

## KI-001 — Tope diario del worker y zona horaria

Históricamente el worker contó el día en UTC. En Colombia eso cambia de fecha a las 19:00 y podía consumir la cuota del día siguiente con tráfico de la noche anterior.

### Antes de intervenir

Comprobar el `worker.py` actual en Oracle. Si ya usa `America/Bogota`, cerrar este asunto y conservar solo la lección pertinente.

---

## KI-002 — Audio/nota de voz

La UI ha ocultado o restringido audio porque existieron fallos de reproducción/entrega aunque el worker tuviera conversión PTT.

### Regla

No habilitar audio solo porque exista código parcial. Probar subida, envío, recepción y reproducción real.

---

## KI-003 — Video llega como nota de voz

**Causa raíz encontrada el 20/08/2026, y no estaba donde decía la nota vieja.**

En `worker.py` de la VM:

```python
AUDIO_EXTS = {".webm", ".m4a", ".mp4", ".aac", ".ogg", ...}
def es_audio(url):
    return os.path.splitext(...)[1].lower() in AUDIO_EXTS
```

`.mp4` está en esa lista, así que **todo** mp4 se clasifica como audio y pasa por `convertir_a_ogg`, que lleva `-vn` — le arranca la pista de video — y sale como PTT.

Comprobado sobre el archivo real enviado el 20/08: `ffprobe` reporta `h264` + `aac`, y `es_audio()` del worker en producción devuelve `True` para esa misma URL.

`.mov` **no** está en `AUDIO_EXTS`, así que MOV sí sale como video. Ese es el motivo de que las dos pruebas del 30/07 no se comportaran igual, aunque la nota de entonces las metiera en el mismo saco.

### La lección, que es más general que el video

El bridge y el worker se reparten la decisión de qué tipo de mensaje sale, y **los dos deciden por la extensión del archivo**. `.mp4` y `.webm` son contenedores: valen igual para audio que para video. Cualquier regla basada solo en la extensión va a equivocarse con ellos.

Verificar el bridge no basta: el worker puede haber transformado el archivo antes de que el bridge lo vea. Ese fue justamente el error de diagnóstico del 20/08 — se leyó el bridge, se dio por bueno, y el `-vn` estaba un paso antes.

### Estado

- frontend: listo, MP4 y MOV habilitados (rama `claude/masivo-video`);
- Storage: acepta video, tope 16 MB;
- bridge: mapea `mp4`/`mov`/`avi` a `VideoMessage` — verificado en el binario en uso;
- **worker: pendiente.** Mientras `.mp4` siga en `AUDIO_EXTS`, MP4 sale como nota de voz. MOV ya funciona.

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

## Cómo cerrar un issue

Cuando se confirme que un asunto fue corregido:

1. registrar qué cambió y dónde;
2. mover la lección permanente a `dangerous-patterns.md`, `database-security-traps.md` o una decisión si todavía protege arquitectura;
3. retirar el asunto de esta lista para no hacer que Claude diagnostique defectos fantasmas.