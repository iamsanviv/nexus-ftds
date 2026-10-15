// Cliente de Supabase (importado como módulo ES, sin <script> de CDN).
//
// Versión EXACTA, nunca `@2`: con el rango, esm.sh sirve la última 2.x en cuanto
// sale, y la compila bajo demanda en su primer uso. El 15/10/2026 el panel
// quedó en blanco minutos después de publicarse la 2.118.0, sin que cambiara una
// línea del repo. Si este import falla, falla TODO (nada más llega a ejecutarse),
// así que subir de versión es una decisión deliberada y probada, no algo que
// pase solo. 2.117.3 es la que corrió en producción del 07/10 al 15/10.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.117.3";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";

/* El enlace de «recuperar contraseña» vuelve a la app con `type=recovery` en el
   hash. Hay que leerlo ANTES de crear el cliente: `detectSessionInUrl` viene
   activado por defecto, consume ese hash y lo borra de la barra de direcciones,
   así que para cuando arranca auth.js ya no queda rastro de que esta visita
   venía de un correo de recuperación — y sin saberlo, el panel abriría la
   sesión normal en vez de pedir la contraseña nueva. */
export const HASH_ENTRADA = (typeof location !== "undefined" && location.hash) || "";

export const SB = createClient(SUPABASE_URL, SUPABASE_ANON);
