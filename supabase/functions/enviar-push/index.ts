// Edge Function `enviar-push`: entrega por Web Push la cola `notificaciones`.
//
// La invocan `disparar_push()` (al encolar) y el cron de cada minuto (para
// reintentar). No recibe parámetros: reclama lo pendiente con
// `reclamar_notificaciones()`, que es quien impide el doble envío cuando dos
// invocaciones coinciden.
//
// Despliegue: con el MCP de Supabase (deploy_edge_function, verify_jwt=true).
// SQL y diseño: sql/2026-10-14_34_notificaciones_push.sql.
import * as wpMod from "npm:web-push@3.6.7";
// En el runtime de Supabase el default import de este paquete CommonJS llega
// incompleto (faltaba setVAPIDDetails, aunque en Deno local sí está).
const webpush: any = (wpMod as any).default?.sendNotification ? (wpMod as any).default : wpMod;
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

// Apple rechaza el JWT VAPID sin un `sub` válido (mailto: o https:).
const SUJETO = "https://nexus-ftds.nexus-pro.workers.dev";

type Claves = { publica: string | null; privada: string | null };

async function claves(): Promise<Claves> {
  let { data, error } = await sb.rpc("vapid_claves");
  if (error) throw error;
  if (!data?.privada) {
    // Primera ejecución: el par se crea aquí para que la privada nunca pase
    // por nadie. Si otra invocación ganó la carrera, guardar_vapid falla o no
    // hace nada, y la relectura trae el par que quedó.
    const k = webpush.generateVAPIDKeys();
    await sb.rpc("guardar_vapid", { p_publica: k.publicKey, p_privada: k.privateKey });
    ({ data, error } = await sb.rpc("vapid_claves"));
    if (error) throw error;
  }
  return data as Claves;
}

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async () => {
  try {
    const k = await claves();
    const vapidDetails = { subject: SUJETO, publicKey: k.publica!, privateKey: k.privada! };

    const { data: lote, error } = await sb.rpc("reclamar_notificaciones", { p_limite: 100 });
    if (error) throw error;
    if (!lote?.length) return json({ enviadas: 0 });

    const duenos = [...new Set(lote.map((n: any) => n.owner_id))];
    const { data: subs, error: e2 } = await sb
      .from("push_suscripciones").select("endpoint, owner_id, p256dh, auth").in("owner_id", duenos);
    if (e2) throw e2;

    const muertas = new Set<string>();
    const usadas = new Set<string>();
    const enviadas: number[] = [];

    for (const n of lote) {
      const suyas = (subs || []).filter((s: any) => s.owner_id === n.owner_id && !muertas.has(s.endpoint));
      const carga = JSON.stringify({ titulo: n.titulo, cuerpo: n.cuerpo, url: n.url, tag: `${n.tipo}:${n.clave}` });
      const res = await Promise.allSettled(suyas.map((s: any) =>
        webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          carga,
          { TTL: 3600, urgency: "high", vapidDetails },
        )));
      let alguna = false;
      res.forEach((r, i) => {
        if (r.status === "fulfilled") { alguna = true; usadas.add(suyas[i].endpoint); return; }
        const code = (r.reason as any)?.statusCode;
        // 404/410: el navegador revocó la suscripción (desinstaló, borró
        // datos, quitó el permiso). No vuelve; se borra.
        if (code === 404 || code === 410) muertas.add(suyas[i].endpoint);
        else console.error("push falló", code, (r.reason as any)?.body || String(r.reason));
      });
      // Sin dispositivos vivos tampoco hay a quién reintentar: se cierra.
      if (alguna || suyas.every((s: any) => muertas.has(s.endpoint))) enviadas.push(n.id);
    }

    const ahora = new Date().toISOString();
    if (enviadas.length) await sb.from("notificaciones").update({ enviada_en: ahora }).in("id", enviadas);
    if (muertas.size) await sb.from("push_suscripciones").delete().in("endpoint", [...muertas]);
    if (usadas.size) await sb.from("push_suscripciones").update({ usada_en: ahora }).in("endpoint", [...usadas]);

    return json({ reclamadas: lote.length, enviadas: enviadas.length, borradas: muertas.size });
  } catch (e) {
    console.error(e);
    return json({ error: String((e as any)?.message || e) }, 500);
  }
});
