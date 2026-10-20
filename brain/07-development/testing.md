# Protocolo de pruebas

## Regla general

Leer el código no basta para validar cambios visuales ni de autorización.

## Visual

Para cambios de interfaz:

1. servir `public/` por HTTP;
2. montar el bloque en su contexto real;
3. inyectar datos representativos;
4. renderizar escritorio y móvil;
5. comprobar tema claro y oscuro cuando el cambio toque estilos compartidos.

Referencias históricas de entorno usadas por Claude Code:

- escritorio: 1280 px;
- móvil: 390 px;
- `npx http-server public` o servidor equivalente;
- Playwright para captura/inspección.

### Capturas de página completa en móvil

`page.screenshot({ fullPage: true })` deja la barra inferior fija (`.tabbar`,
`position:fixed; bottom:0`) a la altura de la ventana (p. ej. 844 px), así que en
la imagen sale **a mitad de la página**, encima del contenido. No es un defecto de
la app (en el teléfono la barra queda al pie: verificado 20/10/2026, `top 774 /
bottom 844` con ventana de 844), pero el usuario lo vio repetido en capturas y lo
reportó como bug varias veces. Para una captura de página completa:

1. medir `document.documentElement.scrollHeight`;
2. `page.setViewportSize({ width: 390, height: alto })`;
3. capturar sin `fullPage`.

Así la barra queda al pie, como se ve al llegar al final en el teléfono. Para
mostrar la pantalla real, capturar además la ventana de 390×844 arriba y al final
del scroll.

### Contexto completo

No aislar un componente de forma que desaparezcan elementos que realmente compiten por ancho o posición. Si vive dentro de `#app`, incluir el encabezado y controles relevantes de `#app`.

Un banco incompleto ya produjo una validación falsa de escritorio.

## Cambios visuales grandes

Antes de implementar un rediseño importante, presentar mockup/opciones y validar la dirección visual. No convertir exploración de diseño en cambios irreversibles de código sin una referencia aprobada.

## RLS

Probar políticas ejecutando operaciones bajo identidades simuladas, dentro de `begin/rollback`.

Comprobar al menos:

- dueño legítimo;
- agente ajeno;
- director correcto;
- director no relacionado;
- admin cuando corresponda.

Antes de una prueba negativa verificar que el usuario usado realmente sea ajeno.

## Mensajería

Para cambios de selección/programación validar:

- selección vacía inicial;
- filtros no alteran silenciosamente la selección;
- cantidad confirmada = cantidad a encolar;
- duplicado activo se omite/bloquea;
- ownership de destinatarios;
- dos pestañas/carrera concurrente cuando una restricción de base sea relevante.

## Cambios de tiempo

Cuando una regla depende de fecha/hora, probar bordes explícitos: antes, exactamente en el límite y después. Evitar razonar solo con ejemplos cómodos.

## Criterio de terminado

Una tarea no está terminada porque el código compile o se vea razonable. Debe probarse el comportamiento que podía romperse y, si el cambio modifica una regla persistente, actualizar el documento correspondiente del brain.