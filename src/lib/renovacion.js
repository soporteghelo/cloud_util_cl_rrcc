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
import { renovarFila, copiarFila, leerFila, filaNueva, tiposDeMatriz, diferenciasFila, normalizarDocumento } from "../../shared/estados.js";
import { CODIGOS_RRCC } from "../../shared/rrcc.js";
import { fotocheckImagen, nombreFotocheck } from "./fotocheck.js";
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
 * Que certificados van a la carpeta de la persona (y al ZIP), uno por
 * archivo y en el orden en que se bajan.
 *
 * Tanto "A" (autorizados) como "C" (capacitados) suben su PDF si sigue en
 * vigor (`ESTADOS_EN_CARPETA`) y se puede descargar.
 *
 * El PDF consolidado de Drive (en `personales`) no es de ningun curso, asi
 * que no entra en la grilla de riesgos, pero es un certificado de la persona
 * y va en su carpeta igual.
 *
 * Los certificados de EIN y de INDUCCION (los del panel lateral de la ficha)
 * van TODOS a la carpeta, esten o no en la grilla: quien no deba ir se quita
 * con la "x" de ese panel (`excluidos`).
 */
export function certificadosDeCarpeta(resultado, excluidos = null) {
  const vigentes = (resultado.detalle || [])
    .filter(
      (d) =>
        ESTADOS_EN_CARPETA.includes(d.estado) &&
        d.certificado &&
        d.certificado.descargable &&
        d.certificado.origen !== "EIN"
    )
    .map((d) => ({ codigo: d.codigo, etiqueta: d.codigo, cert: d.certificado, archivo: nombreCertificado(d.certificado) }));
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
    .filter((item) => item.descargable && ORIGENES_LATERALES.includes(item.origen))
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
 *   - los certificados de los RRCC que siguen en vigor (vigentes o por vencer),
 *   - el PNG del fotocheck nuevo,
 *   - el Word con el fotocheck nuevo (10 x 8 cm) y la foto del antiguo.
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
    const img = await fotocheckImagen(persona, { foto });
    const [imgBase64, imgBytes] = await Promise.all([blobABase64(img.blob), img.blob.arrayBuffer()]);
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
      fotocheck: { datos: imgBytes, mime: img.mime },
      antiguo,
      medidas: {
        fotocheckAnchoCm: Number(ctx.config.FOTOCHECK_ANCHO_CM || 10),
        fotocheckAltoCm: Number(ctx.config.FOTOCHECK_ALTO_CM || 8),
        antiguoAnchoCm: Number(ctx.config.ANTIGUO_ANCHO_CM || 17),
      },
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
    `${vigentes.length} certificado(s) en vigor (vigentes o por vencer) para subir` +
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
    log(`ZIP listo: ${salida.archivos.length} certificado(s) + fotocheck + Word · Drive sigue subiendo`, "ok");
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
