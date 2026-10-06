/**
 * Fotocheck de Autorizacion de Riesgos Criticos: replica de la hoja
 * FOTOCHEK del Excel, dibujada sobre un <canvas> y exportada a PNG.
 *
 * Por que canvas y no HTML->imagen: en Vercel no hay Chromium para renderizar
 * del lado del servidor, y las librerias de "HTML a PNG" del navegador
 * dependen de <foreignObject>, que ensucia el canvas en cuanto entra una
 * imagen de otro origen (la foto de Drive) y deja de poder exportarse. Con
 * canvas 2D el control es total, el resultado es identico en cualquier
 * navegador y no hace falta ninguna dependencia.
 *
 * El lienzo base es de 1400 x 920 (la proporcion nativa del fotocheck que
 * hoy se pega en el Word); `escala` lo multiplica para imprimir sin dientes.
 */

import { aFormatoCorto } from "../../shared/estados.js";

/* Paleta tomada del fotocheck original. */
const AZUL = "#002060";
const GRIS_LOGO = "#929292";
const BORDE = "#4472C4";
const GRIS_A = "#BFBFBF";

const BASE_W = 1400;
const BASE_H = 920;

const FUENTE = '"Arial Narrow", "Liberation Sans Narrow", Arial, Helvetica, sans-serif';

/** Las dos filas en blanco que el fotocheck original deja al final. */
const FILAS_RRCC = 8;

/* ------------------------------------------------------------------ */
/* Utilidades de dibujo                                                */
/* ------------------------------------------------------------------ */

/** El tamano con que `valor` entra en `ancho` (deja `ctx.font` puesto con el). */
function tamQueEntra(ctx, valor, { tam = 20, negrita = false, ancho = 0 } = {}) {
  let tamActual = tam;
  ctx.font = `${negrita ? "bold " : ""}${tamActual}px ${FUENTE}`;
  // el cargo y los apellidos largos no deben desbordar su casilla
  if (ancho) {
    while (tamActual > 8 && ctx.measureText(valor).width > ancho) {
      tamActual -= 1;
      ctx.font = `${negrita ? "bold " : ""}${tamActual}px ${FUENTE}`;
    }
  }
  return tamActual;
}

function texto(ctx, t, x, y, { tam = 20, negrita = false, color = "#000", alineado = "left", ancho = 0 } = {}) {
  const valor = String(t ?? "");
  if (!valor) return;
  tamQueEntra(ctx, valor, { tam, negrita, ancho });
  ctx.fillStyle = color;
  ctx.textAlign = alineado;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(valor, x, y);
}

/**
 * Un dato del fotocheck que se corrige en el Word (fechas del EMO, uso de
 * lentes y vencimiento de cada RRCC). En el Word va como texto editable encima
 * de la imagen, para poder corregirlo alli sin rehacer el fotocheck: con
 * `editables` (un arreglo) no se dibuja, se anota en el con su posicion y su
 * letra (`y` es la linea base) para que el Word lo ponga en el mismo sitio.
 * Sin valor tambien se anota: asi queda la casilla para escribirlo.
 */
function editable(ctx, editables, nombre, t, x, y, opciones) {
  const valor = String(t ?? "");
  if (!editables) return texto(ctx, valor, x, y, opciones);
  editables.push({
    nombre,
    texto: valor,
    x,
    y,
    alineado: "left",
    ...opciones,
    tam: valor ? tamQueEntra(ctx, valor, opciones) : opciones.tam,
  });
}

function caja(ctx, x, y, w, h, { relleno = null, borde = null, grosor = 1.5 } = {}) {
  if (relleno) {
    ctx.fillStyle = relleno;
    ctx.fillRect(x, y, w, h);
  }
  if (borde) {
    ctx.strokeStyle = borde;
    ctx.lineWidth = grosor;
    ctx.strokeRect(x + grosor / 2, y + grosor / 2, w - grosor, h - grosor);
  }
}

/** Carga una imagen desde una URL, data URI, blob o ArrayBuffer. null si no se puede. */
export function cargarImagen(fuente) {
  return new Promise((resolver) => {
    if (!fuente) return resolver(null);

    const prepararUrl = async () => {
      if (fuente instanceof Blob) {
        const bytes = new Uint8Array(await fuente.arrayBuffer());
        let binario = "";
        const trozo = 0x8000;
        for (let i = 0; i < bytes.length; i += trozo) {
          binario += String.fromCharCode(...bytes.subarray(i, i + trozo));
        }
        return `data:${fuente.type || "image/png"};base64,${btoa(binario)}`;
      }
      if (fuente instanceof ArrayBuffer || ArrayBuffer.isView(fuente)) {
        const buffer = fuente instanceof ArrayBuffer ? fuente : fuente.buffer;
        const bytes = new Uint8Array(buffer);
        let binario = "";
        const trozo = 0x8000;
        for (let i = 0; i < bytes.length; i += trozo) {
          binario += String.fromCharCode(...bytes.subarray(i, i + trozo));
        }
        return `data:image/png;base64,${btoa(binario)}`;
      }
      return fuente;
    };

    prepararUrl()
      .then((url) => {
        const img = new Image();
        if (typeof url === "string" && !url.startsWith("data:") && !url.startsWith("blob:")) {
          img.crossOrigin = "anonymous";
        }
        img.onload = () => resolver(img);
        img.onerror = () => resolver(null);
        img.src = url;
      })
      .catch(() => resolver(null));
  });
}

/** Algo que ya se puede pasar a drawImage tal cual, sin volver a cargarlo. */
const yaCargada = (x) =>
  (typeof HTMLImageElement !== "undefined" && x instanceof HTMLImageElement) ||
  (typeof HTMLCanvasElement !== "undefined" && x instanceof HTMLCanvasElement) ||
  (typeof ImageBitmap !== "undefined" && x instanceof ImageBitmap);

const comoImagen = (x) => (yaCargada(x) ? Promise.resolve(x) : cargarImagen(x));

/**
 * Junta 1 o 2 fotos del fotocheck antiguo (anverso y reverso del carnet
 * fisico) en una sola imagen para pegar en el Word. Con las dos, van lado a
 * lado a la misma altura, como las dos caras de un carnet fisico (antes
 * quedaban una debajo de la otra, en una tira vertical incomoda de leer).
 * Si llega una sola, se usa tal cual: no todo carnet tiene reverso para
 * fotografiar. Devuelve { datos, mime, ancho, alto } listo para `armarAutorizacion`.
 */
export async function combinarFotocheckAntiguo(archivos) {
  const lista = Array.from(archivos || []).filter(Boolean).slice(0, 2);
  if (!lista.length) return null;

  const imagenes = (await Promise.all(lista.map((a) => cargarImagen(a)))).filter(Boolean);
  if (!imagenes.length) throw new Error("no se pudo leer la imagen");

  // altura compartida: la menor de las dos fotos, para no agrandar una por
  // encima de su resolucion real (se veria borrosa).
  const alto = Math.min(1200, ...imagenes.map((img) => img.naturalHeight || img.height));
  const separacion = imagenes.length > 1 ? Math.round(alto * 0.02) || 10 : 0;
  const anchos = imagenes.map((img) => {
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    return Math.round((w * alto) / h);
  });
  const ancho = anchos.reduce((suma, w) => suma + w, 0) + separacion * Math.max(imagenes.length - 1, 0);

  const lienzo = document.createElement("canvas");
  lienzo.width = ancho;
  lienzo.height = alto;
  const ctx = lienzo.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ancho, alto);
  let x = 0;
  imagenes.forEach((img, i) => {
    ctx.drawImage(img, x, 0, anchos[i], alto);
    x += anchos[i] + separacion;
  });

  // son fotos de camara: en PNG pesaban varios MB dentro del Word, en JPEG una fraccion
  const blob = await new Promise((resolver) => lienzo.toBlob(resolver, "image/jpeg", 0.88));
  return { datos: await blob.arrayBuffer(), mime: "image/jpeg", ancho, alto };
}

/** Dibuja `img` dentro del rectangulo recortando lo que sobre (object-fit: cover). */
function dibujarCubriendo(ctx, img, x, y, w, h) {
  const escala = Math.max(w / img.width, h / img.height);
  const aw = img.width * escala;
  const ah = img.height * escala;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - aw) / 2, y + (h - ah) / 2, aw, ah);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* Panel izquierdo: foto y datos                                       */
/* ------------------------------------------------------------------ */

function panelIzquierdo(ctx, p, foto, logo, editables) {
  const X = 12;
  const Y = 6;
  const W = 656;
  const H = 906;

  caja(ctx, X, Y, W, H, { relleno: AZUL, borde: BORDE, grosor: 3 });

  if (logo) {
    const alto = 118;
    const ancho = (logo.width / logo.height) * alto;
    ctx.drawImage(logo, X + 44, Y + 8, ancho, alto);
  } else {
    texto(ctx, "AESA", X + 44, Y + 108, { tam: 78, negrita: true, color: GRIS_LOGO });
  }

  /* Foto: marco blanco y recorte centrado. */
  const fx = 196;
  const fy = 138;
  const fw = 256;
  const fh = 288;
  caja(ctx, fx - 4, fy - 4, fw + 8, fh + 8, { relleno: "#FFFFFF" });
  if (foto) {
    dibujarCubriendo(ctx, foto, fx, fy, fw, fh);
  } else {
    caja(ctx, fx, fy, fw, fh, { relleno: "#D9D9D9" });
    texto(ctx, "SIN FOTO", fx + fw / 2, fy + fh / 2, { tam: 22, color: "#7F7F7F", alineado: "center" });
  }

  const centro = X + W / 2;
  texto(ctx, "DNI", centro - 82, 448, { tam: 26, negrita: true, color: "#FFFFFF", alineado: "right" });
  texto(ctx, p.dni, centro - 62, 448, { tam: 24, color: "#FFFFFF" });
  texto(ctx, "Autorización Interna", centro, 484, { tam: 28, color: "#FFFFFF", alineado: "center" });
  texto(ctx, "Riesgos Críticos de Seguridad", centro, 524, {
    tam: 30,
    negrita: true,
    color: "#FFFFFF",
    alineado: "center",
  });

  /* Recuadro blanco de datos. */
  const dx = X + 4;
  const dy = 558;
  const dw = W - 8;
  const dh = H + Y - dy - 6;
  caja(ctx, dx, dy, dw, dh, { relleno: "#FFFFFF", borde: BORDE, grosor: 2 });

  const etiqueta = dx + 12;
  const valor = dx + 292;
  const anchoValor = dw - 300;
  // [etiqueta, valor, y, negrita, nombre si es editable en el Word]
  const filas = [
    ["Apellidos:", p.apellidos, 588, false],
    ["Nombres:", p.nombres, 625, true],
    ["Area:", p.area, 662, true],
    ["Cargo", p.cargo, 734, true],
    ["F. Ex. Médico:", aFormatoCorto(p.examenMedico), 806, true, "F. Ex. Medico"],
    ["F. Vencimiento:", aFormatoCorto(p.vencimientoEmo), 838, true, "F. Vencimiento EMO"],
    ["Uso de Lentes:", p.usoLentes, 880, true, "Uso de Lentes"],
  ];
  for (const [cab, val, y, negrita, nombreEditable] of filas) {
    texto(ctx, cab, etiqueta, y, { tam: 25, negrita: true });
    const letra = { tam: negrita ? 22 : 21, negrita, ancho: anchoValor };
    if (nombreEditable) editable(ctx, editables, nombreEditable, val, valor, y, letra);
    else texto(ctx, val, valor, y, letra);
  }
}

/* ------------------------------------------------------------------ */
/* Panel derecho: grilla de riesgos criticos                           */
/* ------------------------------------------------------------------ */

function panelDerecho(ctx, p, editables) {
  const X = 690;
  const W = 700;
  const columnas = 3;
  const hueco = 16;
  const anchoCol = (W - hueco * (columnas - 1)) / columnas;
  const altoCaja = 38;
  const paso = 71;
  const y0 = 14;

  for (let fila = 0; fila < FILAS_RRCC; fila++) {
    for (let col = 0; col < columnas; col++) {
      const r = p.riesgos[fila * columnas + col] || null;
      const x = X + col * (anchoCol + hueco);
      const yEtiqueta = y0 + fila * paso + 16;
      const yCaja = y0 + fila * paso + 24;

      texto(ctx, r ? r.rotulo : "-", x + anchoCol / 2, yEtiqueta, {
        tam: 21,
        alineado: "center",
        ancho: anchoCol - 6,
      });
      caja(ctx, x, yCaja, anchoCol, altoCaja, { relleno: "#FFFFFF", borde: "#000000", grosor: 1.6 });
      if (!r) continue;

      /* La letra va en su propio recuadro a la derecha; "A" ademas sombreado. */
      const anchoLetra = 40;
      const xLetra = x + anchoCol - anchoLetra;
      if (r.tipo === "A") caja(ctx, xLetra, yCaja, anchoLetra, altoCaja, { relleno: GRIS_A });
      if (r.tipo) {
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(xLetra, yCaja);
        ctx.lineTo(xLetra, yCaja + altoCaja);
        ctx.stroke();
        texto(ctx, r.tipo, xLetra + anchoLetra / 2, yCaja + 28, { tam: 24, negrita: true, alineado: "center" });
      }
      editable(ctx, editables, r.rotulo, aFormatoCorto(r.venc), x + (anchoCol - anchoLetra) / 2, yCaja + 28, {
        tam: 24,
        alineado: "center",
        ancho: anchoCol - anchoLetra - 8,
      });
    }
  }

  /* AUTORIZADO / NO AUTORIZADO */
  const yMarca = y0 + FILAS_RRCC * paso + 26;
  const autorizado = p.estadoFinal === "VIGENTE" && p.riesgos.some((r) => r.tipo === "A");
  const lado = 34;

  caja(ctx, X + 72, yMarca - lado + 6, lado, lado, {
    relleno: autorizado ? "#000000" : "#FFFFFF",
    borde: "#000000",
    grosor: 2,
  });
  texto(ctx, "AUTORIZADO", X + 118, yMarca, { tam: 26, negrita: true });

  caja(ctx, X + 412, yMarca - lado + 6, lado, lado, {
    relleno: autorizado ? "#FFFFFF" : "#000000",
    borde: "#000000",
    grosor: 2,
  });
  texto(ctx, "NO AUTORIZADO", X + 458, yMarca, { tam: 26, negrita: true });

  /* Leyenda */
  const ly = yMarca + 18;
  const lh = BASE_H - ly - 12;
  caja(ctx, X + 26, ly, W - 26, lh, { relleno: "#FFFFFF", borde: BORDE, grosor: 2.5 });

  const lineas = [
    ["IMPORTANTE:", "Lleve Usted esta autorizacion siempre"],
    ["", "para mostrarla cada vez que sea requerida."],
    ["", "Esta prohibida cualquier alteración de la Autorización;"],
    ["", "las Areas de Serv. Grales y SSMA. Son las unicas áreas"],
    ["", "permitidas para su modificación."],
    ["A:", "AUTORIZADO"],
    ["C:", "CAPACITADO"],
  ];
  let ty = ly + 26;
  for (const [fuerte, resto] of lineas) {
    let x = X + 38;
    if (fuerte) {
      texto(ctx, fuerte, x, ty, { tam: 22, negrita: true });
      ctx.font = `bold 22px ${FUENTE}`;
      x += ctx.measureText(fuerte).width + 5;
    }
    texto(ctx, resto, x, ty, { tam: 22 });
    ty += 33;
  }
}

/* ------------------------------------------------------------------ */
/* API publica                                                         */
/* ------------------------------------------------------------------ */

/**
 * Dibuja el fotocheck de una persona y devuelve el canvas.
 * `persona` es lo que devuelve `leerFila()` de estados.js. Con `editables`
 * (un arreglo) los datos editables en el Word no se dibujan: se anotan en el
 * (ver `editable`).
 */
export async function dibujarFotocheck(
  persona,
  { foto = null, logo = "/logo-aesa.png", escala = 3, editables = null } = {}
) {
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.round(BASE_W * escala);
  lienzo.height = Math.round(BASE_H * escala);

  const ctx = lienzo.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.scale(escala, escala);
  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, BASE_W, BASE_H);

  const [imgFoto, imgLogo] = await Promise.all([comoImagen(foto), comoImagen(logo)]);

  panelIzquierdo(ctx, persona, imgFoto, imgLogo, editables);
  panelDerecho(ctx, persona, editables);

  return lienzo;
}

/**
 * Formato del fotocheck que se guarda (Drive, ZIP, Word y descarga del panel).
 *
 * Antes era PNG a 3x (4200 x 2760 px, ~1.4 MB): lo mas pesado de cada
 * carpeta, y el Word lo llevaba adentro otra vez. En el Word se imprime a
 * ~11 cm de ancho: 2x (2800 px) son ~650 dpi, de sobra para imprimir nitido, y
 * JPEG con calidad alta pesa una fraccion del PNG sin que se note en el texto.
 */
export const FOTOCHECK = { mime: "image/jpeg", ext: "jpg", escala: 2, calidad: 0.92 };

/** Nombre del archivo del fotocheck de una persona. */
export const nombreFotocheck = (persona) => `FOTOCHECK_${persona.nombreCompleto || persona.dni}.${FOTOCHECK.ext}`;

/** ¿Es la imagen del fotocheck en una carpeta de Drive? (las mas viejas eran PNG) */
export const esImagenFotocheck = (nombre) => /^FOTOCHECK_.+\.(jpe?g|png)$/i.test(String(nombre || ""));

/**
 * El fotocheck como imagen (Blob, en el formato de FOTOCHECK), lista para
 * subir a Drive.
 *
 * Con `conWord`, ademas `word`: el `fotocheck` que pide `armarAutorizacion`.
 * Es la misma imagen pero sin los datos editables (fechas del EMO, uso de
 * lentes y vencimiento de cada RRCC), que el Word pone encima como texto
 * (`textos`, en pixeles del lienzo base `marco`). Se dibuja una sola vez:
 * primero sin esos datos para el Word, y luego se agregan sobre el mismo
 * lienzo para la imagen suelta.
 */
export async function fotocheckImagen(persona, { conWord = false, ...opciones } = {}) {
  const editables = conWord ? [] : null;
  const lienzo = await dibujarFotocheck(persona, { escala: FOTOCHECK.escala, ...opciones, editables });
  const aBlob = () => new Promise((r) => lienzo.toBlob(r, FOTOCHECK.mime, FOTOCHECK.calidad));
  const fallo = () => new Error("el navegador no pudo generar la imagen del fotocheck");

  let word = null;
  if (editables) {
    const sinEditables = await aBlob();
    if (!sinEditables) throw fallo();
    word = { datos: await sinEditables.arrayBuffer(), mime: FOTOCHECK.mime, textos: editables, marco: PROPORCION };
    const ctx = lienzo.getContext("2d");
    ctx.setTransform(lienzo.width / BASE_W, 0, 0, lienzo.height / BASE_H, 0, 0);
    for (const e of editables) texto(ctx, e.texto, e.x, e.y, e);
  }

  const blob = await aBlob();
  if (!blob) throw fallo();
  return { blob, lienzo, mime: FOTOCHECK.mime, ancho: lienzo.width, alto: lienzo.height, word };
}

export const PROPORCION = { ancho: BASE_W, alto: BASE_H };

/** Recuadro de la foto en el lienzo base (ver `panelIzquierdo`). */
const FOTO = { ancho: 256, alto: 288 };

/**
 * La foto achicada a lo que ocupa en el fotocheck en alta (FOTOCHECK.escala),
 * como JPEG. Las fotos de FOTOS suelen ser de camara (varios MB): para ver
 * cientos de fotochecks a la vez no se puede tener cada una entera en memoria,
 * y el fotocheck no usa mas pixeles que estos. null si no se puede leer.
 */
export async function fotoReducida(fuente) {
  const img = await comoImagen(fuente);
  if (!img) return null;
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  if (!w || !h) return null;
  const escala = Math.min(1, Math.max((FOTO.ancho * FOTOCHECK.escala) / w, (FOTO.alto * FOTOCHECK.escala) / h));
  const lienzo = document.createElement("canvas");
  lienzo.width = Math.max(1, Math.round(w * escala));
  lienzo.height = Math.max(1, Math.round(h * escala));
  const ctx = lienzo.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
  return new Promise((r) => lienzo.toBlob(r, "image/jpeg", 0.9));
}
