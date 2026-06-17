// Punto de entrada. Importar cada módulo ejecuta su "wiring" de eventos,
// y al final arrancamos la sesión.
import "./ui.js";    // engancha modales, catálogo, búsqueda, botón + Cliente
import "./csv.js";   // engancha importar / exportar
import { boot } from "./auth.js"; // engancha login y revisa la sesión

boot();
