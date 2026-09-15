# Salud y vinculación de canales WhatsApp

## Módulos

- `public/js/canal.js` — estado y vinculación del WhatsApp propio.
- `public/js/salud.js` — alertas de canal y panel de supervisión.

## Fuente operativa

La tabla/vista de salud cambia con frecuencia. Nombres, hosts, puertos y estados de bridges no deben tomarse de una lista estática del brain.

Para diagnóstico real:

1. consultar `canales_wa`/`salud_canales` en Supabase;
2. usar el MCP Oracle si la pregunta depende del estado de VM;
3. contrastar con el worker/bridge correspondiente.

## Propiedad

Un agente gestiona su propio canal.

Un director puede supervisar canales dentro de su jerarquía según las reglas vigentes. Esa supervisión no autoriza a enviar mensajes usando el canal de otro ni a mezclar sus clientes.

## Estado vinculado

El worker solo debe enviar desde el bridge correspondiente al dueño y cuando ese canal esté en un estado operativo válido, históricamente `vinculado`.

Si el canal del dueño no está disponible, el sistema debe fallar de forma visible; nunca hacer fallback a otro WhatsApp.

## `salud_canales`

La vista existe para exponer salud con un alcance controlado y tiene comportamiento de seguridad deliberado. Antes de cambiar `SECURITY DEFINER`/RLS, consultar:

`../08-memory/database-security-traps.md`

## Datos de host y puerto

`host` y `puerto` son ubicación técnica del bridge, no identidad del agente.

La identidad para enrutar mensajes es `owner_id`.

El índice único de puerto se mantuvo históricamente como defensa adicional contra colisiones peligrosas entre VM. No eliminarlo solo porque el enrutamiento correcto ya use `owner_id` sin revisar la decisión y el worker vigente.

## Alta/migración de bridges

No escoger un puerto únicamente mirando `canales_wa`: puede existir infraestructura ya provisionada en una VM antes de que la base refleje correctamente host/puerto.

El runbook operativo detallado sigue en `contexto-worker.md` hasta que ese procedimiento sea migrado o sustituido por una fuente operativa más fiable.

## Baja de canal (retirar a quien dejó la empresa)

Retirar ≠ borrar. La baja apaga **solo infraestructura**: el bridge de esa persona y el puerto que ocupaba. Sus clientes, ventas, seguimientos e historial no se tocan, y su acceso al panel tampoco. Bloquear el ingreso es otra decisión, aún no tomada.

El panel no alcanza la VM, así que la baja es una señal en la base que un ejecutor de la máquina recoge:

1. `dar_de_baja_canal(owner)` (SECURITY DEFINER, exige `es_admin()`) cancela la cola pendiente y sella `canales_wa.baja_en`;
2. `bajas.py` en la VM apaga `nexus-bridge@<slug>`, archiva el directorio y pone `puerto = null`;
3. `deshacer_baja_canal(owner)` solo funciona **mientras el ejecutor no la haya tomado**.

**La señal no puede vivir en `estado`.** El bridge reescribe esa columna en cada latido (~30 s), así que un `estado='baja'` puesto desde el panel dura medio minuto. `baja_en` existe porque es una columna que el bridge nunca toca. Con `puerto` forma toda la máquina de estados, sin banderas extra:

| `baja_en` | `puerto` | `estado` | significado |
|---|---|---|---|
| null | — | — | canal normal |
| puesto | no null | ≠ `bajando` | pedida, sin ejecutar (se puede deshacer) |
| puesto | no null | `bajando` | el ejecutor la reclamó (ya **no** se puede deshacer) |
| puesto | null | `baja` | puerto liberado, hecho |

En `salud_canales`, `salud='baja'` es la **primera** rama del CASE y queda fuera de `alertar`: si no, un canal retirado cae en `sin_canal` y pide atención en rojo para siempre.

Migración: `sql/2026-09-15_23_baja_de_canal.sql`. El ejecutor se documenta en [[../05-integrations/whatsapp-worker]].

## Alertas

Una alerta persistente que nunca puede cerrarse termina perdiendo valor. Diferenciar visual y semánticamente:

- problemas accionables de canal;
- avisos informativos/novedades.

No usar el mismo nivel de alarma para ambos.

## Relacionado

- [[../05-integrations/whatsapp-worker]]
- [[../05-integrations/oracle-mcp]]
- [[../03-domain/messaging-rules]]
- [[../08-memory/database-security-traps]]