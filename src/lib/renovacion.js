/**
 * Motor de renovacion de la Autorizacion de Riesgos Criticos.
 *
 * Quien orquesta es el navegador, igual que en el extractor de certificados:
 * cada funcion serverless hace UNA operacion corta y vuelve. Con los 60 s de
 * Vercel Hobby no hay otra forma de procesar a una persona con 18 cursos, y
 * ademas permite ir pintando el avance en pantalla.
 *
 * Por persona:
 *   1. leer su fila de `BD AESA`           -> /api/sheets  (persona)
 *   2. inventariar sus certificados        -> /api/search
 *   3. recalcular fechas, estados y "A"    -> estados.js (aca, sin red)
 *   4. escribir la fila de vuelta          -> /api/sheets  (guardar)
 *   5. armar la carpeta de salida en Drive -> /api/download + /api/drive-output
 */

import { buscar, descargar, sheets, drive, driveDirecto, aBase64, desdeBase64, blobABase64 } from "./api.js";
import { obtenerContexto, obtenerPersonal, obtenerPersona, anotarPersona } from "./datos.js";
import { renovarFila, copiarFila, leerFila, filaNueva, tiposDeMatriz, diferenciasFila } from "../../shared/estados.js";
import { fotocheckPng } from "./fotocheck.js";
import { armarAutorizacion, medirImagen } from "./docx.js";

export const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/* ------------------------------------------------------------------ */
/* Contexto (se carga una vez por corrida)                             */
/* ------------------------------------------------------------------ */

/**
 * CONFIG + diccionario de cursos + matriz por puesto, en una sola llamada.
 * Lo sirve `datos.js`: la primera pestana que lo pida lo trae y el resto lo
 * reutiliza sin volver a preguntarle a la hoja.
 */
export function cargarContexto() {
  return obtenerContexto();
}

/**
 * Todo el personal de `BD AESA`, para el reporte de vencimientos por RRCC.
 * Una sola llamada trae a todo el mundo en vez de consultar persona por
 * persona; cada elemento ya viene con la forma de `leerFila`.
 *
 * `filtro: "vencidos_activos"` le pide al backend que filtre ANTES de
 * serializar: para "estado total" es la diferencia entre bajar a las 600+
 * personas de la hoja (1.5+ MB, lo mas lento de la app) o solo a las pocas
 * decenas que estan vencidas y activas. Un backend viejo que no reconozca el
 * filtro simplemente lo ignora y sigue devolviendo a todo el mundo: por eso
 * quien llama debe seguir filtrando del lado del navegador igual.
 *
 * Lo sirve `datos.js`, que ademas lo comparte entre pestanas: si ESTADO RRCC
 * ya bajo el listado completo, el filtrado que necesita ESTADO TOTAL sale de
 * ahi sin tocar la red.
 */
export function listarPersonal(senal, filtro) {
  return obtenerPersonal({ filtro });
}

/**
 * Nombre de la carpeta de la persona. La plantilla vive en CONFIG para no
 * tener que tocar codigo si manana la quieren con el DNI delante.
 */
export function nombreCarpeta(persona, config = {}) {
  const plantilla = config.PLANTILLA_CARPETA || "{DNI}_{APELLIDOS} {NOMBRES}";
  return plantilla
    .replace(/\{APELLIDOS\}/gi, persona.apellidos || "")
    .replace(/\{NOMBRES\}/gi, persona.nombres || "")
    .replace(/\{NOMBRE\}/gi, persona.nombreCompleto || "")
    .replace(/\{DNI\}/gi, persona.dni || "")
    .replace(/\{CODIGO\}/gi, persona.codigo || "")
    .replace(/\s+/g, " ")
    .trim();
}

const nombreCertificado = (item) =>
  [item.fecha, item.curso].filter(Boolean).join("_").replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";

/* ------------------------------------------------------------------ */
/* Paso 1-4: recalcular y guardar la fila                              */
/* ------------------------------------------------------------------ */

/**
 * Renueva a una persona y deja su fila escrita en la hoja.
 * Devuelve { estado: "ok" | "nuevo" | "error", ... }.
 */
export async function renovarPersona(
  dni,
  ctx,
  { log = () => {}, senal, escribir = true, alLeer = null, inventario: adelantado = null } = {}
) {
  log(`buscando ${dni} en la base y sus certificados (JOMISER + EIN + Drive)...`);
  // el inventario solo necesita el DNI: se pide YA, en paralelo con la fila.
  // La fila va por la cola de Apps Script y el inventario no, asi que ninguno
  // espera al otro. Si la persona no esta en la base, el inventario se
  // descarta (y su rechazo se silencia para no quedar como error suelto).
  // En un lote, quien llama puede haberlo pedido antes (`inventario`, una
  // promesa) mientras se procesaba a la persona anterior.
  const inventarioP = adelantado || buscar({ dni }, senal);
  inventarioP.catch(() => {});

  // lo que va a escribir lee SIEMPRE de la hoja: recalcular sobre una copia
  // cacheada pisaria lo que otro haya editado desde que se guardo esa copia.
  const registro = await obtenerPersona(dni, { refrescar: escribir, senal });

  if (!registro.encontrada) {
    log(`${dni} no esta en la base: hay que darlo de alta como personal nuevo`, "warn");
    return { estado: "nuevo", dni };
  }

  const antes = leerFila(registro.valores);
  log(`${antes.nombreCompleto || dni} · fila ${registro.fila}`, "ok");
  // quien llama puede adelantar lo que depende de la fila (el fotocheck
  // antiguo) mientras el inventario sigue en camino
  try {
    alLeer?.(antes);
  } catch {
    /* un aviso que falla no frena la renovacion */
  }

  const inventario = await inventarioP;
  for (const aviso of inventario.avisos || []) log(`  ${aviso}`, "warn");

  const resultado = renovarFila({
    fila: registro.valores,
    items: inventario.items || [],
    diccionario: ctx.diccionario,
    config: ctx.config,
  });

  const cambiados = resultado.detalle.filter((d) => d.cambio === "NUEVO" || d.cambio === "ACTUALIZADO");
  log(`${cambiados.length} riesgo(s) con certificado nuevo`, cambiados.length ? "ok" : "info");
  for (const a of resultado.alertas) log(`  ${a.codigo ? a.codigo + ": " : ""}${a.motivo}`, a.nivel === "error" ? "err" : "warn");

  if (escribir) {
    await sheets(
      { accion: "guardar", fila: registro.fila, valores: resultado.fila, noMapeados: resultado.noMapeados },
      senal
    );
    // el resto de las pestanas repinta sola con esta fila: no hay que recargar
    anotarPersona({ dni, fila: registro.fila, valores: resultado.fila });
    log("fila actualizada en la hoja", "ok");
  }

  return {
    estado: "ok",
    dni,
    fila: registro.fila,
    antes,
    despues: leerFila(resultado.fila),
    valores: resultado.fila,
    // la fila tal como queda en la hoja: la recalculada si se escribio, la
    // original si fue solo consulta. Es la base de las ediciones manuales.
    enHoja: escribir ? resultado.fila : copiarFila(registro.valores),
    detalle: resultado.detalle,
    alertas: resultado.alertas,
    personales: resultado.personales,
    inventario,
  };
}

/* ------------------------------------------------------------------ */
/* Guardar una fila y comprobar que la hoja la tiene                   */
/* ------------------------------------------------------------------ */

/**
 * Guarda la fila y la RELEE de la hoja para confirmar que quedo como se pidio.
 *
 * Hace falta porque Apps Script a veces ejecuta el guardado pero entrega una
 * respuesta rota (pagina 404 de Drive) cuando se demora: sin la relectura, la
 * app diria "no se pudo guardar" con el cambio ya en la hoja. Si el guardado
 * falla pero la relectura muestra la fila como se pidio, cuenta como guardado
 * (`recuperado`). Si falla y la hoja no coincide, se lanza el error original.
 *
 * `codigos` = los riesgos que se quiere comprobar; `datos` = columnas de A:O
 * a corregir ({ "F. Vencimiento": "2026-10-03", "Area Planilla": "MINA" }), que
 * tambien se comprueban. Devuelve { fila, valores
 * (la fila tal como esta en la hoja), diferencias, confirmado, recuperado }.
 */
export async function guardarFilaVerificada({ fila, valores, dni, codigos, datos = {}, noMapeados = [], senal }) {
  let errorGuardado = null;
  let respuesta = null;
  try {
    respuesta = await sheets({ accion: "guardar", fila, valores, datos, noMapeados }, senal);
  } catch (e) {
    if (senal?.aborted) throw e;
    errorGuardado = e;
  }

  let leido = null;
  try {
    // `refrescar` obligatorio: la gracia de este paso es ver lo que quedo en
    // la hoja, no lo que la app creia que habia
    leido = await obtenerPersona(dni, { refrescar: true, senal });
  } catch (e) {
    if (errorGuardado) throw errorGuardado; // ni se pudo guardar ni comprobar
    throw new Error(`se guardo, pero no se pudo releer la hoja para confirmarlo: ${e.message}`);
  }
  if (!leido?.encontrada || Number(leido.fila) !== Number(fila)) {
    throw errorGuardado || new Error("no se pudo confirmar: la persona no esta en la fila esperada de la hoja");
  }

  const diferencias = diferenciasFila(valores, leido.valores, codigos, Object.keys(datos));
  if (errorGuardado && diferencias.length) throw errorGuardado; // no se guardo
  // lo releido es la version confirmada: con eso se parchea lo compartido y
  // las demas pestanas quedan al dia sin volver a bajar el listado
  anotarPersona({ dni, fila: leido.fila, valores: leido.valores });
  return {
    fila: Number(fila),
    valores: copiarFila(leido.valores),
    diferencias,
    confirmado: diferencias.length === 0,
    recuperado: Boolean(errorGuardado),
    formulaReemplazada: respuesta?.formulaReemplazada || [],
  };
}

/* ------------------------------------------------------------------ */
/* Consulta: ver a la persona y verificar sus "A" sin tocar nada       */
/* ------------------------------------------------------------------ */

/**
 * Resumen de las autorizaciones de una persona: cuantas "A" tiene, cuantas
 * siguen vigentes y cuales hay que renovar.
 *
 * Se calcula sobre el resultado YA recalculado con los certificados de
 * JOMISER, EIN y Drive, asi que "vigente" quiere decir que existe un
 * certificado que lo respalda hoy, no que la hoja lo diga.
 */
export function resumenAutorizaciones(detalle = []) {
  const autorizados = detalle.filter((d) => d.tipo === "A");
  const porEstado = (e) => autorizados.filter((d) => d.estado === e);
  return {
    total: autorizados.length,
    vigentes: porEstado("VIGENTE"),
    porVencer: porEstado("ACTUALIZAR"),
    vencidos: porEstado("VENCIDO"),
    sinCertificado: autorizados.filter((d) => d.estado === "NO APLICA"),
    capacitados: detalle.filter((d) => d.tipo === "C" && d.cap).length,
    conCertificadoNuevo: detalle.filter((d) => d.cambio === "NUEVO" || d.cambio === "ACTUALIZADO").length,
  };
}

/**
 * Adelanta el inventario de certificados de los siguientes de un lote.
 *
 * La busqueda (JOMISER + EIN + Drive) tarda varios segundos, solo necesita el
 * DNI y no pasa por la fila de Apps Script: pedirla para la persona que viene
 * mientras se lee, guarda y arma la carpeta de la actual saca esos segundos
 * del camino critico. Se adelantan pocas (`cuantas`) para no cargar de golpe
 * a JOMISER y EIN con todo el lote.
 *
 * Devuelve `tomar(i)`: la promesa del inventario del elemento `i` (la
 * adelantada si existe, o `null` para que `renovarPersona` la pida) y, de
 * paso, dispara la de los siguientes.
 */
export function adelantarInventarios(dnis, senal, cuantas = 2) {
  const pedidos = new Map();
  const pedir = (i) => {
    if (i >= dnis.length || pedidos.has(i) || senal?.aborted) return;
    const p = buscar({ dni: dnis[i] }, senal);
    p.catch(() => {}); // si falla, lo reporta `renovarPersona` al usarla
    pedidos.set(i, p);
  };
  return function tomar(i) {
    const propia = pedidos.get(i) || null;
    pedidos.delete(i);
    for (let j = i + 1; j <= i + cuantas; j++) pedir(j);
    return propia;
  };
}

/**
 * Consulta de solo lectura: trae los datos de la persona y verifica la
 * vigencia de sus autorizaciones contra JOMISER, EIN y Drive. No escribe en
 * la hoja ni crea nada en Drive.
 */
export async function consultarPersona(dni, ctx, opciones = {}) {
  const r = await renovarPersona(dni, ctx, { ...opciones, escribir: false });
  if (r.estado !== "ok") return r;
  return { ...r, consulta: true, resumen: resumenAutorizaciones(r.detalle) };
}

/* ------------------------------------------------------------------ */
/* Paso 5: la carpeta de salida en Drive                               */
/* ------------------------------------------------------------------ */

/** Descargas de certificados en simultaneo (no pasan por Apps Script). */
const DESCARGAS_SIMULTANEAS = 6;
/** Tope de bytes (ya en base64) por lote de subida: Vercel corta en 4.5 MB. */
const MAX_LOTE_BASE64 = 3 * 1024 * 1024;
/**
 * `subir-lote` necesita el Code.gs nuevo. Si el Web App publicado todavia es
 * el viejo responde "accion desconocida": desde ahi se sube de a uno y no se
 * vuelve a probar en toda la sesion.
 */
let loteDisponible = true;

/**
 * Cola de subida a una carpeta. Cada archivo que se agrega se sube en cuanto
 * la carpeta existe; mientras una tanda esta en el aire, lo que va llegando
 * se acumula y sale todo junto en la llamada siguiente. Asi las descargas no
 * esperan a las subidas, y las subidas pagan el costo fijo de Apps Script una
 * vez por tanda y no una vez por archivo.
 */
function colaDeSubida(carpetaP, senal) {
  const pendientes = [];
  let activo = false;

  async function subirTanda(carpetaId, tanda) {
    if (loteDisponible && tanda.length > 1) {
      try {
        const r = await drive(
          {
            accion: "subir-lote",
            carpetaId,
            archivos: tanda.map(({ nombre, mime, datos }) => ({ nombre, mime, datos })),
          },
          senal
        );
        if (Array.isArray(r.archivos) && r.archivos.length === tanda.length) {
          tanda.forEach((a, i) => a.listo(r.archivos[i]));
          return;
        }
      } catch (e) {
        if (senal?.aborted) throw e;
        if (/accion desconocida/i.test(e.message)) loteDisponible = false;
        // cualquier otra falla del lote: se reintenta de a uno, que ademas
        // deja el error pegado al archivo que de verdad fallo. `subir`
        // reemplaza por nombre, asi que repetir un archivo no lo duplica.
      }
    }
    for (const a of tanda) {
      try {
        a.listo(await drive({ accion: "subir", carpetaId, nombre: a.nombre, mime: a.mime, datos: a.datos }, senal));
      } catch (e) {
        a.fallo(e);
      }
    }
  }

  async function bombear() {
    activo = true;
    try {
      const { carpetaId } = await carpetaP;
      while (pendientes.length) {
        if (senal?.aborted) throw new DOMException("abortado", "AbortError");
        const tanda = [pendientes.shift()];
        let bytes = tanda[0].datos.length;
        while (pendientes.length && bytes + pendientes[0].datos.length <= MAX_LOTE_BASE64) {
          bytes += pendientes[0].datos.length;
          tanda.push(pendientes.shift());
        }
        try {
          await subirTanda(carpetaId, tanda);
        } catch (e) {
          tanda.forEach((a) => a.fallo(e));
        }
      }
    } catch (e) {
      // sin carpeta (o abortado) no se puede subir nada de lo que espera
      pendientes.splice(0).forEach((a) => a.fallo(e));
    } finally {
      activo = false;
    }
  }

  return function subir(archivo) {
    return new Promise((listo, fallo) => {
      pendientes.push({ ...archivo, listo, fallo });
      if (!activo) bombear();
    });
  };
}

/** Recorre `lista` con hasta `n` trabajos a la vez. */
async function enParalelo(lista, n, fn, senal) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (!senal?.aborted && i < lista.length) await fn(lista[i++]);
    })
  );
}

/**
 * Crea la carpeta de la persona en Drive y le deja dentro:
 *   - los certificados de los RRCC que quedaron VIGENTES,
 *   - el PNG del fotocheck nuevo,
 *   - el Word con el fotocheck nuevo (10 x 8 cm) y la foto del antiguo.
 *
 * Todo lo que no depende entre si corre a la vez: la carpeta se crea
 * mientras bajan los PDF, los PDF bajan de a varios, cada uno se encola para
 * subir apenas llega, y el fotocheck y el Word se arman en el navegador en
 * paralelo con todo eso.
 *
 * `material` = { foto, antiguo } ya pedidos por quien llama (valores o
 * promesas): la vista los adelanta para pintar el fotocheck antes de que
 * termine la descarga de certificados, y aca no se vuelven a pedir.
 */
export async function generarSalidas(
  resultado,
  ctx,
  { log = () => {}, senal, avance = () => {}, antiguoManual = null, material = null } = {}
) {
  const persona = resultado.despues;
  const nombre = nombreCarpeta(persona, ctx.config);

  log(`carpeta de Drive "${nombre}"...`);
  const carpetaP = drive({ accion: "carpeta", nombre }, senal);
  carpetaP.then(
    (c) => log(c.creada ? `carpeta creada` : `carpeta ya existia, se actualiza`, "ok"),
    () => {}
  );
  const subir = colaDeSubida(carpetaP, senal);

  const salida = { carpetaId: null, nombre, certificados: [], fotocheck: null, word: null, fallos: [] };

  /* --- foto y fotocheck antiguo: los adelantados, o se piden ahora --- */
  const fotoP = Promise.resolve(
    material && "foto" in material ? material.foto : fotoDeDni(persona.dni, senal)
  ).catch((e) => {
    log(`  sin foto de la persona: ${e.message}`, "warn");
    return null;
  });
  const antiguoP = antiguoManual
    ? Promise.resolve(antiguoManual)
    : Promise.resolve(
        material && "antiguo" in material ? material.antiguo : fotoAntigua(persona.fotocheckAntiguoDriveId, senal)
      ).catch((e) => {
        log(`  sin foto del fotocheck antiguo: ${e.message}`, "warn");
        return null;
      });

  /* --- fotocheck + Word (en el navegador, en paralelo con las descargas) --- */
  const documentosP = (async () => {
    const foto = await fotoP;
    const png = await fotocheckPng(persona, { foto });
    const [pngBase64, pngBytes] = await Promise.all([blobABase64(png.blob), png.blob.arrayBuffer()]);
    const fotocheckSubido = subir({
      nombre: `FOTOCHECK_${persona.nombreCompleto || persona.dni}.png`,
      mime: "image/png",
      datos: pngBase64,
    }).then((r) => {
      log(`fotocheck subido (${png.ancho}x${png.alto} px)`, "ok");
      return r;
    });
    fotocheckSubido.catch(() => {});

    const antiguo = await antiguoP;
    const docx = await armarAutorizacion({
      fotocheck: { datos: pngBytes, mime: "image/png" },
      antiguo,
      medidas: {
        fotocheckAnchoCm: Number(ctx.config.FOTOCHECK_ANCHO_CM || 10),
        fotocheckAltoCm: Number(ctx.config.FOTOCHECK_ALTO_CM || 8),
        antiguoAnchoCm: Number(ctx.config.ANTIGUO_ANCHO_CM || 17),
      },
    });
    const wordSubido = subir({
      nombre: `Autorizacion_RRCC_${persona.nombreCompleto || persona.dni}.docx`,
      mime: MIME_DOCX,
      datos: await blobABase64(docx),
    }).then((r) => {
      log(`Word de autorizacion subido`, "ok");
      return r;
    });

    // se devuelven las imagenes ya armadas para que la vista pueda abrir la
    // previsualizacion sin volver a pedirlas a Drive
    salida.blobs = { fotocheck: png.blob, word: docx };
    salida.foto = foto;
    salida.antiguo = antiguo;
    [salida.fotocheck, salida.word] = await Promise.all([fotocheckSubido, wordSubido]);
  })();
  documentosP.catch(() => {});

  /* --- certificados vigentes ---
   * Tanto "A" (autorizados) como "C" (capacitados) suben su PDF si esta
   * vigente y se puede descargar. Los de origen EIN quedan fuera de la
   * carpeta de salida a pedido del area.
   *
   * El PDF consolidado de Drive (en `personales`) no es de ningun curso, asi
   * que no entra en la grilla de riesgos, pero es un certificado de la
   * persona y va en su carpeta igual. La reinduccion (origen INDUCCION)
   * queda fuera a pedido del area. */
  const vigentes = resultado.detalle
    .filter(
      (d) => d.estado === "VIGENTE" && d.certificado && d.certificado.descargable && d.certificado.origen !== "EIN"
    )
    .map((d) => ({ codigo: d.codigo, etiqueta: d.codigo, cert: d.certificado, archivo: nombreCertificado(d.certificado) }));
  const extra = (resultado.personales || [])
    .filter((item) => item.descargable && item.origen !== "INDUCCION")
    .map((item) => ({
      codigo: "DRIVE",
      etiqueta: `[${item.origen}]`,
      cert: item,
      archivo: `${item.archivo ? item.archivo.replace(/\.pdf$/i, "") : item.curso}.pdf`.replace(/[\\/:*?"<>|]+/g, " "),
      personal: true,
    }));
  const tareas = [...vigentes, ...extra];
  log(`${vigentes.length} certificado(s) vigente(s) para subir${extra.length ? ` + ${extra.length} de Drive` : ""}`);

  let listos = 0;
  const subidas = [];
  const fallo = (t, e) => {
    if (senal?.aborted) return;
    salida.fallos.push({ codigo: t.codigo, error: e.message });
    log(`  · ${t.etiqueta}: ${e.message}`, "err");
  };
  await enParalelo(
    tareas,
    DESCARGAS_SIMULTANEAS,
    async (t) => {
      const { cert } = t;
      try {
        const r = await descargar({ id: cert.id, origen: cert.origen, ...(cert.datosDescarga || {}) }, senal);
        if (r.sinCertificado) {
          if (!t.personal) log(`  · ${t.codigo}: sin certificado emitido`, "warn");
          return;
        }
        const kb = (r.pdf.byteLength / 1024).toFixed(0);
        // no se espera la subida: la descarga siguiente arranca ya
        subidas.push(
          subir({ nombre: t.archivo, mime: "application/pdf", datos: aBase64(r.pdf) }).then(
            (subido) => {
              salida.certificados.push(subido);
              log(`  · ${t.etiqueta}: ${kb} KB → ${subido.nombre}`, "ok");
            },
            (e) => fallo(t, e)
          )
        );
      } catch (e) {
        fallo(t, e);
      } finally {
        avance(++listos, tareas.length, `${t.codigo} · ${cert.curso || t.archivo}`);
      }
    },
    senal
  );

  await Promise.all(subidas);
  // la carpeta es lo unico obligatorio: si no se pudo crear, ese es el error
  salida.carpetaId = (await carpetaP).carpetaId;
  await documentosP;
  return salida;
}

/**
 * Foto de la persona, buscada por documento en la carpeta FOTOS.
 *
 * No se usa la columna FOTO de la hoja porque guarda una ruta de texto
 * ("FOTOS/47259616.png"), no un id, y porque las fotos estan subidas con las
 * dos grafias del documento (con y sin el cero inicial). Buscar por DNI
 * normalizado resuelve las dos cosas de una vez.
 *
 * Primero la lectura publica, SIN hacer fila detras de Apps Script: asi la
 * foto llega mientras se leen la hoja y los certificados. Solo si ahi no
 * aparece se le pregunta a Apps Script (eso si respeta la fila).
 */
export async function fotoDeDni(dni, senal) {
  if (!dni) throw new Error("la fila no tiene DNI");
  let r = null;
  try {
    r = await driveDirecto({ accion: "foto-de", dni, soloPublica: true }, senal);
  } catch (e) {
    if (senal?.aborted) throw e;
  }
  if (!r || r.respaldo) r = await drive({ accion: "foto-de", dni }, senal);
  if (!r.encontrada) throw new Error(`no hay foto de ${dni} en la carpeta FOTOS`);
  return `data:${r.mime};base64,${r.datos}`;
}

/** Foto del fotocheck antiguo, con sus dimensiones (para no deformarla). */
export async function fotoAntigua(idDrive, senal) {
  if (!idDrive) throw new Error("la fila no tiene FOTOCHECK_ANTIGUO_DRIVE_ID");
  const r = await drive({ accion: "bajar", id: idDrive }, senal);
  const bytes = desdeBase64(r.datos);
  const medida = await medirImagen(new Blob([bytes], { type: r.mime }));
  return { datos: bytes, mime: r.mime, ancho: medida.ancho, alto: medida.alto };
}

/* ------------------------------------------------------------------ */
/* Alta de personal nuevo                                              */
/* ------------------------------------------------------------------ */

/**
 * Da de alta a una persona y despues le corre el mismo motor de renovacion,
 * para que sus fechas salgan de los certificados y no a mano.
 */
export async function altaPersona(datos, ctx, { log = () => {}, senal, tipos = null } = {}) {
  const porMatriz = tipos || tiposDeMatriz(ctx.matriz, datos.cargo, datos.area);
  const marcados = Object.keys(porMatriz).length;
  log(`matriz por puesto: ${marcados} riesgo(s) marcados para "${datos.cargo || "sin cargo"}"`, marcados ? "ok" : "warn");

  const fila = filaNueva({ datos, tipos: porMatriz });
  const alta = await sheets({ accion: "alta", valores: fila }, senal);
  if (!alta.ok) {
    if (alta.yaExiste) log(alta.error, "warn");
    return { estado: "existe", ...alta };
  }
  log(`alta creada con codigo ${alta.codigo} (fila ${alta.fila})`, "ok");
  // la persona nueva entra ya en el listado compartido: ESTADO RRCC y ESTADO
  // TOTAL la ven sin recargar, aunque la renovacion que sigue todavia no haya
  // terminado de ponerle fechas
  anotarPersona({ dni: datos.dni, fila: alta.fila, valores: alta.valores || fila });

  return renovarPersona(datos.dni, ctx, { log, senal });
}

/** Sube la foto de una persona a la carpeta de fotos y devuelve su id. */
export async function subirFoto(archivo, { nombre, senal } = {}) {
  const datos = await blobABase64(archivo);
  const r = await drive(
    { accion: "foto", nombre: nombre || archivo.name, mime: archivo.type || "image/jpeg", datos },
    senal
  );
  return r.id;
}
