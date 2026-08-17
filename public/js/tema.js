/* ============================================================
   tema.js — modo claro/oscuro para todo el sistema.

   Cárgalo en el <head>, ANTES del CSS y del resto de scripts, para
   que la primera pintura ya salga con el tema correcto (sin parpadeo):

     <script src="./js/tema.js"></script>

   Qué hace:
   - Lee la preferencia guardada (localStorage "nx.tema"); si no hay,
     usa la del sistema operativo (prefers-color-scheme).
   - Pone data-tema="claro" | "oscuro" en <html>. Todo el CSS cuelga de ahí.
   - Monta el interruptor sol/luna en cualquier elemento con
     [data-tema-toggle]. Sirve en todas las vistas sin código extra.

   API:  Tema.get()  Tema.set('claro'|'oscuro')  Tema.alternar()
   Evento: document.addEventListener('temacambio', e => e.detail.tema)
   ============================================================ */
(function () {
  var CLAVE = "nx.tema";
  var raiz = document.documentElement;

  function preferido() {
    try {
      var g = localStorage.getItem(CLAVE);
      if (g === "claro" || g === "oscuro") return g;
    } catch (e) {}
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches
      ? "claro" : "oscuro";
  }

  function aplicar(tema, persistir) {
    raiz.setAttribute("data-tema", tema);
    if (persistir) { try { localStorage.setItem(CLAVE, tema); } catch (e) {} }
    pintarBotones();
    document.dispatchEvent(new CustomEvent("temacambio", { detail: { tema: tema } }));
  }

  var SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4"></path></svg>';
  var LUNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8.5 8.5 0 019.5 4a7 7 0 1010.5 10.5z"></path></svg>';

  function montar(host) {
    if (host.dataset.temaMontado) return;
    host.dataset.temaMontado = "1";
    host.classList.add("tema-toggle");
    host.innerHTML =
      '<button type="button" data-tema-valor="claro" title="Modo claro" aria-label="Modo claro">' + SOL + "</button>" +
      '<button type="button" data-tema-valor="oscuro" title="Modo oscuro" aria-label="Modo oscuro">' + LUNA + "</button>";
    host.addEventListener("click", function (ev) {
      var b = ev.target.closest("[data-tema-valor]");
      if (b) aplicar(b.getAttribute("data-tema-valor"), true);
    });
  }

  function pintarBotones() {
    var actual = raiz.getAttribute("data-tema");
    document.querySelectorAll("[data-tema-valor]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-tema-valor") === actual));
    });
  }

  // 1) tema antes de pintar
  raiz.setAttribute("data-tema", preferido());

  // 2) interruptores cuando el DOM exista
  function iniciar() {
    document.querySelectorAll("[data-tema-toggle]").forEach(montar);
    pintarBotones();
    raiz.setAttribute("data-tema-listo", "1");
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar);
  else iniciar();

  // 3) vistas que se montan después (SPA): vuelve a barrer
  window.Tema = {
    get: function () { return raiz.getAttribute("data-tema"); },
    set: function (t) { aplicar(t === "claro" ? "claro" : "oscuro", true); },
    alternar: function () { this.set(this.get() === "claro" ? "oscuro" : "claro"); },
    refrescar: iniciar
  };
})();
