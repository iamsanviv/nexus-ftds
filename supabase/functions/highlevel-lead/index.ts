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

// HighLevel manda `{{contact.phone}}` en formato nacional cuando el número es
// del país de la subcuenta (Colombia): «318 5506790», sin «+57». Así no cruza
// con WhatsApp (que guarda 57…) y la ficha lo vuelve «+318…», un número que no
// existe. Solo se completa el móvil colombiano (10 dígitos que empiezan por 3);
// lo que llega con «+» o con otra forma se deja como vino.
const conIndicativo = (t?: string) => {
  if (!t || t.trim().startsWith("+")) return t;
  const d = t.replace(/\D/g, "");
  return /^3\d{9}$/.test(d) ? "+57" + d : t;
};

// País a partir del indicativo, porque HighLevel solo manda nombre, teléfono e
// id (ningún campo de país). Nombres escritos como ya los usa la base
// («México», «Perú»…) para que filtros y banderas los reconozcan.
// De más largo a más corto: «1809» (Rep. Dominicana) le gana a «1». El «1» a
// secas NO se asigna: es Estados Unidos, Canadá o el Caribe, y un país
// equivocado es peor que ninguno (el agente lo completa).
// Solo Colombia fija la diferencia horaria (0): tiene un único huso. México y
// los demás no, por lo mismo que en la ficha (ver `paisDesdeTel` en ui.js).
const PREFIJO_PAIS: [string, string][] = [
  ["1809", "República Dominicana"], ["1829", "República Dominicana"], ["1849", "República Dominicana"],
  ["1787", "Puerto Rico"], ["1939", "Puerto Rico"],
  ["501", "Belice"], ["502", "Guatemala"], ["503", "El Salvador"], ["504", "Honduras"],
  ["505", "Nicaragua"], ["506", "Costa Rica"], ["507", "Panamá"], ["509", "Haití"],
  ["591", "Bolivia"], ["593", "Ecuador"], ["595", "Paraguay"], ["598", "Uruguay"], ["351", "Portugal"],
  ["33", "Francia"], ["34", "España"], ["39", "Italia"], ["44", "Reino Unido"], ["49", "Alemania"],
  ["51", "Perú"], ["52", "México"], ["53", "Cuba"], ["54", "Argentina"], ["55", "Brasil"],
  ["56", "Chile"], ["57", "Colombia"], ["58", "Venezuela"],
];
// Exige el «+» (o el 57 que añadió `conIndicativo`) y un largo internacional
// plausible: un número nacional sin indicativo («0414…», «55…») empezaría
// igual que un prefijo y daría un país falso.
const paisDeTel = (t?: string) => {
  if (!t || !t.trim().startsWith("+")) return null;
  const d = t.replace(/\D/g, "");
  if (d.length < 10 || d.length > 15) return null;
  const hit = PREFIJO_PAIS.find(([p]) => d.startsWith(p));
  return hit ? hit[1] : null;
};
const datosPais = (t?: string) => {
  const pais = paisDeTel(t);
  if (!pais) return {};
  return pais === "Colombia" ? { pais, tz_offset_min: 0 } : { pais };
};

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
    membresia: "Lead", creado: hoyCO(), ...datosPais(telefono),
  }).select("id").single();
  if (error) throw error;
  return { id: data.id as string, existia: false };
}

// A una persona que ya existía solo se le pone país si no tenía: el que
// escribió el agente manda. La diferencia horaria tampoco se pisa.
async function completarPais(id: string, telefono?: string) {
  const { pais, tz_offset_min } = datosPais(telefono) as { pais?: string; tz_offset_min?: number };
  if (!pais) return;
  const { data } = await sb.from("clientes").update({ pais }).eq("id", id)
    .or("pais.is.null,pais.eq.").select("id");
  // La hora solo acompaña a un país que se acaba de poner aquí; si el agente ya
  // había escrito otro país, un 0 de Colombia lo contradiría.
  if (data?.length && tz_offset_min !== undefined)
    await sb.from("clientes").update({ tz_offset_min }).eq("id", id).is("tz_offset_min", null);
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
  const telefono = conIndicativo(primero(b?.phone, c?.phone, b?.phone_number));
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
    if (telefono && previo.cliente_id) {
      await sb.from("clientes").update({ telefono }).eq("id", previo.cliente_id).is("telefono", null);
      await completarPais(previo.cliente_id, telefono);
    }
    return json(200, { ok: true, nuevo: false });
  }
  try {
    const p = await personaPara(tok.owner_id, nombre, telefono);
    if (p.existia) await completarPais(p.id, telefono);
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
