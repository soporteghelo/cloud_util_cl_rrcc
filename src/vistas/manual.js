/**
 * Vista "MANUAL": guia corta de uso y de como guardar los archivos que la app
 * lee de Drive (certificados de reinduccion). El contenido es estatico y vive
 * en index.html; aqui solo se engancha el boton que copia el prompt de
 * renombrado.
 */

import { $, copiarTexto } from "./comun.js";

const TEXTO_BOTON = "COPIAR PROMPT";

export function montarManual() {
  const boton = $("mn-copiar");
  const prompt = $("mn-prompt");
  if (!boton || !prompt) return;

  let reponer = 0;
  boton.addEventListener("click", async () => {
    const ok = await copiarTexto(prompt.textContent.trim());
    // sin portapapeles (navegador sin permiso), el texto queda seleccionado
    // para copiarlo a mano con Ctrl+C
    if (!ok) window.getSelection()?.selectAllChildren(prompt);
    boton.textContent = ok ? "COPIADO ✓" : "SELECCIONADO · CTRL+C";
    clearTimeout(reponer);
    reponer = setTimeout(() => (boton.textContent = TEXTO_BOTON), 2500);
  });
}
