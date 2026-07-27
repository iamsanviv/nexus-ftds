const $=id=>document.getElementById(id);
$("segSrv").innerHTML='<optgroup label="Clases"><option>Uso de Plataforma Nexus</option></optgroup>';
// modo PUNTUAL con imagen cargada
$("segTipoAct").querySelectorAll("[data-tipo]").forEach(b=>b.classList.toggle("on",b.dataset.tipo==="libre"));
$("segSrvRow").classList.add("hidden");
$("segLibreRow").classList.remove("hidden");
$("segLibre").value="Lanzamiento de membresías";
$("segImgAyuda").textContent="Una actividad puntual no tiene servicio del cual heredar imagen: si no subes una, la invitación va sin imagen.";
const c=document.createElement("canvas");c.width=c.height=200;const x=c.getContext("2d");
const g=x.createLinearGradient(0,0,200,200);g.addColorStop(0,"#E8B84B");g.addColorStop(1,"#8a6f2e");
x.fillStyle=g;x.fillRect(0,0,200,200);x.fillStyle="#191204";x.font="bold 26px sans-serif";
x.textAlign="center";x.fillText("LANZA-",100,95);x.fillText("MIENTO",100,125);
$("segImgPrev").src=c.toDataURL();$("segImgPrev").classList.remove("hidden");
$("segImgDel").classList.remove("hidden");
$("segImgEstado").textContent="✓ Imagen lista";
$("segFecha").value="2026-07-30";$("segHora").value="19:00";
