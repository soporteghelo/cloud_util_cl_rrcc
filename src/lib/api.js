/** Cliente de las funciones serverless. */

async function pedir(ruta, cuerpo, senal) {
  const res = await fetch(ruta, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
    signal: senal,
  });
  return res;
}

async function json(ruta, cuerpo, senal) {
  const res = await pedir(ruta, cuerpo, senal);
  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  if (!res.ok) {
    const e = new Error(datos.error || `HTTP ${res.status}`);
    e.estado = res.status;
    e.detalle = datos;
    // 502 sin JSON (la red de Vercel corto antes) tambien es una demora
    e.reintentable = Boolean(datos.reintentable) || /respuesta ilegible \(HTTP 50[24]\)/.test(e.message);
    throw e;
  }
  return datos;
}

/**
 * Apps Script a veces entrega una pagina de error de Google, el "hello" de
 * doGet o nada, aunque el script ande (va lento o esta saturado). El puente
 * ya reintenta dentro de su tiempo; si igual falla, se vuelve a pedir desde
 * aca un par de veces antes de rendirse: una sola respuesta rota al cargar
 * CONFIG ya no tumba la renovacion entera.
 *
 * Solo para lo que se puede repetir sin riesgo: lecturas y acciones que dan
 * lo mismo aunque corran dos veces. `guardar` tiene su propia verificacion
 * (guardarFilaVerificada) y `alta` nunca se repite a ciegas.
 */
const REINTENTOS = 2;
const esperar = (ms, senal) =>
  new Promise((listo, falla) => {
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

async function conReintentos(pedido, senal) {
  for (let intento = 0; ; intento++) {
    try {
      return await pedido();
    } catch (e) {
      if (senal?.aborted || !e.reintentable || intento >= REINTENTOS) throw e;
      await esperar(2000 * (intento + 1), senal);
    }
  }
}

/** Acciones de /api/sheets que solo leen: se pueden repetir. */
const SHEETS_REPETIBLES = new Set(["contexto", "persona", "listado", "cargos", "comprobar"]);
/** Acciones de /api/sheets que van por el carril urgente (ver `pendientes`). */
const SHEETS_URGENTES = new Set(["persona", "guardar"]);

/** Inventario de certificados de un DNI. */
export function buscar(cuerpo, senal) {
  return json("/api/search", cuerpo, senal);
}

/** Descarga UN certificado. Devuelve { pdf: ArrayBuffer }. */
export async function descargar(cuerpo, senal) {
  const res = await pedir("/api/download", cuerpo, senal);
  const tipo = res.headers.get("content-type") || "";

  if (tipo.includes("application/pdf")) {
    return { pdf: await res.arrayBuffer() };
  }

  const datos = await res.json().catch(() => ({ error: `respuesta ilegible (HTTP ${res.status})` }));
  if (datos.sinCertificado) return datos;
  throw new Error(datos.error || `HTTP ${res.status}`);
}

/* ------------------------------------------------------------------ */
/* Cola hacia Apps Script (Sheets y Drive comparten el mismo Web App)   */
/* ------------------------------------------------------------------ */

/**
 * `/api/sheets` y `/api/drive-output` terminan las dos en el mismo Web App
 * de Apps Script. Con dos o mas pedidos simultaneos (p.ej. "contexto" +
 * "cargos" al montar la pestaña, o eso mas la foto del fotocheck) Google
 * satura las ejecuciones concurrentes del Web App: cada pedido pasa de
 * tardar unos segundos a tardar 30-100+, y a veces ni siquiera devuelve lo
 * que se le pidio (llega la respuesta de otro pedido, o una pagina de error
 * en vez de JSON). Por eso todo lo que hable con Apps Script se turna aca,
 * uno a la vez, sin importar desde que parte de la app se dispare.
 */
/*
 * La fila tiene dos carriles. En el normal va todo lo que el usuario acaba de
 * pedir; en el de fondo, las precargas que la app dispara sola al abrirse (el
 * listado de personal entero, que son ~1.5 MB y varios segundos). Mientras una
 * precarga sigue ESPERANDO turno, cualquier pedido del usuario se le adelanta:
 * sin esto, abrir la pagina y ponerse a renovar de inmediato significaria
 * esperar a que termine de bajar una lista que nadie pidio todavia.
 *
 * Lo que ya esta en el aire no se adelanta ni se cancela: sigue siendo un
 * pedido a la vez, que es lo que Apps Script aguanta.
 */
/*
 * Y un tercer carril, el urgente, para lo que tiene a la persona esperando
 * frente a la pantalla: leer su fila y guardarla. En una renovacion, crear y
 * vaciar la carpeta de Drive se encola ANTES que el guardado (arranca apenas
 * se identifica el DNI); sin este carril la ficha quedaba en "guardando..."
 * detras de esas llamadas, que con Apps Script lento son varios segundos cada
 * una. Las subidas igual esperan a la carpeta, asi que no pierden nada.
 */
const pendientes = { urgente: [], normal: [], fondo: [] };
let enCurso = false;

/*
 * Respiro despues de una respuesta rota. La pagina 404 de Google llega
 * cuando el script esta lento, y la ejecucion suele seguir corriendo en
 * Google aunque el puente ya se haya rendido: mandar el pedido siguiente en
 * ese mismo instante lo pone a competir con ella, y en un lote de varios DNI
 * eso encadena una respuesta rota tras otra. Con unos segundos de espera la
 * ejecucion abandonada termina y el siguiente encuentra el script libre.
 * `enfriarMs` es configurable para las pruebas.
 */
export const AJUSTES_COLA = { enfriarMs: 3000 };
let enfriarHasta = 0;

/*
 * Carril de fondo retenido. Un lote de varios DNI primero pinta TODAS las
 * fichas (leer la fila, cruzar certificados, guardar) y recien despues arma
 * las carpetas de Drive. Mientras se retiene, lo del carril de fondo espera
 * aunque Apps Script este libre: un pedido que ya salio no se puede frenar, y
 * una subida de varios MB en el aire dejaba el guardado de la persona
 * siguiente esperando hasta agotar el tiempo.
 */
let retenciones = 0;

/** Retiene el carril de fondo hasta llamar a la funcion devuelta (una sola vez cuenta). */
export function retenerFondo() {
  retenciones++;
  let suelto = false;
  return () => {
    if (suelto) return;
    suelto = true;
    retenciones--;
    bombear();
  };
}

const hayListo = () =>
  pendientes.urgente.length > 0 || pendientes.normal.length > 0 || (retenciones === 0 && pendientes.fondo.length > 0);

function unoALaVez(tarea, carril = "normal") {
  return new Promise((listo, falla) => {
    pendientes[carril].push({ tarea, listo, falla });
    bombear();
  });
}

async function bombear() {
  if (enCurso || !hayListo()) return;

  enCurso = true;
  const respiro = enfriarHasta - Date.now();
  if (respiro > 0) await new Promise((r) => setTimeout(r, respiro));
  // se elige DESPUES del respiro: lo urgente que llego mientras tanto pasa primero
  const siguiente =
    pendientes.urgente.shift() || pendientes.normal.shift() || (retenciones === 0 ? pendientes.fondo.shift() : null);
  if (!siguiente) {
    // el fondo quedo retenido durante el respiro
    enCurso = false;
    return;
  }
  try {
    siguiente.listo(await siguiente.tarea());
  } catch (e) {
    if (e?.reintentable) enfriarHasta = Date.now() + AJUSTES_COLA.enfriarMs;
    siguiente.falla(e); // un pedido fallido no debe atascar la fila
  } finally {
    enCurso = false;
    bombear();
  }
}

/* ------------------------------------------------------------------ */
/* Base en Google Sheets                                               */
/* ------------------------------------------------------------------ */

/**
 * Una accion de /api/sheets: contexto | persona | guardar | alta | cargos | setup.
 * `fondo: true` la manda por el carril de precarga, que cede el turno a todo
 * lo que pida el usuario.
 */
export function sheets(cuerpo, senal, { fondo = false } = {}) {
  const pedido = () => json("/api/sheets", cuerpo, senal);
  const accion = String(cuerpo?.accion || "");
  const repetible = SHEETS_REPETIBLES.has(accion);
  const carril = SHEETS_URGENTES.has(accion) ? "urgente" : fondo ? "fondo" : "normal";
  return unoALaVez(() => (repetible ? conReintentos(pedido, senal) : pedido()), carril);
}

/* ------------------------------------------------------------------ */
/* Salidas en Google Drive                                             */
/* ------------------------------------------------------------------ */

/**
 * Una accion de /api/drive-output: carpeta | subir | foto | bajar | listar.
 * `fondo: true` la manda por el carril de fondo (las carpetas de un lote).
 */
export function drive(cuerpo, senal, { fondo = false } = {}) {
  // todas las acciones de Drive dan lo mismo si corren dos veces: `carpeta`
  // reutiliza la que exista, `subir` reemplaza por nombre, `eliminar` manda a
  // la papelera lo que haya, y el resto solo lee
  return unoALaVez(() => conReintentos(() => json("/api/drive-output", cuerpo, senal), senal), fondo ? "fondo" : "normal");
}

/**
 * Igual que `drive`, pero sin hacer fila. SOLO para pedidos que no llegan a
 * Apps Script (la foto por la lectura publica, `soloPublica: true`): esos no
 * lo saturan, y hacerlos esperar detras de las subidas seria perder el
 * paralelismo que justamente se busca.
 */
export function driveDirecto(cuerpo, senal) {
  return json("/api/drive-output", cuerpo, senal);
}

/* ------------------------------------------------------------------ */
/* Binarios <-> base64                                                 */
/* ------------------------------------------------------------------ */

/**
 * El JSON de las funciones no transporta binarios, asi que los PDF y las
 * imagenes viajan en base64. Se convierte por trozos porque
 * `String.fromCharCode(...bytes)` con un array de 400 KB revienta la pila.
 */
export function aBase64(bufferOBlob) {
  const bytes = bufferOBlob instanceof Uint8Array ? bufferOBlob : new Uint8Array(bufferOBlob);
  let binario = "";
  const trozo = 0x8000;
  for (let i = 0; i < bytes.length; i += trozo) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + trozo));
  }
  return btoa(binario);
}

export function desdeBase64(texto) {
  const binario = atob(String(texto || ""));
  const bytes = new Uint8Array(binario.length);
  for (let i = 0; i < binario.length; i++) bytes[i] = binario.charCodeAt(i);
  return bytes;
}

export async function blobABase64(blob) {
  return aBase64(await blob.arrayBuffer());
}
