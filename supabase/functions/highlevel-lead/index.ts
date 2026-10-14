// Edge Function `highlevel-lead`: recibe los leads que un workflow de
// HighLevel empuja cuando un contacto queda asignado al agente.
//
// El agente no tiene token de la API de HighLevel, por eso el flujo es al
// revés: HighLevel llama aquí. No hay JWT (HighLevel no sabe de Supabase): la
// identidad es el token secreto de `crm_tokens` en la URL (`?t=…`). Sin token
// válido no se escribe nada. Es la única vía de inserción en `crm_leads`.
//
// Desde el 14/10/2026 el lead entra además como persona de Nexus (lead) al
// llegar: se enlaza con quien ya tenga ese número o se crea. Así el agente
// puede anotarle registro y promesa antes de que baje a WhatsApp.
//
// Despliegue: MCP de Supabase (deploy_edge_function, verify_jwt=false).
// SQL y diseño: sql/2026-10-14_35_crm_leads.sql, sql/2026-10-14_36_crm_leads_clientes.sql
// · brain/04-features/mi-dia.md.
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// HighLevel manda el contacto con nombres de campo que varían según la acción
// del workflow (Webhook estándar o Custom Webhook). Se aceptan las variantes
// conocidas y se guarda el cuerpo completo en `payload` por si falta alguna.
const primero = (...v: unknown[]) => v.find(x => typeof x === "string" && x.trim()) as string | undefined;

// Mismo criterio que `claveTel` (public/js/entrantes.js): WhatsApp y HighLevel
// guardan el «1» de móvil de México (521…) y el «9» de Argentina (549…); la
// ficha a veces no.
const claveTel = (t?: string | null) => {
  const d = (t || "").replace(/\D/g, "");
  if (/^521\d{10}$/.test(d)) return "52" + d.slice(3);
  if (/^549\d{10}$/.test(d)) return "54" + d.slice(3);
  return d;
};
const hoyCO = () => new Date(Date.now() - 5 * 3600e3).toISOString().slice(0, 10);

// La persona en Nexus: la que ya tenga ese número (no se duplica) o una nueva.
async function personaPara(owner: string, nombre: string | undefined, telefono: string | undefined) {
  const k = claveTel(telefono);
  if (k.length >= 8) {
    const { data } = await sb.from("clientes").select("id, telefono").eq("owner_id", owner).not("telefono", "is", null);
    const ya = (data || []).find(c => claveTel(c.telefono) === k);
    if (ya) return { id: ya.id as string, existia: true };
  }
  const { data, error } = await sb.from("clientes").insert({
    owner_id: owner, nombre: nombre || telefono || "Lead de HighLevel", telefono: telefono || null,
    membresia: "Lead", creado: hoyCO(),
  }).select("id").single();
  if (error) throw error;
  return { id: data.id as string, existia: false };
}

Deno.serve(async req => {
  if (req.method !== "POST") return json(405, { error: "usa POST" });
  const token = new URL(req.url).searchParams.get("t") || "";
  if (!/^[0-9a-f]{36}$/.test(token)) return json(401, { error: "token inválido" });

  const { data: tok } = await sb.from("crm_tokens").select("owner_id").eq("token", token).maybeSingle();
  if (!tok) return json(401, { error: "token inválido" });

  let b: any;
  try { b = await req.json(); } catch { return json(400, { error: "cuerpo no es JSON" }); }
  const c = b?.contact || b?.customData || {};
  const ghlId = primero(b?.contact_id, b?.contactId, c?.id, c?.contact_id, b?.id);
  if (!ghlId) return json(400, { error: "falta contact_id" });

  const nombre = primero(b?.full_name, c?.full_name, c?.name, b?.name,
    [b?.first_name ?? c?.first_name ?? c?.firstName, b?.last_name ?? c?.last_name ?? c?.lastName].filter(Boolean).join(" "));
  const telefono = primero(b?.phone, c?.phone, b?.phone_number);
  const email = primero(b?.email, c?.email);

  // Si el mismo contacto llega otra vez (reasignado), se actualizan sus datos
  // pero NO se tocan las anotaciones del agente (resultado, intentos, estado).
  const { data: previo } = await sb.from("crm_leads").select("id, cliente_id")
    .eq("owner_id", tok.owner_id).eq("ghl_id", ghlId).maybeSingle();
  const datos = { nombre: nombre || null, telefono: telefono || null, email: email || null, payload: b };
  if (previo) {
    const { error } = await sb.from("crm_leads").update(datos).eq("id", previo.id);
    if (error) return json(500, { error: error.message });
    // Si la primera vez llegó sin teléfono, la persona lo recibe ahora (solo si
    // no tenía uno: el que puso el agente manda).
    if (telefono && previo.cliente_id)
      await sb.from("clientes").update({ telefono }).eq("id", previo.cliente_id).is("telefono", null);
    return json(200, { ok: true, nuevo: false });
  }
  try {
    const p = await personaPara(tok.owner_id, nombre, telefono);
    // Si ya estaba en Nexus con ese número, ya es un lead de WhatsApp: no queda
    // «por bajar» (no se le quitan los envíos automáticos que ya recibía).
    const { error } = await sb.from("crm_leads").insert({ ...datos, owner_id: tok.owner_id, ghl_id: ghlId,
      cliente_id: p.id, ...(p.existia ? { estado: "bajo", resultado_en: new Date().toISOString() } : {}) });
    if (error) {
      // Sin su fila en crm_leads la persona quedaría suelta y HighLevel la
      // reenviaría como nueva: se deshace.
      if (!p.existia) await sb.from("clientes").delete().eq("id", p.id);
      return json(500, { error: error.message });
    }
  } catch (e) {
    return json(500, { error: (e as Error).message });
  }
  return json(200, { ok: true, nuevo: true });
});
