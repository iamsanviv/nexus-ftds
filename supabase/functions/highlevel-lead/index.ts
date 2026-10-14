// Edge Function `highlevel-lead`: recibe los leads que un workflow de
// HighLevel empuja cuando un contacto queda asignado al agente.
//
// El agente no tiene token de la API de HighLevel, por eso el flujo es al
// revés: HighLevel llama aquí. No hay JWT (HighLevel no sabe de Supabase): la
// identidad es el token secreto de `crm_tokens` en la URL (`?t=…`). Sin token
// válido no se escribe nada. Es la única vía de inserción en `crm_leads`.
//
// Despliegue: MCP de Supabase (deploy_edge_function, verify_jwt=false).
// SQL y diseño: sql/2026-10-14_35_crm_leads.sql · brain/04-features/mi-dia.md.
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
  const { data: previo } = await sb.from("crm_leads").select("id")
    .eq("owner_id", tok.owner_id).eq("ghl_id", ghlId).maybeSingle();
  const datos = { nombre: nombre || null, telefono: telefono || null, email: email || null, payload: b };
  const { error } = previo
    ? await sb.from("crm_leads").update(datos).eq("id", previo.id)
    : await sb.from("crm_leads").insert({ ...datos, owner_id: tok.owner_id, ghl_id: ghlId });
  if (error) return json(500, { error: error.message });
  return json(200, { ok: true, nuevo: !previo });
});
