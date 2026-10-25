/**
 * Carga por carpeta de NUEVO PERSONAL: la parte que decide.
 *
 * El administrador manda por WhatsApp, persona por persona, un mensaje con
 * "APELLIDOS NOMBRES / DNI CARGO", su foto y (a veces) el certificado de
 * aptitud medica (EMO). Lo que llega a la app es una carpeta con capturas de
 * ese chat y los PDF del EMO, mezclados y sin orden. Aca se reconoce cada
 * archivo y se arma, por DNI, lo que hay que subir.
 *
 * Modulo puro (sin DOM ni red), para poder probarlo: recibe palabras con su
 * caja ya leidas (texto del PDF u OCR) y pixeles RGBA. Quien lee los archivos,
 * corre el OCR y sube es `vistas/carpeta-altas.js`.
 *
 * Todas las cajas van en pixeles de arriba hacia abajo: { x0, y0, x1, y1 }.
 */

import { aIso, sumarAnios } from "../../shared/estados.js";
import { INDICE } from "../../shared/rrcc.js";

const sinAcentos = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
const normal = (t) => sinAcentos(t).toUpperCase().replace(/\s+/g, " ").trim();

/* ------------------------------------------------------------------ */
/* Filas de texto                                                      */
/* ------------------------------------------------------------------ */

/**
 * Agrupa palabras sueltas en filas: las que comparten altura van juntas,
 * ordenadas de izquierda a derecha. Asi se lee un formulario como el EMO,
 * donde el rotulo y su valor estan en la misma linea pero el PDF (o el OCR)
 * los entrega en cualquier orden.
 */
export function agruparFilas(palabras) {
  const validas = (palabras || []).filter((p) => String(p.texto ?? "").trim());
  const ordenadas = validas.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const filas = [];
  for (const p of ordenadas) {
    const centro = (p.y0 + p.y1) / 2;
    const fila = filas[filas.length - 1];
    if (fila && centro >= fila.y0 && centro <= fila.y1) {
      fila.palabras.push(p);
      fila.y0 = Math.min(fila.y0, p.y0);
      fila.y1 = Math.max(fila.y1, p.y1);
    } else {
      filas.push({ y0: p.y0, y1: p.y1, palabras: [p] });
    }
  }
  for (const f of filas) {
    f.palabras.sort((a, b) => a.x0 - b.x0);
    f.texto = f.palabras.map((p) => String(p.texto).trim()).join(" ");
  }
  return filas;
}

/* ------------------------------------------------------------------ */
/* EMO (certificado de aptitud medico ocupacional)                     */
/* ------------------------------------------------------------------ */

const FECHA = /(\d{1,2})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{4})/;
/** La casilla marcada: "X" en el PDF; en un escaneo el OCR la lee como "Xx]", "[X" o "×". */
const esMarcaX = (t) => {
  const s = String(t ?? "").trim();
  return s.length > 0 && s.length <= 4 && /[xX×]/.test(s) && !/[A-WYZa-wyz0-9]/.test(s);
};

/** El texto de la fila que esta despues del rotulo (`rotulo` = regex que lo cubre entero). */
function despuesDe(filas, rotulo) {
  const fila = filas.find((f) => rotulo.test(sinAcentos(f.texto)));
  if (!fila) return "";
  const texto = sinAcentos(fila.texto);
  const m = rotulo.exec(texto);
  // se corta sobre el texto original (con acentos), que tiene el mismo largo
  return fila.texto.slice(m.index + m[0].length).replace(/^[\s:;.]+/, "").trim();
}

/**
 * Lee un EMO a partir de sus palabras. Devuelve null si no parece un EMO
 * (asi un PDF cualquiera de la carpeta no se confunde con uno).
 *
 * { dni, apellidos, nombres, fechaExamen, vencimiento, empleador, puesto,
 *   aptitud, restricciones, usoLentes }
 */
export function leerEmo(palabras) {
  const filas = agruparFilas(palabras);
  const todo = normal(filas.map((f) => f.texto).join("\n"));
  if (!/APTITUD/.test(todo) || !/OCUPACIONAL/.test(todo)) return null;

  const fechaTexto = despuesDe(filas, /fecha\s+de\s+examen\s*:?/i);
  const f = FECHA.exec(fechaTexto);
  const fechaExamen = f ? aIso(`${f[1]}/${f[2]}/${f[3]}`) : "";

  const filaDni = filas.find((x) => /documento\s+de\s+identidad/i.test(sinAcentos(x.texto)));
  let dni = filaDni ? (/(?<![\d-])(\d{8})(?!\d)/.exec(filaDni.texto) || [])[1] || "" : "";
  if (!dni) {
    // sin rotulo legible: el unico numero de 8 cifras suelto (el del medico va como "DNI-xxxxxxxx")
    const sueltos = new Set();
    for (const x of filas) {
      for (const m of x.texto.matchAll(/(?<![\d\w-])(\d{8})(?!\d)/g)) sueltos.add(m[1]);
    }
    if (sueltos.size === 1) dni = [...sueltos][0];
  }

  const nombre = despuesDe(filas, /apellidos\s+y\s+nombres\s*:?/i).toUpperCase();
  let apellidos = "";
  let nombres = "";
  if (nombre.includes(",")) {
    [apellidos, nombres] = nombre.split(",").map((t) => t.replace(/\s+/g, " ").trim());
  } else if (nombre) {
    ({ apellidos, nombres } = partirNombre(nombre));
  }

  const empleador = despuesDe(filas, /empleador\s*:?/i).toUpperCase();
  const puesto = despuesDe(filas, /puesto\s+al\s+que\s+postula(\s*\(.*?\))?\s*:?/i).toUpperCase();

  // la aptitud del CSOA: el bloque de arriba; el de abajo (servicio de salud
  // del titular) tiene los tres rotulos en una sola fila y va sin marcar
  const corte = filas.findIndex((x) => /APTITUD EMITIDA POR SERVICIO/.test(normal(x.texto)));
  const arriba = corte >= 0 ? filas.slice(0, corte) : filas;
  let aptitud = "";
  for (const fila of arriba) {
    const t = normal(fila.texto);
    let rotulo = "";
    if (/^APTO CON RESTRICCION/.test(t)) rotulo = "APTO CON RESTRICCION";
    else if (/^NO APTO\b/.test(t)) rotulo = "NO APTO";
    else if (/^APTO\b/.test(t) && !/APTO CON|NO APTO/.test(t)) rotulo = "APTO";
    if (!rotulo) continue;
    if (fila.palabras.slice(1).some((p) => esMarcaX(p.texto))) {
      aptitud = rotulo;
      break;
    }
  }

  // restricciones: lo escrito en la columna derecha entre "RESTRICCIONES" y
  // "Grupo sanguineo" (a la izquierda estan los rotulos APTO y sus casillas)
  const iRestr = filas.findIndex((x) => /^RESTRICCIONES$/.test(normal(x.texto)) || /\bRESTRICCIONES\s*$/.test(normal(x.texto)));
  const iGrupo = filas.findIndex((x) => /GRUPO SANGUINEO/.test(normal(x.texto)));
  let restricciones = "";
  if (iRestr >= 0 && iGrupo > iRestr) {
    const ancho = Math.max(...(palabras || []).map((p) => p.x1));
    const columna = ancho * 0.33;
    restricciones = filas
      .slice(iRestr + 1, iGrupo)
      .map((x) => x.palabras.filter((p) => p.x0 > columna).map((p) => String(p.texto).trim()).join(" "))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (/^[-–—._\s]*$/.test(restricciones) || /^NINGUNA\.?$/i.test(restricciones)) restricciones = "";
  }

  return {
    dni,
    apellidos,
    nombres,
    fechaExamen,
    vencimiento: fechaExamen ? sumarAnios(fechaExamen, 1) : "",
    empleador,
    puesto,
    aptitud,
    restricciones,
    usoLentes: /LENTE/.test(normal(restricciones)) ? "SI" : "NO",
  };
}

/**
 * "ROJAS TAIPE MARCO ANTONIO" sin coma: lo habitual en la base es dos
 * apellidos y el resto nombres. Es una suposicion: quien llama la marca para
 * revisar.
 */
export function partirNombre(nombre) {
  const p = String(nombre || "").toUpperCase().replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (p.length <= 2) return { apellidos: p[0] || "", nombres: p.slice(1).join(" ") };
  return { apellidos: p.slice(0, 2).join(" "), nombres: p.slice(2).join(" ") };
}

/**
 * EMPRESA de la base para el empleador del EMO: AESA es "ADMINISTRACION DE
 * EMPRESAS S.A.C."; las contratistas se buscan entre las que ya existen
 * ("LUCARBAL RENT A CAR EMPRESA INDIVIDUAL..." -> "LUCARBAL RENT A CAR EIRL").
 */
export function empresaDeEmpleador(empleador, conocidas = []) {
  const e = normal(empleador);
  if (!e) return "";
  if (/ADMINISTRACION DE EMPRESAS/.test(e) || /^AESA\b/.test(e)) return "AESA";
  const palabras = new Set(e.split(/[^A-Z0-9]+/).filter((w) => w.length > 2));
  const primera = e.split(/[^A-Z0-9]+/).find(Boolean);
  let mejor = "";
  let puntos = 0;
  for (const c of conocidas) {
    const n = normal(c);
    if (!n || n.split(/[^A-Z0-9]+/)[0] !== primera) continue;
    const comunes = n.split(/[^A-Z0-9]+/).filter((w) => palabras.has(w)).length;
    if (comunes > puntos || (comunes === puntos && n.length > normal(mejor).length)) {
      mejor = c;
      puntos = comunes;
    }
  }
  return mejor || e;
}

/* ------------------------------------------------------------------ */
/* Capturas del chat                                                   */
/* ------------------------------------------------------------------ */

const HORA = /\s*\d{1,2}\s*[:.]\s*\d{2}\s*(?:[ap]\.?\s*m\.?)?.*$/i;

/** Lee 8 digitos aunque el OCR confunda O/0, I/1, S/5 o B/8. */
export function dniDeOcr(token) {
  const t = String(token || "")
    .replace(/[Oo]/g, "0")
    .replace(/[Il|]/g, "1")
    .replace(/S/g, "5")
    .replace(/B/g, "8");
  return /^\d{8}$/.test(t) ? t : "";
}

/**
 * Cabeceras de persona en una captura: la linea "DNI CARGO hora" y, justo
 * encima, la del nombre. `lineas` = [{ texto, x0, y0, x1, y1 }] de arriba a abajo.
 * Devuelve [{ dni, nombre, cargo, y0, y1 }].
 */
export function leerCaptura(lineas) {
  const salida = [];
  const orden = (lineas || []).slice().sort((a, b) => a.y0 - b.y0);
  orden.forEach((linea, i) => {
    const t = String(linea.texto || "").trim();
    const m = /^[^\w]{0,3}([0-9OoIlSB|]{8})(?![0-9])\s*(.*)$/.exec(t);
    if (!m) return;
    const dni = dniDeOcr(m[1]);
    if (!dni) return;
    const cargo = m[2]
      .replace(HORA, "")
      // "TECNICO ELECTRICISTA |": el OCR lee la I romana suelta como barra
      .replace(/(^|\s)[|!¡](?=\s|$)/g, "$1I")
      .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9 .()/-]+/g, " ")
      .replace(/(\s+[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s]+)+\s*$/, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();
    let nombre = "";
    const previa = orden[i - 1];
    const alto = linea.y1 - linea.y0 || 1;
    if (previa && linea.y0 - previa.y1 < alto * 1.5) {
      const n = String(previa.texto || "")
        .toUpperCase()
        .replace(HORA, "")
        .replace(/[^A-ZÁÉÍÓÚÑÜ .'-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        // "CAYCHO A v" (cortado por la flecha del menu): fuera las letras sueltas del final
        .replace(/(\s+[A-ZÁÉÍÓÚÑ.'-]){1,3}$/, "")
        .replace(/[.'-]+$/, "")
        .trim();
      if (n.split(" ").length >= 2 && !/^ACTIVO$/.test(n)) nombre = n;
    }
    salida.push({ dni, nombre, cargo, y0: linea.y0, y1: linea.y1 });
  });
  return salida;
}

/* ------------------------------------------------------------------ */
/* Fotos dentro de una captura                                         */
/* ------------------------------------------------------------------ */

const DOCUMENTO = /CERTIFICADO|APTITUD|FORMATO|OCUPACIONAL|NATCLAR|\.PDF|PAGINA|PÁGINA/i;
// la hora tal como la deja el OCR: "5:38 p.m.", "5:38", "538p.m", "7170.m"
const HORA_SOLA = /^\W*\d{1,2}\s*[:.]?\s*\d{2}\s*[ap0o]?\s*\.?\s*m?\.?\s*\W*$/i;

/**
 * Recuadros de foto en una captura (o la imagen entera si es una foto suelta).
 *
 * En el chat (tema oscuro) una foto carnet es un bloque claro grande: se
 * buscan las celdas claras, se juntan en bloques y se descartan los que son
 * texto (bajos) o la vista previa de un PDF (el OCR lee "CERTIFICADO..."
 * dentro). La ropa oscura corta el bloque claro antes de tiempo: se estira
 * hacia abajo hasta la hora que WhatsApp pinta sobre la foto o la linea
 * siguiente. Al final se recorta a vertical, centrado en la cara.
 *
 * `imagen` = { datos (RGBA), ancho, alto }; `lineas` = lineas del OCR.
 * Devuelve [{ x0, y0, x1, y1 }] de arriba a abajo.
 */
export function regionesDeFoto(imagen, lineas = []) {
  const { datos, ancho, alto } = imagen;
  const luma = (x, y) => {
    const i = (y * ancho + x) * 4;
    return 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
  };

  // fondo oscuro (chat) o foto suelta: se mira la mediana de una muestra
  const muestra = [];
  for (let y = 0; y < alto; y += Math.max(1, Math.floor(alto / 60))) {
    for (let x = 0; x < ancho; x += Math.max(1, Math.floor(ancho / 60))) muestra.push(luma(x, y));
  }
  muestra.sort((a, b) => a - b);
  const mediana = muestra[Math.floor(muestra.length / 2)] || 0;
  if (mediana > 110 && !lineas.some((l) => DOCUMENTO.test(l.texto))) {
    return [vertical({ x0: 0, y0: 0, x1: ancho, y1: alto }, imagen)];
  }

  const celda = Math.max(3, Math.round(Math.min(ancho, alto) / 160));
  const cols = Math.ceil(ancho / celda);
  const filas = Math.ceil(alto / celda);
  const clara = new Uint8Array(cols * filas);
  for (let cy = 0; cy < filas; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let n = 0;
      let claros = 0;
      for (let y = cy * celda; y < Math.min(alto, (cy + 1) * celda); y++) {
        for (let x = cx * celda; x < Math.min(ancho, (cx + 1) * celda); x++) {
          n++;
          if (luma(x, y) > 110) claros++;
        }
      }
      clara[cy * cols + cx] = claros > n / 2 ? 1 : 0;
    }
  }

  // bloques de celdas claras conectadas
  const visto = new Uint8Array(cols * filas);
  const bloques = [];
  for (let i = 0; i < clara.length; i++) {
    if (!clara[i] || visto[i]) continue;
    const pila = [i];
    visto[i] = 1;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, n = 0;
    while (pila.length) {
      const j = pila.pop();
      const cx = j % cols;
      const cy = (j - cx) / cols;
      n++;
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx);
      y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= filas) continue;
        const k = ny * cols + nx;
        if (clara[k] && !visto[k]) {
          visto[k] = 1;
          pila.push(k);
        }
      }
    }
    bloques.push({ x0: x0 * celda, y0: y0 * celda, x1: Math.min(ancho, (x1 + 1) * celda), y1: Math.min(alto, (y1 + 1) * celda), n });
  }

  const dentro = (l, r) => {
    const cx = (l.x0 + l.x1) / 2;
    const cy = (l.y0 + l.y1) / 2;
    return cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1;
  };

  const candidatos = bloques
    .filter((b) => b.x1 - b.x0 >= Math.max(60, ancho * 0.12) && b.y1 - b.y0 >= Math.max(60, alto * 0.08))
    .filter((b) => {
      const textos = lineas.filter((l) => dentro(l, b));
      if (textos.some((l) => DOCUMENTO.test(l.texto))) return false; // vista previa de un PDF
      const largas = textos.filter((l) => String(l.texto).trim().split(/\s+/).length >= 3 && !HORA_SOLA.test(l.texto));
      if (largas.length >= 3) return false; // una burbuja de texto clara (tema claro), no una foto
      // la vista previa de un PDF es gris (papel y tinta); una foto tiene piel
      return proporcionDeColor(imagen, b) >= 0.04;
    })
    .sort((a, b) => a.y0 - b.y0);

  const altos = lineas.map((l) => l.y1 - l.y0).filter((h) => h > 0).sort((a, b) => a - b);
  const altoLinea = altos[Math.floor(altos.length / 2)] || alto * 0.02;
  const borde = Math.max(2, Math.round(celda / 2)); // esquinas redondeadas de la burbuja

  return candidatos.map((b, i) => {
    const r = { ...b };
    const siguiente = candidatos[i + 1];
    const solapa = (l) => l.x1 > r.x0 && l.x0 < r.x1;
    // la ropa oscura corta el bloque claro: se estira hasta un 35% hacia abajo,
    // sin pasar la linea de texto siguiente ni el borde de la burbuja (una
    // fila pareja, sin detalle: el margen de la burbuja o el fondo del chat)
    let tope = Math.min(alto, r.y1 + (r.y1 - r.y0) * 0.35);
    if (siguiente) tope = Math.min(tope, siguiente.y0 - 2);
    for (const l of lineas) {
      if (l.y0 >= r.y1 - 2 && l.y0 < tope && solapa(l)) tope = Math.min(tope, l.y0 - 3);
    }
    let y = Math.round(r.y1);
    for (; y < tope; y++) {
      let min = 255;
      let max = 0;
      for (let x = Math.round(r.x0) + borde; x < Math.round(r.x1) - borde; x++) {
        const l = luma(x, y);
        if (l < min) min = l;
        if (l > max) max = l;
      }
      if (max - min < 10) break;
    }
    r.y1 = Math.max(r.y1, y);
    // la hora que WhatsApp escribe sobre la esquina inferior de la foto; si
    // el OCR no la leyo (texto blanco sobre ropa clara), se quita esa franja
    let sinHora = false;
    for (const l of lineas) {
      const cy = (l.y0 + l.y1) / 2;
      if (HORA_SOLA.test(l.texto) && solapa(l) && cy > r.y0 + (r.y1 - r.y0) * 0.7 && cy <= r.y1 + 2) {
        r.y1 = Math.min(r.y1, l.y0 - 3);
        sinHora = true;
      }
    }
    if (!sinHora) r.y1 -= Math.round(altoLinea * 1.8);
    return vertical({ x0: Math.round(r.x0) + borde, y0: Math.round(r.y0) + borde, x1: Math.round(r.x1) - borde, y1: Math.round(r.y1) }, imagen);
  });
}

/** Fraccion de pixeles con color (no grises) dentro de `r`. */
function proporcionDeColor({ datos, ancho }, r) {
  let n = 0;
  let color = 0;
  for (let y = r.y0; y < r.y1; y += 2) {
    for (let x = r.x0; x < r.x1; x += 2) {
      const i = (y * ancho + x) * 4;
      const max = Math.max(datos[i], datos[i + 1], datos[i + 2]);
      const min = Math.min(datos[i], datos[i + 1], datos[i + 2]);
      n++;
      if (max - min > 25) color++;
    }
  }
  return n ? color / n : 0;
}

/** Recorte vertical (ancho = 0.8 x alto), centrado en lo oscuro de la parte alta (pelo y cara sobre fondo claro). */
function vertical(r, { datos, ancho }) {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const objetivo = Math.round(h * 0.8);
  if (w <= objetivo) return r;
  const peso = new Float64Array(w);
  for (let y = r.y0; y < r.y0 + h * 0.75; y += 2) {
    for (let x = r.x0; x < r.x1; x++) {
      const i = (y * ancho + x) * 4;
      const l = 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
      if (l < 150) peso[x - r.x0] += 150 - l;
    }
  }
  let total = 0;
  let momento = 0;
  peso.forEach((p, i) => {
    total += p;
    momento += p * i;
  });
  const centro = total ? r.x0 + momento / total : (r.x0 + r.x1) / 2;
  const x0 = Math.round(Math.min(Math.max(r.x0, centro - objetivo / 2), r.x1 - objetivo));
  return { x0, y0: r.y0, x1: x0 + objetivo, y1: r.y1 };
}

/* ------------------------------------------------------------------ */
/* Personas                                                            */
/* ------------------------------------------------------------------ */

/**
 * Junta lo leido de todos los archivos en una ficha por DNI.
 *
 * `archivos` va en el orden de los nombres (las capturas de Windows y de
 * WhatsApp llevan fecha y hora en el nombre): una foto se asigna a la ultima
 * cabecera que hay encima de ella en su captura, o a la ultima de la captura
 * anterior si la persona quedo partida entre dos capturas.
 *
 * Cada archivo: { nombre, tipo: "emo", emo } | { nombre, tipo: "captura",
 * cabeceras, fotos: [{ y0, area, imagen }] } | { nombre, tipo: "foto", foto }
 * | { nombre, tipo: "otro", motivo }.
 *
 * Devuelve { personas: [...], huerfanas: [{ archivo, imagen }], otros: [...] }.
 */
export function armarPersonas(archivos, { empresas = [] } = {}) {
  const porDni = new Map();
  const huerfanas = [];
  const otros = [];
  const de = (dni) => {
    if (!porDni.has(dni)) porDni.set(dni, { dni, nombres: [], cargos: [], emo: null, fotos: [], archivos: new Set() });
    return porDni.get(dni);
  };

  let arrastre = null; // ultima cabecera vista, para la foto que cae en la captura siguiente
  for (const a of archivos) {
    if (a.tipo === "emo") {
      if (!a.emo?.dni) {
        otros.push({ nombre: a.nombre, motivo: "EMO sin DNI legible" });
        continue;
      }
      const p = de(a.emo.dni);
      // si llegan dos EMO de la misma persona, vale el mas reciente
      if (!p.emo || (a.emo.fechaExamen || "") > (p.emo.fechaExamen || "")) p.emo = a.emo;
      p.archivos.add(a.nombre);
    } else if (a.tipo === "captura") {
      const cabeceras = (a.cabeceras || []).slice().sort((x, y) => x.y0 - y.y0);
      for (const c of cabeceras) {
        const p = de(c.dni);
        if (c.nombre) p.nombres.push(c.nombre);
        if (c.cargo) p.cargos.push(c.cargo);
        p.archivos.add(a.nombre);
      }
      for (const f of a.fotos || []) {
        const encima = cabeceras.filter((c) => c.y1 <= f.y0 + 4).pop();
        const duenio = encima || arrastre;
        if (!duenio) {
          huerfanas.push({ archivo: a.nombre, imagen: f.imagen, area: f.area });
          continue;
        }
        const p = de(duenio.dni);
        p.fotos.push({ archivo: a.nombre, imagen: f.imagen, area: f.area || 0 });
        p.archivos.add(a.nombre);
      }
      if (cabeceras.length) arrastre = cabeceras[cabeceras.length - 1];
    } else if (a.tipo === "foto") {
      const dni = (/(?<!\d)(\d{8})(?!\d)/.exec(a.nombre) || [])[1];
      if (dni) {
        const p = de(dni);
        p.fotos.push({ archivo: a.nombre, imagen: a.foto, area: a.area || 0 });
        p.archivos.add(a.nombre);
      } else {
        huerfanas.push({ archivo: a.nombre, imagen: a.foto, area: a.area || 0 });
      }
    } else {
      otros.push({ nombre: a.nombre, motivo: a.motivo || "no reconocido" });
    }
  }

  const personas = [...porDni.values()].map((p) => fichaDe(p, empresas));
  return { personas, huerfanas, otros };
}

const masLargo = (lista) => lista.slice().sort((a, b) => b.length - a.length)[0] || "";
const masRepetido = (lista) => {
  const n = new Map();
  for (const x of lista) n.set(x, (n.get(x) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0] || "";
};

function fichaDe(p, empresas) {
  const avisos = [];
  const emo = p.emo;
  let apellidos = emo?.apellidos || "";
  let nombres = emo?.nombres || "";
  if (!apellidos) {
    const n = masLargo(p.nombres);
    if (n) {
      ({ apellidos, nombres } = partirNombre(n));
      avisos.push("nombre sin EMO: revisa qué parte son apellidos");
    }
  }
  const cargo = masRepetido(p.cargos) || emo?.puesto || "";
  let empresa = emo ? empresaDeEmpleador(emo.empleador, empresas) : "";
  if (!empresa) {
    empresa = "AESA";
    if (!emo) avisos.push("sin EMO: empresa AESA por defecto");
  }
  if (!emo) avisos.push("sin EMO");
  else if (!emo.fechaExamen) avisos.push("EMO sin fecha legible");
  if (!p.fotos.length) avisos.push("sin foto");
  const foto = p.fotos.slice().sort((a, b) => b.area - a.area)[0] || null;
  return {
    dni: p.dni,
    apellidos,
    nombres,
    cargo,
    empresa,
    examenMedico: emo?.fechaExamen || "",
    vencimientoEmo: emo?.vencimiento || "",
    usoLentes: emo ? emo.usoLentes : "",
    restricciones: emo?.restricciones || "",
    aptitud: emo?.aptitud || "",
    foto: foto?.imagen || null,
    fotos: p.fotos,
    archivos: [...p.archivos],
    avisos,
  };
}

/* ------------------------------------------------------------------ */
/* Que se sube                                                         */
/* ------------------------------------------------------------------ */

/** Columnas de A:O que se completan, con el campo de la ficha que las llena. */
const CAMPOS = [
  ["Apellidos", "apellidos"],
  ["Nombres", "nombres"],
  ["Cargo Planilla", "cargo"],
  ["EMPRESA", "empresa"],
  ["F. Ex. Medico", "examenMedico"],
  ["F. Vencimiento", "vencimientoEmo"],
  ["USO DE LENTES", "usoLentes"],
];
const ES_FECHA = new Set(["F. Ex. Medico", "F. Vencimiento"]);

/**
 * Decide que hacer con una persona segun lo que ya tiene la hoja.
 *
 * - "alta": no esta en la hoja.
 * - "completar": esta, y le faltan datos o la foto. SOLO se llenan celdas
 *   vacias: un dato que ya existe nunca se pisa; si el archivo dice otra
 *   cosa queda en `diferencias` para que alguien lo revise.
 * - "completo": esta y no le falta nada de lo que trae la carpeta.
 *
 * `leido` = respuesta de `obtenerPersona`; `tieneFoto` = si ya hay foto en FOTOS.
 * Devuelve { accion, datos, extras, subirFoto, diferencias }.
 */
export function planDeCarga(persona, leido, { tieneFoto = false } = {}) {
  if (!leido?.encontrada) {
    return { accion: "alta", datos: {}, extras: {}, subirFoto: Boolean(persona.foto), diferencias: [] };
  }
  const v = leido.valores || [];
  const valor = (col) => (ES_FECHA.has(col) ? aIso(v[INDICE[col]]) : String(v[INDICE[col]] ?? "").trim());
  const datos = {};
  const diferencias = [];
  for (const [col, campo] of CAMPOS) {
    const nuevo = ES_FECHA.has(col) ? aIso(persona[campo]) : String(persona[campo] ?? "").trim().toUpperCase();
    if (!nuevo) continue;
    const actual = valor(col);
    if (!actual) datos[col] = nuevo;
    else if (normal(actual) !== normal(nuevo)) diferencias.push({ columna: col, hoja: actual, archivo: nuevo });
  }
  const extras = {};
  if (persona.restricciones && !valor("RESTRICCIONES_EMO")) extras.RESTRICCIONES_EMO = persona.restricciones;
  if (!valor("_EstaTE")) extras._EstaTE = "ACTIVO";
  const subirFoto = !tieneFoto && Boolean(persona.foto);
  const accion = Object.keys(datos).length || Object.keys(extras).length || subirFoto ? "completar" : "completo";
  return { accion, datos, extras, subirFoto, diferencias };
}
