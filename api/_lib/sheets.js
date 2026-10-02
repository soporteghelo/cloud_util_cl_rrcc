/**
 * Cliente de Google Sheets sobre la cuenta de servicio.
 *
 * La base es el Spreadsheet `DATA` que vive dentro de la carpeta `RRCC` de
 * Drive. Ya tiene sus hojas propias (`BD AESA`, `FOTOCHEK`, `TB_DINAMICS`) y
 * la app **no las reestructura**: se engancha a `BD AESA` tal como esta y
 * agrega, si faltan, tres hojas auxiliares suyas:
 *
 *   BD AESA        una fila por persona   <- la que ya existia
 *   CURSO_RRCC     diccionario nombre de curso -> codigo de riesgo critico
 *   MATRIZ_PUESTO  que RRCC exige cada puesto (solo para personal nuevo)
 *   CONFIG         parametros (umbrales, plantillas, medidas del Word)
 *
 * `BD AESA` no arranca en la fila 1: las filas 1 y 2 son la numeracion y los
 * encabezados de grupo, la cabecera real esta en la 3 y los datos empiezan en
 * la 4. Por eso todo aca se cuenta desde `filaDatos()` y no desde 2.
 *
 * Todo se escribe con valueInputOption RAW y las fechas como texto ISO
 * "YYYY-MM-DD": si se dejara que Sheets las interprete, el resultado
 * dependeria de la configuracion regional de la hoja y un 02/09 podria
 * guardarse como 9 de febrero.
 */

import { pedirGoogle } from "./google.js";
import { CABECERA, letraColumna } from "../../shared/rrcc.js";

const API = "https://sheets.googleapis.com/v4/spreadsheets";

/**
 * `personal` arranca con el nombre por defecto y lo corrige
 * `resolverHojaPersonal()` mirando las pestanas que existen de verdad: la
 * hoja puede llamarse "BD AESA" o "BD_AESA" segun quien la haya nombrado, y
 * un espacio de mas no deberia romper nada.
 */
export const HOJAS = {
  // La estructura oficial usa guion bajo. La normalizacion conserva tambien
  // compatibilidad de lectura con libros antiguos llamados "BD AESA".
  personal: process.env.SHEET_HOJA_PERSONAL || "BD_AESA",
  cursos: "CURSO_RRCC",
  matriz: "MATRIZ_PUESTO",
  config: "CONFIG",
};

/** "BD_AESA", "BD AESA" y "bd  aesa" son la misma pestana. */
export function normalizarNombreHoja(texto) {
  return String(texto ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

let hojaResuelta = false;

/**
 * Ajusta `HOJAS.personal` al nombre real de la pestana. Se llama una vez por
 * invocacion; en caliente no vuelve a preguntar.
 */
export async function resolverHojaPersonal() {
  if (hojaResuelta) return HOJAS.personal;
  const titulos = await hojasExistentes();
  const buscado = normalizarNombreHoja(HOJAS.personal);
  const encontrada = titulos.find((t) => normalizarNombreHoja(t) === buscado);
  if (encontrada) HOJAS.personal = encontrada;
  hojaResuelta = true;
  return HOJAS.personal;
}

/** Fila de la cabecera real de `BD AESA` (1 y 2 son titulos de grupo). */
export const filaCabecera = () => Number(process.env.SHEET_FILA_CABECERA || 3);

/** Primera fila con datos de personas. */
export const filaDatos = () => Number(process.env.SHEET_FILA_DATOS || filaCabecera() + 1);

export function idHoja() {
  const id = process.env.SHEET_ID;
  if (!id) throw new Error("falta SHEET_ID (el id del Spreadsheet `DATA` de la carpeta RRCC)");
  return id;
}

export const hayHoja = () => Boolean(process.env.SHEET_ID);

/** Fila de la hoja (1-based) para el n-esimo registro (0-based). */
export const filaDeRegistro = (indice) => filaDatos() + indice;

/** Rango con el nombre de hoja entrecomillado: "BD AESA" lleva un espacio. */
const rango = (hoja, a1) => `'${String(hoja).replace(/'/g, "''")}'!${a1}`;

/* ------------------------------------------------------------------ */
/* Ancho util                                                          */
/* ------------------------------------------------------------------ */

/**
 * Cuantas columnas tiene realmente la cuadricula de `BD AESA`.
 *
 * Importa porque `CABECERA` describe 98 columnas y la hoja que ya existia
 * llega hasta CP (94): escribir mas alla del ancho de la cuadricula no
 * "crece" sola, devuelve "exceeds grid limits". Se consulta una vez por
 * invocacion y se recorta la escritura a lo que quepa.
 */
let anchoCache = null;

export async function anchoPersonal() {
  if (anchoCache) return anchoCache;
  await resolverHojaPersonal();
  const datos = await pedirGoogle(`${API}/${idHoja()}?fields=sheets.properties`);
  const props = (datos?.sheets || []).map((s) => s.properties).find((p) => p.title === HOJAS.personal);
  if (!props) {
    const titulos = (datos?.sheets || []).map((s) => s.properties.title).join(", ");
    throw new Error(`el Spreadsheet no tiene la hoja "${HOJAS.personal}". Tiene: ${titulos}`);
  }
  anchoCache = { id: props.sheetId, columnas: props.gridProperties?.columnCount || CABECERA.length };
  return anchoCache;
}

/** Agrega columnas al final de `BD AESA` hasta que quepa toda la CABECERA. */
export async function asegurarColumnas() {
  const info = await anchoPersonal();
  const faltan = CABECERA.length - info.columnas;
  if (faltan <= 0) return 0;

  await pedirGoogle(`${API}/${idHoja()}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [
        { appendDimension: { sheetId: info.id, dimension: "COLUMNS", length: faltan } },
      ],
    }),
  });
  anchoCache = { id: info.id, columnas: CABECERA.length };
  return faltan;
}

/* ------------------------------------------------------------------ */
/* Lectura                                                             */
/* ------------------------------------------------------------------ */

/** Un rango A1 -> matriz de valores (puede venir con filas mas cortas). */
export async function leerRango(a1) {
  const url = `${API}/${idHoja()}/values/${encodeURIComponent(a1)}?valueRenderOption=UNFORMATTED_VALUE`;
  const datos = await pedirGoogle(url);
  return datos?.values || [];
}

/** Varios rangos en UNA sola llamada (importa: cada una cuesta ~200 ms). */
export async function leerRangos(rangos) {
  const qs = rangos.map((r) => `ranges=${encodeURIComponent(r)}`).join("&");
  const url = `${API}/${idHoja()}/values:batchGet?${qs}&valueRenderOption=UNFORMATTED_VALUE`;
  const datos = await pedirGoogle(url);
  return (datos?.valueRanges || []).map((v) => v.values || []);
}

/* ------------------------------------------------------------------ */
/* Escritura                                                           */
/* ------------------------------------------------------------------ */

export async function escribirRango(a1, valores, entrada = "RAW") {
  const url = `${API}/${idHoja()}/values/${encodeURIComponent(a1)}?valueInputOption=${entrada}`;
  return pedirGoogle(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ range: a1, majorDimension: "ROWS", values: valores }),
  });
}

/** Varias escrituras en una sola llamada. `datos` = [{ range, values }]. */
export async function escribirRangos(datos) {
  if (!datos.length) return null;
  return pedirGoogle(`${API}/${idHoja()}/values:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ valueInputOption: "RAW", data: datos }),
  });
}

/** Agrega filas al final de una hoja. Devuelve el rango escrito. */
export async function agregarFilas(hoja, filas) {
  const url =
    `${API}/${idHoja()}/values/${encodeURIComponent(rango(hoja, "A1"))}:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const r = await pedirGoogle(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ majorDimension: "ROWS", values: filas }),
  });
  return r?.updates?.updatedRange || "";
}

/* ------------------------------------------------------------------ */
/* Hoja de personal                                                    */
/* ------------------------------------------------------------------ */

/**
 * Indice DNI -> numero de fila. Se lee solo la columna del DNI: traer las 98
 * columnas de 600 personas para buscar un documento seria absurdo.
 */
export async function indicePorDni() {
  await resolverHojaPersonal();
  const col = letraColumna(CABECERA.indexOf("DNI"));
  const desde = filaDatos();
  const valores = await leerRango(rango(HOJAS.personal, `${col}${desde}:${col}`));
  const indice = new Map();
  valores.forEach((fila, i) => {
    const dni = normalizarClaveDni(fila?.[0]);
    if (dni && !indice.has(dni)) indice.set(dni, desde + i);
  });
  return indice;
}

/**
 * El DNI puede estar guardado como numero (Sheets se come el cero inicial,
 * igual que Excel) o como texto. Se compara siempre relleno a 8 digitos.
 */
export function normalizarClaveDni(valor) {
  const d = String(valor ?? "").replace(/\D/g, "");
  if (!d) return "";
  return d.length < 8 ? d.padStart(8, "0") : d;
}

/** Fila completa de una persona por su numero de fila. */
export async function leerFilaPersonal(fila) {
  const { columnas } = await anchoPersonal();
  const ultima = letraColumna(Math.min(CABECERA.length, columnas) - 1);
  const valores = await leerRango(rango(HOJAS.personal, `A${fila}:${ultima}${fila}`));
  return completar(valores[0] || []);
}

/**
 * Todas las filas de personas de una vez, completas al ancho de CABECERA.
 * Sirve para reportes que recorren a todo el mundo (vencimientos por RRCC):
 * una sola llamada en vez de una por persona. El rango sin fila final
 * ("A4:CP") hace que Sheets devuelva solo hasta la ultima fila con datos.
 */
export async function leerTodoElPersonal() {
  await resolverHojaPersonal();
  const { columnas } = await anchoPersonal();
  const ultima = letraColumna(Math.min(CABECERA.length, columnas) - 1);
  const desde = filaDatos();
  const iDni = CABECERA.indexOf("DNI");
  const valores = await leerRango(rango(HOJAS.personal, `A${desde}:${ultima}`));
  return valores.map(completar).filter((fila) => String(fila[iDni] || "").trim());
}

/**
 * Actualiza solo el bloque que pertenece a RRCC (P en adelante). Los datos
 * personales A:O tienen validaciones y formulas propias en la hoja original;
 * reescribirlos aunque no hayan cambiado puede disparar un rechazo de Sheets
 * (por ejemplo, la lista validada de EMPRESA).
 */
export async function escribirFilaPersonal(fila, valores) {
  const { columnas } = await anchoPersonal();
  const ancho = Math.min(CABECERA.length, columnas);
  const inicio = 15; // P: comienza el primer bloque de riesgo (AE)
  if (ancho <= inicio) throw new Error("BD_AESA no tiene columnas de riesgos para actualizar");
  const ultima = letraColumna(ancho - 1);
  return escribirRango(rango(HOJAS.personal, `${letraColumna(inicio)}${fila}:${ultima}${fila}`), [
    completar(valores).slice(inicio, ancho),
  ]);
}

/** Columnas de A:O que la ficha puede corregir a mano; el resto de A:O no se toca. */
export const COLUMNAS_EDITABLES = {
  "F. Ex. Medico": "fecha",
  "F. Vencimiento": "fecha",
  "Area Planilla": "texto",
  Apellidos: "texto",
  Nombres: "texto",
  "Cargo Planilla": "texto",
  EMPRESA: "texto",
};

/**
 * Escribe esas columnas para una fila. Los nombres se validan antes de
 * escribir nada. USER_ENTERED para que "2026-10-03" quede como fecha y no
 * como texto.
 */
export async function escribirDatosPersonales(fila, datos) {
  const nombres = Object.keys(datos || {});
  for (const n of nombres) {
    if (!COLUMNAS_EDITABLES[n]) throw new Error(`columna no editable desde la app: ${n}`);
  }
  for (const n of nombres) {
    const valor = COLUMNAS_EDITABLES[n] === "fecha" ? datos[n] || "" : String(datos[n] ?? "").trim();
    const col = letraColumna(CABECERA.indexOf(n));
    await escribirRango(rango(HOJAS.personal, `${col}${fila}`), [[valor]], "USER_ENTERED");
  }
}

/** Agrega una persona al final y devuelve su numero de fila. */
export async function agregarPersona(valores) {
  const { columnas } = await anchoPersonal();
  const ancho = Math.min(CABECERA.length, columnas);
  const escrito = await agregarFilas(HOJAS.personal, [completar(valores).slice(0, ancho)]);
  const m = /![A-Z]+(\d+)/.exec(escrito);
  return m ? Number(m[1]) : null;
}

/**
 * Sheets devuelve las filas recortadas en la ultima celda con contenido, asi
 * que una fila a medio llenar vuelve mas corta que la cabecera. Se rellena
 * para que los indices de `rrcc.js` sigan siendo validos.
 */
export function completar(fila) {
  const salida = CABECERA.map(() => "");
  for (let i = 0; i < Math.min(fila.length, salida.length); i++) {
    salida[i] = fila[i] === null || fila[i] === undefined ? "" : fila[i];
  }
  return salida;
}

/* ------------------------------------------------------------------ */
/* Comprobacion de la cabecera                                         */
/* ------------------------------------------------------------------ */

/**
 * Compara la cabecera real de `BD AESA` con la que espera el codigo.
 *
 * Todo depende de que las columnas esten donde se cree: la hoja FOTOCHEK
 * resuelve por BUSCARV posicional y el motor escribe por indice. Si alguien
 * inserta una columna, la app escribiria las fechas en el lugar equivocado
 * sin protestar. Esto lo detecta antes de tocar nada.
 */
export async function comprobarCabecera() {
  await resolverHojaPersonal();
  const fila = filaCabecera();
  const { columnas } = await anchoPersonal();
  const ultima = letraColumna(Math.max(CABECERA.length, columnas) - 1);
  const leida = (await leerRango(rango(HOJAS.personal, `A${fila}:${ultima}${fila}`)))[0] || [];

  const norm = (t) =>
    String(t ?? "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, " ")
      .trim();

  const diferencias = [];
  for (let i = 0; i < CABECERA.length; i++) {
    const esperada = CABECERA[i];
    const real = leida[i];
    if (real === undefined || real === "") {
      // las columnas que la app agrega al final pueden no existir todavia
      diferencias.push({ columna: letraColumna(i), esperada, real: "(vacia)", nueva: i >= columnas });
      continue;
    }
    if (norm(real) !== norm(esperada)) {
      diferencias.push({ columna: letraColumna(i), esperada, real: String(real) });
    }
  }

  return {
    hoja: HOJAS.personal,
    filaCabecera: fila,
    filaDatos: filaDatos(),
    columnasEnLaHoja: columnas,
    columnasEsperadas: CABECERA.length,
    cabeceraLeida: leida,
    diferencias,
    // una diferencia dentro del ancho existente es un problema de verdad
    grave: diferencias.some((d) => !d.nueva && d.real !== "(vacia)"),
  };
}

/* ------------------------------------------------------------------ */
/* Hojas auxiliares                                                    */
/* ------------------------------------------------------------------ */

/** CURSO_RRCC, MATRIZ_PUESTO y CONFIG en una sola llamada. */
export async function leerAuxiliares() {
  const [cursos, matriz, config] = await leerRangos([
    rango(HOJAS.cursos, "A2:C"),
    rango(HOJAS.matriz, "A1:Z"),
    rango(HOJAS.config, "A2:B"),
  ]);
  return { cursos, matriz, config: aObjeto(config) };
}

/** [["CLAVE","valor"],...] -> { CLAVE: "valor" } */
export function aObjeto(filas) {
  const o = {};
  for (const fila of filas || []) {
    const k = String(fila?.[0] ?? "").trim();
    if (k) o[k] = fila?.[1] ?? "";
  }
  return o;
}

/** Deja constancia de un curso que no se pudo mapear, para revisarlo luego. */
export async function registrarNoMapeados(cursos) {
  if (!cursos.length) return;
  const sello = new Date().toISOString();
  const filas = cursos.map((c) => [c.curso, "", c.origen || "", `sin mapear ${sello}`]);
  await agregarFilas(HOJAS.cursos, filas);
}

/* ------------------------------------------------------------------ */
/* Creacion de las hojas auxiliares (setup)                            */
/* ------------------------------------------------------------------ */

/** Nombres de las hojas que ya existen en el Spreadsheet. */
export async function hojasExistentes() {
  const datos = await pedirGoogle(`${API}/${idHoja()}?fields=sheets.properties.title`);
  return (datos?.sheets || []).map((s) => s.properties.title);
}

/**
 * Crea las hojas auxiliares que falten. **Nunca** crea ni toca la hoja de
 * personal: esa ya existe y es la fuente de verdad.
 */
export async function crearHojasFaltantes() {
  await resolverHojaPersonal();
  const existen = await hojasExistentes();
  const auxiliares = [HOJAS.cursos, HOJAS.matriz, HOJAS.config];
  const faltan = auxiliares.filter((h) => !existen.includes(h));
  if (!faltan.length) return { creadas: [], faltaPersonal: !existen.includes(HOJAS.personal) };

  await pedirGoogle(`${API}/${idHoja()}:batchUpdate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: faltan.map((title) => ({ addSheet: { properties: { title } } })),
    }),
  });
  return { creadas: faltan, faltaPersonal: !existen.includes(HOJAS.personal) };
}
