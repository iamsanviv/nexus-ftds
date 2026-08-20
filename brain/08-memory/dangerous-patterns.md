# Patrones peligrosos

Errores que ya produjeron daño real o estuvieron cerca de hacerlo. No tratarlos como anécdotas: son invariantes de diseño.

## DP-001 — Selección invisible de destinatarios

### Incidente

El panel de programación preseleccionaba a todos los faltantes. El buscador ocultaba filas, pero no las retiraba de `segSel`. Un agente podía ver un solo nombre y, al programar, encolar decenas.

Se observaron 43 registros programados en el mismo milisegundo después de unas pocas selecciones manuales.

### Causa

Confundir tres conjuntos diferentes:

- visibles;
- seleccionados;
- destinatarios finalmente encolados.

### Protección

- `segSel` nace vacío.
- "Marcar visibles" respeta el filtro.
- Confirmación siempre antes de encolar.
- Mostrar cantidad real y nombres representativos.
- No introducir nuevamente selección masiva implícita.

---

## DP-002 — Duplicar seguimientos activos

### Incidente

Una advertencia de UI permitía aceptar duplicados. Se llegaron a crear múltiples seguimientos activos por cliente y actividad, con ráfagas repetidas de mensajes.

### Protección

- invariante en base: máximo un seguimiento `activo` por `(cliente_id, actividad_id)`;
- la UI omite duplicados activos en vez de preguntarle al operador si quiere correr el riesgo;
- traducir conflicto 23505 a mensaje entendible;
- `cancelado` y `completado` no bloquean una nueva programación válida.

---

## DP-003 — Enrutar bridges por puerto

### Incidente

Al distribuir bridges entre más de una VM, se usó el puerto como clave global. El mismo número de puerto podía existir en hosts distintos y una entrada pisó a otra. Mensajes de un agente terminaron saliendo por el WhatsApp de otra persona; un número fue bloqueado.

### Protección

La identidad es `owner_id`.

```text
owner_id -> host + puerto
```

Si no se resuelve el canal correcto, fallar cerrado. Nunca caer por defecto a `localhost` o a un bridge distinto.

---

## DP-004 — Suponer que visibilidad RLS autoriza envío

### Riesgo

Un director ve clientes de sus agentes para supervisar. Usar "todo lo visible" como población de envío hace que su WhatsApp contacte clientes que no le pertenecen.

### Protección

Para envío:

```text
cliente.owner_id == auth.uid()
```

La visibilidad jerárquica y la propiedad de envío son conceptos separados.

---

## DP-005 — Borrar padre antes de cancelar dependencias

Eliminar una actividad antes de cancelar seguimientos/mensajes deja dependencias sin un identificador fiable para limpieza.

### Protección

Cancelar primero, borrar después.

---

## DP-006 — Falsos positivos en pruebas RLS

Se escogió como usuario supuestamente ajeno alguien que sí pertenecía a la jerarquía del director. La política parecía demasiado permisiva cuando la prueba estaba mal construida.

### Protección

Antes de una prueba negativa, verificar explícitamente relaciones `director_id` y owner.

---

## DP-007 — Banco visual incompleto

Probar solo el bloque modificado sin el encabezado/entorno real ocultó problemas de escritorio que aparecieron al desplegar.

### Protección

Si el componente vive en `#app`, el banco debe montar el contexto real necesario: encabezado, selector, buscador y contenedor. Validar render a escritorio y móvil.

---

## DP-008 — Columna/estado redundante sin lector

El proyecto ya ha sufrido campos escritos que nadie consumía o flags que duplicaban una verdad derivable. Esto produce estados muertos que confunden futuras modificaciones.

### Protección

Antes de agregar una columna o bandera, responder:

1. ¿quién la lee?
2. ¿existe ya otra fuente de verdad?
3. ¿puede derivarse de datos actuales?

Ejemplos: el rastreo se determina por presencia de `clic_token`; el progreso de campañas se calcula desde mensajes reales, no desde un contador paralelo.
---

## DP-009 — Mensaje que sale antes que la invitación

### Incidente

19/08/2026. Una agente programó una actividad de las 19:00 y difirió la invitación a las 18:01, precisamente para saltarse el recordatorio de una hora. El recordatorio salió igual, a las 18:00: **61 personas leyeron «en 1 hora empieza X» un minuto antes de ser invitadas.**

La causa es que los cuatro recordatorios se cuelgan del **inicio de la actividad**, mientras que la invitación se cuelga de **cuándo se invita**. Son dos relojes distintos y el código solo comparaba contra `ahora`, así que un mensaje futuro pero anterior a la invitación pasaba el filtro.

Con la invitación inmediata el defecto no se ve: todo lo pasado ya se descartaba. Solo aparece al diferirla, que es cuando los dos relojes se separan.

### Protección

- la invitación es el **primer contacto**: nada del mismo seguimiento puede salir antes o en el mismo instante;
- la referencia es la hora de la invitación, no `ahora`. Sin invitación (el agente ya invitó por fuera) vuelve a ser `ahora`;
- lo que se omite **se dice** en el aviso de confirmación, con nombre propio: saltarse un recordatorio en silencio se descubre tarde;
- la misma regla aplica al **cambio de hora** de la actividad, que recalcula los recordatorios y puede meterlos antes de una invitación todavía pendiente. Ahí el piso es `max(ahora, invitación pendiente)`.

### Señal para el futuro

Cuando dos mensajes de un mismo flujo se calculan desde orígenes distintos, comparar contra `ahora` no ordena nada. Hay que comparar contra el hito que los ordena de verdad.
