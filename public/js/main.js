// Punto de entrada. Importar cada módulo ejecuta su "wiring" de eventos,
// y al final arrancamos la sesión.
import "./ui.js";    // engancha modales, catálogo, búsqueda, botón + Cliente
import "./csv.js";   // engancha importar / exportar
import "./stats.js";
import "./seguimiento.js";
import "./masivo.js";  // compositor de mensaje masivo
import "./canal.js";   // "Mi WhatsApp": estado y vinculación del canal del agente
import "./salud.js";   // avisos de canal caído + panel de agentes del director
import "./ventas.js";  // ventas, abonos y comisiones
import "./ftd.js";     // bloque de FTD en Personas, metas y cierre mensual
import { boot } from "./auth.js"; // engancha login y revisa la sesión

boot();
