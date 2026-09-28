/**
 * POST /api/sheets
 * Body: { accion, ... }
 *
 * Puerta unica a la base en Google Sheets. Una funcion con varias acciones
 * en vez de cinco funciones distintas: en Vercel Hobby hay un tope de
 * funciones por proyecto, y todas estas operaciones comparten el mismo
 * cliente y el mismo token.
 *
 *   contexto  ->  CONFIG + CURSO_RRCC + MATRIZ_PUESTO + cabecera
 *   persona   ->  { dni } fila de esa persona (o encontrada:false)
 *   listado   ->  todo el personal (para el reporte de vencimientos por RRCC)
 *   guardar   ->  { fila, valores, datos? } escribe una fila ya calculada (datos = columnas editables de A:O)
 *   alta      ->  { valores } agrega una persona nueva al final
 *   cargos    ->  cargos y areas distintos (para el formulario de alta)
 *   comprobar ->  contrasta la cabecera real de la hoja con la que espera el codigo
 *   setup     ->  crea las hojas auxiliares que falten y las siembra
 *
 * El calculo NO vive aca: lo hace `shared/estados.js`, que corre igual en el
 * navegador y en Node, para poder probarlo sin red ni credenciales.
 */

import {
  HOJAS,
  hayHoja,
  leerRango,
  leerRangos,
  escribirRango,
  agregarFilas,
  indicePorDni,
  leerFilaPersonal,
  leerTodoElPersonal,
  escribirFilaPersonal,
  escribirDatosPersonales,
  agregarPersona,
  normalizarClaveDni,
  leerAuxiliares,
  completar,
  crearHojasFaltantes,
  comprobarCabecera,
  resolverHojaPersonal,
  asegurarColumnas,
  filaDatos,
  hojasExistentes,
  registrarNoMapeados,
} from "./_lib/sheets.js";
import { CABECERA, INDICE, RRCC, CODIGOS_RRCC, letraColumna } from "../shared/rrcc.js";
import { leerFila, ALIAS_BASE, CURSOS_IGNORADOS } from "../shared/estados.js";
import { hayCuentaDeServicio } from "./_lib/google.js";
import { buscarSpreadsheet, carpetaRaiz } from "./_lib/drive-escritura.js";
import { appsScriptUrl, pedirAppsScript } from "./_lib/apps-script.js";

/* ------------------------------------------------------------------ */
/* Semillas de las hojas auxiliares                                    */
/* ------------------------------------------------------------------ */

const CONFIG_POR_DEFECTO = [
  ["CLAVE", "VALOR"],
  ["UMBRAL_VENCIDO", 365],
  ["UMBRAL_ACTUALIZAR", 330],
  ["A_SIN_CERT", "MANTENER"],
  // las carpetas de salida se llaman "<DNI>_<APELLIDOS NOMBRES>"
  ["PLANTILLA_CARPETA", "{DNI}_{APELLIDOS} {NOMBRES}"],
  ["PREFIJO_CODIGO", "AE"],
  ["FOTOCHECK_ALTO_CM", 8],
  ["FOTOCHECK_ANCHO_CM", 10],
  ["ANTIGUO_ANCHO_CM", 17],
];

const CABECERA_CURSOS = ["nombre_certificado", "codigo_rrcc", "fuente_preferida", "nota"];
const CABECERA_MATRIZ = ["Cargo", "Area", ...CODIGOS_RRCC];

function semillaCursos() {
  const filas = [CABECERA_CURSOS];
  for (const r of RRCC) filas.push([r.nombre, r.codigo, r.codigo === "ES" || r.codigo === "HM" ? "EIN" : "", "catalogo"]);
  for (const [nombre, codigo] of ALIAS_BASE) {
    filas.push([nombre, codigo, "", "alias"]);
  }
  for (const c of CURSOS_IGNORADOS) filas.push([c, "IGNORAR", "", "no es riesgo critico"]);
  return filas;
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

async function accionContexto() {
  const aux = await leerAuxiliares();
  return {
    cabecera: CABECERA,
    riesgos: RRCC,
    config: aux.config,
    cursos: aux.cursos,
    matriz: aux.matriz,
  };
}

async function accionPersona({ dni }) {
  const clave = normalizarClaveDni(dni);
  if (!clave) return { error: "DNI invalido" };

  const indice = await indicePorDni();
  const fila = indice.get(clave);
  if (!fila) return { encontrada: false, dni: clave };

  const valores = await leerFilaPersonal(fila);
  return { encontrada: true, dni: clave, fila, valores, datos: leerFila(valores) };
}

/**
 * Todo el personal, o solo quienes coinciden con `filtro` ("vencidos_activos":
 * ESTADO_FINAL = VENCIDO y _EstaTE = ACTIVO), para el reporte de vencimientos.
 * Filtrar aca (antes de responder) evita mandar por red a las 600+ personas
 * de la hoja cuando la vista solo necesita a un puñado de ellas.
 */
async function accionListado({ filtro } = {}) {
  const normalizar = (valor) => String(valor ?? "").trim().toUpperCase();
  let filas = await leerTodoElPersonal();
  // Se filtra sobre la fila cruda, antes de `leerFila` (que arma los 18
  // riesgos de cada persona), igual que en apps-script/Code.gs: asi el trabajo
  // pesado se hace solo para quienes de verdad van a viajar en la respuesta.
  if (filtro === "vencidos_activos") {
    filas = filas.filter(
      (f) => normalizar(f[INDICE["ESTADO_FINAL"]]) === "VENCIDO" && normalizar(f[INDICE["_EstaTE"]]) === "ACTIVO"
    );
  }
  return { personas: filas.map((fila) => leerFila(fila)) };
}

async function accionGuardar({ fila, valores, noMapeados, datos }) {
  if (!fila || !Number.isFinite(Number(fila))) throw new Error("falta el numero de fila");
  if (!Array.isArray(valores)) throw new Error("falta el arreglo de valores");
  // las columnas editables de A:O (vencimiento del EMO, area) se validan y escriben primero
  await escribirDatosPersonales(Number(fila), datos);
  await escribirFilaPersonal(Number(fila), valores);
  if (noMapeados?.length) {
    // no debe tumbar el guardado: es solo un registro para revisar despues
    try {
      await registrarNoMapeados(noMapeados);
    } catch {
      /* la hoja CURSO_RRCC puede no existir todavia */
    }
  }
  return { ok: true, fila: Number(fila) };
}

async function accionAlta({ valores }) {
  if (!Array.isArray(valores)) throw new Error("falta el arreglo de valores");
  const completa = completar(valores);

  const dni = normalizarClaveDni(completa[INDICE["DNI"]]);
  if (!dni) throw new Error("la persona nueva no trae DNI");
  const indice = await indicePorDni();
  if (indice.has(dni)) {
    return { ok: false, yaExiste: true, fila: indice.get(dni), error: `el DNI ${dni} ya esta en ${HOJAS.personal}` };
  }

  if (!String(completa[INDICE["Codigo"]] || "").trim()) {
    completa[INDICE["Codigo"]] = await siguienteCodigo();
  }
  if (!String(completa[INDICE["Item"]] || "").trim()) {
    completa[INDICE["Item"]] = indice.size + 1;
  }

  const fila = await agregarPersona(completa);
  return { ok: true, fila, codigo: completa[INDICE["Codigo"]], valores: completa };
}

/** Siguiente correlativo AE###, mirando el mayor que ya existe. */
async function siguienteCodigo() {
  const col = letraColumna(INDICE["Codigo"]);
  const valores = await leerRango(`'${HOJAS.personal}'!${col}${filaDatos()}:${col}`);
  const prefijo = process.env.PREFIJO_CODIGO || "AE";
  let mayor = 0;
  for (const f of valores) {
    const m = new RegExp("^" + prefijo + "(\\d+)$", "i").exec(String(f?.[0] ?? "").trim());
    if (m) mayor = Math.max(mayor, Number(m[1]));
  }
  return prefijo + String(mayor + 1).padStart(3, "0");
}

async function accionCargos() {
  const colCargo = letraColumna(INDICE["Cargo Planilla"]);
  const colArea = letraColumna(INDICE["Area Planilla"]);
  const desde = filaDatos();
  const [cargos, areas] = await leerRangos([
    `'${HOJAS.personal}'!${colCargo}${desde}:${colCargo}`,
    `'${HOJAS.personal}'!${colArea}${desde}:${colArea}`,
  ]);
  const distintos = (filas) =>
    [...new Set(filas.map((f) => String(f?.[0] ?? "").trim()).filter(Boolean))].sort();
  return { cargos: distintos(cargos), areas: distintos(areas) };
}

/**
 * Deja el Spreadsheet listo para la app SIN tocar la hoja de personal.
 *
 * `BD AESA` ya existe y es la fuente de verdad: la app se engancha a ella,
 * no la reestructura. Lo unico que puede cambiarle es agregar al final las
 * columnas que necesita (CARPETA_DRIVE_ID, ACTUALIZADO...), y eso no afecta
 * a los BUSCARV de la hoja FOTOCHEK, que trabajan sobre C:CO.
 */
async function accionSetup() {
  const { creadas, faltaPersonal } = await crearHojasFaltantes();
  const hecho = [];
  const avisos = [];

  if (faltaPersonal) {
    avisos.push(`el Spreadsheet no tiene la hoja "${HOJAS.personal}": revisa SHEET_ID o SHEET_HOJA_PERSONAL`);
  } else {
    const agregadas = await asegurarColumnas();
    if (agregadas) hecho.push(`${HOJAS.personal}: ${agregadas} columna(s) agregadas al final`);
  }

  const [cursos, matriz, config] = await leerRangos([
    `${HOJAS.cursos}!A1:A1`,
    `${HOJAS.matriz}!A1:A1`,
    `${HOJAS.config}!A1:A1`,
  ]);

  if (!cursos.length) {
    const filas = semillaCursos();
    await escribirRango(`${HOJAS.cursos}!A1`, filas);
    hecho.push(`${HOJAS.cursos}: ${filas.length - 1} alias sembrados`);
  }
  if (!matriz.length) {
    await escribirRango(`${HOJAS.matriz}!A1`, [CABECERA_MATRIZ]);
    hecho.push(`${HOJAS.matriz}: cabecera (pendiente cargar la matriz real)`);
  }
  if (!config.length) {
    await escribirRango(`${HOJAS.config}!A1`, CONFIG_POR_DEFECTO);
    hecho.push(`${HOJAS.config}: ${CONFIG_POR_DEFECTO.length - 1} parametros por defecto`);
  }

  const revision = faltaPersonal ? null : await comprobarCabecera();
  return { ok: true, creadas, hecho, avisos, revision };
}

/** Contrasta la cabecera real con la que el codigo da por sentada. */
async function accionComprobar() {
  const hojas = await hojasExistentes();
  const personal = await resolverHojaPersonal();
  const revision = hojas.includes(personal) ? await comprobarCabecera() : null;
  return {
    ok: Boolean(revision) && !revision.grave,
    spreadsheet: process.env.SHEET_ID,
    hojaPersonal: personal,
    hojas,
    faltan: Object.values(HOJAS).filter((h) => !hojas.includes(h)),
    revision,
  };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

const ACCIONES = {
  contexto: accionContexto,
  persona: accionPersona,
  listado: accionListado,
  guardar: accionGuardar,
  alta: accionAlta,
  cargos: accionCargos,
  comprobar: accionComprobar,
  setup: accionSetup,
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const accion = String(body.accion || "").trim();
    const fn = ACCIONES[accion];
    if (!fn) {
      res.status(400).json({ error: `accion desconocida: "${accion}"`, disponibles: Object.keys(ACCIONES) });
      return;
    }

    // Apps Script usa la identidad del propietario del Spreadsheet/Drive;
    // asi este servidor no necesita GOOGLE_SA_EMAIL ni una clave privada.
    if (appsScriptUrl()) {
      res.status(200).json(await pedirAppsScript("sheets", body));
      return;
    }

    if (!hayCuentaDeServicio()) {
      res.status(503).json({
        error: "la base en Google Sheets no esta configurada",
        faltan: ["APPS_SCRIPT_URL (recomendado) o GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY"],
      });
      return;
    }

    // Sin SHEET_ID se busca el Spreadsheet dentro de la carpeta RRCC. Es una
    // red de seguridad para el id copiado a mano: en un id de Drive la "l" y
    // la "I" se dibujan igual y el error resultante parece de permisos.
    if (!hayHoja()) {
      const encontrado = carpetaRaiz() ? await buscarSpreadsheet() : null;
      if (!encontrado) {
        res.status(503).json({
          error: "no se encontro el Spreadsheet de la base",
          faltan: ["SHEET_ID", carpetaRaiz() ? null : "DRIVE_RRCC_FOLDER_ID"].filter(Boolean),
        });
        return;
      }
      process.env.SHEET_ID = encontrado.id;
    }

    const salida = await fn(body);
    res.status(200).json(salida);
  } catch (e) {
    // `reintentable`: Google entrego una pagina rota, el "hello" de doGet o
    // nada a tiempo. La accion pudo haber corrido igual; el navegador decide
    // si repetirla segun sea de lectura o idempotente.
    res.status(502).json({ error: e?.message || String(e), reintentable: Boolean(e?.ambiguo) });
  }
}
