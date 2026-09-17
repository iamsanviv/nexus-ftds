// Cliente de Supabase (importado como módulo ES, sin <script> de CDN).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";

/* El enlace de «recuperar contraseña» vuelve a la app con `type=recovery` en el
   hash. Hay que leerlo ANTES de crear el cliente: `detectSessionInUrl` viene
   activado por defecto, consume ese hash y lo borra de la barra de direcciones,
   así que para cuando arranca auth.js ya no queda rastro de que esta visita
   venía de un correo de recuperación — y sin saberlo, el panel abriría la
   sesión normal en vez de pedir la contraseña nueva. */
export const HASH_ENTRADA = (typeof location !== "undefined" && location.hash) || "";

export const SB = createClient(SUPABASE_URL, SUPABASE_ANON);
