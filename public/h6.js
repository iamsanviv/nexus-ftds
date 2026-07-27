const $=id=>document.getElementById(id);
$("agPendBloque").classList.add("hidden");
$("agDirBloque").classList.add("hidden");
$("agAutLista").innerHTML='<div class="naplica">No hay correos pendientes.</div>';
const filas=[
 ["mal","Fallando","Majo Guzman",true,"10/10","canal de WhatsApp no vinculado para este agente"],
 ["mal","Sin canal","Camila Ruiz",false,"0/0",""],
 ["ok","Operando","Evelin Gomez",false,"0/10",""],
 ["gris","Sin estrenar","Santiago Lemus",false,"0/0",""]];
$("agentesBody").innerHTML=filas.map(([c,t,n,alerta,u10,err])=>{
 const roto=c==="mal";
 return `<div class="agrow${roto&&!alerta?" visto":""}">
   <div class="agtop"><span class="agchip ${c}">${t}</span><span class="agname">${n}</span>
   ${roto&&!alerta?'<span class="agvisto">revisado</span>':''}
   ${alerta?'<button class="pmark agok">Ya lo vi</button>':''}</div>
   <div class="agmeta">${c==="gris"?'<span>Nunca ha enviado mensajes</span>':
     `<span>✓ 0 enviados · 24 h</span><span class="${u10[0]!=="0"?"agbad":""}">${u10} últimos fallaron</span><span>Último OK: —</span>`}</div>
   ${err&&roto?`<div class="agerr">${err}</div>`:''}</div>`}).join("");
