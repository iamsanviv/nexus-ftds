// Cliente de Supabase (importado como módulo ES, sin <script> de CDN).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";

export const SB = createClient(SUPABASE_URL, SUPABASE_ANON);
