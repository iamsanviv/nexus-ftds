# Resumen nocturno con IA

`resumir.py` escribe `clientes.necesidad` y `clientes.recomendacion` leyendo la
conversación de WhatsApp de cada cliente en el `messages.db` del bridge (solo
lectura, sin candado). Detalle y decisiones: cabecera de `resumir.py` y
`brain/04-features/people-followup.md` («Vista Tabla de Comunidad»).

Va en la VM donde vive el bridge del agente (Sanviv: VM1, slug `santiago_viveros`).

## Instalación (VM1)

1. SQL `sql/2026-11-23_76_resumen_ia.sql` aplicado.
2. `mkdir -p ~/nexus-resumen-ia` y copiar `resumir.py`.
3. `.env` junto al script con `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` (mismo formato que `chats-sync`), `chmod 600`.
4. `chats_sync.py` se importa de `/home/ubuntu/nexus-worker` (o `CHATS_SYNC_DIR`).
5. Prueba sin escribir: `python3 resumir.py --simulacro --tel 573007283226`.
6. Primera carga (todos los clientes, con todo su historial): `python3 resumir.py --todos`.
7. `sudo cp nexus-resumen-ia.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now nexus-resumen-ia.timer`.

Presupuesto por vuelta: `NEXUS_RESUMEN_NEURONAS` (por defecto 4000 de las 10.000
neuronas diarias gratis, que comparte con `chats_sync`). Quien no alcanza queda en
`pendientes` (`~/.nexus-resumen-ia.json`) para la vuelta siguiente; los clientes sin
necesidad guardada también entran solos, así que no hace falta repetir `--todos`.

Activar a otro agente = una fila en `resumen_ia_agentes` (solo service_role).
Desactivar: `sudo systemctl disable --now nexus-resumen-ia.timer`.
