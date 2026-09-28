/**
 * POST /api/drive-output
 * Body: { accion, ... }
 *
 * Salidas a Google Drive: la carpeta de cada persona, sus certificados
 * vigentes, el Word de autorizacion y las fotos.
 *
 *   carpeta  ->  { nombre } crea (o reutiliza) la subcarpeta de la persona
 *   carpetas ->  comprueba que DATA y FOTOS existan y sean accesibles
 *   subir    ->  { carpetaId, nombre, mime, datos } un archivo (base64)
 *   subir-lote -> { carpetaId, archivos: [{ nombre, mime, datos }] } varios
 *               archivos en una sola llamada (cada una a Apps Script cuesta
 *               varios segundos fijos, asi que agruparlas es lo que mas rinde)
 *   foto     ->  sube una foto a la carpeta FOTOS
 *   foto-de  ->  { dni, soloPublica } baja la foto de esa persona, buscandola
 *               por nombre. Con `soloPublica` no cae a Apps Script si la
 *               lectura publica no la encuentra: responde `{ respaldo: true }`
 *               y el navegador decide cuando hacer esa consulta mas lenta.
 *   bajar    ->  { id } el contenido de un archivo, en base64
 *   listar   ->  { carpetaId } que quedo dentro
 *   eliminar ->  { carpetaId, nombres } manda esos archivos a la papelera
 *
 * Un archivo por llamada, igual que /api/download: la funcion tiene 60 s y
 * 4.5 MB por peticion, asi que quien va encadenando es el navegador.
 */

import {
  carpetaPara,
  subirArchivo,
  bajarArchivo,
  infoArchivo,
  listarCarpeta,
  eliminarDeCarpeta,
  buscarFoto,
  carpetaSalidas,
  carpetaFotos,
  carpetaRaiz,
} from "./_lib/drive-escritura.js";
import { hayCuentaDeServicio } from "./_lib/google.js";
import { appsScriptUrl, pedirAppsScript } from "./_lib/apps-script.js";
import { driveFotoBuscar } from "./_lib/drive.js";

/** Tope defensivo: Vercel corta el cuerpo en 4.5 MB de todos modos. */
const MAX_BYTES = 4 * 1024 * 1024;

function limpiarNombre(texto, max = 120) {
  return (
    String(texto ?? "")
      .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^\.+|\.+$/g, "")
      .slice(0, max)
      .trim() || "SIN_NOMBRE"
  );
}

function decodificar(datos) {
  if (!datos) throw new Error("falta el contenido del archivo (base64)");
  const limpio = String(datos).replace(/^data:[^;]+;base64,/, "");
  const buffer = Buffer.from(limpio, "base64");
  if (!buffer.length) throw new Error("el contenido llego vacio");
  if (buffer.length > MAX_BYTES) throw new Error(`el archivo pesa ${(buffer.length / 1048576).toFixed(1)} MB (maximo 4 MB)`);
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Acciones                                                            */
/* ------------------------------------------------------------------ */

async function accionCarpeta({ nombre, padre, dni, vaciar }) {
  const limpio = limpiarNombre(nombre);
  const r = await carpetaPara(limpio, padre || (await carpetaSalidas()), dni);
  const salida = { ok: true, carpetaId: r.id, nombre: r.nombre, creada: r.creada, renombrada: r.renombrada || "" };
  if (vaciar) {
    // todo lo que habia va a la papelera, en el mismo pedido
    const archivos = r.creada ? [] : await listarCarpeta(r.id);
    const nombres = [...new Set(archivos.filter((a) => a.mimeType !== "application/vnd.google-apps.folder").map((a) => a.name))];
    salida.eliminados = nombres.length ? (await eliminarDeCarpeta(r.id, nombres)).length : 0;
    salida.vaciada = true;
  }
  return salida;
}

/** Comprueba que las carpetas de trabajo existan y sean accesibles. */
async function accionCarpetas() {
  const [salidas, fotos] = await Promise.all([carpetaSalidas(), carpetaFotos()]);
  return {
    ok: Boolean(salidas && fotos),
    raiz: carpetaRaiz(),
    salidas,
    fotos,
    faltan: [!salidas ? "carpeta de salidas (DATA)" : null, !fotos ? "carpeta de fotos (FOTOS)" : null].filter(
      Boolean
    ),
  };
}

/**
 * Foto de una persona por su documento, sin depender de lo que diga la
 * columna FOTO: se busca por nombre en la carpeta FOTOS.
 */
async function accionFotoDe({ dni }) {
  const archivo = await buscarFoto(dni);
  if (!archivo) return { ok: false, encontrada: false, dni };
  const buffer = await bajarArchivo(archivo.id);
  return {
    ok: true,
    encontrada: true,
    id: archivo.id,
    nombre: archivo.name,
    mime: archivo.mimeType || "image/png",
    datos: buffer.toString("base64"),
  };
}

async function accionSubir({ carpetaId, nombre, mime, datos, reemplazar }) {
  if (!carpetaId) throw new Error("falta carpetaId");
  const r = await subirArchivo({
    nombre: limpiarNombre(nombre),
    mime,
    datos: decodificar(datos),
    carpetaId,
    reemplazar: reemplazar !== false,
  });
  return { ok: true, ...r };
}

/** Tope por lote: el cuerpo en base64 tiene que caber en los 4.5 MB de Vercel. */
const MAX_LOTE = 3 * 1024 * 1024;

async function accionSubirLote({ carpetaId, archivos }) {
  if (!carpetaId) throw new Error("falta carpetaId");
  if (!Array.isArray(archivos) || !archivos.length) throw new Error("falta la lista de archivos");
  const total = archivos.reduce((s, a) => s + String(a?.datos || "").length, 0);
  if (total > MAX_LOTE * 1.4) throw new Error("el lote es demasiado grande: subelo en partes");
  const subidos = [];
  for (const a of archivos) subidos.push(await accionSubir({ carpetaId, ...a }));
  return { ok: true, archivos: subidos };
}

async function accionFoto({ nombre, mime, datos, carpetaId }) {
  const destino = carpetaId || (await carpetaFotos());
  if (!destino) throw new Error("no se encontro la carpeta FOTOS en Drive");
  return accionSubir({ carpetaId: destino, nombre, mime, datos });
}

async function accionBajar({ id }) {
  const info = await infoArchivo(id);
  const buffer = await bajarArchivo(id);
  if (buffer.length > MAX_BYTES) {
    throw new Error(`"${info?.name || id}" pesa ${(buffer.length / 1048576).toFixed(1)} MB y no cabe en una respuesta`);
  }
  return {
    ok: true,
    id,
    nombre: info?.name || "",
    mime: info?.mimeType || "application/octet-stream",
    datos: buffer.toString("base64"),
  };
}

async function accionListar({ carpetaId }) {
  if (!carpetaId) throw new Error("falta carpetaId");
  return { ok: true, archivos: await listarCarpeta(carpetaId) };
}

/** Manda a la papelera los archivos con esos nombres (certificados quitados con la "x"). */
async function accionEliminar({ carpetaId, nombres }) {
  if (!carpetaId) throw new Error("falta carpetaId");
  if (!Array.isArray(nombres) || !nombres.length) throw new Error("falta la lista de nombres");
  return { ok: true, eliminados: await eliminarDeCarpeta(carpetaId, nombres.map((n) => limpiarNombre(n))) };
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

const ACCIONES = {
  carpeta: accionCarpeta,
  carpetas: accionCarpetas,
  subir: accionSubir,
  "subir-lote": accionSubirLote,
  foto: accionFoto,
  "foto-de": accionFotoDe,
  bajar: accionBajar,
  listar: accionListar,
  eliminar: accionEliminar,
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

    if (appsScriptUrl()) {
      // La lectura de FOTOS es publica y se resuelve directo por nombre. Asi
      // evitamos que Apps Script recorra toda la carpeta y agote su tiempo.
      if (accion === "foto-de") {
        const archivo = await driveFotoBuscar(body.dni);
        if (archivo) {
          res.status(200).json({
            ok: true,
            encontrada: true,
            id: archivo.id,
            nombre: archivo.name,
            mime: archivo.mimeType || "image/png",
            datos: archivo.datos.toString("base64"),
          });
          return;
        }
        if (body.soloPublica) {
          res.status(200).json({ ok: false, encontrada: false, respaldo: true, dni: body.dni });
          return;
        }
      }
      res.status(200).json(await pedirAppsScript("drive", body));
      return;
    }

    if (!hayCuentaDeServicio()) {
      res.status(503).json({
        error: "Drive de escritura no esta configurado",
        faltan: ["APPS_SCRIPT_URL (recomendado) o GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY"],
      });
      return;
    }

    res.status(200).json(await fn(body));
  } catch (e) {
    // `reintentable`: Google entrego una pagina rota, el "hello" de doGet o
    // nada a tiempo. La accion pudo haber corrido igual; el navegador decide
    // si repetirla segun sea de lectura o idempotente.
    res.status(502).json({ error: e?.message || String(e), reintentable: Boolean(e?.ambiguo) });
  }
}
