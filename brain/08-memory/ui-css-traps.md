# Trampas de UI y CSS

Consultar este documento cuando una tarea toque estilos compartidos, formularios, modales o bancos de prueba visuales.

## Especificidad de `.frow`

`.frow label` tiene más especificidad que una clase suelta aplicada al mismo elemento.

Defectos históricos hicieron que controles como checkboxes/toggles heredaran estilos de etiqueta de campo: mayúsculas, tamaño, espaciado y márgenes incorrectos.

Patrón correcto cuando un control necesita sobrescribir esa regla:

- apuntar al elemento con una regla igual o más específica, por ejemplo `.frow label.chkline` o `.frow label.segtoggle`;
- restablecer todas las propiedades heredadas que correspondan;
- no usar `!important` como parche automático.

## `z-index` y bancos de prueba

`.tabbar` y `.overlay` han compartido el mismo `z-index`. En el producto el orden del DOM sostiene el resultado esperado.

Un banco de prueba que reconstruya esos elementos en otro orden puede producir un modal tapado por la barra aunque producción no tenga el defecto.

Antes de corregir CSS por un fallo visto solo en un harness, comprobar que el harness conserva el orden real del DOM.

## No copiar markup viejo en el banco

Un banco visual que mantiene una copia manual de una tarjeta envejece silenciosamente.

Para componentes críticos, extraer o reutilizar el markup/lógica real de `ui.js` y cargar `state.js` real cuando sea razonable. El objetivo es probar la interfaz actual, no una maqueta que alguna vez se parecía.

## Responsive

La frontera vigente de escritorio es 1040 px para el rediseño documentado.

El sistema nació móvil. Muchas decisiones de escritorio están deliberadamente encerradas en `@media (min-width:1040px)` o `matchMedia` para no alterar móvil.

Cuando una tarea diga "solo escritorio", comprobar explícitamente que la rama móvil sigue igual.

## Modo claro

El modo claro depende de tokens.

- `tema.js` aplica `data-tema` temprano para evitar parpadeo.
- `tema.css` redefine tokens.
- rellenos dorados usan el token destinado a fondo (`--gold-fill`) cuando corresponda, no asumir que el token de texto dorado tiene contraste suficiente en ambos temas.
- evitar introducir hexes aislados en una vista si ya existe un sistema de tokens.

## Filas de personas

En escritorio, nombre, teléfono, progreso y acciones conviven en una fila compacta.

Detalles históricos que protegen layout:

- elipsis en el elemento de texto (`.nmlink`), no en un contenedor con elementos auxiliares como bandera;
- nombres largos deben ser parte de la prueba visual;
- el buscador también puede encontrar por teléfono;
- las tarjetas de membresía pueden actuar como filtros y combinarse con filtro de progreso.

## Regla de prueba

No declarar corregido un problema visual únicamente porque el CSS "parece correcto". Renderizar 1280/390 o los breakpoints relevantes, y en claro/oscuro cuando toque tokens compartidos.

## Relacionado

- [[../04-features/ui-theme-responsive]]
- [[../07-development/testing]]
- [[dangerous-patterns]]