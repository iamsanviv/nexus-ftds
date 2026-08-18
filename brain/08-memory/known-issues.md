# Asuntos conocidos

Este archivo separa defectos abiertos o históricamente abiertos de invariantes ya resueltas. **Verificar estado real antes de afirmar que siguen abiertos.**

## KI-001 — Tope diario del worker y zona horaria

Históricamente el worker contó el día en UTC. En Colombia eso cambia de fecha a las 19:00 y podía consumir la cuota del día siguiente con tráfico de la noche anterior.

### Antes de intervenir

Comprobar el `worker.py` actual en Oracle. Si ya usa `America/Bogota`, actualizar este documento y cerrar el asunto.

---

## KI-002 — Audio/nota de voz

La UI ha ocultado o restringido audio porque existieron fallos de reproducción/entrega aunque el worker tuviera conversión PTT.

### Regla

No habilitar audio solo porque exista código parcial. Probar envío real y reproducción.

---

## KI-003 — Video

El worker documentado históricamente no tenía una rama segura de video y podía tratar `.mp4` como otro tipo de medio.

### Regla

Video debe permanecer deshabilitado hasta confirmar soporte del worker real de extremo a extremo.

---

## KI-004 — Estado de bridges/canales

Los nombres, hosts, puertos y estados de bridges cambian con frecuencia. Cualquier tabla estática de agentes/canales se vuelve obsoleta.

### Regla

Para diagnóstico operativo, consultar `canales_wa` y/o Oracle. No tomar una lista de este brain como inventario vivo.

---

## KI-005 — Diferencias entre README y sistema actual

El README conserva una descripción más pequeña/antigua del producto que el conjunto actual de módulos de FTD, ventas, masivos, seguimiento, tema y canales.

### Acción recomendada

Actualizar README en una tarea documental separada cuando la migración del brain quede validada. No usar el README antiguo como fuente superior al código/brain.

---

## Cómo cerrar un issue

Cuando se confirme que un asunto fue corregido:

1. registrar qué cambió y dónde;
2. mover la lección permanente a `dangerous-patterns.md` o una decisión si todavía protege arquitectura;
3. retirar el asunto de esta lista para no hacer que Claude diagnostique defectos fantasmas.