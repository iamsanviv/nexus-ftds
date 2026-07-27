const $=id=>document.getElementById(id);
$("segProgTitulo").innerHTML='Programar para <b>Uso de Plataforma Nexus</b> · 28/07, 6:00 p. m.';
$("segSegmentos").innerHTML='';
$("segFiltros").innerHTML=[["Todos (128)",1],["Beca (32)",0],["VIP (21)",0],["Oro (9)",0]]
 .map(([l,on])=>`<button class="pill ${on?"on":""}">${l}</button>`).join("");
$("segSelCount").textContent="34 de 128 seleccionados";
$("segFaltan").innerHTML=[["Oro","Berlis Coley"],["VIP","César Betancur"],["Beca","Yulieth Ramírez"]]
 .map(([m,n])=>`<label class="seg-row"><input type="checkbox" checked><span class="badge b-${m}">${m}</span><span>${n}</span></label>`).join("");
// activar el modo sin invitación, igual que hace seguimiento.js
$("segSinInv").checked=true;
$("segTardeToggle").classList.add("hidden");
$("segProgramar").textContent="Programar sin invitación";
