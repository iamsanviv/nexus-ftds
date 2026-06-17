# Nexus · Dashboard de Servicios

Panel para gestionar el acceso de los clientes de la academia Nexus a clases,
operativas y mentorías, con login y dos roles (Director / Agente).

**Stack:** HTML + CSS + JavaScript vanilla (módulos ES, sin build) · Supabase
(Postgres + Auth + RLS) · desplegado en Cloudflare Workers (assets estáticos).

---

## Estructura

```
public/
  index.html            Marcado de la app (login, vistas, modales)
  css/styles.css        Todos los estilos
  js/
    config.js           Credenciales de Supabase + constantes (NIVEL)
    supabase.js         Crea el cliente de Supabase
    state.js            Estado compartido + utilidades + lógica de negocio
    data.js             Consultas y escrituras a Supabase (sin render)
    auth.js             Login, registro, sesión y aplicación del rol
    ui.js               Render de vistas, modales y catálogo
    csv.js              Importar / exportar CSV
    main.js             Punto de entrada (arranque)
wrangler.toml           Configuración de despliegue (assets en /public)
```

Flujo de dependencias (sin ciclos):
`config → supabase → data → ui → {auth, csv} → main`. El estado mutable vive
en un único objeto `state` (en `state.js`) que todos importan.

---

## Desarrollo local

Los módulos ES se cargan por HTTP (no funcionan abriendo el archivo con
`file://`). Levanta un servidor local:

```bash
# Opción recomendada (igual que en producción):
npx wrangler dev

# Alternativas:
npx serve public
# o
python -m http.server 8080 --directory public
```

Abre la URL que te indique la terminal. La app usa la misma base de datos de
Supabase de producción, así que para experimentar sin tocar datos reales puedes
crear un segundo proyecto de Supabase (staging) y cambiar las credenciales en
`public/js/config.js` temporalmente.

---

## Configuración

Las credenciales están en `public/js/config.js`:

- `SUPABASE_URL` y `SUPABASE_ANON`: de Supabase → Project Settings → API.
- La **anon key es pública por diseño** y es seguro tenerla en el repo: las
  políticas RLS de la base de datos son las que protegen los datos.
- **Nunca** pongas aquí la `service_role` key.

El esquema de la base de datos (tablas, roles y políticas RLS) está aparte, en
el archivo `nexus-supabase-schema.sql` que ya corriste en Supabase.

---

## Despliegue (recomendado: Git + Workers Builds)

Conecta este repositorio a tu Worker existente para que cada `git push`
despliegue solo:

1. Sube este repo a GitHub (privado recomendado).
2. En Cloudflare → **Workers & Pages → tu Worker `nexus-ftds` → Settings →
   Builds → Git Repository → Manage** → conecta el repo.
3. Configuración de build:
   - **Build command:** *(vacío)* — es estático, no hay compilación.
   - **Deploy command:** `npx wrangler deploy`
   - **Root directory:** *(raíz del repo)*
4. A partir de ahí:
   - `git push` a `main` → **deploy automático a producción**.
   - Cada Pull Request genera una **URL de preview** para revisar antes de
     hacer merge.

### Volver atrás (rollback)

Si un cambio rompe algo: Cloudflare → tu Worker → **Deployments** → elige una
versión anterior → **Rollback**. Instantáneo.

### Despliegue manual (sin Git, alternativa)

```bash
npx wrangler deploy
```

---

## Cómo actualizar sin romper nada

1. Crea una rama: `git checkout -b cambio-x`
2. Edita los archivos en `public/`.
3. Prueba en local con `npx wrangler dev`.
4. `git push` de la rama → revisa en la **URL de preview**.
5. Si todo bien, merge a `main` → deploy a producción.
6. Si algo falla en producción, **rollback** desde el dashboard.

---

## Nota sobre el login y la URL

En Supabase → **Authentication → URL Configuration**, el **Site URL** y las
**Redirect URLs** deben apuntar a la dirección pública del Worker para que la
confirmación de correo de nuevos agentes funcione:

```
https://nexus-ftds.santiagoviveros18.workers.dev
https://nexus-ftds.santiagoviveros18.workers.dev/**
```
