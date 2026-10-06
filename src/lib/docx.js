/**
 * Genera el Word de autorizacion: arriba el fotocheck nuevo (10 cm de ancho
 * x 8 cm de alto) y debajo la foto del fotocheck antiguo.
 *
 * Se arma el OOXML a mano con JSZip (que ya esta en el proyecto para los ZIP)
 * en vez de sumar la libreria `docx`: un .docx es un ZIP con cuatro XML, y de
 * esos cuatro aca solo cambia el que lleva las dos imagenes. Evita una
 * dependencia de varios MB para producir un documento de dos parrafos.
 *
 * Las medidas van en EMU (English Metric Units), que es como mide OOXML:
 * 360000 EMU = 1 cm. Se fijan explicitamente en `wp:extent` y en `a:ext`
 * porque Word usa el primero para el hueco en la pagina y el segundo para el
 * dibujo; si no coinciden, la imagen sale recortada.
 *
 * Las fechas del fotocheck (EMO y vencimiento de cada RRCC) no van en la
 * imagen sino en cuadros de texto flotantes encima de ella, en la misma
 * letra, para poder corregirlas en el Word sin rehacer el fotocheck.
 */

import JSZip from "jszip";

export const EMU_POR_CM = 360000;
export const cmAEmu = (cm) => Math.round(cm * EMU_POR_CM);
const CM_POR_PT = 2.54 / 72;

/** La letra del fotocheck (ver FUENTE en fotocheck.js). */
const FUENTE_WORD = "Arial Narrow";
/** Altura de la linea base de Arial Narrow negrita sobre el borde de la linea, en em (winAscent 1910/2048). */
const ASCENSO = 0.93;

const NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const MIME_EXT = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/gif": "gif",
  "image/bmp": "bmp",
};

/* ------------------------------------------------------------------ */
/* Piezas del documento                                                */
/* ------------------------------------------------------------------ */

/** `textos` (ver `cuadroTexto`) se anclan a este mismo parrafo: quedan encima de la imagen. */
function parrafoImagen(idRel, idDoc, nombre, anchoEmu, altoEmu, textos = "") {
  return (
    "<w:p><w:r><w:drawing>" +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${anchoEmu}" cy="${altoEmu}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    `<wp:docPr id="${idDoc}" name="${escapar(nombre)}"/>` +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    "<pic:pic>" +
    `<pic:nvPicPr><pic:cNvPr id="${idDoc}" name="${escapar(nombre)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${idRel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    "<pic:spPr>" +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${anchoEmu}" cy="${altoEmu}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    "</pic:spPr>" +
    "</pic:pic>" +
    "</a:graphicData></a:graphic>" +
    "</wp:inline>" +
    "</w:drawing></w:r>" +
    textos +
    "</w:p>"
  );
}

/**
 * Propiedades de la letra, puestas en el texto y en la marca de parrafo: si
 * se borra la fecha entera y se escribe otra, Word sigue usando esta letra.
 */
function letra(t) {
  return (
    "<w:rPr>" +
    `<w:rFonts w:ascii="${FUENTE_WORD}" w:hAnsi="${FUENTE_WORD}" w:eastAsia="${FUENTE_WORD}" w:cs="${FUENTE_WORD}"/>` +
    (t.negrita ? "<w:b/><w:bCs/>" : "") +
    "<w:noProof/>" +
    '<w:color w:val="000000"/>' +
    `<w:w w:val="${t.escalaH}"/>` +
    `<w:sz w:val="${t.medios}"/><w:szCs w:val="${t.medios}"/>` +
    "</w:rPr>"
  );
}

/**
 * Cuadro de texto flotante, sin borde ni relleno, anclado al parrafo de la
 * imagen y puesto relativo a su esquina (la imagen va en linea, al inicio de
 * la columna y del parrafo). `t` = { texto, nombre, xCm, yCm, anchoCm, altoCm,
 * medios (tamano en medios puntos), escalaH (% de ancho de la letra), negrita,
 * alineado }.
 */
function cuadroTexto(t, idDoc) {
  const ancho = cmAEmu(t.anchoCm);
  const alto = cmAEmu(t.altoCm);
  const rPr = letra(t);
  return (
    "<w:r><w:drawing>" +
    '<wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" ' +
    `relativeHeight="${251659264 + idDoc}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    '<wp:simplePos x="0" y="0"/>' +
    `<wp:positionH relativeFrom="column"><wp:posOffset>${cmAEmu(t.xCm)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${cmAEmu(t.yCm)}</wp:posOffset></wp:positionV>` +
    `<wp:extent cx="${ancho}" cy="${alto}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    "<wp:wrapNone/>" +
    `<wp:docPr id="${idDoc}" name="${escapar(t.nombre || "Fecha")}"/>` +
    "<wp:cNvGraphicFramePr/>" +
    '<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
    "<wps:wsp>" +
    '<wps:cNvSpPr txBox="1"/>' +
    "<wps:spPr>" +
    `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${ancho}" cy="${alto}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    "<a:noFill/><a:ln><a:noFill/></a:ln>" +
    "</wps:spPr>" +
    "<wps:txbx><w:txbxContent><w:p><w:pPr>" +
    '<w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/>' +
    '<w:ind w:left="0" w:right="0" w:firstLine="0"/>' +
    `<w:jc w:val="${t.alineado === "center" ? "center" : "left"}"/>` +
    rPr +
    "</w:pPr>" +
    (t.texto ? `<w:r>${rPr}<w:t xml:space="preserve">${escapar(t.texto)}</w:t></w:r>` : "") +
    "</w:p></w:txbxContent></wps:txbx>" +
    '<wps:bodyPr rot="0" vert="horz" wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t" anchorCtr="0">' +
    "<a:noAutofit/></wps:bodyPr>" +
    "</wps:wsp>" +
    "</a:graphicData></a:graphic>" +
    "</wp:anchor>" +
    "</w:drawing></w:r>"
  );
}

const escapar = (t) =>
  String(t ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function documento(cuerpo) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    `<w:document ${NS}><w:body>` +
    cuerpo +
    // A4 vertical con margenes de 2 cm (1134 twips)
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="709" w:footer="709" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>"
  );
}

function contentTypes(extensiones) {
  const defaults = ["rels", ...extensiones]
    .filter((v, i, a) => a.indexOf(v) === i)
    .map((ext) =>
      ext === "rels"
        ? '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        : `<Default Extension="${ext}" ContentType="image/${ext === "jpeg" ? "jpeg" : ext}"/>`
    )
    .join("");
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    defaults +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ' +
    'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>"
  );
}

/* ------------------------------------------------------------------ */
/* API publica                                                         */
/* ------------------------------------------------------------------ */

/**
 * `imagenes` = [{ datos, mime, anchoCm, altoCm, nombre, textos }] en el orden
 * en que van en el documento; `textos` son los cuadros de texto que van
 * encima de esa imagen (ver `cuadroTexto`). Devuelve un Blob listo para
 * descargar o subir a Drive.
 */
export async function armarDocx(imagenes, tipo = "blob") {
  const zip = new JSZip();
  const utiles = imagenes.filter((i) => i && i.datos);
  if (!utiles.length) throw new Error("el Word necesita al menos una imagen");

  const rels = [];
  const extensiones = [];
  let cuerpo = "<w:p/>";
  // ids de los cuadros de texto: despues de los de las imagenes (1..n), sin repetirse
  let idTexto = utiles.length;

  for (let i = 0; i < utiles.length; i++) {
    const img = utiles[i];
    const ext = MIME_EXT[String(img.mime || "").toLowerCase()] || "png";
    const archivo = `image${i + 1}.${ext}`;
    const idRel = `rId${i + 10}`;

    zip.file(`word/media/${archivo}`, img.datos);
    rels.push(
      `<Relationship Id="${idRel}" ` +
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" ' +
        `Target="media/${archivo}"/>`
    );
    extensiones.push(ext);

    const textos = (img.textos || []).map((t) => cuadroTexto(t, ++idTexto)).join("");
    cuerpo +=
      parrafoImagen(idRel, i + 1, img.nombre || archivo, cmAEmu(img.anchoCm), cmAEmu(img.altoCm), textos) + "<w:p/>";
  }

  zip.file("[Content_Types].xml", contentTypes(extensiones));
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" ' +
      'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
      'Target="word/document.xml"/>' +
      "</Relationships>"
  );
  zip.file("word/document.xml", documento(cuerpo));
  zip.file(
    "word/_rels/document.xml.rels",
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      rels.join("") +
      "</Relationships>"
  );

  return zip.generateAsync({
    type: tipo,
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    compression: "DEFLATE",
  });
}

/**
 * El Word de autorizacion de una persona.
 *
 * - `fotocheck`: imagen del fotocheck nuevo. Va SIEMPRE a 10 x 8 cm, que es
 *   el tamano que hoy tienen los documentos oficiales. Si trae `textos` y
 *   `marco` (el `word` de `fotocheckImagen` con `conWord`), las fechas van
 *   encima como texto editable.
 * - `antiguo`: foto(s) del fotocheck viejo, ya combinadas lado a lado por
 *   `combinarFotocheckAntiguo`. Se respeta su proporcion, limitando el ancho
 *   (por defecto 17 cm, el ancho completo de la pagina entre margenes).
 */
export async function armarAutorizacion({ fotocheck, antiguo = null, medidas = {}, tipo = "blob" }) {
  const anchoFc = Number(medidas.fotocheckAnchoCm ?? 10);
  const altoFc = Number(medidas.fotocheckAltoCm ?? 8);
  const anchoMax = Number(medidas.antiguoAnchoCm ?? 17);

  const imagenes = [
    {
      datos: fotocheck.datos,
      mime: fotocheck.mime || "image/png",
      anchoCm: anchoFc,
      altoCm: altoFc,
      nombre: "Fotocheck nuevo",
      textos: fotocheck.marco ? textosEnCm(fotocheck.textos || [], fotocheck.marco, anchoFc, altoFc) : [],
    },
  ];

  if (antiguo?.datos) {
    const proporcion = antiguo.alto && antiguo.ancho ? antiguo.alto / antiguo.ancho : 0.59;
    imagenes.push({
      datos: antiguo.datos,
      mime: antiguo.mime || "image/jpeg",
      anchoCm: anchoMax,
      altoCm: Number((anchoMax * proporcion).toFixed(2)),
      nombre: "Fotocheck antiguo",
    });
  }

  return armarDocx(imagenes, tipo);
}

/**
 * Pasa los textos del fotocheck (pixeles del lienzo `marco`, linea base en
 * `y`, como los dibuja el canvas) a cuadros de texto en cm sobre la imagen
 * puesta a `anchoCm` x `altoCm`.
 *
 * El Word no respeta la proporcion del lienzo (1400 x 920 a 10 x 8 cm): la
 * imagen sale estirada a lo alto y su letra tambien. Para que la del texto se
 * vea igual, el tamano sale del alto y el ancho de letra (`w:w`) de lo que
 * queda angosta respecto de ese alto.
 */
function textosEnCm(textos, marco, anchoCm, altoCm) {
  const sx = anchoCm / marco.ancho;
  const sy = altoCm / marco.alto;
  return textos.map((t) => {
    const medios = Math.max(2, Math.round(((t.tam * sy) / CM_POR_PT) * 2));
    const emCm = (medios / 2) * CM_POR_PT;
    const anchoPx = t.ancho || 200;
    return {
      texto: t.texto,
      nombre: t.nombre,
      negrita: Boolean(t.negrita),
      alineado: t.alineado,
      medios,
      escalaH: Math.min(600, Math.max(1, Math.round((100 * t.tam * sx) / emCm))),
      xCm: (t.alineado === "center" ? t.x - anchoPx / 2 : t.x) * sx,
      yCm: t.y * sy - ASCENSO * emCm,
      anchoCm: anchoPx * sx,
      altoCm: emCm * 1.6,
    };
  });
}

/** Mide un PNG/JPEG sin decodificarlo del todo (para respetar su proporcion). */
export function medirImagen(blobOUrl) {
  return new Promise((resolver) => {
    const img = new Image();
    const url = typeof blobOUrl === "string" ? blobOUrl : URL.createObjectURL(blobOUrl);
    img.onload = () => {
      resolver({ ancho: img.naturalWidth, alto: img.naturalHeight });
      if (typeof blobOUrl !== "string") URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolver({ ancho: 0, alto: 0 });
      if (typeof blobOUrl !== "string") URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}
