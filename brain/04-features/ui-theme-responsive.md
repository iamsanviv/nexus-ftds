# Interfaz, tema y responsive

## Principio

El diseño de escritorio y móvil comparte producto, pero no necesariamente estructura visual. Los cambios recientes están deliberadamente condicionados por ancho para no alterar la experiencia móvil al rediseñar escritorio.

## Tema

`public/js/tema.js` gestiona la preferencia claro/oscuro y `localStorage`. El tema se aplica temprano para evitar parpadeos. Los estilos compartidos usan tokens CSS; no introducir colores fijos que rompan contraste en uno de los temas cuando ya existe un token semántico.

## Escritorio

Cambios recientes incluyen:

- barra lateral fija en lugar de cinta inferior;
- tarjeta FTD reorganizada en columnas;
- tarjetas de membresía como filtros;
- buscador integrado con filtros;
- filas de cliente horizontales;
- selector Comunidad/Leads reubicado;
- búsqueda por nombre y teléfono.

Gran parte de esta estructura se activa alrededor de `min-width: 1040px` o mediante `matchMedia` según el módulo. Antes de tocar una regla, comprobar dónde está gateada actualmente.

## Móvil

El objetivo de varias fases recientes fue mantener móvil sin cambios funcionales mientras se rediseñaba escritorio. No eliminar condicionales responsive por "simplificación" sin renderizar ambas variantes.

## Pruebas

Para cambios de UI:

- 1280 px escritorio;
- 390 px móvil;
- tema claro;
- tema oscuro;
- datos con nombres largos y casos representativos;
- contexto completo del encabezado y controles reales.

Consultar [[../07-development/testing]].

## Código relacionado

- `public/index.html`
- `public/css/styles.css`
- archivos de tema CSS existentes
- `public/js/tema.js`
- `public/js/seguimiento.js`
- `public/js/ftd.js`

## Relacionado

- [[../07-development/testing]]
- [[../01-product/current-state]]