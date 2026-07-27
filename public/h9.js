const $=id=>document.getElementById(id);
$("segProgTitulo").innerHTML='Programar para <b>Uso de Plataforma Nexus</b> · 28/07, 6:00 p. m.';
$("segSegmentos").innerHTML='';
$("segFiltros").innerHTML='<button class="pill on">Todos (128)</button><button class="pill">Beca (32)</button>';
$("segSelCount").textContent="2 de 128 seleccionados · 3 ya programados";
// mezcla: nuevos, ya programados, y uno que además ya asistió
const gente=[
 ["Oro","Berlis Coley",false,false,true],
 ["VIP","César Betancur",true,false,false],
 ["Beca","Yulieth Ramírez",true,false,false],
 ["Platino","Jhon Fredy Álzate",true,true,false],
 ["Beca","Diana Marcela Ríos",false,false,true],
];
$("segFaltan").innerHTML=gente.map(([m,n,prog,asis,check])=>`
        <label class="seg-row${prog?" yaprogfila":""}">
          <input type="checkbox" ${check?"checked":""}>
          <span class="badge b-${m}">${m}</span>
          <span>${n}</span>
          ${prog?'<span class="yaprog">✓ ya programado</span>':''}
          ${asis?'<span class="yaasis">ya asistió</span>':''}
        </label>`).join("");
