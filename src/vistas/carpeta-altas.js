/**
 * NUEVO PERSONAL → CARGAR CARPETA.
 *
 * Se elige una carpeta con capturas del chat de WhatsApp (nombre, DNI, cargo
 * y foto de cada persona) y los PDF del EMO, todo mezclado. La app reconoce
 * cada archivo, arma una ficha por DNI y muestra que va a hacer con cada una
 * antes de tocar la hoja:
 *
 *   - ALTA si el DNI no esta en `BD AESA` (foto a FOTOS y fila nueva, con las
 *     A que proponga la matriz por puesto, igual que el formulario);
 *   - COMPLETAR si ya esta: solo se llenan las celdas vacias y se sube la
 *     foto si no hay; lo que ya tiene la hoja nunca se pisa.
 *
 * Lo que decide vive en `lib/carpeta-altas.js` (puro, con pruebas). Aca se
 * leen los archivos (texto del PDF con pdf.js; OCR con tesseract.js para las
 * capturas y los EMO escaneados), se dibuja la revision y se sube.
 */

import { $, notificar, escaparHtml, copiarTexto } from "./comun.js";
import { cargarPdfjs } from "./visor-pdf.js";
import { leerEmo, leerCaptura, regionesDeFoto, armarPersonas, planDeCarga } from "../lib/carpeta-altas.js";
import { obtenerContexto, obtenerPersona, obtenerPersonal, anotarPersona } from "../lib/datos.js";
import { fotoDeDni, subirFoto, guardarFilaVerificada } from "../lib/renovacion.js";
import { sheets } from "../lib/api.js";
import { filaNueva, tiposDeMatriz, aplicarEdicionesManuales, sumarAnios, aIso } from "../../shared/estados.js";
import { INDICE } from "../../shared/rrcc.js";

/** Lado mayor con el que se analiza una imagen (una foto de celular de 4000 px no hace falta entera). */
const MAX_ANALISIS = 1800;
/** Alto maximo de la foto que se sube a FOTOS. */
const MAX_FOTO = 900;

/* ------------------------------------------------------------------ */
/* OCR                                                                 */
/* ------------------------------------------------------------------ */

// tesseract.js pesa y baja el idioma la primera vez: se carga recien al usar la carpeta
let ocrP = null;
function ocr() {
  ocrP ||= import("tesseract.js").then(({ createWorker }) => createWorker("spa"));
  ocrP.catch(() => (ocrP = null)); // un fallo de red no queda pegado
  return ocrP;
}
async function soltarOcr() {
  const p = ocrP;
  ocrP = null;
  if (p) (await p.catch(() => null))?.terminate();
}

/**
 * OCR de un lienzo. El texto del chat es claro sobre fondo oscuro y chico:
 * se agranda, se pasa a blanco y negro y se invierte, que es como tesseract
 * lo lee bien (sin esto no ve el DNI en verde). Devuelve palabras y lineas
 * con sus cajas en pixeles del lienzo original.
 */
async function leerTexto(lienzo) {
  const escala = Math.min(3, Math.max(1, 1600 / Math.max(lienzo.width, lienzo.height)));
  const c = crearLienzo(Math.round(lienzo.width * escala), Math.round(lienzo.height * escala));
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(lienzo, 0, 0, c.width, c.height);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  let suma = 0;
  for (let i = 0; i < d.length; i += 16) suma += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  const oscura = suma / (d.length / 16) < 110;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const tinta = oscura ? l > 100 : l < 140;
    d[i] = d[i + 1] = d[i + 2] = tinta ? 0 : 255;
  }
  ctx.putImageData(img, 0, 0);

  const worker = await ocr();
  const { data } = await worker.recognize(c, {}, { blocks: true });
  const caja = (b) => ({ x0: b.x0 / escala, y0: b.y0 / escala, x1: b.x1 / escala, y1: b.y1 / escala });
  const lineas = [];
  const palabras = [];
  for (const bloque of data.blocks || []) {
    for (const parrafo of bloque.paragraphs || []) {
      for (const linea of parrafo.lines || []) {
        lineas.push({ texto: String(linea.text || "").trim(), ...caja(linea.bbox) });
        for (const w of linea.words || []) palabras.push({ texto: w.text, ...caja(w.bbox) });
      }
    }
  }
  return { lineas, palabras };
}

/* ------------------------------------------------------------------ */
/* Lectura de cada archivo                                             */
/* ------------------------------------------------------------------ */

function crearLienzo(ancho, alto) {
  const c = document.createElement("canvas");
  c.width = ancho;
  c.height = alto;
  return c;
}

async function lienzoDeImagen(archivo) {
  const bmp = await createImageBitmap(archivo);
  const escala = Math.min(1, MAX_ANALISIS / Math.max(bmp.width, bmp.height));
  const c = crearLienzo(Math.round(bmp.width * escala), Math.round(bmp.height * escala));
  c.getContext("2d", { willReadFrequently: true }).drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** Recorta `r` del lienzo y lo devuelve como PNG (Blob), achicado si es muy alto. */
function recortar(lienzo, r) {
  const w = Math.max(1, Math.round(r.x1 - r.x0));
  const h = Math.max(1, Math.round(r.y1 - r.y0));
  const escala = Math.min(1, MAX_FOTO / h);
  const c = crearLienzo(Math.round(w * escala), Math.round(h * escala));
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(lienzo, r.x0, r.y0, w, h, 0, 0, c.width, c.height);
  return new Promise((ok, mal) => c.toBlob((b) => (b ? ok(b) : mal(new Error("no se pudo recortar la foto"))), "image/png"));
}

const pareceEmo = (texto) => /APTITUD/i.test(texto) && /OCUPACIONAL/i.test(texto);

async function analizarPdf(archivo) {
  const pdfjs = await cargarPdfjs();
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await archivo.arrayBuffer()) }).promise;
  try {
    for (let n = 1; n <= Math.min(doc.numPages, 3); n++) {
      const pagina = await doc.getPage(n);
      const vista = pagina.getViewport({ scale: 1 });
      // primero el texto del PDF (exacto y al instante)
      const items = (await pagina.getTextContent()).items.filter((it) => String(it.str || "").trim());
      const palabras = items.map((it) => {
        const y1 = vista.height - it.transform[5];
        return { texto: it.str, x0: it.transform[4], x1: it.transform[4] + it.width, y0: y1 - (it.height || 8), y1 };
      });
      let emo = leerEmo(palabras);
      // un EMO escaneado solo trae la firma digital como texto: se lee con OCR
      if (!emo?.dni) {
        const v = pagina.getViewport({ scale: 2.5 });
        const c = crearLienzo(Math.round(v.width), Math.round(v.height));
        await pagina.render({ canvasContext: c.getContext("2d"), viewport: v }).promise;
        const leido = await leerTexto(c);
        emo = leerEmo(leido.palabras) || emo;
      }
      if (emo) return { nombre: archivo.name, tipo: "emo", emo };
    }
    return { nombre: archivo.name, tipo: "otro", motivo: "PDF que no es un EMO" };
  } finally {
    doc.destroy();
  }
}

async function analizarImagen(archivo) {
  const lienzo = await lienzoDeImagen(archivo);
  const { lineas, palabras } = await leerTexto(lienzo);

  // una foto o captura de un EMO (no del chat)
  if (pareceEmo(lineas.map((l) => l.texto).join(" "))) {
    const emo = leerEmo(palabras);
    if (emo?.dni) return { nombre: archivo.name, tipo: "emo", emo };
  }

  const cabeceras = leerCaptura(lineas);
  const ctx = lienzo.getContext("2d", { willReadFrequently: true });
  const imagen = { datos: ctx.getImageData(0, 0, lienzo.width, lienzo.height).data, ancho: lienzo.width, alto: lienzo.height };
  const regiones = regionesDeFoto(imagen, lineas);
  const fotos = [];
  for (const r of regiones) {
    fotos.push({ y0: r.y0, area: (r.x1 - r.x0) * (r.y1 - r.y0), imagen: await recortar(lienzo, r) });
  }

  const entera = regiones.length === 1 && fotos[0].area >= lienzo.width * lienzo.height * 0.6;
  if (!cabeceras.length && entera) {
    return { nombre: archivo.name, tipo: "foto", foto: fotos[0].imagen, area: fotos[0].area };
  }
  if (!cabeceras.length && !fotos.length) {
    return { nombre: archivo.name, tipo: "otro", motivo: "imagen sin DNI ni foto reconocible" };
  }
  return { nombre: archivo.name, tipo: "captura", cabeceras, fotos };
}

async function analizarArchivo(archivo) {
  const nombre = archivo.name.toLowerCase();
  if (archivo.type === "application/pdf" || nombre.endsWith(".pdf")) return analizarPdf(archivo);
  if (archivo.type.startsWith("image/") || /\.(png|jpe?g|webp|bmp)$/.test(nombre)) return analizarImagen(archivo);
  return { nombre: archivo.name, tipo: "otro", motivo: "tipo de archivo no reconocido" };
}

/* ------------------------------------------------------------------ */
/* Vista                                                               */
/* ------------------------------------------------------------------ */

const ACCION = {
  alta: { txt: "ALTA", clase: "cc-alta" },
  completar: { txt: "COMPLETAR", clase: "cc-completar" },
  completo: { txt: "YA COMPLETO", clase: "cc-completo" },
  error: { txt: "ERROR", clase: "cc-error" },
};

export function montarCargaCarpeta({ consola }) {
  const el = {
    boton: $("nv-carpeta"),
    input: $("nv-carpeta-input"),
    modal: $("nv-carpeta-modal"),
    cuerpo: $("nv-carpeta-cuerpo"),
    count: $("nv-carpeta-count"),
    subir: $("nv-carpeta-subir"),
    cerrar: $("nv-carpeta-cerrar"),
    cancelar: $("nv-carpeta-cancelar"),
  };
  if (!el.boton || !el.input || !el.modal) return;

  /** Estado de la carga en curso. */
  let s = null;
  let urls = [];

  const urlDe = (blob) => {
    if (!blob) return "";
    const u = URL.createObjectURL(blob);
    urls.push(u);
    return u;
  };
  const soltarUrls = () => {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [];
  };

  function cerrar() {
    if (s?.subiendo) return; // a mitad de la subida no se cierra
    if (s) s.cancelado = true;
    el.modal.hidden = true;
    soltarUrls();
    s = null;
  }
  el.cerrar.addEventListener("click", cerrar);
  el.cancelar.addEventListener("click", cerrar);

  el.boton.addEventListener("click", () => {
    el.input.value = "";
    el.input.click();
  });
  el.input.addEventListener("change", () => {
    const archivos = [...(el.input.files || [])].filter((f) => !/^(desktop\.ini|thumbs\.db)$/i.test(f.name) && !f.name.startsWith("."));
    if (archivos.length) analizar(archivos);
  });

  el.subir.addEventListener("click", () => {
    if (s && !s.subiendo) subir();
  });

  /* ---------------- analisis ---------------- */

  async function analizar(archivos) {
    soltarUrls();
    // por nombre: las capturas llevan fecha y hora, asi una persona partida
    // entre dos capturas queda en orden
    archivos.sort((a, b) =>
      (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, "es", { numeric: true })
    );
    s = { personas: [], huerfanas: [], otros: [], cancelado: false, subiendo: false, contexto: null };
    const yo = s;
    el.modal.hidden = false;
    el.subir.disabled = true;
    el.count.textContent = `${archivos.length} archivo(s)`;
    el.cuerpo.innerHTML = `<p class="cc-estado" id="nv-carpeta-estado">preparando el OCR (la primera vez baja el idioma)…</p>`;
    const estado = (t) => {
      const e = $("nv-carpeta-estado");
      if (e) e.textContent = t;
    };
    consola.cabecera(`CARGA DESDE CARPETA · ${archivos.length} archivo(s)`);

    const leidos = [];
    try {
      for (const [i, archivo] of archivos.entries()) {
        if (yo.cancelado) return;
        estado(`leyendo ${i + 1}/${archivos.length}: ${archivo.name}`);
        try {
          const r = await analizarArchivo(archivo);
          leidos.push(r);
          consola(`${archivo.name}: ${resumenArchivo(r)}`, r.tipo === "otro" ? "warn" : "ok");
        } catch (e) {
          leidos.push({ nombre: archivo.name, tipo: "otro", motivo: `no se pudo leer (${e.message})` });
          consola(`${archivo.name}: no se pudo leer (${e.message})`, "warn");
        }
      }
    } finally {
      soltarOcr();
    }
    if (yo.cancelado) return;

    estado("consultando la base…");
    let empresas = [];
    try {
      yo.contexto = await obtenerContexto();
      empresas = [...new Set((await obtenerPersonal()).map((p) => p.empresa).filter(Boolean))];
    } catch (e) {
      consola(`no se pudo leer la base: ${e.message}`, "err");
      el.cuerpo.innerHTML = `<div class="alert alert-warn">No se pudo leer la base: ${escaparHtml(e.message)}</div>`;
      return;
    }

    const armado = armarPersonas(leidos, { empresas });
    yo.huerfanas = armado.huerfanas;
    yo.otros = armado.otros;
    yo.personas = armado.personas.map((p) => ({ ...p, incluir: true, estado: "", detalle: "" }));

    for (const [i, p] of yo.personas.entries()) {
      if (yo.cancelado) return;
      estado(`consultando ${i + 1}/${yo.personas.length}: ${p.dni}`);
      await consultar(p);
    }
    if (yo.cancelado) return;
    pintar();
  }

  function resumenArchivo(r) {
    if (r.tipo === "emo") return `EMO de ${r.emo.dni || "¿DNI?"} ${r.emo.apellidos} ${r.emo.nombres}`.trim();
    if (r.tipo === "captura") {
      const dnis = r.cabeceras.map((c) => c.dni).join(", ");
      return `captura${dnis ? ` (${dnis})` : " sin cabecera"} · ${r.fotos.length} foto(s)`;
    }
    if (r.tipo === "foto") return "foto suelta";
    return r.motivo;
  }

  /** Lee la fila de la persona y si ya tiene foto, y decide que hacer con ella. */
  async function consultar(p) {
    try {
      p.leido = await obtenerPersona(p.dni, { refrescar: true });
      p.tieneFoto = false;
      if (p.leido.encontrada) {
        try {
          await fotoDeDni(p.dni);
          p.tieneFoto = true;
        } catch (e) {
          // "no hay foto" es la respuesta normal; cualquier otro error deja la
          // foto sin subir antes que duplicarla
          if (!/no hay foto/i.test(e.message)) {
            p.tieneFoto = true;
            p.avisos.push(`no se pudo comprobar la foto: ${e.message}`);
          }
        }
      }
      replanificar(p);
    } catch (e) {
      p.plan = { accion: "error" };
      p.detalle = e.message;
      p.incluir = false;
    }
  }

  function replanificar(p) {
    p.vencimientoEmo = p.examenMedico ? sumarAnios(p.examenMedico, 1) : "";
    p.plan = planDeCarga(p, p.leido, { tieneFoto: p.tieneFoto });
    const { accion, datos, extras, subirFoto: foto } = p.plan;
    if (accion === "alta") {
      const tipos = tiposDeMatriz(s.contexto?.matriz || [], p.cargo, "");
      const a = Object.values(tipos).filter((t) => t === "A").length;
      p.detalle = `fila nueva · matriz: ${Object.keys(tipos).length ? `${a} A` : "sin fila para el cargo"}`;
      if (!p.foto) {
        p.detalle += " · FALTA FOTO (obligatoria)";
        p.incluir = false;
      }
    } else if (accion === "completar") {
      const que = [...Object.keys(datos), ...Object.keys(extras)];
      p.detalle = `fila ${p.leido.fila}: ${que.length ? que.join(", ") : "—"}${foto ? " + foto" : ""}`;
    } else if (accion === "completo") {
      p.detalle = `fila ${p.leido.fila}: no le falta nada`;
      p.incluir = false;
    }
    if (p.plan.diferencias?.length) {
      p.detalle += ` · difiere: ${p.plan.diferencias.map((d) => `${d.columna} (hoja ${d.hoja} / archivo ${d.archivo})`).join("; ")}`;
    }
  }

  /* ---------------- revision ---------------- */

  function pintar() {
    soltarUrls(); // las miniaturas de la pintada anterior
    const { personas, huerfanas, otros } = s;
    const n = personas.filter((p) => p.incluir).length;
    el.count.textContent = `${personas.length} persona(s) · ${n} para subir`;
    el.subir.disabled = !n;
    el.subir.textContent = n ? `SUBIR ${n} A LA BASE` : "NADA PARA SUBIR";

    const filas = personas
      .map((p, i) => {
        const a = ACCION[p.plan?.accion] || ACCION.error;
        const bloqueado = p.plan?.accion === "error" || p.plan?.accion === "completo" || (p.plan?.accion === "alta" && !p.foto);
        const campo = (k, extra = "") =>
          `<input class="inp cc-inp" data-i="${i}" data-k="${k}" value="${escaparHtml(p[k] || "")}"${extra} />`;
        return (
          `<tr class="${p.estado ? `cc-${p.estado}` : ""}">` +
          `<td><input type="checkbox" data-i="${i}" data-incluir${p.incluir ? " checked" : ""}${bloqueado || s.subiendo ? " disabled" : ""} /></td>` +
          `<td>${p.foto ? `<img class="cc-foto" src="${urlDe(p.foto)}" alt="foto de ${escaparHtml(p.dni)}" />` : `<span class="cc-sinfoto">sin foto</span>`}</td>` +
          `<td class="cc-dni">${escaparHtml(p.dni)}</td>` +
          `<td>${campo("apellidos")}${campo("nombres")}</td>` +
          `<td>${campo("cargo")}${campo("empresa")}</td>` +
          `<td><input class="inp cc-inp" type="date" data-i="${i}" data-k="examenMedico" value="${escaparHtml(aIso(p.examenMedico))}" />` +
          `<span class="cc-venc">vence ${escaparHtml(p.vencimientoEmo || "—")}</span></td>` +
          `<td><select class="inp cc-inp" data-i="${i}" data-k="usoLentes">` +
          ["", "SI", "NO"].map((v) => `<option value="${v}"${(p.usoLentes || "") === v ? " selected" : ""}>${v || "—"}</option>`).join("") +
          `</select>${campo("restricciones", ' placeholder="restricciones"')}</td>` +
          `<td><b class="cc-accion ${a.clase}">${a.txt}</b><div class="cc-det">${escaparHtml(p.detalle || "")}</div>` +
          (p.avisos.length ? `<div class="cc-avisos">${p.avisos.map(escaparHtml).join(" · ")}</div>` : "") +
          `<div class="cc-arch">${p.archivos.map(escaparHtml).join(" · ")}</div></td>` +
          `</tr>`
        );
      })
      .join("");

    const opciones = personas.map((p) => `<option value="${escaparHtml(p.dni)}">${escaparHtml(p.dni)} · ${escaparHtml(p.apellidos)}</option>`).join("");
    const htmlHuerfanas = huerfanas.length
      ? `<h3 class="cc-sub">FOTOS SIN DUEÑO (${huerfanas.length})</h3><div class="cc-huerfanas">` +
        huerfanas
          .map(
            (h, i) =>
              `<label class="cc-huerfana"><img class="cc-foto" src="${urlDe(h.imagen)}" alt="foto sin asignar" />` +
              `<span>${escaparHtml(h.archivo)}</span><select class="inp" data-huerfana="${i}"${s.subiendo ? " disabled" : ""}>` +
              `<option value="">asignar a…</option>${opciones}</select></label>`
          )
          .join("") +
        `</div>`
      : "";
    const htmlOtros = otros.length
      ? `<h3 class="cc-sub">ARCHIVOS NO USADOS (${otros.length})</h3><ul class="cc-otros">` +
        otros.map((o) => `<li><b>${escaparHtml(o.nombre)}</b> — ${escaparHtml(o.motivo)}</li>`).join("") +
        `</ul>`
      : "";

    el.cuerpo.innerHTML =
      (personas.length
        ? `<p class="nota">Revisa y corrige antes de subir. En las personas que ya están en la base solo se llenan las celdas vacías: lo que ya tiene la hoja no se pisa.</p>` +
          `<div class="cc-tabla-wrap"><table class="estado-tabla cc-tabla"><thead><tr>` +
          `<th></th><th>Foto</th><th>DNI</th><th>Apellidos / Nombres</th><th>Cargo / Empresa</th><th>EMO</th><th>Lentes / Restr.</th><th>Qué se hará</th>` +
          `</tr></thead><tbody>${filas}</tbody></table></div>`
        : `<div class="alert alert-warn">No se reconoció a ninguna persona en la carpeta.</div>`) +
      htmlHuerfanas +
      htmlOtros;
  }

  // edicion en la tabla: se replanifica la persona (que columnas se llenan)
  el.cuerpo.addEventListener("change", (e) => {
    if (!s || s.subiendo) return;
    const t = e.target;
    if (t.dataset.huerfana !== undefined) {
      const h = s.huerfanas[Number(t.dataset.huerfana)];
      const p = s.personas.find((x) => x.dni === t.value);
      if (h && p) {
        p.foto = h.imagen;
        p.avisos = p.avisos.filter((a) => a !== "sin foto");
        s.huerfanas.splice(Number(t.dataset.huerfana), 1);
        replanificar(p);
        if (p.plan.accion !== "completo") p.incluir = true;
        pintar();
      }
      return;
    }
    const p = s.personas[Number(t.dataset.i)];
    if (!p) return;
    if (t.dataset.incluir !== undefined) {
      p.incluir = t.checked;
      pintar();
      return;
    }
    if (t.dataset.k) {
      // la fecha y las restricciones van tal cual; nombres, cargo y empresa en mayusculas como en la base
      const tal = t.dataset.k === "examenMedico" || t.dataset.k === "restricciones";
      p[t.dataset.k] = tal ? t.value.trim() : t.value.toUpperCase().trim();
      replanificar(p);
      pintar();
    }
  });

  /* ---------------- subida ---------------- */

  async function subir() {
    const elegidas = s.personas.filter((p) => p.incluir);
    if (!elegidas.length) return;
    s.subiendo = true;
    el.subir.disabled = true;
    el.cancelar.disabled = true;
    pintar();
    consola.cabecera(`SUBIENDO ${elegidas.length} PERSONA(S)`);
    const hechos = [];
    try {
      for (const p of elegidas) {
        el.subir.textContent = `SUBIENDO ${hechos.length + 1}/${elegidas.length}…`;
        try {
          await subirPersona(p);
          p.estado = "ok";
          hechos.push(p.dni);
        } catch (e) {
          p.estado = "err";
          p.detalle = `no se pudo: ${e.message}`;
          consola(`${p.dni}: ${e.message}`, "err");
        }
        p.incluir = false;
        pintar();
      }
    } finally {
      s.subiendo = false;
      el.cancelar.disabled = false;
      pintar();
    }

    const fallas = elegidas.length - hechos.length;
    consola.cabecera(`CARGA TERMINADA · ${hechos.length} ok${fallas ? ` · ${fallas} con error` : ""}`);
    if (hechos.length) {
      consola(`para generar sus RRCC (fotocheck, Word y ZIP) usa RENOVACIÓN con: ${hechos.join(" ")}`, "ok");
      try {
        await copiarTexto(hechos.join("\n"));
        consola("DNI copiados al portapapeles: pégalos en RENOVACIÓN", "ok");
      } catch {
        /* sin portapapeles quedan en la consola */
      }
    }
    notificar(
      fallas ? "Carga con errores" : "Carga completa",
      `${hechos.length} persona(s) subida(s)${fallas ? `, ${fallas} con error (ver consola)` : ""}.`,
      fallas ? "warn" : "ok"
    );
  }

  async function subirPersona(p) {
    // se vuelve a leer la fila justo antes de escribir: el plan pudo quedar viejo
    p.leido = await obtenerPersona(p.dni, { refrescar: true });
    const plan = planDeCarga(p, p.leido, { tieneFoto: p.tieneFoto });

    if (plan.accion === "alta") {
      if (!p.foto) throw new Error("falta la foto (obligatoria para el alta)");
      // la foto va antes que la fila, como en el formulario: si falla no queda un registro sin foto
      await subirFoto(p.foto, { nombre: `${p.dni}.png` });
      consola(`${p.dni}: foto subida a FOTOS/${p.dni}.png`, "ok");
      const tipos = tiposDeMatriz(s.contexto?.matriz || [], p.cargo, "");
      const fila = filaNueva({
        datos: {
          dni: p.dni,
          apellidos: p.apellidos,
          nombres: p.nombres,
          empresa: p.empresa || "AESA",
          cargo: p.cargo,
          area: "",
          examenMedico: p.examenMedico,
          vencimientoEmo: p.vencimientoEmo,
          usoLentes: p.usoLentes || "NO",
          restricciones: p.restricciones,
        },
        tipos,
      });
      const r = await sheets({ accion: "alta", valores: fila });
      if (!r.ok) throw new Error(r.error || (r.yaExiste ? "el DNI ya existe" : "la hoja rechazó el alta"));
      anotarPersona({ dni: p.dni, fila: r.fila, valores: r.valores || fila });
      p.detalle = `alta en la fila ${r.fila} con código ${r.codigo || "—"}`;
      consola(`${p.dni}: ${p.detalle}`, "ok");
      return;
    }

    if (plan.accion === "completo") {
      p.detalle = "ya estaba completo";
      return;
    }

    if (plan.subirFoto) {
      await subirFoto(p.foto, { nombre: `${p.dni}.png` });
      consola(`${p.dni}: foto subida a FOTOS/${p.dni}.png`, "ok");
    }
    const columnas = [...Object.keys(plan.datos), ...Object.keys(plan.extras)];
    if (columnas.length) {
      const valores = aplicarEdicionesManuales(p.leido.valores, {}, { config: s.contexto?.config });
      for (const [col, v] of Object.entries({ ...plan.datos, ...plan.extras })) valores[INDICE[col]] = v;
      const g = await guardarFilaVerificada({ fila: p.leido.fila, valores, dni: p.dni, codigos: [], datos: plan.datos });
      if (g.diferencias?.length) throw new Error(`la hoja no confirmó: ${g.diferencias.map((d) => d.campo || d.codigo).join(", ")}`);
    }
    p.detalle = `fila ${p.leido.fila}: ${columnas.length ? columnas.join(", ") : "sin datos nuevos"}${plan.subirFoto ? " + foto" : ""}`;
    consola(`${p.dni}: completado (${p.detalle})`, "ok");
  }
}
