// =====================================================================
//  Configuración de Supabase
//  La "anon key" es PÚBLICA por diseño: es seguro tenerla en el repo
//  porque las políticas RLS de la base de datos protegen los datos.
//  NUNCA pongas aquí la "service_role key".
//  La encuentras en: Supabase → Project Settings → API
// =====================================================================
export const SUPABASE_URL  = "https://cizjalpqscqftxtbdlmw.supabase.co";
export const SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNpemphbHBxc2NxZnR4dGJkbG13Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyOTY0NzgsImV4cCI6MjA5Njg3MjQ3OH0.XINBRXlgO5Mxtx-1bX8Y8pzTGWWDLL1mMjLSHyk1wAI";

// Jerarquía de niveles (mayor número = nivel más alto).
// "Lead" es quien aún no hace parte de la Comunidad (no tiene membresía).
export const NIVEL = { Lead: 0, Beca: 1, VIP: 2, Platino: 3, Oro: 4 };

// Nivel de membresía a partir del cual un servicio es "requerido".
// Por debajo de ese nivel, el servicio es "adicional" (invitación): se puede
// marcar, pero NO cuenta en el % ni en "le faltan X".
//   sin tier  -> requerido desde Beca (1)
//   tier vip  -> requerido desde VIP  (2)
//   tier oro  -> requerido desde Oro  (4)
export const REQ_DESDE = { vip: 2, oro: 4 };
