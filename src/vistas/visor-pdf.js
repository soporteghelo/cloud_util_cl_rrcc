/**
 * Visor de PDF que funciona tambien en el celular.
 *
 * Un <iframe> con el PDF solo se ve donde el navegador trae visor propio
 * (Chrome/Edge/Firefox de escritorio). En Android el iframe queda en blanco u
 * ofrece descargar, y en iOS muestra solo la primera pagina sin poder moverse:
 * habia que bajar cada certificado para verlo. Ahi el PDF se dibuja con
 * pdf.js, pagina por pagina, en <canvas>.
 *
 * pdf.js pesa bastante: se carga recien al abrir el primer PDF que lo necesita,
 * asi no engorda la carga inicial de la app.
 */

import { escaparHtml, descargarBlob } from "./comun.js";

let pdfjsP = null;
function cargarPdfjs() {
  pdfjsP ||= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(([lib, worker]) => {
    lib.GlobalWorkerOptions.workerSrc = worker.default;
    return lib;
  });
  pdfjsP.catch(() => (pdfjsP = null)); // un fallo de red no queda pegado
  return pdfjsP;
}

/** Visor nativo solo en escritorio con visor de PDF propio; en tactil, pdf.js. */
export function usarVisorNativo() {
  return navigator.pdfViewerEnabled === true && !window.matchMedia("(max-width: 900px), (pointer: coarse)").matches;
}

/** Niveles de zoom del visor dibujado (ancho de la pagina respecto de la pantalla). */
const ZOOMS = [1, 1.5, 2, 3];

/**
 * Reemplaza `lugar` por el PDF (`bytes`: ArrayBuffer o Uint8Array).
 * Devuelve { url } cuando uso el visor nativo, para que quien llama suelte el
 * blob al cerrar; con pdf.js no queda nada que soltar.
 */
export async function montarPdf(lugar, bytes, { titulo = "Documento" } = {}) {
  if (usarVisorNativo()) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    const iframe = document.createElement("iframe");
    iframe.className = "visor-pdf";
    iframe.title = titulo;
    iframe.src = url;
    lugar.replaceWith(iframe);
    return { url };
  }

  const pdfjs = await cargarPdfjs();
  // copia: pdf.js se queda con el buffer que recibe (lo pasa al worker) y el
  // original sigue haciendo falta para el ZIP y para volver a abrirlo
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes).slice() }).promise;

  const caja = document.createElement("div");
  caja.className = "visor-lienzo";
  caja.innerHTML =
    `<div class="visor-scroll" data-scroll><div class="visor-paginas" data-paginas></div></div>` +
    `<div class="visor-zoom" role="group" aria-label="Zoom">` +
    `<button type="button" class="btn btn-ghost btn-sm" data-zoom="-1" aria-label="Alejar">−</button>` +
    `<span data-zoom-n>100%</span>` +
    `<button type="button" class="btn btn-ghost btn-sm" data-zoom="1" aria-label="Acercar">+</button></div>`;
  lugar.replaceWith(caja);
  const paginas = caja.querySelector("[data-paginas]");

  // Se dibuja una sola vez con resolucion de sobra para el zoom maximo mas
  // usado (x2), y el zoom solo cambia el ancho CSS: acercar es instantaneo.
  const anchoPantalla = Math.max(280, caja.querySelector("[data-scroll]").clientWidth - 16);
  const anchoLienzo = Math.min(2000, Math.round(anchoPantalla * Math.min(window.devicePixelRatio || 1, 2) * 2));
  for (let n = 1; n <= doc.numPages; n++) {
    const pagina = await doc.getPage(n);
    const base = pagina.getViewport({ scale: 1 });
    const vista = pagina.getViewport({ scale: anchoLienzo / base.width });
    const lienzo = document.createElement("canvas");
    lienzo.className = "visor-pagina";
    lienzo.width = Math.round(vista.width);
    lienzo.height = Math.round(vista.height);
    lienzo.setAttribute("aria-label", `${titulo} · página ${n} de ${doc.numPages}`);
    paginas.appendChild(lienzo);
    await pagina.render({ canvasContext: lienzo.getContext("2d"), viewport: vista }).promise;
    pagina.cleanup();
  }
  doc.destroy();

  let zoom = 0;
  const aplicarZoom = () => {
    paginas.style.width = `${ZOOMS[zoom] * 100}%`;
    caja.querySelector("[data-zoom-n]").textContent = `${ZOOMS[zoom] * 100}%`;
    caja.querySelector('[data-zoom="-1"]').disabled = zoom === 0;
    caja.querySelector('[data-zoom="1"]').disabled = zoom === ZOOMS.length - 1;
  };
  caja.querySelectorAll("[data-zoom]").forEach((b) =>
    b.addEventListener("click", () => {
      zoom = Math.min(ZOOMS.length - 1, Math.max(0, zoom + Number(b.dataset.zoom)));
      aplicarZoom();
    })
  );
  aplicarZoom();
  return { url: "" };
}

/**
 * Capa a pantalla completa con un PDF que ya esta en memoria. Se cierra con
 * VOLVER o Escape; DESCARGAR baja el archivo por si hace falta compartirlo.
 */
export function abrirVisorPdf({ titulo, subtitulo = "", pdf, nombre = "documento.pdf" }) {
  const previo = document.activeElement;
  const visor = document.createElement("div");
  visor.className = "visor-modal";
  visor.setAttribute("role", "dialog");
  visor.setAttribute("aria-modal", "true");
  visor.setAttribute("aria-label", titulo);
  visor.innerHTML =
    `<div class="visor-head"><button class="btn btn-ghost btn-sm" data-volver>← VOLVER</button>` +
    `<span class="visor-titulo">${escaparHtml(titulo)}${subtitulo ? ` · ${escaparHtml(subtitulo)}` : ""}</span>` +
    `<button class="btn btn-ghost btn-sm" data-descargar>DESCARGAR</button></div>` +
    `<div class="visor-carga">Cargando…</div>`;
  document.body.appendChild(visor);

  let url = "";
  let cerrado = false;
  const cerrar = () => {
    cerrado = true;
    if (url) URL.revokeObjectURL(url);
    document.removeEventListener("keydown", alTeclear);
    visor.remove();
    previo?.focus?.();
  };
  const alTeclear = (ev) => {
    if (ev.key === "Escape") cerrar();
  };
  document.addEventListener("keydown", alTeclear);
  visor.querySelector("[data-volver]").addEventListener("click", cerrar);
  visor.querySelector("[data-descargar]").addEventListener("click", () =>
    descargarBlob(new Blob([pdf], { type: "application/pdf" }), nombre)
  );
  visor.querySelector("[data-volver]").focus();

  montarPdf(visor.querySelector(".visor-carga"), pdf, { titulo }).then(
    (r) => {
      if (cerrado) URL.revokeObjectURL(r.url || "");
      else url = r.url;
    },
    (e) => {
      if (cerrado) return;
      const carga = visor.querySelector(".visor-carga");
      if (carga) carga.outerHTML = `<div class="visor-error">No se pudo abrir el PDF: ${escaparHtml(e.message)}</div>`;
    }
  );
  return cerrar;
}
