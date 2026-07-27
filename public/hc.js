const $=id=>document.getElementById(id);
const acts=[
 ["Lanzamiento de membresías","30/07, 7:00 p. m.",true,true,true],
 ["Uso de Plataforma Nexus","28/07, 6:00 p. m.",false,true,false],
 ["Operativa en vivo","29/07, 9:00 p. m.",false,false,false],
];
$("acts").innerHTML=acts.map(([n,f,libre,ajena,link])=>`
    <article class="actcard">
      <div class="am"><h4>${n}</h4>
        <div class="ameta"><span class="atime">${f}</span>
          ${libre?'<span class="achip suelta">✦ Puntual</span>':''}
          ${ajena?'<span class="achip equipo">👥 De tu director</span>':''}
          ${link?'<span class="achip ok">Enlace listo</span>':'<span class="achip miss">Falta el enlace</span>'}
        </div></div>
      <div class="ab"><button class="pmark">📨 Programar</button>
      ${ajena?'':'<button class="pmark">✎</button><button class="pmark off">✕</button>'}</div>
    </article>`).join("");
$("perfil").innerHTML=
 '<div class="actrow"><span class="an">Uso de Plataforma Nexus</span><input type="date" value="2026-07-24"></div>'
+'<div class="pstitle" style="margin-top:14px">Actividades puntuales</div>'
+'<div class="actrow"><span class="an">Lanzamiento de membresías<span class="achip suelta" style="margin-left:7px">✦ Puntual</span></span><input type="date" value="2026-07-30"></div>';
