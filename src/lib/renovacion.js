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
import {
  renovarFila,
  copiarFila,
  leerFila,
  filaNueva,
  tiposDeMatriz,
  diferenciasFila,
  normalizarDocumento,
  SIEMPRE_A,
  construirDiccionario,
  mapearCurso,
} from "../../shared/estados.js";
import { CODIGOS_RRCC } from "../../shared/rrcc.js";
import { fotocheckImagen, nombreFotocheck } from "./fotocheck.js";
import { armarAutorizacion, medidasWord, medirImagen } from "./docx.js";

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
 * Nombre de la carpeta de la persona: SOLO su DNI (8 digitos).
 *
 * Antes era "{DNI}_{APELLIDOS} {NOMBRES}" (PLANTILLA_CARPETA en CONFIG), y
 * bastaba con corregir una letra del nombre para que la siguiente renovacion
 * creara otra carpeta de la misma persona. El DNI no cambia. Las carpetas
 * viejas con nombre se reutilizan igual: el backend las busca por el DNI del
 * comienzo y las renombra (ver `carpeta` con `dni`). PLANTILLA_CARPETA ya no
 * se usa.
 */
export function nombreCarpeta(persona) {
  return normalizarDocumento(persona.dni) || String(persona.dni || "").trim();
}

const nombreCertificado = (item) =>
  [item.fecha, item.curso].filter(Boolean).join("_").replace(/[\\/:*?"<>|]+/g, " ").trim() + ".pdf";

/** Nombre con que se sube un PDF de Drive que no es de ningun RRCC (el consolidado de la persona). */
const nombrePersonal = (item) =>
  `${item.archivo ? item.archivo.replace(/\.pdf$/i, "") : item.curso}.pdf`.replace(/[\\/:*?"<>|]+/g, " ");

/** Identifica un certificado del inventario. En EIN el id es la posicion de la fila: por eso entra el DNI. */
export const claveCertificado = (cert) => [cert.origen, cert.id, cert.datosDescarga?.dni || ""].join("|");

/** Origenes del panel lateral de la ficha: van a la carpeta salvo que se quiten con la "x". */
export const ORIGENES_LATERALES = ["EIN", "INDUCCION"];

/** Nombre con que un certificado del panel lateral se guarda en la carpeta y en el ZIP. */
export const nombreEnCarpeta = (cert) => (cert.archivo ? nombrePersonal(cert) : nombreCertificado(cert));

/**
 * Nombres con que ese certificado puede haber quedado en la carpeta de la
 * persona (como certificado de un RRCC o como PDF suelto de Drive): la "x"
 * del panel lateral los manda a la papelera.
 */
export const nombresEnCarpeta = (cert) => [...new Set([nombreEnCarpeta(cert), nombreCertificado(cert), nombrePersonal(cert)])];

/* ------------------------------------------------------------------ */
/* Paso 1-4: recalcular y guardar la fila                              */
/* ------------------------------------------------------------------ */

/**
 * Renueva a una persona y deja su fila escrita en la hoja.
 * Devuelve { estado: "ok" | "nuevo" | "error", ... }.
 *
 * Si el guardado falla aun despues de reintentar, lanza un error que trae la
 * renovacion ya calculada en `error.resultado` (con `sinGuardar: true`), para
 * que un lote pueda seguir con esa persona y reintentar el guardado al final.
 * `reintentosGuardado`: un lote pasa 0 (no frena la lista: reintenta al final).
 */
export async function renovarPersona(
  dni,
  ctx,
  {
    log = () => {},
    senal,
    escribir = true,
    alLeer = null,
    alCalcular = null,
    inventario: adelantado = null,
    reintentosGuardado = REINTENTOS_GUARDADO,
  } = {}
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
  // antiguo, o pintar ya las fechas de la hoja) mientras el inventario sigue
  // en camino
  try {
    alLeer?.(antes, registro);
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

  const salida = {
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

  // El resultado ya esta calculado: quien llama puede pintarlo mientras la
  // escritura hace fila en Apps Script (unos segundos que antes se esperaban
  // con la pantalla vacia). Si el guardado falla, esta funcion lanza igual.
  try {
    alCalcular?.(salida);
  } catch {
    /* un aviso que falla no frena la renovacion */
  }

  if (escribir) {
    try {
      // Verificado: una respuesta rota de Google (la pagina 404, frecuente en
      // lotes de varios DNI) ya no tumba a la persona. Si la hoja ya lo tiene
      // cuenta como guardado; si no, se reintenta. Con la respuesta sana no se
      // relee, para no sumar otra llamada a Apps Script por persona.
      // el resto de las pestanas repinta sola con esta fila (anotarPersona)
      const guardado = await guardarFilaVerificada({
        fila: registro.fila,
        valores: resultado.fila,
        dni,
        codigos: CODIGOS_RRCC,
        noMapeados: resultado.noMapeados,
        senal,
        releer: "si-falla",
        reintentos: reintentosGuardado,
      });
      log(
        guardado.recuperado
          ? "fila actualizada en la hoja (Google respondió con error, pero el guardado quedó confirmado)"
          : "fila actualizada en la hoja",
        "ok"
      );
    } catch (e) {
      if (senal?.aborted) throw e;
      // La renovacion ya esta calculada y es valida: quien llama puede seguir
      // con ella (pintar la ficha, armar la carpeta) y reintentar el guardado
      // despues. `enHoja` vuelve a ser la fila original: la hoja no cambio.
      const error = new Error(`no se pudo guardar la fila en la hoja: ${e.message}`);
      error.causa = e;
      error.resultado = { ...salida, enHoja: copiarFila(registro.valores), sinGuardar: true };
      throw error;
    }
  }

  return salida;
}

/* ------------------------------------------------------------------ */
/* Guardar una fila y comprobar que la hoja la tiene                   */
/* ------------------------------------------------------------------ */

/** Reintentos extra de un guardado cuya respuesta llego rota (ademas de los del puente). */
const REINTENTOS_GUARDADO = 2;
/** Espera antes de reintentar un guardado (x numero de intento). */
const ESPERA_GUARDADO_MS = 4000;

/**
 * Solo se repite un guardado cuya ejecucion quedo en duda: la respuesta llego
 * rota o vacia (`reintentable`), o ni siquiera hubo respuesta (se corto la
 * red: el error no trae estado HTTP). Un error que Code.gs explico es real.
 */
const repetibleGuardado = (e) => Boolean(e?.reintentable) || (e?.estado === undefined && e?.name !== "AbortError");

function pausa(ms, senal) {
  return new Promise((listo, falla) => {
    if (senal?.aborted) return falla(new DOMException("abortado", "AbortError"));
    const t = setTimeout(listo, ms);
    senal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        falla(new DOMException("abortado", "AbortError"));
      },
      { once: true }
    );
  });
}

/**
 * Guarda la fila y la RELEE de la hoja para confirmar que quedo como se pidio.
 *
 * Hace falta porque Apps Script a veces ejecuta el guardado pero entrega una
 * respuesta rota (pagina 404 de Drive) cuando se demora: sin la relectura, la
 * app diria "no se pudo guardar" con el cambio ya en la hoja. Si el guardado
 * falla pero la relectura muestra la fila como se pidio, cuenta como guardado
 * (`recuperado`). Si falla y la hoja no coincide, se lanza el error original.
 *
 * Si la hoja tampoco lo tiene y la falla fue una respuesta rota (o no hubo
 * respuesta), el guardado se vuelve a mandar hasta `reintentos` veces, con
 * una espera creciente: guardar reescribe la misma fila y la `marca` es la
 * misma en todos los intentos, asi que repetirlo no duplica ni revierte nada.
 * Un error que Code.gs si explico (validacion, hoja inexistente) no se repite.
 *
 * `releer`: "siempre" (lo que confirma una edicion a mano) o "si-falla" (la
 * renovacion de un lote: con la respuesta sana basta, y releer costaria una
 * llamada mas a Apps Script por persona).
 *
 * `codigos` = los riesgos que se quiere comprobar; `datos` = columnas de A:O
 * a corregir ({ "F. Vencimiento": "2026-10-03", "Area Planilla": "MINA" }), que
 * tambien se comprueban. Devuelve { fila, valores
 * (la fila tal como esta en la hoja), diferencias, confirmado, recuperado, intentos }.
 */
export async function guardarFilaVerificada({
  fila,
  valores,
  dni,
  codigos,
  datos = {},
  noMapeados = [],
  senal,
  releer = "siempre",
  reintentos = REINTENTOS_GUARDADO,
  esperaMs = ESPERA_GUARDADO_MS,
}) {
  // `marca`: Code.gs descarta una escritura mas vieja que llegue despues de
  // esta (una ejecucion anterior que Google dejo corriendo tras una respuesta
  // rota), en vez de dejar que revierta lo que se guarda ahora. Es UNA para
  // todos los intentos: un reintento no es una escritura nueva.
  const marca = Date.now();
  const columnas = Object.keys(datos);

  for (let intento = 0; ; intento++) {
    let errorGuardado = null;
    let respuesta = null;
    try {
      // los cursos sin mapear solo van en el primer intento: si ese se
      // ejecuto aunque la respuesta llegara rota, repetirlos los duplicaria
      const pedido = { accion: "guardar", fila, valores, datos, noMapeados: intento ? [] : noMapeados, marca };
      respuesta = await sheets(pedido, senal);
    } catch (e) {
      if (senal?.aborted) throw e;
      errorGuardado = e;
    }

    if (!errorGuardado && releer === "si-falla") {
      anotarPersona({ dni, fila, valores });
      return {
        fila: Number(fila),
        valores: copiarFila(valores),
        diferencias: [],
        confirmado: true,
        recuperado: intento > 0,
        intentos: intento + 1,
        formulaReemplazada: respuesta?.formulaReemplazada || [],
      };
    }

    let leido = null;
    try {
      // `refrescar` obligatorio: la gracia de este paso es ver lo que quedo en
      // la hoja, no lo que la app creia que habia
      leido = await obtenerPersona(dni, { refrescar: true, senal });
    } catch (e) {
      if (senal?.aborted) throw e;
      if (!errorGuardado) throw new Error(`se guardo, pero no se pudo releer la hoja para confirmarlo: ${e.message}`);
      // ni se pudo guardar ni comprobar: se reintenta el guardado (abajo)
    }

    if (leido) {
      if (!leido.encontrada || Number(leido.fila) !== Number(fila)) {
        throw errorGuardado || new Error("no se pudo confirmar: la persona no esta en la fila esperada de la hoja");
      }
      const diferencias = diferenciasFila(valores, leido.valores, codigos, columnas);
      if (!errorGuardado || !diferencias.length) {
        // lo releido es la version confirmada: con eso se parchea lo compartido
        // y las demas pestanas quedan al dia sin volver a bajar el listado
        anotarPersona({ dni, fila: leido.fila, valores: leido.valores });
        return {
          fila: Number(fila),
          valores: copiarFila(leido.valores),
          diferencias,
          confirmado: diferencias.length === 0,
          recuperado: Boolean(errorGuardado) || intento > 0,
          intentos: intento + 1,
          formulaReemplazada: respuesta?.formulaReemplazada || [],
        };
      }
    }

    // no se guardo (o no se pudo comprobar)
    if (!repetibleGuardado(errorGuardado) || intento >= reintentos) throw errorGuardado;
    await pausa(esperaMs * (intento + 1), senal);
  }
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

/**
 * Certificados ya bajados (o bajandose), por fuente + id + DNI. Abrir un PDF
 * en el visor y armar la carpeta piden los mismos archivos: el segundo pedido
 * sale de aca al instante, o espera al que ya esta en camino. Un fallo no
 * queda guardado. Se guardan los ultimos `MAX_CERTS_EN_MEMORIA`.
 *
 * En EIN el id es la posicion de la fila en la grilla (0, 1, 2...): por eso
 * el DNI entra en la clave.
 */
const certsEnMemoria = new Map();
const MAX_CERTS_EN_MEMORIA = 80;

export function descargarCertificado(cert, senal) {
  const clave = claveCertificado(cert);
  const guardado = certsEnMemoria.get(clave);
  if (guardado) return guardado;
  // sin senal: un pedido compartido no se cancela porque uno de los dos se vaya
  const p = descargar({ id: cert.id, origen: cert.origen, ...(cert.datosDescarga || {}) });
  certsEnMemoria.set(clave, p);
  p.catch(() => certsEnMemoria.delete(clave));
  while (certsEnMemoria.size > MAX_CERTS_EN_MEMORIA) certsEnMemoria.delete(certsEnMemoria.keys().next().value);
  if (!senal) return p;
  return new Promise((listo, falla) => {
    if (senal.aborted) return falla(new DOMException("abortado", "AbortError"));
    senal.addEventListener("abort", () => falla(new DOMException("abortado", "AbortError")), { once: true });
    p.then(listo, falla);
  });
}

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
 *
 * `juntarP`: la primera tanda espera ademas a esta promesa (en la carpeta de
 * una persona, a que esten todos los archivos), para no gastar una llamada en
 * el primer certificado que llega solo. `fondo`: carril de la cola de Apps
 * Script (ver `drive`).
 */
function colaDeSubida(carpetaP, senal, { juntarP = null, fondo = false } = {}) {
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
          senal,
          { fondo }
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
        a.listo(await drive({ accion: "subir", carpetaId, nombre: a.nombre, mime: a.mime, datos: a.datos }, senal, { fondo }));
      } catch (e) {
        a.fallo(e);
      }
    }
  }

  async function bombear() {
    activo = true;
    try {
      const { carpetaId } = await carpetaP;
      if (juntarP) await juntarP;
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

/**
 * Sube varios archivos a una carpeta en la menor cantidad de llamadas (un
 * `subir-lote` mientras quepan). Devuelve lo subido, en el mismo orden.
 */
export function subirArchivos(carpetaId, archivos, senal, opciones = {}) {
  const subir = colaDeSubida(Promise.resolve({ carpetaId }), senal, opciones);
  return Promise.all(archivos.map((a) => subir(a)));
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
 * Un RRCC lleva su certificado a la carpeta mientras siga en vigor: VIGENTE
 * o POR VENCER (ACTUALIZAR). Un "por vencer" sigue respaldado por ese PDF
 * hasta su vencimiento, y es justo lo que se renueva: dejarlo fuera vaciaba
 * el ZIP de quien tiene casi todo por vencer (p. ej. los certificados de
 * respaldo de Drive del ultimo anio). VENCIDO o sin fecha no entra.
 */
const ESTADOS_EN_CARPETA = ["VIGENTE", "ACTUALIZAR"];

/**
 * El certificado de cada RRCC de la grilla que se puede descargar, con el
 * nombre que lleva en la carpeta y si le toca ir (`entra`).
 *
 * Solo van los de los RRCC AUTORIZADOS ("A"): la carpeta respalda la
 * autorizacion, y un capacitado ("C") o un RRCC sin tipo no se autoriza con
 * ella. Ademas tiene que seguir en vigor (`ESTADOS_EN_CARPETA`). Los de EIN
 * van por el panel lateral, que no mira el estado (ver `certificadosDeCarpeta`),
 * asi que para ellos solo cuenta la "A".
 *
 * `detalle` debe traer el tipo que muestra la ficha (con lo editado a mano):
 * cambiar una "A" por "C" en la tarjeta la saca de la carpeta.
 */
export function certificadosDeRrcc(detalle = []) {
  return detalle
    .filter((d) => d.certificado?.descargable)
    .map((d) => {
      const cert = d.certificado;
      const ein = cert.origen === "EIN";
      const autorizado = String(d.tipo || "").trim().toUpperCase() === "A";
      return {
        codigo: d.codigo,
        cert,
        ein,
        archivo: ein ? nombreEnCarpeta(cert) : nombreCertificado(cert),
        entra: autorizado && (ein || ESTADOS_EN_CARPETA.includes(d.estado)),
      };
    });
}

/**
 * Que certificados van a la carpeta de la persona (y al ZIP), uno por
 * archivo y en el orden en que se bajan.
 *
 * De la grilla, solo los de los RRCC con "A" que siguen en vigor
 * (`certificadosDeRrcc`); los "C" y los sin tipo no van.
 *
 * El PDF consolidado de Drive (en `personales`) no es de ningun curso, asi
 * que no entra en la grilla de riesgos, pero es un certificado de la persona
 * y va en su carpeta igual.
 *
 * Los certificados de EIN y de INDUCCION (los del panel lateral de la ficha)
 * van a la carpeta, esten o no en la grilla, salvo el de EIN que es el de un
 * RRCC "C" o sin tipo: quien mas no deba ir se quita con la "x" de ese panel
 * (`excluidos`).
 */
export function certificadosDeCarpeta(resultado, excluidos = null) {
  const deRrcc = certificadosDeRrcc(resultado.detalle);
  const vigentes = deRrcc
    .filter((c) => c.entra && !c.ein)
    .map((c) => ({ codigo: c.codigo, etiqueta: c.codigo, cert: c.cert, archivo: c.archivo }));
  // el de EIN de un RRCC que no es "A" tampoco entra por el panel
  const deOtroTipo = new Set(deRrcc.filter((c) => c.ein && !c.entra).map((c) => claveCertificado(c.cert)));
  const extra = (resultado.personales || [])
    .filter((item) => item.descargable && item.origen !== "INDUCCION")
    .map((item) => ({
      codigo: "DRIVE",
      etiqueta: `[${item.origen}]`,
      cert: item,
      archivo: nombrePersonal(item),
      personal: true,
    }));
  const laterales = (resultado.inventario?.items || [])
    .filter(
      (item) => item.descargable && ORIGENES_LATERALES.includes(item.origen) && !deOtroTipo.has(claveCertificado(item))
    )
    .map((item) => ({
      codigo: item.origen,
      etiqueta: `[${item.origen}] ${item.curso || ""}`.trim(),
      cert: item,
      archivo: nombreEnCarpeta(item),
      personal: true,
    }));
  // uno por certificado (el mismo puede estar en la grilla y en el panel), y
  // los quitados con la "x" no se suben ni entran al ZIP
  const vistos = new Set();
  const tareas = [...vigentes, ...extra, ...laterales].filter((t) => {
    const clave = claveCertificado(t.cert);
    if (vistos.has(clave) || excluidos?.has(clave)) return false;
    vistos.add(clave);
    return true;
  });
  const deLaterales = tareas.filter((t) => laterales.includes(t)).length;
  return { tareas, vigentes, extra, deLaterales };
}

/**
 * Crea la carpeta de la persona en Drive y le deja dentro:
 *   - los certificados de los RRCC autorizados ("A") que siguen en vigor,
 *   - el PNG del fotocheck nuevo,
 *   - el Word con el fotocheck nuevo (10.9 x 8.6 cm) y la foto del antiguo.
 *
 * Todo lo que no depende entre si corre a la vez: la carpeta se crea
 * mientras bajan los PDF, los PDF bajan de a varios y el fotocheck y el Word
 * se arman en el navegador en paralelo con todo eso. Las subidas esperan a
 * que este TODO (certificados, fotocheck y Word) y salen juntas, en la menor
 * cantidad de llamadas a Apps Script: cada una cuesta segundos fijos, y en un
 * lote de varios DNI son las que saturan el Web App.
 *
 * `fondo`: todo lo que va a Apps Script (carpeta, foto, subidas) viaja por el
 * carril de fondo de la cola, para no quitarle el turno a las fichas de un
 * lote (ver `retenerFondo` en api.js).
 *
 * `excluidos` = claves (`claveCertificado`) de los certificados que se
 * quitaron con la "x": no se bajan ni se suben.
 *
 * `material` = { foto, antiguo } ya pedidos por quien llama (valores o
 * promesas): la vista los adelanta para pintar el fotocheck antes de que
 * termine la descarga de certificados, y aca no se vuelven a pedir.
 *
 * `carpeta` = lo que devolvio `vaciarCarpeta` al identificar a la persona:
 * la carpeta ya existe y esta vacia, asi que no se vuelve a pedir ni hay que
 * limpiarla al final. Si no vino (o el vaciado fallo), se crea aca y la
 * limpieza se hace al terminar, como antes.
 */
export async function generarSalidas(
  resultado,
  ctx,
  {
    log = () => {},
    senal,
    avance = () => {},
    avanceZip = () => {},
    alZipListo = null,
    antiguoManual = null,
    material = null,
    excluidos = null,
    carpeta = null,
    fondo = false,
  } = {}
) {
  const persona = resultado.despues;
  const nombre = nombreCarpeta(persona, ctx.config);

  const crear = () => {
    log(`carpeta de Drive "${nombre}"...`);
    const p = drive({ accion: "carpeta", nombre, dni: persona.dni }, senal, { fondo });
    p.then(
      (c) => log(textoCarpeta(c), "ok"),
      () => {}
    );
    return p;
  };
  // la vaciada al identificar a la persona sirve solo si es la misma carpeta
  // (si se corrigio el nombre en el camino, la carpeta es otra)
  const carpetaP = carpeta && carpeta.nombre === nombre ? carpeta.promesa.catch(crear) : crear();
  // la primera tanda sale cuando todo lo de la carpeta ya esta en memoria
  let soltarSubidas = () => {};
  const juntarP = new Promise((listo) => (soltarSubidas = listo));
  const subir = colaDeSubida(carpetaP, senal, { juntarP, fondo });

  const salida = { carpetaId: null, nombre, certificados: [], fotocheck: null, word: null, fallos: [], archivos: [] };

  /* Dos avances separados, porque terminan en momentos distintos:
       - ZIP (`avanceZip`): bajar cada certificado y armar el fotocheck y el
         Word. Al completarse, `alZipListo(salida)` avisa que el ZIP ya se
         puede descargar, aunque Drive siga subiendo.
       - DRIVE (`avance`): la carpeta, la subida de cada certificado y la del
         fotocheck y el Word.
     Los `total` se fijan mas abajo, antes de que termine cualquier operacion. */
  let total = 0;
  let hecho = 0;
  const paso = (que) => avance(Math.min(++hecho, total), total, que);
  let totalZip = 0;
  let hechoZip = 0;
  const pasoZip = (que) => avanceZip(Math.min(++hechoZip, totalZip), totalZip, que);
  carpetaP.then(
    () => paso("carpeta lista"),
    () => {}
  );

  /* --- foto y fotocheck antiguo: los adelantados, o se piden ahora --- */
  const fotoP = Promise.resolve(
    material && "foto" in material ? material.foto : fotoDeDni(persona.dni, senal, { fondo })
  ).catch((e) => {
    log(`  sin foto de la persona: ${e.message}`, "warn");
    return null;
  });
  const antiguoP = antiguoManual
    ? Promise.resolve(antiguoManual)
    : Promise.resolve(
        material && "antiguo" in material ? material.antiguo : fotoAntigua(persona.fotocheckAntiguoDriveId, senal, { fondo })
      ).catch((e) => {
        log(`  sin foto del fotocheck antiguo: ${e.message}`, "warn");
        return null;
      });

  /* --- fotocheck + Word (en el navegador, en paralelo con las descargas) --- */
  const nombreFoto = nombreFotocheck(persona);
  const nombreWord = `Autorizacion_RRCC_${persona.nombreCompleto || persona.dni}.docx`;
  // armar (parte del ZIP) y subir (parte de Drive) van separados: el ZIP no
  // espera a que el fotocheck y el Word terminen de subir
  let fotocheckSubido = null;
  let wordSubido = null;
  const armadoP = (async () => {
    const foto = await fotoP;
    const img = await fotocheckImagen(persona, { foto, conWord: true });
    const imgBase64 = await blobABase64(img.blob);
    const kb = (img.blob.size / 1024).toFixed(0);
    pasoZip("fotocheck listo");
    fotocheckSubido = subir({
      nombre: nombreFoto,
      mime: img.mime,
      datos: imgBase64,
    }).then((r) => {
      log(`fotocheck subido a Drive (${img.ancho}x${img.alto} px, ${kb} KB)`, "ok");
      paso("fotocheck subido");
      return r;
    });
    fotocheckSubido.catch(() => {});

    const antiguo = await antiguoP;
    const docx = await armarAutorizacion({
      fotocheck: img.word,
      antiguo,
      medidas: medidasWord(ctx.config),
    });
    pasoZip("Word listo");

    // se devuelven las imagenes ya armadas para que la vista pueda abrir la
    // previsualizacion sin volver a pedirlas a Drive
    salida.blobs = { fotocheck: img.blob, word: docx };
    salida.foto = foto;
    salida.antiguo = antiguo;

    // se encola aca y no despues: asi entra en la misma tanda que el resto
    wordSubido = subir({
      nombre: nombreWord,
      mime: MIME_DOCX,
      datos: await blobABase64(docx),
    }).then((r) => {
      log(`Word de autorizacion subido a Drive`, "ok");
      paso("Word subido");
      return r;
    });
    wordSubido.catch(() => {});
    return docx;
  })();
  armadoP.catch(() => {});

  const documentosP = armadoP.then(async () => {
    [salida.fotocheck, salida.word] = await Promise.all([fotocheckSubido, wordSubido]);
  });
  documentosP.catch(() => {});

  const { tareas, vigentes, extra, deLaterales } = certificadosDeCarpeta(resultado, excluidos);
  total = 1 + tareas.length + 2; // DRIVE: carpeta + cada certificado + fotocheck + Word
  totalZip = tareas.length + 2; // ZIP: cada certificado + fotocheck + Word
  log(
    `${vigentes.length} certificado(s) de RRCC "A" en vigor para subir` +
      (extra.length ? ` + ${extra.length} de Drive` : "") +
      (deLaterales ? ` + ${deLaterales} de EIN/inducción` : "")
  );

  const subidas = [];
  const fallo = (t, e) => {
    if (senal?.aborted) return;
    salida.fallos.push({ codigo: t.codigo, error: e.message });
    log(`  · ${t.etiqueta}: ${e.message}`, "err");
  };
  let bajados = 0;
  const descargasP = enParalelo(
    tareas,
    DESCARGAS_SIMULTANEAS,
    async (t) => {
      const { cert } = t;
      try {
        const r = await descargarCertificado(cert, senal);
        if (r.sinCertificado) {
          if (!t.personal) log(`  · ${t.codigo}: sin certificado emitido`, "warn");
          paso(`${t.codigo} · sin certificado`); // no hay nada que subir
          return;
        }
        const kb = (r.pdf.byteLength / 1024).toFixed(0);
        // queda en memoria: el ZIP de la carpeta se arma con esto en el
        // navegador, sin volver a bajar cada archivo de Drive
        salida.archivos.push({ nombre: t.archivo, datos: r.pdf });
        // no se espera la subida: la descarga siguiente arranca ya
        subidas.push(
          subir({ nombre: t.archivo, mime: "application/pdf", datos: aBase64(r.pdf) }).then(
            (subido) => {
              salida.certificados.push(subido);
              log(`  · ${t.etiqueta}: ${kb} KB → Drive (${subido.nombre})`, "ok");
              paso(`subido ${t.codigo}`);
            },
            (e) => {
              fallo(t, e);
              paso(`${t.codigo} · no se pudo subir`);
            }
          )
        );
      } catch (e) {
        fallo(t, e);
        paso(`${t.codigo} · no se pudo bajar`); // tampoco se sube
      } finally {
        bajados++;
        pasoZip(`certificados ${bajados}/${tareas.length} · ${cert.curso || t.archivo}`);
      }
    },
    senal
  );

  // El ZIP esta completo cuando bajaron todos los certificados y ya estan
  // armados el fotocheck y el Word: se avisa YA, sin esperar a Drive.
  const zipP = Promise.all([descargasP, armadoP]).then(() => {
    if (senal?.aborted) return;
    log(`ZIP listo: ${salida.archivos.length} certificado(s) + Word · Drive sigue subiendo`, "ok");
    try {
      alZipListo?.(salida);
    } catch {
      /* un aviso que falla no frena la subida */
    }
  });
  zipP.catch(() => {});
  // todo lo que va a la carpeta ya esta encolado: salen las subidas (juntas)
  Promise.allSettled([descargasP, armadoP]).then(() => soltarSubidas());

  await descargasP;
  await Promise.all(subidas);
  // la carpeta es lo unico obligatorio: si no se pudo crear, ese es el error
  salida.carpetaId = (await carpetaP).carpetaId;
  await documentosP;
  await zipP;

  if (!(await carpetaP).vaciada) {
    await limpiarCarpeta(salida, [...tareas.map((t) => t.archivo), nombreFoto, nombreWord], { log, senal, fondo });
  }
  return salida;
}

/**
 * Apenas se identifica a la persona (se leyo su fila), su carpeta de Drive se
 * crea si no existe y se VACIA: todo lo que tenia va a la papelera (se puede
 * recuperar desde Drive), para que al terminar quede solo lo que suba esta
 * renovacion.
 *
 * Se hace mientras se consultan JOMISER, EIN y Drive, que no pasan por Apps
 * Script: la fila de Apps Script esta libre en ese momento, asi que no le
 * suma tiempo a la renovacion. Las subidas esperan a que termine, para que
 * el vaciado no se lleve un archivo recien subido con el mismo nombre.
 *
 * Devuelve { nombre, promesa } para pasarlo a `generarSalidas`. La promesa
 * trae la carpeta con `vaciada: true` si se pudo vaciar; si fallo solo el
 * vaciado, `vaciada: false` y `generarSalidas` limpia al final.
 */
/** Lo que se informa en la consola sobre la carpeta de la persona. */
function textoCarpeta(c) {
  if (c.creada) return "carpeta creada";
  if (c.renombrada) return `carpeta existente reutilizada (antes "${c.renombrada}")`;
  return "carpeta ya existia, se actualiza";
}

export function vaciarCarpeta(persona, ctx, { log = () => {}, senal, fondo = false } = {}) {
  const nombre = nombreCarpeta(persona, ctx.config);
  const promesa = (async () => {
    log(`carpeta de Drive "${nombre}"...`);
    // `vaciar`: el Code.gs nuevo manda todo a la papelera en la misma
    // ejecucion (1 llamada a Apps Script en vez de 3). Uno viejo ignora el
    // pedido y no devuelve `vaciada`: entonces se lista y se borra desde aca.
    const c = await drive({ accion: "carpeta", nombre, dni: persona.dni, vaciar: true }, senal, { fondo });
    if (c.creada) {
      log(textoCarpeta(c), "ok");
      return { ...c, vaciada: true };
    }
    if (typeof c.vaciada === "boolean") {
      log(
        c.eliminados
          ? `${textoCarpeta(c)} · vaciada: ${c.eliminados} archivo(s) anteriores a la papelera`
          : `${textoCarpeta(c)} · estaba vacia`,
        "ok"
      );
      return c;
    }
    try {
      const { archivos = [] } = await drive({ accion: "listar", carpetaId: c.carpetaId }, senal, { fondo });
      const nombres = [
        ...new Set(archivos.filter((a) => a.mimeType !== "application/vnd.google-apps.folder").map((a) => a.name)),
      ];
      if (nombres.length) {
        await drive({ accion: "eliminar", carpetaId: c.carpetaId, nombres }, senal, { fondo });
        log(`carpeta vaciada: ${nombres.length} archivo(s) anteriores a la papelera`, "ok");
      } else {
        log("carpeta ya existia, estaba vacia", "ok");
      }
      return { ...c, vaciada: true };
    } catch (e) {
      if (senal?.aborted) throw e;
      log(`  no se pudo vaciar la carpeta (se limpiara al terminar): ${e.message}`, "warn");
      return { ...c, vaciada: false };
    }
  })();
  // sin esto la falla quedaba muda: `generarSalidas` crea la carpeta de nuevo
  promesa.catch((e) => {
    if (!senal?.aborted) log(`  no se pudo preparar la carpeta (se reintenta al subir): ${e.message}`, "warn");
  });
  return { nombre, promesa };
}

/** Espacios repetidos y bordes fuera: la cuenta de servicio limpia asi los nombres al subir. */
const mismoNombre = (n) => String(n || "").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * La carpeta queda solo con lo de ESTA renovacion: lo que habia de corridas
 * anteriores (certificados que ya no aplican, los quitados con la "x", un
 * fotocheck con otro nombre...) se manda a la papelera de Drive.
 *
 * Se hace AL FINAL, con todo lo nuevo ya arriba: si algo falla a mitad de
 * camino la carpeta no queda vacia. Lo que esta renovacion intento subir se
 * conserva aunque la subida haya fallado, porque la version anterior tiene el
 * mismo nombre y es mejor que nada. Un fallo al limpiar solo se avisa.
 */
export async function limpiarCarpeta(salida, pedidos, { log = () => {}, senal, fondo = false } = {}) {
  const conservar = new Set(
    [...pedidos, ...salida.certificados.map((c) => c.nombre), salida.fotocheck?.nombre, salida.word?.nombre]
      .filter(Boolean)
      .map(mismoNombre)
  );
  try {
    const { archivos = [] } = await drive({ accion: "listar", carpetaId: salida.carpetaId }, senal, { fondo });
    const viejos = [
      ...new Set(
        archivos
          .filter((a) => a.mimeType !== "application/vnd.google-apps.folder" && !conservar.has(mismoNombre(a.name)))
          .map((a) => a.name)
      ),
    ];
    if (!viejos.length) return;
    await drive({ accion: "eliminar", carpetaId: salida.carpetaId, nombres: viejos }, senal, { fondo });
    salida.eliminados = viejos;
    log(`${viejos.length} archivo(s) de renovaciones anteriores enviados a la papelera: ${viejos.join(", ")}`, "ok");
  } catch (e) {
    if (senal?.aborted) throw e;
    log(`  no se pudieron quitar los archivos anteriores de la carpeta: ${e.message}`, "warn");
  }
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
 *
 * `soloPublica`: no se llega a Apps Script; si la lectura publica no la
 * encuentra devuelve null (un lote de varios DNI deja esa consulta, que es
 * lenta, para despues de pintar todas las fichas). `fondo`: carril de la cola.
 */
export async function fotoDeDni(dni, senal, { soloPublica = false, fondo = false } = {}) {
  if (!dni) throw new Error("la fila no tiene DNI");
  let r = null;
  try {
    r = await driveDirecto({ accion: "foto-de", dni, soloPublica: true }, senal);
  } catch (e) {
    if (senal?.aborted) throw e;
  }
  if (!r || r.respaldo) {
    if (soloPublica) return null;
    r = await drive({ accion: "foto-de", dni }, senal, { fondo });
  }
  if (!r.encontrada) throw new Error(`no hay foto de ${dni} en la carpeta FOTOS`);
  return `data:${r.mime};base64,${r.datos}`;
}

/**
 * Foto del fotocheck antiguo, con sus dimensiones (para no deformarla).
 *
 * Igual que la foto: primero la lectura publica de Drive (no hace fila detras
 * de Apps Script); si el archivo no es publico, se le pide a Apps Script.
 */
export async function fotoAntigua(idDrive, senal, { fondo = false } = {}) {
  if (!idDrive) throw new Error("la fila no tiene FOTOCHECK_ANTIGUO_DRIVE_ID");
  let r = null;
  try {
    r = await driveDirecto({ accion: "bajar", id: idDrive, soloPublica: true }, senal);
  } catch (e) {
    if (senal?.aborted) throw e;
  }
  if (!r?.datos) r = await drive({ accion: "bajar", id: idDrive }, senal, { fondo });
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

/* ------------------------------------------------------------------ */
/* RENOVAR AUTOMATICO: los criterios del lote                          */
/* ------------------------------------------------------------------ */

/*
 * Lo que antes hacia el robot de AUTO_RRCC (renovar_rrcc.py) desde afuera,
 * ahora dentro de la pestana. Aca va solo la parte que decide (sin red ni
 * DOM, para poder probarla); quien la ejecuta sobre las fichas es
 * `vistas/renovacion.js`. Las fechas viajan como texto ISO "aaaa-mm-dd".
 */

/** Interruptores de cada criterio (los de criterios.json del robot). */
export const CRITERIOS_AUTO = Object.freeze({
  // HM y ES: del certificado mas reciente y VIGENTE entre RIESGOS CRITICOS
  // (panel EIN) y CERTIFICADOS INDUCCION, la fecha de su curso en la tabla del
  // PDF + 365 dias
  actualizarHmEs: true,
  rrccConFechaDeInduccion: ["HM", "ES"],
  // HM y ES van siempre como "A": un "C" se cambia a "A"
  hmEsSiempreA: true,
  // estos "C" siguen en "C" y llevan la misma vigencia que HM y ES (en "A"
  // siguen en "A" con la vigencia de su certificado)
  cIgualQueHmEs: true,
  cConFechaDeHmEs: ["CS", "AE", "EC", "SP", "SQ", "TA"],
  // los demas "C" pasan a "–" (sin tipo ni fecha): entre ellos IE, PM, OC,
  // VEM y AP
  demasCSinTipo: true,
  // demas "A": la vigencia del certificado de la tarjeta, si es de estos origenes
  aSegunCertificado: true,
  origenesCertificadoA: ["JOMISER", "DRIVE"],
  // "x" a los certificados de HM y ES
  xEnHmEs: true,
  // de los paneles laterales solo queda uno: el elegido (o el mas reciente)
  soloUnCertificadoLateral: true,
  // EMO vencido o VEM "A" vencido -> el ZIP dice FALTA ACTUALIZAR
  marcarFaltaActualizar: true,
});

/** Tiempos y reintentos de la corrida automatica (segundos). */
export const EJECUCION_AUTO = Object.freeze({
  carpetaZip: "{fecha}_RRCC",
  vueltas: 4, // cada vuelta nueva lleva solo los DNI que no se pudieron cerrar
  reintentosPaso: 3,
  reintentarSiFaltaCertificado: true,
  esperaEntreVueltasSeg: 10,
  esperaBaseOkSeg: 120,
  esperaEntreGuardadosSeg: 45,
  esperaFotoSeg: 120,
  esperaZipSeg: 180,
  esperaDriveSeg: 600,
  sinAvanceSeg: 420,
});

/** UMBRAL_VENCIDO de la app: la vigencia es el curso + 365 dias. */
export const DIAS_VIGENCIA_AUTO = 365;

const MESES_AUTO = {
  ENERO: 1, FEBRERO: 2, MARZO: 3, ABRIL: 4, MAYO: 5, JUNIO: 6, JULIO: 7,
  AGOSTO: 8, SETIEMBRE: 9, SEPTIEMBRE: 9, OCTUBRE: 10, NOVIEMBRE: 11, DICIEMBRE: 12,
};

export const sinTildesAuto = (texto) =>
  String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();

function isoValida(anio, mes, dia) {
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  if (f.getUTCFullYear() !== anio || f.getUTCMonth() !== mes - 1 || f.getUTCDate() !== dia) return null;
  return f.toISOString().slice(0, 10);
}

/** "12/11/2025" (o "1/9/2026") -> "2025-11-12". null si no es una fecha. */
export function isoDeCorta(texto) {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(texto || "");
  return m ? isoValida(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

/** "2025-11-12" -> el mismo texto si es una fecha valida, null si no. */
export function isoValidaAuto(texto) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texto || "").trim());
  return m ? isoValida(Number(m[1]), Number(m[2]), Number(m[3])) : null;
}

/** "2025-11-12" -> "12/11/2025" (o "sin fecha"). */
export const cortaDeIso = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : "sin fecha");

const diaDe = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86400000;
export const sumarDiasIso = (iso, dias) => new Date((diaDe(iso) + dias) * 86400000).toISOString().slice(0, 10);

/** Hoy en la hora local, como ISO. */
export function hoyLocalIso(ahora = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${ahora.getFullYear()}-${p(ahora.getMonth() + 1)}-${p(ahora.getDate())}`;
}

/** Como estadoDe() de la app: VENCIDO si pasaron mas de 365 dias desde el curso. */
export function cursoVigente(fechaCurso, hoy) {
  if (!fechaCurso) return false;
  const dias = diaDe(hoy) - diaDe(fechaCurso);
  return dias >= 0 && dias <= DIAS_VIGENCIA_AUTO;
}

/**
 * Fecha de un certificado de induccion a partir del texto del PDF:
 * "INICIO: 23/9/2026" o "Realizado el dia 23 de Setiembre del 2026".
 * Devuelve { fecha, problema }.
 */
export function fechaDeInduccion(texto, dni) {
  const plano = sinTildesAuto(texto).replace(/\s+/g, " ");
  if (!plano.replace(/\D/g, "").includes(String(dni).replace(/^0+/, ""))) return { fecha: null, problema: "el PDF no trae este DNI" };
  // "INICIO: 23/9/2026" o, en los certificados por curso, "INICIO: 7 / 10 / 2026"
  const fechas = [...plano.matchAll(/INICIO\s*:\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/g)].map((m) =>
    isoValida(Number(m[3]), Number(m[2]), Number(m[1]))
  );
  if (!fechas.length) {
    for (const m of plano.matchAll(/REALIZADO EL DIA (\d{1,2}) DE ([A-Z]+) DEL? (\d{4})/g)) {
      if (MESES_AUTO[m[2]]) fechas.push(isoValida(Number(m[3]), MESES_AUTO[m[2]], Number(m[1])));
    }
  }
  const validas = fechas.filter(Boolean).sort();
  if (!validas.length) return { fecha: null, problema: "no se encontró la fecha en el PDF" };
  return { fecha: validas[validas.length - 1], problema: "" };
}

/**
 * Fecha de cada curso segun el contenido del certificado (EIN o induccion de
 * Drive), que es la fecha real del curso y no la de INICIO. Lee los dos
 * formatos que hay:
 *
 * - Tabla "CURSO RIESGOS CRITICOS": la columna FECHA usa celdas combinadas,
 *   una fecha para varios cursos seguidos, centrada en su bloque ("1.- a 7.-"
 *   el primer dia, "8.- a 13.-" el segundo).
 * - Un certificado por curso en el mismo PDF ("...el curso de: TRABAJOS EN
 *   ALTURA Realizado el dia 7 de octubre del 2026"), cada uno seguido de la
 *   pagina de su TEMARIO.
 *
 * `paginas` = [{ items: [{ str, x, y, ancho }] }] con las coordenadas de pdf.js
 * (y crece hacia arriba). Devuelve { ES: "2025-10-09", AE: "2025-10-08", ... };
 * vacio si el PDF no trae ninguno de los dos.
 */
export function fechasDeCursosPdf(paginas, dic = construirDiccionario([])) {
  const lista = paginas || [];
  const fechas = fechasPorCertificado(lista, dic);
  // la tabla es mas precisa: si un curso sale en los dos, manda la tabla
  for (const pagina of lista) Object.assign(fechas, fechasDePagina(pagina.items || [], dic));
  return fechas;
}

const textoPlano = (pagina) =>
  sinTildesAuto((pagina?.items || []).map((i) => i.str).join(" ")).replace(/\s+/g, " ").trim();

/** Codigo RRCC del primer nombre que se pueda mapear (null si ninguno). */
function primerCodigo(nombres, dic) {
  for (const nombre of nombres) {
    const codigo = nombre ? mapearCurso(nombre, dic) : null;
    if (codigo && codigo !== "IGNORADO") return codigo;
  }
  return null;
}

/** "Realizado el dia 7 de octubre del 2026" o "INICIO: 7 / 10 / 2026" (con o sin espacios). */
function fechaDeTexto(plano) {
  const r = /REALIZADO EL DIA (\d{1,2}) DE ([A-Z]+),? DEL? (\d{4})/.exec(plano);
  if (r && MESES_AUTO[r[2]]) {
    const iso = isoValida(Number(r[3]), MESES_AUTO[r[2]], Number(r[1]));
    if (iso) return iso;
  }
  const i = /INICIO\s*:\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{4})/.exec(plano);
  return i ? isoValida(Number(i[3]), Number(i[2]), Number(i[1])) : null;
}

/**
 * PDF con un certificado por curso: cada pagina "culmino satisfactoriamente el
 * curso de: X" da la fecha de X. El nombre a veces sale mal escrito
 * ("EXCAVACACIONES") o fuera de lugar en el texto: entonces vale el titulo del
 * TEMARIO o la fila CURSO / DURACION / NOTA de la pagina siguiente.
 */
function fechasPorCertificado(paginas, dic) {
  const fechas = {};
  const planos = paginas.map(textoPlano);
  planos.forEach((plano, k) => {
    if (!/CULMINADO SATISFACTORIAMENTE EL CURSO DE/.test(plano)) return;
    const fecha = fechaDeTexto(plano);
    if (!fecha) return;
    const siguiente = planos[k + 1] || "";
    const codigo = primerCodigo(
      [
        (/EL CURSO DE\s*:?\s*(.*?)\s*REALIZADO/.exec(plano) || [])[1],
        /CULMINADO SATISFACTORIAMENTE/.test(siguiente) ? "" : (/TEMARIO\s+(.*?)\s*•/.exec(siguiente) || [])[1],
        /CULMINADO SATISFACTORIAMENTE/.test(siguiente) ? "" : (/CURSO DURACION NOTA\s+(.*?)\s+\d/.exec(siguiente) || [])[1],
      ],
      dic
    );
    if (codigo && (!fechas[codigo] || fecha > fechas[codigo])) fechas[codigo] = fecha;
  });
  return fechas;
}

function fechasDePagina(items, dic) {
  const limpios = items.filter((i) => String(i.str || "").trim());
  const cabecera = limpios.find((i) => /^FECHA$/i.test(i.str.trim()));
  if (!cabecera) return {};
  const centro = (i) => i.x + (i.ancho || 0) / 2;
  const colFecha = centro(cabecera);

  // las fechas de la columna FECHA, de arriba hacia abajo
  const dias = limpios
    .filter((i) => i.y < cabecera.y && Math.abs(centro(i) - colFecha) < 60 && isoDeCorta(i.str.trim()) && /^\s*\d{1,2}\/\d{1,2}\/\d{4}\s*$/.test(i.str))
    .map((i) => ({ y: i.y, iso: isoDeCorta(i.str) }))
    .sort((a, b) => b.y - a.y);
  if (!dias.length) return {};

  // renglones a la izquierda de FECHA, armados con sus pedazos (pdf.js parte
  // las tildes en items sueltos)
  const porLinea = new Map();
  for (const i of limpios) {
    if (i.y >= cabecera.y || i.x >= cabecera.x - 5) continue;
    const clave = [...porLinea.keys()].find((y) => Math.abs(y - i.y) <= 2) ?? i.y;
    if (!porLinea.has(clave)) porLinea.set(clave, []);
    porLinea.get(clave).push(i);
  }
  const lineas = [...porLinea]
    .map(([y, trozos]) => {
      trozos.sort((a, b) => a.x - b.x);
      let texto = "";
      trozos.forEach((t, k) => {
        const previo = trozos[k - 1];
        if (previo && t.x - (previo.x + (previo.ancho || 0)) > 1.5) texto += " ";
        texto += t.str;
      });
      return { y, texto: texto.trim() };
    })
    .sort((a, b) => b.y - a.y);

  // cada curso "N.- NOMBRE"; un renglon sin numero justo debajo es su continuacion
  const filas = [];
  for (const l of lineas) {
    if (/^\d{1,2}\s*\.?\s*-/.test(l.texto)) filas.push({ arriba: l.y, abajo: l.y, texto: l.texto });
    else {
      const ultima = filas[filas.length - 1];
      if (ultima && ultima.abajo - l.y <= 15) {
        ultima.abajo = l.y;
        ultima.texto += " " + l.texto;
      }
    }
  }
  if (filas.length < dias.length) return {};

  // cursos seguidos -> bloques, uno por fecha, con cada fecha lo mas centrada
  // posible en su bloque (asi se lee una celda combinada)
  const n = filas.length;
  const m = dias.length;
  const costo = (g, a, b) => Math.abs((filas[a].arriba + filas[b].abajo) / 2 - dias[g].y);
  const mejor = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(Infinity));
  const corte = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(-1));
  mejor[0][0] = 0;
  for (let g = 1; g <= m; g++) {
    for (let fin = g; fin <= n; fin++) {
      for (let ini = g - 1; ini < fin; ini++) {
        const c = mejor[g - 1][ini] + costo(g - 1, ini, fin - 1);
        if (c < mejor[g][fin]) {
          mejor[g][fin] = c;
          corte[g][fin] = ini;
        }
      }
    }
  }

  const fechas = {};
  for (let g = m, fin = n; g > 0; g--) {
    const ini = corte[g][fin];
    for (let k = ini; k < fin; k++) {
      const codigo = mapearCurso(filas[k].texto.replace(/^\d{1,2}\s*\.?\s*-\s*/, ""), dic);
      if (codigo && codigo !== "IGNORADO" && !fechas[codigo]) fechas[codigo] = dias[g - 1].iso;
    }
    fin = ini;
  }
  return fechas;
}

/*
 * `ficha` es lo que muestra la tarjeta (ver `leerFichaAuto` en la vista):
 *   riesgos:   [{ codigo, tipo, venc, sinCert, certVigencia, certCurso, certClave, certExcluido }]
 *   laterales: [{ origen: "EIN"|"INDUCCION", clave, curso, fecha, descargable, excluido }]
 *   emo, nombre
 */

/**
 * Candidatos a certificado de HM/ES: RIESGOS CRITICOS del panel EIN (con su
 * fecha) y cada induccion descargable (su fecha se lee del PDF). De todos se
 * lee el PDF (`leerPdf: true`) para sacar la fecha de cada curso de su tabla
 * (`fechas`, ver `fechasDeCursosPdf`). El item "INDUCCION" de EIN no cuenta.
 */
export function candidatosLaterales(ficha) {
  const lista = [];
  for (const item of ficha.laterales || []) {
    if (item.origen === "EIN" && sinTildesAuto(item.curso).includes("RIESGOS CRITICOS")) {
      lista.push({ ...item, fechaIso: isoDeCorta(item.fecha), leerPdf: item.descargable !== false });
    } else if (item.origen === "INDUCCION" && item.descargable) {
      lista.push({ ...item, fechaIso: null, leerPdf: true });
    }
  }
  return lista;
}

/** El que manda: el mas reciente entre los vigentes (null si ninguno lo esta). */
export function elegirCertificadoLateral(candidatos, hoy) {
  const vigentes = candidatos.filter((c) => cursoVigente(c.fechaIso, hoy));
  vigentes.sort((a, b) => b.fechaIso.localeCompare(a.fechaIso));
  return vigentes[0] || null;
}

/**
 * Las fechas y tipos que hay que poner en la ficha. Devuelve
 *   acciones:  [{ codigo, venc }] o [{ codigo, tipo }] ("A", o "" = pasar a "–")
 *   esperadas: { codigo: iso | null } lo que la hoja tiene que terminar teniendo
 *   cambios / avisos: textos para la consola y el Excel de detalle
 */
export function planFechas(ficha, elegido, criterios = CRITERIOS_AUTO) {
  const acciones = [];
  const esperadas = {};
  const cambios = [];
  const avisos = [];
  // copias: el plan cambia el tipo de HM/ES sin tocar la ficha recibida
  const riesgos = new Map((ficha.riesgos || []).map((r) => [r.codigo, { ...r }]));
  const codigosInd = criterios.rrccConFechaDeInduccion.map((c) => c.toUpperCase());
  const codigosC = criterios.cConFechaDeHmEs.map((c) => c.toUpperCase());
  const poner = (codigo, r, venc, porque) => {
    if (isoValidaAuto(r.venc) === venc) return;
    acciones.push({ codigo, venc });
    esperadas[codigo] = venc;
    cambios.push(`${codigo}: ${cortaDeIso(isoValidaAuto(r.venc))} -> ${cortaDeIso(venc)} (${porque})`);
  };

  if (!elegido) avisos.push(`sin RIESGOS CRITICOS (EIN) ni inducción vigente: ${codigosInd.join("/")} sin actualizar`);

  // HM y ES nunca quedan en "C"
  if (criterios.hmEsSiempreA) {
    for (const codigo of SIEMPRE_A) {
      const r = riesgos.get(codigo);
      if (r?.tipo !== "C") continue;
      acciones.push({ codigo, tipo: "A" });
      r.tipo = "A";
      cambios.push(`${codigo}: C -> A (siempre autorizado)`);
    }
  }

  // La fecha de cada curso es la que dice la tabla del certificado elegido
  // (`elegido.fechas`). Sin esa fila (o sin tabla) va la de HM/ES de la misma
  // tabla y, a falta de tabla, la fecha general del certificado.
  const tabla = (elegido && elegido.fechas) || {};
  const fechaCurso = (codigo) => {
    if (tabla[codigo]) return { iso: tabla[codigo], porque: `curso del ${cortaDeIso(tabla[codigo])} en ${elegido.origen}` };
    const base = codigosInd.map((c) => tabla[c]).find(Boolean);
    if (base) return { iso: base, porque: `sin fila propia: HM/ES del ${cortaDeIso(base)} en ${elegido.origen}` };
    return { iso: elegido.fechaIso, porque: `${elegido.origen} ${cortaDeIso(elegido.fechaIso)}` };
  };
  if (elegido && !Object.keys(tabla).length) avisos.push(`el certificado ${elegido.origen} no trae la tabla de cursos: se usó su fecha general (${cortaDeIso(elegido.fechaIso)})`);

  // HM y ES: fecha de su curso + 365
  let nueva = null;
  if (elegido && criterios.actualizarHmEs) {
    for (const codigo of codigosInd) {
      const f = fechaCurso(codigo);
      const venc = sumarDiasIso(f.iso, DIAS_VIGENCIA_AUTO);
      nueva ||= venc;
      const r = riesgos.get(codigo);
      if (r && (r.tipo === "A" || r.tipo === "C")) poner(codigo, r, venc, f.porque);
    }
  }

  // "C" de la lista: del mismo certificado que HM y ES, con la fecha de su curso
  if (criterios.cIgualQueHmEs) {
    for (const codigo of codigosC) {
      const r = riesgos.get(codigo);
      if (!r || r.tipo !== "C") continue;
      if (!nueva) avisos.push(`${codigo} (C): sin actualizar (no hay fecha de HM/ES)`);
      else {
        const f = fechaCurso(codigo);
        poner(codigo, r, sumarDiasIso(f.iso, DIAS_VIGENCIA_AUTO), f.porque);
      }
    }
  }

  // los demas "C" pasan a "–" (la app tambien les borra la fecha)
  if (criterios.demasCSinTipo) {
    for (const [codigo, r] of riesgos) {
      if (r.tipo !== "C" || codigosC.includes(codigo) || codigosInd.includes(codigo)) continue;
      acciones.push({ codigo, tipo: "" });
      esperadas[codigo] = null;
      cambios.push(`${codigo}: C -> – (vigencia ${cortaDeIso(isoValidaAuto(r.venc))} borrada)`);
    }
  }

  // demas "A": la vigencia del certificado que muestra la tarjeta
  if (criterios.aSegunCertificado) {
    const origenesOk = new Set(criterios.origenesCertificadoA.map((o) => o.toUpperCase()));
    for (const [codigo, r] of riesgos) {
      if (r.tipo !== "A" || codigosInd.includes(codigo)) continue;
      if (r.sinCert) {
        avisos.push(`${codigo} (A): sin certificado`);
        continue;
      }
      const origen = String(r.certCurso || "").split("·").pop().trim().toUpperCase();
      if (!origenesOk.has(origen)) {
        avisos.push(`${codigo} (A): su certificado es de ${origen || "?"}: no se tocó`);
        continue;
      }
      const vig = isoDeCorta(r.certVigencia);
      if (vig) poner(codigo, r, vig, origen);
    }
  }
  return { acciones, esperadas, cambios, avisos, nueva };
}

/**
 * Las "x" a pulsar sobre la ficha ya editada: certificados de HM y ES fuera y,
 * de los paneles laterales, solo queda el elegido (si ninguno esta vigente,
 * el mas reciente). Un certificado puede estar en la tarjeta y en el panel
 * (comparten la "x"): va una sola vez por clave. Devuelve [{ clave, texto, codigo? }]
 * (`codigo` = la "x" de esa tarjeta; sin el, la del panel lateral).
 */
export function planQuitar(ficha, elegido, candidatos, criterios = CRITERIOS_AUTO) {
  let claveElegido = elegido?.clave || null;
  if (!elegido && criterios.soloUnCertificadoLateral) {
    const conFecha = candidatos.filter((c) => c.fechaIso).sort((a, b) => b.fechaIso.localeCompare(a.fechaIso));
    if (conFecha.length) claveElegido = conFecha[0].clave;
  }
  const quitar = new Map();
  if (criterios.xEnHmEs) {
    for (const codigo of criterios.rrccConFechaDeInduccion.map((c) => c.toUpperCase())) {
      const r = (ficha.riesgos || []).find((x) => x.codigo === codigo);
      // la "x" de la tarjeta solo existe en un "A"
      if (r?.certClave && r.tipo === "A" && !r.certExcluido && r.certClave !== claveElegido && !quitar.has(r.certClave)) {
        quitar.set(r.certClave, { clave: r.certClave, codigo, texto: `${codigo}: certificado quitado del ZIP (x)` });
      }
    }
  }
  if (criterios.soloUnCertificadoLateral) {
    for (const item of ficha.laterales || []) {
      if (item.excluido || !item.clave || item.clave === claveElegido || quitar.has(item.clave)) continue;
      quitar.set(item.clave, { clave: item.clave, texto: `panel ${item.origen}: ${item.curso} ${item.fecha} quitado del ZIP (x)` });
    }
  }
  return [...quitar.values()];
}

/** EMO vencido (o sin fecha) o VEM "A" vencido: lo que hace que el ZIP diga FALTA ACTUALIZAR. Vence hoy = aun vale. */
export function faltaActualizar(ficha, hoy) {
  const faltan = [];
  const emo = isoValidaAuto(ficha.emo);
  if (!emo) faltan.push("EMO: sin fecha de vencimiento");
  else if (emo < hoy) faltan.push(`EMO: vencido el ${cortaDeIso(emo)}`);
  const vem = (ficha.riesgos || []).find((x) => x.codigo === "VEM");
  if (vem?.tipo === "A") {
    const v = isoValidaAuto(vem.venc);
    if (!v) faltan.push("Vehiculos y Equipos Moviles (A): sin vigencia");
    else if (v < hoy) faltan.push(`Vehiculos y Equipos Moviles (A): vencido el ${cortaDeIso(v)}`);
  }
  return faltan;
}

/** Texto de "FALTA ACTUALIZAR.txt", el que va dentro del ZIP junto al Word. */
export function textoFaltaActualizar(dni, faltan, ahora = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const cuando = `${p(ahora.getDate())}/${p(ahora.getMonth() + 1)}/${ahora.getFullYear()} ${p(ahora.getHours())}:${p(ahora.getMinutes())}`;
  return `FALTA ACTUALIZAR - DNI ${dni}\r\nRevisado el ${cuando}\r\n\r\n` + faltan.map((f) => `- ${f}\r\n`).join("");
}

/** <DNI>_<NOMBRE>[ - FALTA ACTUALIZAR].zip a partir del nombre que propone la app. */
export function nombreZipAuto(sugerido, dni, faltan = []) {
  let base = String(sugerido || dni).replace(/\.zip$/i, "").trim() || dni;
  if (!base.startsWith(dni)) base = `${dni}_${base}`;
  return { base, nombre: `${base}${faltan.length ? " - FALTA ACTUALIZAR" : ""}.zip` };
}

/**
 * Errores de certificados de la consola, repartidos por DNI. En un lote la
 * etapa 1 escribe bajo una cabecera "[i/n] DNI x" y la etapa 2 antepone "[x]".
 * Solo cuentan los certificados que no bajaron / no subieron.
 * `lineas` = [{ t: texto, c: clases }].
 */
export function erroresPorDni(lineas) {
  const errores = {};
  let actual = null;
  for (const l of lineas) {
    const t = String(l.t || "").trim();
    let m = /^(?:\[\d+\/\d+\] )?DNI (\d{6,12})/.exec(t);
    if (m) {
      actual = m[1];
      continue;
    }
    m = /^\[(\d{6,12})\]\s*(.*)$/.exec(t);
    const [dni, texto] = m ? [m[1], m[2]] : [actual, t];
    if (/\bln-err\b/.test(l.c) && dni && (texto.startsWith("·") || texto.includes("no se pudo bajar") || texto.includes("no se pudo subir"))) {
      (errores[dni] ||= []).push(texto);
    }
  }
  return errores;
}

/** OK | OBSERVACION | FALLA | NO PROCESADO, para el Excel de detalle. */
export function calificarAuto(r) {
  if (r.estado === "ERROR") return "FALLA";
  if (r.estado === "NO PROCESADO") return "NO PROCESADO";
  if ((r.estado === "OK" || r.estado === "CONSULTADO") && !r.faltaActualizar && !r.avisos) return "OK";
  return "OBSERVACION";
}

/** La hoja del Excel de detalle (para `armarXlsx`): una fila por DNI. */
export function hojaDetalleAuto(resultados) {
  const lineas = (texto) => String(texto || "").split(" | ").map((t) => t.trim()).filter(Boolean).join("\n");
  const columnas = [
    { titulo: "N°", ancho: 5, tipo: "numero" },
    { titulo: "DNI", ancho: 11 },
    { titulo: "APELLIDOS Y NOMBRES", ancho: 32 },
    { titulo: "RESULTADO", ancho: 15 },
    { titulo: "FALLA / OBSERVACION", ancho: 55 },
    { titulo: "FALTA ACTUALIZAR", ancho: 38 },
    { titulo: "CAMBIOS HECHOS", ancho: 55 },
    { titulo: "ARCHIVO ZIP", ancho: 45 },
    { titulo: "HOJA BD", ancho: 9 },
    { titulo: "DRIVE", ancho: 8 },
    { titulo: "INTENTOS", ancho: 9, tipo: "numero" },
  ];
  const filas = resultados.map((r, i) => {
    const calif = calificarAuto(r);
    let detalle = lineas(r.avisos);
    if (!["OK", "OK CON AVISOS", "ERROR", "NO PROCESADO", "CONSULTADO"].includes(r.estado)) detalle = [r.estado, detalle].filter(Boolean).join("\n");
    if (calif === "FALLA" && !r.zip) detalle = ["NO SE GENERÓ EL ZIP", detalle].filter(Boolean).join("\n");
    return [i + 1, r.dni, r.nombre, calif, detalle, lineas(r.faltaActualizar), lineas(r.cambios), r.zip, r.guardadoHoja, r.drive, r.intentos];
  });
  return { nombre: "DETALLE", columnas, filas };
}
