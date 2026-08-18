# Nexus FTDs Brain en Obsidian

`brain/` es la memoria persistente del proyecto para Claude Code y, al mismo tiempo, un conjunto de notas Markdown navegable desde Obsidian.

No hay una API especial entre Claude Code y Obsidian. Ambos leen y escriben los mismos archivos del repositorio.

## Estado de esta integración

La parte que vive en Git ya queda preparada con esta rama:

- `brain/` versionado;
- `CLAUDE.md` como bootstrap pequeño;
- enlaces internos;
- `.obsidian/` ignorado por Git.

La única activación que debe hacerse físicamente en cada computador es abrir la carpeta local del repositorio como vault. GitHub no puede realizar ese clic dentro de Obsidian por el usuario.

## Abrir el proyecto como vault

En el equipo donde está clonado `nexus-ftds`:

1. traer la rama/versión que contiene el brain;
2. abrir Obsidian;
3. elegir **Open folder as vault / Abrir carpeta como vault**;
4. seleccionar la carpeta raíz del repositorio `nexus-ftds`, no solamente `brain/`;
5. Obsidian creará `.obsidian/` dentro del repositorio;
6. `.obsidian/` ya está ignorado por Git y no debe versionarse.

La carpeta `brain/` sí se versiona.

## Por qué el vault es la raíz

Abrir todo `nexus-ftds` permite navegar desde una nota del brain hacia archivos como:

- `CLAUDE.md`;
- `README.md`;
- `public/js/...`;
- `sql/...`;
- `mcp/...`;
- `contexto-worker.md` mientras siga existiendo como fuente legacy/operativa.

## Punto de entrada humano

Abrir primero:

`brain/00-index.md`

Ese archivo funciona como mapa del conocimiento y router por tipo de tarea.

## Punto de entrada de Claude Code

Claude Code comienza con:

`CLAUDE.md`

Ese archivo le indica que consulte `brain/00-index.md` solo cuando la tarea necesite contexto persistente y que lea únicamente las notas pertinentes.

## Enlaces Obsidian

Los documentos usan enlaces `[[...]]` para formar un grafo navegable.

Los enlaces son ayuda de navegación, no una orden para cargar todas las notas relacionadas en el contexto de Claude.

## Plugins

No hace falta instalar plugins comunitarios para que esta arquitectura funcione.

Primero mantener el sistema basado en Markdown plano. Agregar un plugin solo si resuelve una necesidad concreta sin convertir el vault en una dependencia para Claude Code.

## Git

El contenido del brain debe viajar con los cambios relevantes del proyecto.

La configuración personal de Obsidian no.

```text
versionado:
  brain/
  CLAUDE.md

no versionado:
  .obsidian/
```

## Regla de salud

Si navegar el brain empieza a requerir abrir muchas notas para una tarea sencilla, la arquitectura está perdiendo su propósito. Revisar duplicaciones, documentos demasiado amplios o un índice poco preciso.

Ver:

- [[07-development/brain-maintenance]]
- [[00-index]]