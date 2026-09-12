// Autenticación: arranque, login/registro, sesión y aplicación del rol a la UI.
import { SB } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_ANON } from "./config.js";
import { state, $, toast } from "./state.js";
import { cargarTodo } from "./data.js";
import { render } from "./ui.js";
import { repasoDiario } from "./repaso.js";
import { refrescarIndicadorAgentes } from "./salud.js";

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

// El error de Supabase no siempre trae un `message` usable: cuando el fallo
// viene del backend de Auth puede llegar como objeto vacío, y al pintarlo salía
// literalmente "{}" en pantalla. Se normaliza a algo legible siempre.
function textoDeError(err) {
  const m = (err && (err.message || err.error_description || err.msg)) || "";
  const t = String(m).trim();
  return (!t || t === "{}" || t === "[object Object]") ? "" : t;
}

function traducirError(err) {
  const m = textoDeError(err);
  if (!m) return "No se pudo completar la operación. Revisa tu conexión e inténtalo de nuevo.";
  if (/Invalid login/i.test(m)) return "Correo o contraseña incorrectos.";
  if (/already registered/i.test(m)) return "Ese correo ya tiene cuenta. Inicia sesión.";
  if (/at least 6/i.test(m)) return "La contraseña debe tener al menos 6 caracteres.";
  if (/Database error saving new user/i.test(m))
    return "No se pudo crear la cuenta. Vuelve a intentar; si sigue fallando, avísale a tu director.";
  return m;
}

async function entrar() {
  const { data: { user } } = await SB.auth.getUser();
  let { data: prof } = await SB.from("profiles")
    .select("id,full_name,role,aprobado,director_id,rechazado_en").eq("id", user.id).single();
  if (!prof) { prof = { id: user.id, full_name: "", role: "agente", aprobado: false }; }
  state.me = {
    id: user.id, name: prof.full_name || (user.email || "").split("@")[0],
    role: prof.role, email: user.email,
    aprobado: prof.aprobado !== false, directorId: prof.director_id,
  };

  // Cuenta creada pero sin aprobar: no entra a la app. El RLS ya le impide
  // crear nada, esto es para que entienda por qué en vez de ver todo vacío.
  if (!state.me.aprobado) { mostrarEspera(prof.director_id, prof.rechazado_en); return; }

  $("pendScreen").classList.add("hidden");
  $("authScreen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("meName").textContent = state.me.name;
  $("meRol").textContent = { admin: "Administrador", director: "Director" }[state.me.role] || "Agente";
  $("meRol").className = "rol " + state.me.role;
  // Espejo en el pie de la barra lateral de escritorio (mismos datos).
  const rolTxt = { admin: "Administrador", director: "Director" }[state.me.role] || "Agente";
  if ($("sideName")) $("sideName").textContent = state.me.name;
  if ($("sideRol")) { $("sideRol").textContent = rolTxt; $("sideRol").className = "rol " + state.me.role; }
  const admin = state.me.role === "admin";
  const dir = state.me.role === "director";
  const mando = admin || dir;                 // ve el panel de equipo
  $("btnCat").classList.toggle("hidden", !mando);
  $("btnAgentes").classList.toggle("hidden", !mando);
  if (mando) refrescarIndicadorAgentes();
  $("appSub").textContent = admin
    ? "Administrador · tus clientes son tuyos; de los demás solo ves el nombre"
    : dir
      ? "Director · ves lo tuyo y lo de los agentes de tu equipo"
      : "Tus clientes · solo tú ves y gestionas los que registras";

  try { await cargarTodo(); render(); repasoDiario(); }
  catch (err) { toast("⚠ Error cargando datos: " + err.message); }
}

/* ---------- espera de aprobación ---------- */
async function mostrarEspera(directorId, rechazadoEn) {
  $("app").classList.add("hidden");
  $("authScreen").classList.add("hidden");
  $("pendScreen").classList.remove("hidden");

  // A quien fue rechazado no se le deja esperando un permiso que no va a
  // llegar: se le dice, y se le quita el botón de "ya me aprobaron".
  if (rechazadoEn) {
    $("pendIcono").textContent = "🚫";
    $("pendTitulo").textContent = "Tu solicitud no fue aprobada";
    $("pendTexto").innerHTML = "Si crees que es un error, habla con la persona que te invitó y pídele que la revise de nuevo.";
    $("pendSub").textContent = "";
    $("pendRefrescar").classList.add("hidden");
    return;
  }
  $("pendRefrescar").classList.remove("hidden");

  // Decirle a quién le toca aprobarlo evita el "¿y ahora a quién le escribo?".
  let quien = "Un administrador";
  if (directorId) {
    const { data } = await SB.from("profiles").select("full_name").eq("id", directorId).maybeSingle();
    if (data && data.full_name) quien = data.full_name;
  }
  $("pendDir").textContent = quien;
}

$("pendRefrescar").onclick = () => location.reload();
$("pendSalir").onclick = async () => { await SB.auth.signOut(); location.reload(); };

/* ---------- lista de directores para el registro ---------- */
// Va por función (directores_publicos) porque hace falta ANTES de tener
// sesión, y expone solo id y nombre.
let directoresCargados = false;
async function cargarDirectores() {
  if (directoresCargados) return;
  const sel = $("auDir");
  const { data, error } = await SB.rpc("directores_publicos");
  if (error || !data || !data.length) {
    sel.innerHTML = `<option value="">(no hay directores disponibles)</option>`;
    return;
  }
  sel.innerHTML = data.map(d => `<option value="${d.id}">${d.nombre}</option>`).join("");
  directoresCargados = true;
}

/* ---------- wiring de la pantalla de login (se ejecuta al importar) ---------- */
function toggleSignup() {
  state.signupMode = !state.signupMode; clearErr();
  $("nameRow").style.display = state.signupMode ? "block" : "none";
  $("dirRow").style.display = state.signupMode ? "block" : "none";
  if (state.signupMode) cargarDirectores();
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
      const directorId = $("auDir").value || null;
      if (!name) { authError("Escribe tu nombre completo."); return; }
      if (!directorId) { authError("Elige a tu director."); return; }
      const { error } = await SB.auth.signUp({
        email, password: pass,
        options: { data: { full_name: name, director_id: directorId } },
      });
      if (error) throw error;
      const { data: sess } = await SB.auth.getSession();
      // La cuenta nace sin aprobar: entrar() detecta eso y muestra la espera.
      if (sess.session) entrar();
      else { toast("Cuenta creada. Revisa tu correo si pide confirmación, luego inicia sesión."); toggleSignup(); }
    } else {
      const { error } = await SB.auth.signInWithPassword({ email, password: pass });
      if (error) throw error;
      entrar();
    }
  } catch (err) {
    authError(traducirError(err));
  } finally {
    $("auBtn").disabled = false; $("auBtn").textContent = state.signupMode ? "Crear cuenta" : "Entrar";
  }
};

/* ---------- cambiar contraseña (con sesión abierta) ---------- */
// `updateUser` NO manda correo: usa la sesión que ya existe. Por eso esto
// funciona sin SMTP propio, a diferencia del «olvidé mi contraseña», que sí lo
// necesita y por ahora choca con el límite del SMTP de desarrollo de Supabase.
const passErr = m => {
  const e = $("passErr");
  e.textContent = m; e.classList.toggle("show", !!m);
};

// Supabase responde en inglés y aquí todo va en español. Se traducen los que de
// verdad pueden salir en esta pantalla; lo demás se muestra tal cual, que es
// mejor que un «error desconocido» que no deja ni buscarlo.
function traducirAuth(msg) {
  const m = (msg || "").toLowerCase();
  if (m.includes("should be different")) return "La contraseña nueva tiene que ser distinta de la actual.";
  if (m.includes("at least") || m.includes("too short")) return "La contraseña es demasiado corta.";
  if (m.includes("session") && m.includes("missing")) return "Se cerró tu sesión. Vuelve a entrar e inténtalo otra vez.";
  if (m.includes("rate limit")) return "Demasiados intentos seguidos. Espera un momento.";
  if (m.includes("weak") || m.includes("pwned") || m.includes("compromis"))
    return "Esa contraseña aparece en filtraciones conocidas. Usa otra.";
  return msg;
}

function cerrarPass() {
  $("passOverlay").classList.remove("open");
  $("pass1").value = ""; $("pass2").value = ""; passErr("");
}

$("btnPass").onclick = () => { cerrarPass(); $("passOverlay").classList.add("open"); $("pass1").focus(); };
$("passCancelar").onclick = cerrarPass;
$("passOverlay").onclick = e => { if (e.target.id === "passOverlay") cerrarPass(); };

$("passGuardar").onclick = async () => {
  const a = $("pass1").value, b = $("pass2").value;
  if (a.length < 8) return passErr("La contraseña necesita al menos 8 caracteres.");
  if (a !== b) return passErr("Las dos contraseñas no son iguales.");

  const btn = $("passGuardar");
  btn.disabled = true; btn.textContent = "Cambiando…";
  const { error } = await SB.auth.updateUser({ password: a });
  btn.disabled = false; btn.textContent = "Cambiar contraseña";

  if (error) return passErr(traducirAuth(error.message));
  cerrarPass();
  // La sesión sigue abierta: cambiar la contraseña no echa a nadie.
  toast("🔑 Contraseña cambiada");
};

$("btnLogout").onclick = async () => { await SB.auth.signOut(); location.reload(); };
