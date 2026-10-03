# `bajas.py` — ejecutor de bajas de canal

Código **del lado de la VM**, no servido por Cloudflare. Se guarda aquí para
que quede versionado y recuperable; el despliegue es manual en cada VM con
bridges (el panel no alcanza la VM).

## Qué hace

Cada 2 min (timer de systemd) lee `canales_wa` buscando bajas pendientes
(`baja_en IS NOT NULL AND puerto IS NOT NULL`), resuelve el bridge en **su
propia** máquina por `WA_OWNER=<uuid>` (una fila cuyo bridge vive en la otra VM
se deja pendiente), lo apaga/deshabilita, archiva su carpeta con punto delante
(`.baja-<slug>-<fecha>`, lo único que libera el puerto para `provisionar.sh`) y
cierra la baja poniendo `puerto=null`. Solo biblioteca estándar.

Seguridad: valida el UUID (regex) y el nombre de carpeta contra
`^[a-z0-9][a-z0-9_-]{0,31}$` **antes** de reclamar la fila; `subprocess` con
`shell=False`. Las 20 pruebas están en `prueba_bajas.py`.

## Despliegue (resumen; runbook completo en el brain)

En cada VM (VM1 `141.148.40.31`, VM2 `10.0.0.23`):

1. `mkdir -p /home/ubuntu/nexus-bajas` y copiar `bajas.py` ahí
   (verificar `sha256sum` == el de este repo).
2. Crear `/home/ubuntu/nexus-bajas/.env` con `SUPABASE_URL` y
   `SUPABASE_SERVICE_KEY` (se pueden sacar de cualquier `nexus-bridges/*/env`).
3. Copiar `nexus-bajas.service` y `nexus-bajas.timer` a
   `/etc/systemd/system/`, `daemon-reload`.
4. Dry-run: `python3 bajas.py --simulacro` (debe decir «sin bajas pendientes»).
5. `sudo systemctl enable --now nexus-bajas.timer`.

VM2 no tiene Go/gcc ni (quizá) `nexus-worker/`; por eso el service corre desde
`/home/ubuntu/nexus-bajas/` con su propio `.env`, no desde `nexus-worker`.

Ver `brain/05-integrations/whatsapp-worker.md` (runbook de baja/desactivación) y
`sql/2026-09-15_23_baja_de_canal.sql` (la máquina de estados de la baja).
