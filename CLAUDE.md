# Nexus FTDs — Instrucciones para Claude Code

Panel interno de seguimiento de personas, actividades, FTD, ventas y mensajería de WhatsApp para Nexus.

## Stack y restricciones

- HTML + CSS + JavaScript vanilla con ES Modules.
- Sin build step.
- Supabase: PostgreSQL + Auth + RLS + RPC/vistas.
- Cloudflare Workers sirve `public/` como assets estáticos.
- El worker de WhatsApp corre fuera de este repositorio y se documenta en `brain/05-integrations/whatsapp-worker.md`.

No agregar React, Vue, Angular, TypeScript, bundler ni dependencias npm de runtime sin una decisión arquitectónica explícita.

## Idioma y comentarios

- Interfaz, documentación del proyecto y commits: español.
- Los comentarios deben explicar el **porqué** de una decisión no evidente, no repetir lo que ya dice el código.

# Memoria persistente

La memoria del proyecto vive en:

`brain/`

Su router es:

`brain/00-index.md`

**No leas todo `brain/` automáticamente.**

Para cada tarea:

1. entiende qué área modifica;
2. lee `brain/00-index.md` si necesitas contexto persistente;
3. abre únicamente los documentos relevantes;
4. inspecciona después el código citado por esos documentos;
5. verifica la realidad antes de asumir que una nota histórica sigue vigente.

El brain contiene conocimiento; este archivo contiene instrucciones. No vuelvas a convertir `CLAUDE.md` en una bitácora monolítica.

## Jerarquía de verdad

Si dos fuentes se contradicen:

1. instrucción explícita del usuario en la tarea actual;
2. estado verificado de producción (Supabase, Oracle, Cloudflare);
3. código actual;
4. decisiones vigentes en `brain/06-decisions/`;
5. documentación modular de `brain/`;
6. SQL histórico;
7. notas/documentación legacy.

El código puede estar equivocado respecto al comportamiento deseado, pero representa lo implementado. Si código y memoria difieren, identifica la causa antes de modificar ambos.

# Procedimiento de trabajo

Para una modificación no trivial:

1. identifica dominio/feature;
2. consulta memoria relevante;
3. localiza los archivos mínimos de código;
4. comprende la fuente de verdad del dato afectado;
5. implementa el cambio más pequeño que preserve las invariantes;
6. prueba el comportamiento de riesgo, no solo el camino feliz;
7. actualiza `brain/` si cambió conocimiento persistente.

Evita recorrer el repositorio completo cuando el brain ya identifica los archivos relevantes.

# Invariantes que debes tratar como críticas

## Seguridad

- El frontend no es frontera de seguridad; RLS/constraints deben sostener autorización real.
- Nunca expongas `service_role` ni secretos en `public/`.
- No desactives RLS como arreglo rápido.
- `puede_ver_de(owner)` expresa alcance jerárquico; no dupliques esa lógica sin necesidad.

## Mensajería

**Visibilidad no equivale a propiedad de envío.**

Cada usuario escribe únicamente a clientes cuyo `owner_id` corresponde a su propia identidad. Un director puede supervisar clientes de sus agentes, pero no debe enviarles desde su WhatsApp por el solo hecho de verlos.

Antes de tocar selección, programación, campañas o canales, lee:

- `brain/03-domain/messaging-rules.md`
- `brain/08-memory/dangerous-patterns.md`

## Seguimientos

No deben coexistir dos seguimientos `activo` para el mismo cliente y actividad. La base y la UI sostienen esta regla.

La selección para programar debe comenzar vacía y la cantidad confirmada debe coincidir con los destinatarios reales. Un filtro visual nunca debe convertirse en selección silenciosa.

## WhatsApp worker

La identidad de enrutamiento es `owner_id`, no el puerto. Si una tarea toca infraestructura/bridges, consulta `brain/05-integrations/whatsapp-worker.md` y verifica estado vivo cuando sea necesario.

# Base de datos

`sql/` documenta la historia de cambios, pero **no es la fuente absoluta del estado actual de producción**.

Cuando una tarea dependa de tablas, funciones, vistas o políticas vigentes:

1. consulta memoria relacionada;
2. verifica Supabase real si tienes acceso;
3. aplica el cambio de forma reproducible;
4. documenta SQL cuando corresponda;
5. prueba RLS/constraints.

No agregues columnas o flags redundantes sin identificar quién los lee y por qué no puede derivarse el estado de una fuente existente.

# Pruebas

## Interfaz

No des por válido un cambio visual solo leyendo CSS/HTML.

- renderiza escritorio y móvil;
- prueba claro y oscuro si afecta estilos compartidos;
- usa datos representativos, incluidos nombres largos;
- monta el contexto real del componente, incluido encabezado/controles que afecten layout.

Consulta `brain/07-development/testing.md`.

Para rediseños visuales grandes, primero valida el mockup/dirección antes de reestructurar código.

## RLS

Prueba políticas con sesiones simuladas dentro de transacciones `begin ... rollback`. Verifica que el usuario elegido como caso ajeno realmente no pertenezca a la jerarquía.

## Reglas críticas

Cuando una regla nunca debe violarse, prefiere sostenerla también en base de datos mediante constraint/índice/política. Una advertencia de interfaz no protege carreras, dos pestañas ni llamadas directas.

# Despliegue

`main` despliega a producción mediante Cloudflare Workers Builds.

No trates una rama de trabajo como producción. Para cambios con impacto, valida antes de llevarlos a `main` y conserva una ruta clara de rollback.

`wrangler.toml` contiene configuración deliberada para el enlace rastreado `/i`; no simplifiques defaults sin consultar `brain/04-features/tracked-links.md`.

# Cuándo actualizar el brain

Actualiza memoria cuando cambie:

- arquitectura;
- regla de negocio;
- autorización/RLS;
- contrato de datos;
- integración externa;
- decisión técnica importante;
- invariante de seguridad;
- procedimiento de pruebas relevante;
- defecto cuya causa pueda repetirse;
- estado funcional importante.

No actualices memoria por:

- formato;
- rename trivial;
- logs temporales;
- depuración desechable;
- detalle obvio que se descubre instantáneamente leyendo el código;
- contenido generado;
- información ya representada correctamente en otro documento.

Cuando una tarea revele una lección peligrosa, actualiza `brain/08-memory/dangerous-patterns.md` o crea/actualiza una decisión. Cuando un defecto sea temporal, usa `brain/08-memory/known-issues.md` y elimínalo cuando se cierre.

# Memoria legacy

El `CLAUDE.md` monolítico anterior permanece recuperable en Git. Si detectas una regla histórica que todavía no fue promovida al brain, consulta `brain/09-legacy/README.md`, verifica que siga vigente y muévela al documento modular correcto. **No la pegues de vuelta aquí.**