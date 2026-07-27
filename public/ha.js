const $=id=>document.getElementById(id);
const LIBRE="__libre__";
$("segSrv").innerHTML=`<optgroup label="Clases"><option>Uso de Plataforma Nexus</option>
<option>Uso de ExOption a Profundidad</option></optgroup>
<optgroup label="Fuera del catálogo"><option value="${LIBRE}" selected>✦ Actividad puntual (escribo el nombre)</option></optgroup>`;
$("segLibreRow").classList.remove("hidden");
$("segLibre").value="Lanzamiento de membresías";
$("segFecha").value="2026-07-30";
$("segHora").value="19:00";
$("acts").innerHTML=[
 ["Lanzamiento de membresías","30/07, 7:00 p. m.",true,true],
 ["Uso de Plataforma Nexus","28/07, 6:00 p. m.",false,true],
].map(([n,f,libre,link])=>`
    <article class="actcard">
      <div class="am"><h4>${n}</h4>
        <div class="ameta"><span class="atime">${f}</span>
          ${libre?'<span class="achip suelta">✦ Puntual</span>':''}
          ${link?'<span class="achip ok">Enlace listo</span>':'<span class="achip miss">Falta el enlace</span>'}
        </div></div>
      <div class="ab"><button class="pmark">📨 Programar</button>
        <button class="pmark">✎</button><button class="pmark off">✕</button></div>
    </article>`).join("");
