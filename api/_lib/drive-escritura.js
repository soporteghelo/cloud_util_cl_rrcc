/**
 * Escritura en Google Drive con la cuenta de servicio.
 *
 * `drive.js` sigue siendo la fuente de *lectura* de la carpeta publica por
 * API key (no necesita credenciales y por eso puede desplegarse sin ellas).
 * Esto es lo otro: crear la carpeta de cada persona y subir ahi sus
 * certificados, su foto y el Word de autorizacion.
 *
 * Requisitos: la carpeta raiz de salidas y la de fotos tienen que estar
 * compartidas con GOOGLE_SA_EMAIL como **Editor**. Una cuenta de servicio no
 * tiene "Mi unidad" utilizable, asi que siempre se escribe dentro de una
 * carpeta que un humano le compartio.
 */

import { pedirGoogle } from "./google.js";
import { normalizarDocumento } from "../../shared/estados.js";

const API = "https://www.googleapis.com/drive/v3";
const SUBIDA = "https://www.googleapis.com/upload/drive/v3/files";
const MIME_CARPETA = "application/vnd.google-apps.folder";

/** Las unidades compartidas necesitan este parametro en cada llamada. */
const COMUNES = "supportsAllDrives=true&includeItemsFromAllDrives=true";

/** Las comillas simples rompen la sintaxis `q` de Drive. */
const escapar = (t) => String(t).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

/* ------------------------------------------------------------------ */
/* Las carpetas de trabajo                                             */
/* ------------------------------------------------------------------ */

/**
 * Estructura en Drive:
 *
 *   RRCC/                 <- DRIVE_RRCC_FOLDER_ID
 *     DATA/               <- salidas: una subcarpeta por persona
 *     FOTOS/              <- fotos del personal, "<DNI>.png"
 *     DATA  (Spreadsheet) <- la base, por SHEET_ID
 *
 * Basta con configurar la raiz: `DATA` y `FOTOS` se resuelven por nombre y se
 * recuerdan mientras el proceso siga caliente. Igual se pueden fijar a mano
 * con DRIVE_OUTPUT_FOLDER_ID y DRIVE_FOTOS_FOLDER_ID.
 */
const NOMBRE_SALIDAS = process.env.DRIVE_OUTPUT_FOLDER_NAME || "DATA";
const NOMBRE_FOTOS = process.env.DRIVE_FOTOS_FOLDER_NAME || "FOTOS";

const cacheCarpetas = new Map();

export const carpetaRaiz = () => process.env.DRIVE_RRCC_FOLDER_ID || "";

async function subcarpetaDeRaiz(nombre) {
  if (cacheCarpetas.has(nombre)) return cacheCarpetas.get(nombre);
  const raiz = carpetaRaiz();
  if (!raiz) return "";
  const encontrada = await buscarEnCarpeta(nombre, raiz, MIME_CARPETA);
  const id = encontrada?.id || "";
  if (id) cacheCarpetas.set(nombre, id);
  return id;
}

export async function carpetaSalidas() {
  return process.env.DRIVE_OUTPUT_FOLDER_ID || (await subcarpetaDeRaiz(NOMBRE_SALIDAS));
}

export async function carpetaFotos() {
  return process.env.DRIVE_FOTOS_FOLDER_ID || (await subcarpetaDeRaiz(NOMBRE_FOTOS));
}

/** true si hay al menos una forma de llegar a las carpetas. */
export const hayCarpetas = () =>
  Boolean(process.env.DRIVE_RRCC_FOLDER_ID || process.env.DRIVE_OUTPUT_FOLDER_ID);

/* ------------------------------------------------------------------ */
/* Carpetas                                                            */
/* ------------------------------------------------------------------ */

export async function buscarEnCarpeta(nombre, padreId, mime) {
  const partes = [`name = '${escapar(nombre)}'`, `'${escapar(padreId)}' in parents`, "trashed = false"];
  if (mime) partes.push(`mimeType = '${mime}'`);
  const url =
    `${API}/files?q=${encodeURIComponent(partes.join(" and "))}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType)")}&pageSize=10&${COMUNES}`;
  const datos = await pedirGoogle(url);
  return (datos?.files || [])[0] || null;
}

/**
 * Carpeta de una persona por el DNI del comienzo de su nombre, con o sin el
 * cero inicial: "76018787", "76018787_TORRES ..." o "4220334_...". Si hay
 * varias, gana la que se llama exactamente `nombre`, y si no la modificada
 * mas recientemente. null si no hay ninguna.
 */
async function carpetaDeDni(dni, padre, nombre) {
  const k = normalizarDocumento(dni);
  if (!k) return null;
  const corto = k.replace(/^0+/, "") || k;
  const candidatas = new Map();
  for (const x of new Set([k, corto])) {
    const q = [`name contains '${escapar(x)}'`, `'${escapar(padre)}' in parents`, "trashed = false", `mimeType = '${MIME_CARPETA}'`];
    const url =
      `${API}/files?q=${encodeURIComponent(q.join(" and "))}` +
      `&fields=${encodeURIComponent("files(id,name,modifiedTime)")}&pageSize=50&${COMUNES}`;
    const datos = await pedirGoogle(url);
    for (const f of datos?.files || []) {
      const m = /^(\d+)/.exec(f.name || "");
      if (m && normalizarDocumento(m[1]) === k) candidatas.set(f.id, f);
    }
  }
  const lista = [...candidatas.values()].sort(
    (a, b) => (b.name === nombre) - (a.name === nombre) || String(b.modifiedTime).localeCompare(String(a.modifiedTime))
  );
  return lista[0] || null;
}

/**
 * Carpeta de una persona: la reutiliza si ya existe. Importa para poder
 * volver a correr una renovacion sin acabar con tres carpetas iguales.
 *
 * Con `dni` se busca por el DNI y no por el nombre exacto: una carpeta vieja
 * con apellidos ("76018787_TORRES ...") se reutiliza y se renombra a `nombre`.
 */
export async function carpetaPara(nombre, padreId, dni) {
  const padre = padreId || (await carpetaSalidas());
  if (!padre) {
    throw new Error(
      `no se encontro la carpeta de salidas: define DRIVE_RRCC_FOLDER_ID (y que contenga "${NOMBRE_SALIDAS}") o DRIVE_OUTPUT_FOLDER_ID`
    );
  }

  const porDni = dni ? await carpetaDeDni(dni, padre, nombre) : null;
  if (porDni) {
    if (porDni.name !== nombre) {
      await pedirGoogle(`${API}/files/${encodeURIComponent(porDni.id)}?fields=id&${COMUNES}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: nombre }),
      });
    }
    return { id: porDni.id, nombre, creada: false, renombrada: porDni.name !== nombre ? porDni.name : "" };
  }

  const existente = await buscarEnCarpeta(nombre, padre, MIME_CARPETA);
  if (existente) return { id: existente.id, nombre, creada: false };

  const creada = await pedirGoogle(`${API}/files?fields=id&${COMUNES}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nombre, mimeType: MIME_CARPETA, parents: [padre] }),
  });
  return { id: creada.id, nombre, creada: true };
}

/* ------------------------------------------------------------------ */
/* Subida de archivos                                                  */
/* ------------------------------------------------------------------ */

/**
 * Sube (o reemplaza) un archivo. Se usa multipart en vez de resumable
 * porque nada de lo que sube esta app pasa de unos pocos MB y resumable
 * exige dos viajes de ida y vuelta.
 *
 * Si ya hay un archivo con el mismo nombre en la carpeta se actualiza su
 * contenido en lugar de crear un duplicado: asi el enlace que alguien haya
 * guardado sigue apuntando al archivo bueno.
 */
export async function subirArchivo({ nombre, mime, datos, carpetaId, reemplazar = true }) {
  if (!carpetaId) throw new Error("subirArchivo: falta la carpeta de destino");
  const cuerpo = Buffer.isBuffer(datos) ? datos : Buffer.from(datos);
  const tipo = mime || "application/octet-stream";

  const previo = reemplazar ? await buscarEnCarpeta(nombre, carpetaId) : null;

  const limite = "limite-" + Math.random().toString(36).slice(2);
  const meta = previo ? { name: nombre } : { name: nombre, parents: [carpetaId] };
  const partes = Buffer.concat([
    Buffer.from(
      `--${limite}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify(meta) +
        `\r\n--${limite}\r\nContent-Type: ${tipo}\r\n\r\n`
    ),
    cuerpo,
    Buffer.from(`\r\n--${limite}--\r\n`),
  ]);

  const url = previo
    ? `${SUBIDA}/${previo.id}?uploadType=multipart&fields=id,name,webViewLink&${COMUNES}`
    : `${SUBIDA}?uploadType=multipart&fields=id,name,webViewLink&${COMUNES}`;

  const r = await pedirGoogle(url, {
    method: previo ? "PATCH" : "POST",
    headers: { "Content-Type": `multipart/related; boundary=${limite}` },
    body: partes,
  });

  return { id: r.id, nombre: r.name, enlace: r.webViewLink || "", reemplazado: Boolean(previo) };
}

/**
 * Manda a la papelera de Drive los archivos de `carpetaId` con esos nombres
 * (no los borra: se pueden recuperar desde la papelera). Devuelve los nombres
 * que encontro.
 */
export async function eliminarDeCarpeta(carpetaId, nombres) {
  if (!carpetaId) throw new Error("eliminarDeCarpeta: falta la carpeta");
  const eliminados = [];
  for (const nombre of nombres) {
    const archivo = await buscarEnCarpeta(nombre, carpetaId);
    if (!archivo) continue;
    await pedirGoogle(`${API}/files/${encodeURIComponent(archivo.id)}?fields=id&${COMUNES}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trashed: true }),
    });
    eliminados.push(nombre);
  }
  return eliminados;
}

/* ------------------------------------------------------------------ */
/* Lectura con la cuenta de servicio                                   */
/* ------------------------------------------------------------------ */

/** Contenido de un archivo (foto de la persona, fotocheck antiguo...). */
export async function bajarArchivo(id) {
  if (!id) throw new Error("bajarArchivo: falta el id");
  return pedirGoogle(`${API}/files/${encodeURIComponent(id)}?alt=media&${COMUNES}`, { binario: true });
}

export async function infoArchivo(id) {
  const campos = encodeURIComponent("id,name,mimeType,size,webViewLink");
  return pedirGoogle(`${API}/files/${encodeURIComponent(id)}?fields=${campos}&${COMUNES}`);
}

/**
 * Encuentra el Spreadsheet de la base dentro de la carpeta RRCC.
 *
 * Existe para no depender de que alguien copie bien el id a mano: en un id de
 * Drive la "l" minuscula y la "I" mayuscula son el mismo dibujo en casi
 * cualquier tipografia, y una equivocacion ahi da un 404 que parece un
 * problema de permisos. Si `SHEET_ID` esta puesto, manda ese.
 */
export async function buscarSpreadsheet(nombre = process.env.SHEET_NOMBRE || "DATA") {
  const raiz = carpetaRaiz();
  if (!raiz) return null;
  const q = [
    `'${escapar(raiz)}' in parents`,
    "trashed = false",
    "mimeType = 'application/vnd.google-apps.spreadsheet'",
  ];
  const url =
    `${API}/files?q=${encodeURIComponent(q.join(" and "))}` +
    `&fields=${encodeURIComponent("files(id,name)")}&pageSize=25&${COMUNES}`;

  const datos = await pedirGoogle(url);
  const hojas = datos?.files || [];
  if (!hojas.length) return null;
  const exacta = hojas.find((f) => f.name.trim().toUpperCase() === String(nombre).trim().toUpperCase());
  return exacta || hojas[0];
}

/* ------------------------------------------------------------------ */
/* Foto del personal                                                   */
/* ------------------------------------------------------------------ */

/**
 * Busca la foto de una persona en la carpeta FOTOS.
 *
 * No se puede pedir `name = '<DNI>.png'` y ya: las fotos se subieron con las
 * dos grafias del documento ("4075286.png" y "04065624.png"), porque quien
 * las exporto perdio el cero inicial en unas si y en otras no. Se consulta
 * por la parte significativa (sin ceros a la izquierda) y despues se compara
 * el documento YA NORMALIZADO, para no traer la foto de "14075286" cuando se
 * pidio la de "4075286".
 */
export async function buscarFoto(documento) {
  const dni = normalizarDocumento(documento);
  if (!dni) return null;
  const carpeta = await carpetaFotos();
  if (!carpeta) throw new Error("no se encontro la carpeta FOTOS en Drive");

  const significativo = dni.replace(/^0+/, "") || dni;
  const q = [`'${escapar(carpeta)}' in parents`, "trashed = false", `name contains '${escapar(significativo)}'`];
  const url =
    `${API}/files?q=${encodeURIComponent(q.join(" and "))}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType)")}&pageSize=50&${COMUNES}`;

  const datos = await pedirGoogle(url);
  const candidatos = datos?.files || [];
  const exacto = candidatos.find((f) => normalizarDocumento(f.name.replace(/\.[^.]+$/, "")) === dni);
  return exacto || null;
}

/** Lista el contenido de una carpeta (para comprobar que quedo bien). */
export async function listarCarpeta(carpetaId) {
  const q = `'${escapar(carpetaId)}' in parents and trashed = false`;
  const url =
    `${API}/files?q=${encodeURIComponent(q)}` +
    `&fields=${encodeURIComponent("files(id,name,mimeType,size)")}&pageSize=200&${COMUNES}`;
  const datos = await pedirGoogle(url);
  return datos?.files || [];
}
