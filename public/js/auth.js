// Autenticación: arranque, login/registro, sesión y aplicación del rol a la UI.
import { SB, HASH_ENTRADA } from "./supabase.js";
import { SUPABASE_URL, SUPABASE_ANON, BASE_URL } from "./config.js";
import { state, $, toast, esc } from "./state.js";
import { cargarTodo } from "./data.js";
import { render } from "./ui.js";
import { repasoDiario } from "./repaso.js";
import { refrescarIndicadorAgentes } from "./salud.js";

/* ---------- ver la contraseña ---------- */
// Un botón dentro del campo que alterna type=password/text. Se arma desde JS y
// no en el HTML porque son cinco campos en tres pantallas distintas: repetir
// el marcado cinco veces garantiza que un día uno quede sin él.
//
// `type` y no `-webkit-text-security`: el segundo no existe en Firefox y el
// campo quedaría visible sin que nadie lo pidiera.
//
// Los iconos son SVG y no emoji: un emoji lo dibuja el sistema operativo, así
// que el mismo carácter sale con otro estilo y otro color en cada teléfono y
// no hay forma de que acompañe a la paleta. Estos usan `currentColor`, de modo
// que siguen al tema claro/oscuro como cualquier otro trazo del panel.
const OJO_ABIERTO = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/>
  <circle cx="12" cy="12" r="3.1"/></svg>`;
const OJO_TACHADO = `<svg viewBox="0 0 24 24" width="19" height="19" fill="none"
  stroke="currentColor" stroke-width="1.7" stroke-linecap="round"
  stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M10.7 5.7A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-2.8 3.6"/>
  <path d="M6.6 6.8A16.8 16.8 0 0 0 2.5 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.9-.8"/>
  <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>
  <path d="M3.5 3.5 20.5 20.5"/></svg>`;

// El icono y las etiquetas van juntos a propósito: son la misma decisión vista
// por el ojo y por un lector de pantalla, y separarlas es como se acaban
// contradiciendo.
function pintarOjo(btn, oculta) {
  btn.innerHTML = oculta ? OJO_ABIERTO : OJO_TACHADO;
  const t = oculta ? "Mostrar la contraseña" : "Ocultar la contraseña";
  btn.setAttribute("aria-label", t);
  btn.title = t;
  btn.setAttribute("aria-pressed", String(!oculta));
}

function ponerOjo(id) {
  const input = $(id);
  if (!input || input.dataset.ojo) return;
  input.dataset.ojo = "1";

  const caja = document.createElement("div");
  caja.className = "pwrap";
  input.parentNode.insertBefore(caja, input);
  caja.appendChild(input);

  const btn = document.createElement("button");
  btn.type = "button";           // dentro de un form, sin esto enviaría el form
  btn.className = "pwojo";
  // El campo no lleva `aria-label`: el <label> de al lado ya lo nombra. El que
  // hace falta es el del botón, que si no se anuncia solo como «botón».
  pintarOjo(btn, true);
  caja.appendChild(btn);

  btn.onclick = () => {
    const oculta = input.type !== "text";
    input.type = oculta ? "text" : "password";
    pintarOjo(btn, !oculta);
    input.focus();
  };
}

// Se vuelve a ocultar al cerrar la pantalla: dejar una contraseña a la vista
// para la próxima vez que se abra el modal sería una sorpresa desagradable.
function ocultarOjos(...ids) {
  ids.forEach(id => {
    const i = $(id);
    if (!i || i.type !== "text") return;
    i.type = "password";
    const b = i.parentNode.querySelector(".pwojo");
    if (b) pintarOjo(b, true);
  });
}

["auPass", "pass1", "pass2", "recu1", "recu2"].forEach(ponerOjo);

export function boot() {
  if (SUPABASE_URL.includes("TU-PROYECTO") || SUPABASE_ANON.includes("TU_ANON")) {
    $("authScreen").classList.remove("hidden");
    $("setupMsg").classList.remove("hidden");
    $("setupMsg").innerHTML = "⚙ <b>Falta configurar.</b> Edita <code>public/js/config.js</code> y pon tu <code>SUPABASE_URL</code> y <code>SUPABASE_ANON</code> (Supabase → Project Settings → API).";
    ["auName", "auEmail", "auPass", "auBtn", "auToggle"].forEach(i => { const e = $(i); if (e) e.disabled = true; });
    return;
  }
  /* Volver de un correo de recuperación abre una sesión válida. Sin este
     desvío, `getSession()` la ve y `entrar()` mete a la persona al panel: el
     enlace «funcionaría» pero nunca le pediría la contraseña nueva, y la vieja
     —la que olvidó— seguiría siendo la única que sirve. */
  if (esRecuperacion()) { mostrarRecuperacion(); return; }

  SB.auth.getSession().then(({ data }) => { data.session ? entrar() : mostrarLogin(); });
}

// El hash se capturó en supabase.js antes de que el cliente lo consumiera.
// `onAuthStateChange` también avisa, pero puede dispararse antes de que este
// módulo llegue a escucharlo; el hash no se pierde en esa carrera.
const esRecuperacion = () => /[#&]type=recovery\b/.test(HASH_ENTRADA);

function mostrarRecuperacion() {
  $("app").classList.add("hidden");
  $("authScreen").classList.add("hidden");
  $("pendScreen").classList.add("hidden");
  $("recuScreen").classList.remove("hidden");
  $("recu1").focus();
}

// Red de seguridad por si el enlace llegara sin hash legible (otro flujo de
// Supabase, o un navegador que lo limpie antes). No estorba: si ya estamos en
// la pantalla de recuperación, volver a mostrarla no hace nada.
SB.auth.onAuthStateChange((evento) => {
  if (evento === "PASSWORD_RECOVERY") mostrarRecuperacion();
});

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
  // `full_name` lo escribe cada quien al registrarse, así que es dato de
  // usuario aunque venga de un director. Sin escapar, un nombre con
  // `</option><img src=x onerror=...>` inyectaría script en la pantalla de
  // REGISTRO, que se sirve sin sesión: lo ejecutaría cualquier visitante.
  // Es el único innerHTML del panel que pintaba dato de usuario en crudo.
  sel.innerHTML = data.map(d =>
    `<option value="${esc(d.id)}">${esc(d.nombre)}</option>`).join("");
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
  // Al crear cuenta todavía no hay contraseña que recuperar.
  $("auOlvidoRow").classList.toggle("hidden", state.signupMode);
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

/* ---------- recuperar contraseña (sin sesión) ---------- */
// Todo el mecanismo es de Supabase: `resetPasswordForEmail` manda el correo y
// `updateUser` lo cierra. No hace falta backend propio.
//
// OJO CON EL CORREO: con el SMTP que trae Supabase de fábrica, Auth SOLO
// entrega mensajes a direcciones del equipo del proyecto. Para el resto del
// equipo hay que configurar un SMTP propio, o esto falla EN SILENCIO — el
// correo no llega y nadie ve un error. Por eso el aviso de abajo dice
// explícitamente a quién avisar si no llega.
const recuErr = m => { const e = $("recuEnvErr"); e.textContent = m; e.classList.toggle("show", !!m); };

function abrirRecuperar() {
  recuErr("");
  $("recuEnviado").classList.add("hidden");
  $("recuEnviar").disabled = false;
  $("recuEnviar").textContent = "Enviar el enlace";
  // Si ya escribió el correo para entrar, no se lo hacemos escribir otra vez.
  $("recuEmail").value = ($("auEmail").value || "").trim();
  $("recuOverlay").classList.add("open");
  $("recuEmail").focus();
}
const cerrarRecuperar = () => $("recuOverlay").classList.remove("open");

$("auOlvido").onclick = abrirRecuperar;
$("recuCerrar").onclick = cerrarRecuperar;
$("recuOverlay").onclick = e => { if (e.target.id === "recuOverlay") cerrarRecuperar(); };
$("recuEmail").onkeydown = e => { if (e.key === "Enter") $("recuEnviar").click(); };

$("recuEnviar").onclick = async () => {
  const email = ($("recuEmail").value || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return recuErr("Escribe un correo válido.");

  const btn = $("recuEnviar");
  btn.disabled = true; btn.textContent = "Enviando…";
  // `redirectTo` tiene que estar en la lista de Redirect URLs de Supabase, o el
  // enlace del correo rebota al Site URL. Se usa BASE_URL —el dominio de
  // producción— y no `location.origin`, por la misma razón que en los enlaces
  // rastreados: abrir el panel desde una URL de vista previa no debe decidir a
  // dónde vuelve un correo.
  const { error } = await SB.auth.resetPasswordForEmail(email, { redirectTo: BASE_URL });
  if (error) {
    btn.disabled = false; btn.textContent = "Enviar el enlace";
    return recuErr(traducirAuth(textoDeError(error) || "No se pudo enviar el correo."));
  }
  // A propósito NO se dice si el correo existe o no: eso permitiría averiguar
  // quién tiene cuenta probando direcciones.
  recuErr("");
  $("recuEnviado").classList.remove("hidden");
  $("recuEnviado").textContent =
    "📬 Si esa dirección tiene cuenta, le llega un enlace en unos minutos. "
    + "Revisa también el correo no deseado. Si no llega, avísale al administrador.";
  btn.textContent = "Enviado";
};

/* ---------- elegir la contraseña nueva al volver del correo ---------- */
const recuSetErr = m => { const e = $("recuErr"); e.textContent = m; e.classList.toggle("show", !!m); };

$("recuCancelar").onclick = async () => {
  // Se cierra la sesión de recuperación: dejarla abierta permitiría entrar al
  // panel con solo el enlace del correo, sin haber elegido contraseña.
  await SB.auth.signOut();
  // `location.pathname` y no BASE_URL: basta con soltar el hash del enlace y
  // recargar donde ya estamos. Mandar a BASE_URL sacaría de su sitio a quien
  // abriera el panel desde otra dirección, sin necesidad.
  // `replace` para que el botón «atrás» no devuelva al enlace ya gastado.
  location.replace(location.pathname);
};

$("recuGuardar").onclick = async () => {
  const a = $("recu1").value, b = $("recu2").value;
  if (a.length < 8) return recuSetErr("La contraseña necesita al menos 8 caracteres.");
  if (a !== b) return recuSetErr("Las dos contraseñas no son iguales.");

  const btn = $("recuGuardar");
  btn.disabled = true; btn.textContent = "Guardando…";
  const { error } = await SB.auth.updateUser({ password: a });
  if (error) {
    btn.disabled = false; btn.textContent = "Guardar y entrar";
    return recuSetErr(traducirAuth(textoDeError(error) || "No se pudo cambiar la contraseña."));
  }
  ocultarOjos("recu1", "recu2");
  $("recu1").value = ""; $("recu2").value = ""; recuSetErr("");
  $("recuScreen").classList.add("hidden");
  toast("🔑 Contraseña actualizada");
  entrar();                       // la sesión de recuperación ya vale como sesión normal
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
  ocultarOjos("pass1", "pass2");
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
