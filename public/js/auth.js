// Autenticación: arranque, login/registro, sesión y aplicación del rol a la UI.
import { SB } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { state, $, toast } from "./state.js";
import { cargarTodo } from "./data.js";
import { render } from "./ui.js";
import { repasoDiario } from "./repaso.js";

export function boot() {
  if (SUPABASE_URL.includes("TU-PROYECTO") || SUPABASE_ANON.includes("TU_ANON")) {
    $("authScreen").classList.remove("hidden");
    $("setupMsg").classList.remove("hidden");
    $("setupMsg").innerHTML = "⚙ <b>Falta configurar.</b> Edita <code>public/js/config.js</code> y pon tu <code>SUPABASE_URL</code> y <code>SUPABASE_ANON</code> (Supabase → Project Settings → API).";
    ["auName", "auEmail", "auPass", "auBtn", "auToggle"].forEach(i => { const e = $(i); if (e) e.disabled = true; });
    return;
  }
  SB.auth.getSession().then(({ data }) => { data.session ? entrar() : mostrarLogin(); });
}

function mostrarLogin() { $("app").classList.add("hidden"); $("authScreen").classList.remove("hidden"); }
function authError(msg) { const e = $("authErr"); e.textContent = msg; e.classList.add("show"); }
function clearErr() { $("authErr").classList.remove("show"); }

function traducirError(m) {
  if (/Invalid login/i.test(m)) return "Correo o contraseña incorrectos.";
  if (/already registered/i.test(m)) return "Ese correo ya tiene cuenta. Inicia sesión.";
  if (/at least 6/i.test(m)) return "La contraseña debe tener al menos 6 caracteres.";
  return m;
}

async function entrar() {
  const { data: { user } } = await SB.auth.getUser();
  let { data: prof } = await SB.from("profiles").select("id,full_name,role").eq("id", user.id).single();
  if (!prof) { prof = { id: user.id, full_name: "", role: "agente" }; }
  state.me = { id: user.id, name: prof.full_name || (user.email || "").split("@")[0], role: prof.role, email: user.email };

  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("meName").textContent = state.me.name;
  $("meRol").textContent = state.me.role === "director" ? "Director" : "Agente";
  $("meRol").className = "rol " + state.me.role;
  const dir = state.me.role === "director";
  $("btnCat").classList.toggle("hidden", !dir);
  $("appSub").textContent = dir
    ? "Vista de director · ves todos los clientes y a quién pertenecen"
    : "Tus clientes · solo tú ves y gestionas los que registras";

  try { await cargarTodo(); render(); repasoDiario(); }
  catch (err) { toast("⚠ Error cargando datos: " + err.message); }
}

/* ---------- wiring de la pantalla de login (se ejecuta al importar) ---------- */
function toggleSignup() {
  state.signupMode = !state.signupMode; clearErr();
  $("nameRow").style.display = state.signupMode ? "block" : "none";
  $("authSub").textContent = state.signupMode ? "Crea tu cuenta de agente" : "Inicia sesión para continuar";
  $("auBtn").textContent = state.signupMode ? "Crear cuenta" : "Entrar";
  $("auSwitch").innerHTML = state.signupMode
    ? '¿Ya tienes cuenta? <button id="auToggle2">Iniciar sesión</button>'
    : '¿No tienes cuenta? <button id="auToggle2">Crear cuenta</button>';
  $("auToggle2").onclick = toggleSignup;
}
$("auToggle").onclick = toggleSignup;

$("auBtn").onclick = async () => {
  clearErr();
  const email = $("auEmail").value.trim(), pass = $("auPass").value;
  if (!email || !pass) { authError("Completa correo y contraseña."); return; }
  $("auBtn").disabled = true; $("auBtn").textContent = "Un momento…";
  try {
    if (state.signupMode) {
      const name = $("auName").value.trim();
      const { error } = await SB.auth.signUp({ email, password: pass, options: { data: { full_name: name } } });
      if (error) throw error;
      const { data: sess } = await SB.auth.getSession();
      if (sess.session) entrar();
      else { toast("Cuenta creada. Revisa tu correo si pide confirmación, luego inicia sesión."); toggleSignup(); }
    } else {
      const { error } = await SB.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      entrar();
    }
  } catch (err) {
    authError(traducirError(err.message));
  } finally {
    $("auBtn").disabled = false; $("auBtn").textContent = state.signupMode ? "Crear cuenta" : "Entrar";
  }
};

$("btnLogout").onclick = async () => { await SB.auth.signOut(); location.reload(); };
