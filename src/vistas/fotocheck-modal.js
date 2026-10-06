/**
 * Fotocheck en un panel flotante, sin fondo oscuro: se puede seguir editando
 * las tarjetas mientras esta abierto, y la vista se redibuja con cada cambio
 * (`actualizarFotocheck`). La foto y el fotocheck antiguo ya vienen resueltos
 * desde la corrida, asi que no se vuelve a pedir nada al servidor.
 *
 * La vista en pantalla se dibuja a escala 1 para que redibujar sea barato; el
 * JPG y el Word se generan en alta (ver FOTOCHECK en fotocheck.js) en el momento de descargarlos.
 */

import { $, descargarBlob } from "./comun.js";
import { dibujarFotocheck, fotocheckImagen, nombreFotocheck, PROPORCION } from "../lib/fotocheck.js";
import { armarAutorizacion } from "../lib/docx.js";

/** { clave, persona, foto, antiguo, config } de lo que muestra el panel. */
let actual = null;
let pedido = 0;

/** ¿Esta abierto el panel con el fotocheck de esa persona? (`clave` = su DNI en la lista) */
export function fotocheckAbiertoDe(clave) {
  return Boolean(actual) && !$("fc-modal")?.hidden && actual.clave === clave;
}

export function cerrarFotocheck() {
  const panel = $("fc-modal");
  if (panel) panel.hidden = true;
  actual = null;
  pedido++; // un dibujo en curso ya no debe pintarse
  document.dispatchEvent(new CustomEvent("fotocheck:cerrado"));
}

async function dibujar() {
  const lienzo = $("fc-canvas");
  if (!actual || !lienzo) return;
  const mio = ++pedido;
  const { persona, foto } = actual;

  $("fc-titulo").textContent = `${persona.nombreCompleto || persona.dni} · ${persona.codigo || ""}`.trim();
  const dibujo = await dibujarFotocheck(persona, { foto, escala: 1 });
  if (mio !== pedido) return; // llego otra actualizacion mientras se dibujaba

  lienzo.width = PROPORCION.ancho;
  lienzo.height = PROPORCION.alto;
  lienzo.getContext("2d").drawImage(dibujo, 0, 0);
}

/**
 * Abre el panel con esta persona. `clave` identifica a quien pertenece para
 * que solo sus cambios lo actualicen; `config` lleva las medidas del Word y
 * `antiguo` la foto del fotocheck viejo, si se pudo bajar de Drive. `vivo:
 * false` quita la marca EN VIVO (VER RRCC muestra lo guardado, no una ficha
 * que se este editando).
 */
export async function abrirFotocheck(
  persona,
  { clave = persona.dni, foto = null, antiguo = null, config = {}, vivo = true } = {}
) {
  const panel = $("fc-modal");
  if (!panel || !$("fc-canvas")) return;
  actual = { clave, persona, foto, antiguo, config };
  const marca = panel.querySelector(".fc-vivo");
  if (marca) marca.hidden = !vivo;
  panel.hidden = false;
  await dibujar();
}

/** Redibuja el panel abierto con datos nuevos; no hace nada si esta cerrado. */
export async function actualizarFotocheck(persona, opciones = {}) {
  if (!actual || $("fc-modal")?.hidden) return;
  actual = { ...actual, ...opciones, persona };
  await dibujar();
}

export function montarModalFotocheck() {
  $("fc-cerrar")?.addEventListener("click", cerrarFotocheck);

  // la imagen y el Word salen en el mismo formato que la carpeta de Drive,
  // dibujados con lo que muestra el panel ahora
  const enAlta = async () => (await fotocheckImagen(actual.persona, { foto: actual.foto })).blob;

  $("fc-png")?.addEventListener("click", async () => {
    if (!actual) return;
    descargarBlob(await enAlta(), nombreFotocheck(actual.persona));
  });

  $("fc-docx")?.addEventListener("click", async () => {
    if (!actual) return;
    const { persona, antiguo, config } = actual;
    const { word } = await fotocheckImagen(persona, { foto: actual.foto, conWord: true });
    const docx = await armarAutorizacion({
      fotocheck: word,
      antiguo,
      medidas: {
        fotocheckAnchoCm: Number(config.FOTOCHECK_ANCHO_CM || 10),
        fotocheckAltoCm: Number(config.FOTOCHECK_ALTO_CM || 8),
        antiguoAnchoCm: Number(config.ANTIGUO_ANCHO_CM || 17),
      },
    });
    descargarBlob(docx, `Autorizacion_RRCC_${persona.nombreCompleto || persona.dni}.docx`);
  });
}
