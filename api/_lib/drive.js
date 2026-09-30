/**
 * Fuentes de Drive.
 *
 * INDUCCION: carpeta de Drive (con o sin subcarpetas por anio) con un PDF por
 * persona y anio, nombrado "<DNI>_<APELLIDOS NOMBRES>.pdf" (p. ej.
 * REINDUCCION/2026/47887396_URIOL MACUYAMA MAURO GHERSON.pdf). Va en
 * DRIVE_INDUCCION_FOLDER (id o URL); si falta se usa DRIVE_FOLDER_ID, la
 * carpeta unica de antes. Sin DRIVE_API_KEY o sin carpeta esta fuente queda
 * desactivada en silencio (permite desplegar sin Drive).
 *
 * RESPALDO: los PDF por RRCC de DRIVE_CERT_FOLDERS (mas abajo).
 *
 * Buscar (files.list) usa la API oficial con API key: la carpeta puede tener
 * cientos de archivos y raspar la pagina publica solo trae los primeros 50.
 * Descargar (alt=media) no necesita API key: basta con que el archivo sea
 * publico.
 */

import { pedir, esPdf } from "./nexa.js";
import { porCodigo } from "../../shared/rrcc.js";
import { construirDiccionario, mapearCurso, esArchivoDePersona } from "../../shared/estados.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const MIME_CARPETA = "application/vnd.google-apps.folder";
let fotosFolderPromise = null;

function configurado() {
  const apiKey = process.env.DRIVE_API_KEY;
  return apiKey ? { apiKey } : null;
}

const NOMBRE_INDUCCION = /^(\d{6,12})[ _-]/;
const TTL_ARBOL = 10 * 60 * 1000;
let arbolInduccion = null; // { raiz, hasta, carpetas: [{ id, nombre }] }

/** Id de una carpeta a partir de su id o de su URL. */
function idDeCarpeta(valor) {
  const t = String(valor || "").trim();
  return (/\/folders\/([\w-]+)/.exec(t) || [])[1] || t;
}

async function listar(cfg, q, campos, pageSize = 100) {
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent(campos)}&pageSize=${pageSize}&key=${cfg.apiKey}`;
  const { buffer, res } = await pedir(url);
  if (res.status !== 200) {
    let detalle = `HTTP ${res.status}`;
    try {
      detalle = JSON.parse(buffer.toString("utf8"))?.error?.message || detalle;
    } catch {
      /* cuerpo no-json */
    }
    throw new Error(detalle);
  }
  return JSON.parse(buffer.toString("utf8")).files || [];
}

const MAX_CARPETAS = 30;

/**
 * La carpeta de inducciones y sus subcarpetas (una por anio, hasta 3 niveles).
 * Se recuerda 10 minutos: el arbol casi no cambia y asi cada busqueda solo
 * consulta el contenido de cada carpeta.
 *
 * Una consulta por carpeta y no un "or" entre padres: con API key Drive
 * responde 403 a cualquier combinacion de "in parents" con "or".
 */
async function carpetasDeInduccion(cfg, raiz) {
  if (arbolInduccion && arbolInduccion.raiz === raiz && Date.now() < arbolInduccion.hasta) return arbolInduccion.carpetas;

  const carpetas = [{ id: raiz, nombre: "" }];
  let nivel = [raiz];
  for (let i = 0; i < 3 && nivel.length && carpetas.length < MAX_CARPETAS; i++) {
    const hijas = await Promise.all(
      nivel.map((id) => listar(cfg, `'${id}' in parents and trashed = false and mimeType = '${MIME_CARPETA}'`, "files(id,name)", 200))
    );
    const nuevas = hijas.flat().map((f) => ({ id: f.id, nombre: f.name }));
    carpetas.push(...nuevas);
    nivel = nuevas.map((f) => f.id);
  }
  const acotadas = carpetas.slice(0, MAX_CARPETAS);
  arbolInduccion = { raiz, hasta: Date.now() + TTL_ARBOL, carpetas: acotadas };
  return acotadas;
}

/** Archivos de inducciones -> items del inventario para ese documento. */
export function itemsDeInduccion(archivos, dni, nombreDeCarpeta = () => "") {
  const sinCeros = (d) => String(d).replace(/^0+/, "");
  const items = [];
  for (const f of archivos || []) {
    const m = NOMBRE_INDUCCION.exec(f.name || "");
    // "contains" es por subcadena: se exige el documento exacto (con o sin cero inicial)
    if (!m || sinCeros(m[1]) !== sinCeros(dni)) continue;
    const carpeta = nombreDeCarpeta((f.parents || [])[0]);
    items.push({
      id: f.id,
      empresa: "",
      curso: ["REINDUCCIÓN", carpeta].filter(Boolean).join(" "),
      detalle: carpeta,
      fecha: "",
      estado: "DISPONIBLE",
      descargable: true,
      origen: "INDUCCION",
      archivo: f.name,
    });
  }
  return items;
}

/**
 * Certificados de induccion de un documento. Solo devuelve los que existen:
 * si no hay ninguno, la lista va vacia.
 */
export async function induccionBuscar(dniBruto) {
  const cfg = configurado();
  const raiz = idDeCarpeta(process.env.DRIVE_INDUCCION_FOLDER || process.env.DRIVE_FOLDER_ID);
  const dni = String(dniBruto ?? "").replace(/\D/g, ""); // solo digitos: va dentro de la consulta
  if (!cfg || !raiz || !dni) return { items: [], aviso: null };

  let carpetas;
  let aviso = null;
  try {
    carpetas = await carpetasDeInduccion(cfg, raiz);
  } catch (e) {
    // sin poder recorrer las subcarpetas se busca al menos en la raiz
    carpetas = [{ id: raiz, nombre: "" }];
    aviso = `Inducción: no se pudieron leer las subcarpetas (${e.message})`;
  }

  const sinCeros = dni.replace(/^0+/, "") || dni;
  const nombres = [...new Set([dni, sinCeros])].map((n) => `name contains '${n}'`).join(" or ");
  const resultados = await Promise.allSettled(
    carpetas.map((c) => listar(cfg, `'${c.id}' in parents and trashed = false and (${nombres})`, "files(id,name,parents)", 100))
  );
  const archivos = resultados.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  const falladas = resultados.filter((r) => r.status === "rejected");
  if (falladas.length && !aviso) {
    aviso = `Inducción: ${falladas.length} de ${carpetas.length} carpeta(s) no se pudieron leer (${falladas[0].reason?.message || falladas[0].reason})`;
  }

  const nombreDe = new Map(carpetas.map((c) => [c.id, c.nombre]));
  return { items: itemsDeInduccion(archivos, dni, (id) => nombreDe.get(id) || ""), aviso };
}

/**
 * Respaldo: carpetas de Drive con un PDF por certificado y por RRCC, nombrados
 *
 *     <DNI 8 digitos>_<CODIGO RRCC>_<AAAA-MM-DD>_<APELLIDOS NOMBRES>.pdf
 *
 * (p. ej. 46041028_TA_2026-03-20_ANLAS JANAMPA ELIO YODY.pdf). La fecha es la
 * del curso. Se usan solo donde JOMISER no trae el certificado; esa decision la
 * toma `elegirCertificados` (y `api/search.js` para no listar de mas).
 *
 * Las carpetas van en DRIVE_CERT_FOLDERS, separadas por comas; sirve el id o la
 * URL completa de la carpeta. Deben ser publicas ("cualquiera con el enlace").
 */
const NOMBRE_CERT = /^(\d{8,})_([A-Za-z]{2,3})_(\d{4}-\d{2}-\d{2})_(.*)\.pdf$/i;

export function carpetasRespaldo(valor = process.env.DRIVE_CERT_FOLDERS) {
  return String(valor || "")
    .split(/[,;\s]+/)
    .map((t) => (/\/folders\/([\w-]+)/.exec(t) || [])[1] || t.trim())
    .filter(Boolean);
}

/** Nombres de archivo de una carpeta -> items del inventario para ese documento. */
export function itemsDeArchivos(archivos, dni) {
  const items = [];
  for (const f of archivos || []) {
    const m = NOMBRE_CERT.exec(f.name || "");
    if (!m || m[1] !== dni) continue; // "contains" es por subcadena: se exige el documento exacto
    const codigo = m[2].toUpperCase();
    const rrcc = porCodigo(codigo);
    if (!rrcc) continue;
    items.push({
      id: f.id,
      codigo,
      empresa: "",
      curso: rrcc.nombre,
      fecha: m[3],
      estado: "DISPONIBLE",
      descargable: true,
      origen: "DRIVE",
      respaldo: true,
      archivo: f.name,
    });
  }
  return items;
}

function listarCarpeta(cfg, carpeta, dni) {
  return listar(cfg, `'${carpeta}' in parents and trashed = false and name contains '${dni}'`, "files(id,name)", 100);
}

export async function driveBuscarRespaldo(dniBruto) {
  const apiKey = process.env.DRIVE_API_KEY;
  const carpetas = carpetasRespaldo();
  const dni = String(dniBruto ?? "").replace(/\D/g, ""); // solo digitos: va dentro de la consulta
  if (!apiKey || !carpetas.length || !dni) return { items: [], avisos: [] };

  const resultados = await Promise.allSettled(carpetas.map((c) => listarCarpeta({ apiKey }, c, dni)));
  const items = [];
  const avisos = [];
  const vistos = new Set();
  resultados.forEach((r, i) => {
    if (r.status === "rejected") {
      avisos.push(`Drive (respaldo, carpeta ${i + 1}): ${r.reason?.message || r.reason}`);
      return;
    }
    for (const it of itemsDeArchivos(r.value, dni)) {
      if (vistos.has(it.id)) continue;
      vistos.add(it.id);
      items.push(it);
    }
  });
  return { items, avisos };
}

/**
 * Los PDF por RRCC de las carpetas de respaldo (DRIVE_CERT_FOLDERS) son para
 * cuando JOMISER no trae el certificado: si otra fuente ya tiene un certificado
 * descargable de ese riesgo, no se listan. Aqui solo se usan los alias base; la
 * eleccion definitiva (con la hoja CURSO_RRCC) la hace el navegador.
 */
export function sinRespaldoInnecesario(items) {
  const dic = construirDiccionario([]);
  const cubiertos = new Set();
  for (const it of items) {
    if (it.respaldo || it.descargable === false || esArchivoDePersona(it)) continue;
    const codigo = mapearCurso(it.curso, dic);
    if (codigo && codigo !== "IGNORADO") cubiertos.add(codigo);
  }
  return items.filter((it) => !it.respaldo || !cubiertos.has(it.codigo));
}

export async function driveDescargar(id) {
  if (!id) throw new Error("id de Drive invalido");
  const url = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`;
  const { buffer, res } = await pedir(url, { timeout: 60000 });
  if (!esPdf(buffer)) throw new Error(`Drive: respuesta no-PDF (HTTP ${res.status})`);
  return buffer;
}

/**
 * Lee una foto publica de FOTOS sin pasar por Apps Script. Es importante para
 * la renovacion: Apps Script tenia que recorrer toda esa carpeta para cada
 * persona y terminaba respondiendo una pagina HTML por timeout.
 */
async function carpetaFotosPublica(cfg) {
  if (process.env.DRIVE_FOTOS_FOLDER_ID) return process.env.DRIVE_FOTOS_FOLDER_ID;
  if (fotosFolderPromise) return fotosFolderPromise;

  const raiz = process.env.DRIVE_RRCC_FOLDER_ID;
  if (!raiz) return null;
  const q = `'${raiz}' in parents and trashed = false and name = 'FOTOS' and mimeType = '${MIME_CARPETA}'`;
  const url =
    `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id)")}&pageSize=1&key=${cfg.apiKey}`;
  fotosFolderPromise = pedir(url).then(({ buffer, res }) => {
    if (res.status !== 200) return null;
    return JSON.parse(buffer.toString("utf8")).files?.[0]?.id || null;
  });
  return fotosFolderPromise;
}

/**
 * Baja un archivo de Drive por su id con la API key, sin pasar por Apps
 * Script: solo funciona si el archivo es publico ("cualquiera con el
 * enlace"). null si no se puede (sin API key, privado, inexistente).
 */
export async function driveBajarPublico(id) {
  const cfg = configurado();
  if (!cfg || !id) return null;
  const base = `${DRIVE_API}/files/${encodeURIComponent(id)}`;
  try {
    const [meta, contenido] = await Promise.all([
      pedir(`${base}?fields=${encodeURIComponent("name,mimeType")}&key=${cfg.apiKey}`, { intentos: 1 }),
      pedir(`${base}?alt=media&key=${cfg.apiKey}`, { intentos: 1, timeout: 60000 }),
    ]);
    if (meta.res.status !== 200 || contenido.res.status !== 200 || !contenido.buffer.length) return null;
    const info = JSON.parse(meta.buffer.toString("utf8"));
    return { id, name: info.name || "", mimeType: info.mimeType || "application/octet-stream", datos: contenido.buffer };
  } catch {
    return null;
  }
}

export async function driveFotoBuscar(dni) {
  const cfg = configurado();
  if (!cfg) return null;
  const carpeta = await carpetaFotosPublica(cfg);
  if (!carpeta) return null;

  const limpio = String(dni ?? "").replace(/\D/g, "");
  if (!limpio) return null;
  const documento = limpio.length < 8 ? limpio.padStart(8, "0") : limpio;
  const corto = documento.replace(/^0+/, "") || documento;
  const nombres = [...new Set([documento, corto].flatMap((n) => [n + ".png", n + ".jpg", n + ".jpeg"]))];

  // todas las grafias se consultan a la vez: de a una eran hasta 6 idas y
  // vueltas a Drive antes de dar con la foto (o de saber que no hay)
  const encontrados = await Promise.all(
    nombres.map(async (nombre) => {
      const q = `'${carpeta}' in parents and trashed = false and name = '${nombre}'`;
      const url =
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent("files(id,name,mimeType,size)")}&pageSize=1&key=${cfg.apiKey}`;
      try {
        const { buffer, res } = await pedir(url);
        if (res.status !== 200) return null;
        return JSON.parse(buffer.toString("utf8")).files?.[0] || null;
      } catch {
        return null;
      }
    })
  );

  // se respeta el orden de preferencia (documento de 8 digitos, .png primero)
  for (const archivo of encontrados) {
    if (!archivo) continue;
    const descarga = `${DRIVE_API}/files/${encodeURIComponent(archivo.id)}?alt=media&key=${cfg.apiKey}`;
    const r = await pedir(descarga, { timeout: 60000 });
    if (r.res.status === 200 && r.buffer.length) return { ...archivo, datos: r.buffer };
  }
  return null;
}
