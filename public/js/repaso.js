// Repaso diario de asistencias: al primer ingreso del día (después de las
// 7 AM) pregunta, una por una, por las invitaciones de días anteriores que
// quedaron sin respuesta (¿asistió o no?), para mantener el sistema al día.
import { state, $, esc, fmtF, toast, todos, hoyISO } from "./state.js";
import { dbPatch } from "./data.js";
import { render } from "./ui.js";

const clave = () => "nexusRepaso:" + state.me.id;

// Invitados (conf) de días anteriores sin asistencia marcada (acc), míos.
function pendientes() {
  const hoy = hoyISO();
  const items = [];
  for (const c of state.clientes) {
    if (c.owner_id !== state.me.id) continue;
    for (const s of todos()) {
      const f = (c.conf || {})[s.id];
      if (f && f < hoy && !c.acc[s.id]) items.push({ c, s, f });
    }
  }
  return items.sort((a, b) => a.f.localeCompare(b.f));
}

export function repasoDiario() {
  const hoy = hoyISO();
  if (new Date().getHours() < 7) return;               // antes de las 7 no molesta
  if (localStorage.getItem(clave()) === hoy) return;   // ya se hizo hoy
  const items = pendientes();
  if (!items.length) { localStorage.setItem(clave(), hoy); return; }

  let i = 0;
  const cerrar = () => {
    localStorage.setItem(clave(), hoy);
    $("repOverlay").classList.remove("open");
    render();
  };

  const paso = () => {
    if (i >= items.length) {
      $("repSub").textContent = "Repaso completado";
      $("repBody").innerHTML = `<div class="naplica" style="font-size:.95rem">🎉 Todo al día. ¡Buen trabajo!</div>`;
      localStorage.setItem(clave(), hoy);
      return;
    }
    const { c, s, f } = items[i];
    $("repSub").textContent = `${i + 1} de ${items.length} · invitaciones sin respuesta`;
    $("repBody").innerHTML = `
      <div class="prow" style="flex-direction:column;align-items:stretch;gap:12px">
        <div style="font-size:.95rem">¿<b>${esc(c.nombre)}</b> <span class="badge b-${c.mem}">${c.mem}</span> asistió a <b>${esc(s.n)}</b>?
          <span class="sfecha">invitado el ${fmtF(f)}</span>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="pmark" data-r="si">✓ Sí asistió</button>
          <button class="pmark off" data-r="no">✗ No asistió</button>
          <button class="tbtn" data-r="skip">Saltar por hoy</button>
        </div>
      </div>`;
    $("repBody").querySelectorAll("[data-r]").forEach(b => b.onclick = async () => {
      if (b.dataset.r === "si") {
        c.acc[s.id] = f;
        await dbPatch(c, { acc: c.acc });
        toast(`✓ ${c.nombre.split(" ")[0]} asistió a «${s.n}»`);
      } else if (b.dataset.r === "no") {
        delete c.conf[s.id];
        await dbPatch(c, { conf: c.conf });
        toast(`${c.nombre.split(" ")[0]} vuelve a «por invitar»`);
      }
      i++;
      paso();
    });
  };

  $("repCerrar").onclick = cerrar;
  $("repOverlay").onclick = e => { if (e.target.id === "repOverlay") cerrar(); };
  paso();
  $("repOverlay").classList.add("open");
}
