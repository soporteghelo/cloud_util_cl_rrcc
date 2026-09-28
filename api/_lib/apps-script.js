/** Puente sin credenciales de Google: el Web App de Apps Script hace el trabajo. */
export function appsScriptUrl() {
  return String(process.env.APPS_SCRIPT_URL || "").trim();
}

/** Intentos totales ante una respuesta que no es JSON (el primero + los reintentos). */
const INTENTOS = 3;
/**
 * Espera antes de reintentar (ms x numero de intento, con jitter); se puede
 * cambiar por entorno, las pruebas la ponen a 0. El jitter importa: cuando
 * dos pestañas piden "listado" (la accion mas pesada) casi al mismo tiempo,
 * ambas reciben la pagina rota de Google en el mismo intento y, sin jitter,
 * sus reintentos caen en el mismo instante y vuelven a chocar entre si en
 * cada vuelta. Con una espera aleatoria se desincronizan y la segunda suele
 * encontrar el script libre.
 */
const espera = (intento) => Number(process.env.APPS_SCRIPT_REINTENTO_MS ?? 1200) * intento * (0.5 + Math.random());

/**
 * Tiempo total que este puente puede gastar antes de rendirse con su propio
 * mensaje. Tiene que quedar POR DEBAJO del `maxDuration` de la funcion (60 s
 * en vercel.json).
 *
 * Si se pasa, quien corta es la red de Vercel, y su 504 no es JSON sino una
 * pagina HTML: el navegador solo puede decir "respuesta ilegible (HTTP 504)",
 * sin ninguna pista de que lo que hubo fue una demora. Cortando aca se
 * responde JSON con un mensaje entendible y HTTP 502, que la vista ya sabe
 * reintentar.
 */
const presupuesto = () => Number(process.env.APPS_SCRIPT_PRESUPUESTO_MS ?? 50000);

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Una peticion con tope de tiempo: { r, texto, datos, ms }.
 *  - `datos` es null si la respuesta no era JSON;
 *  - `r` es null si no hubo respuesta (se agoto el tiempo, o fallo la red);
 *  - `ms` es lo que tardo, para saber si queda presupuesto para otro intento.
 */
async function unaPeticion(url, cuerpo, ms) {
  const empezo = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(ms),
    });
    const texto = await r.text();
    try {
      return { r, texto, datos: JSON.parse(texto.replace(/^\uFEFF/, "").trim()), ms: Date.now() - empezo };
    } catch {
      return { r, texto, datos: null, ms: Date.now() - empezo };
    }
  } catch (fallo) {
    // Sin respuesta: la ejecucion en Google pudo haber ocurrido igual, asi que
    // cuenta como una respuesta rota mas (se reintenta, y el error final queda
    // marcado como ambiguo).
    return { r: null, texto: "", datos: null, ms: Date.now() - empezo, fallo };
  }
}

/**
 * `doGet()` (en Code.gs) siempre devuelve el mismo "hello" fijo:
 * {ok:true, servicio:"RRCC Apps Script", version:1}, sin relacion con la
 * accion pedida. Con dos o mas pedidos casi simultaneos al mismo Web App
 * (p.ej. "contexto" + "listado" al cargar el personal), Google a veces
 * entrega esta respuesta en vez de la de `doPost()`. Llega como JSON valido
 * y sin `error`, asi que sin este chequeo pasaria como un exito silencioso:
 * "listado" quedaria en 0 personas sin ningun aviso en la consola. Se
 * reconoce por su forma fija (ninguna accion real trae "servicio") y se
 * trata igual que una pagina rota: se reintenta.
 */
function esRespuestaFantasma(datos) {
  return Boolean(datos) && datos.servicio === "RRCC Apps Script" && datos.version === 1;
}

/** Mensaje legible de una respuesta que no es JSON (normalmente una pagina de error de Google). */
function mensajeDePagina(r, texto, quien = "") {
  // La pagina "No se encontro la pagina / Drive no pudo abrir el archivo" es
  // la respuesta rota de siempre cuando el script tarda o esta saturado: su
  // texto completo (publicidad de Google Drive incluida) no le dice nada a
  // quien usa la app, asi que se resume.
  if (/No se encontr[oó] la p[aá]gina|Page Not Found|Sorry, unable to open the file/i.test(texto)) {
    return `Google respondió "No se encontró la página" en vez de la respuesta de "${quien}": Apps Script está lento o saturado. Vuelve a intentarlo en unos segundos.`;
  }
  const limpio = texto
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  // La pagina de error de Google a veces lleva el mensaje dentro de un
  // <script>, que el recorte de arriba elimina: se rescata de ahi.
  const enScript = /(?:Exception|Error)[: ][^"<\\]{10,240}/.exec(texto);
  return (
    limpio ||
    (enScript && enScript[0].trim()) ||
    `respuesta ilegible de Apps Script (HTTP ${r.status}${texto.trim() ? "" : ", vacia"})`
  );
}

/** Mensaje legible del ultimo intento fallido, haya traido pagina o nada. */
function mensajeDeFallo({ r, texto, fallo }, quien) {
  if (r) return mensajeDePagina(r, texto, quien);
  if (fallo?.name === "TimeoutError" || fallo?.name === "AbortError") {
    return `Apps Script no respondió a tiempo a "${quien}" (${Math.round(presupuesto() / 1000)} s): la hoja está lenta o el script arrancando en frío; vuelve a intentarlo en unos segundos`;
  }
  return `no se pudo hablar con Apps Script: ${fallo?.message || fallo}`;
}

/**
 * Cuando el script tarda (arranque en frio, o la hoja recalculando), Google
 * entrega la respuesta rota: una pagina 404 "No se encontro la pagina Drive"
 * o un HTML vacio, AUNQUE la ejecucion si haya ocurrido (el cambio queda en la
 * hoja). Las acciones del puente son idempotentes (guardar reescribe la misma
 * fila, alta comprueba que el DNI no exista, subir reemplaza el archivo), asi
 * que ante una respuesta que no es JSON se reintenta: la segunda suele salir
 * en unos segundos con el script ya caliente.
 *
 * Un error que SI viene en JSON (validacion, hoja inexistente...) es real y no
 * se reintenta.
 */
export async function pedirAppsScript(servicio, cuerpo) {
  const url = appsScriptUrl();
  if (!url) throw new Error("Apps Script no esta configurado: define APPS_SCRIPT_URL");
  const envio = { servicio, ...cuerpo, token: process.env.APPS_SCRIPT_TOKEN || "" };
  const quien = `${servicio}:${cuerpo?.accion || ""}`;
  const vence = Date.now() + presupuesto();

  let ultima = null;
  for (let intento = 1; intento <= INTENTOS; intento++) {
    ultima = await unaPeticion(url, envio, Math.max(vence - Date.now(), 1));
    if (ultima.datos && !esRespuestaFantasma(ultima.datos)) break;
    if (intento === INTENTOS) break;
    // Empezar un intento que no cabe en el presupuesto solo asegura el 504 de
    // Vercel: si no entran la pausa mas otro intento como el que acaba de
    // fallar, mejor rendirse ahora y responder con un mensaje legible.
    const pausa = espera(intento);
    if (vence - Date.now() < pausa + ultima.ms) break;
    await dormir(pausa);
  }

  const { r, datos } = ultima;
  if (!datos || esRespuestaFantasma(datos)) {
    const e = new Error(
      datos
        ? `Apps Script devolvió el "hello" de doGet en vez de la respuesta de "${quien}" (pedidos simultaneos saturando el Web App)`
        : mensajeDeFallo(ultima, quien)
    );
    e.ambiguo = true; // la ejecucion pudo haber ocurrido: quien escribe debe verificarlo
    throw e;
  }
  // `ok:false` sin `error` es un resultado valido (p.ej. fotoDe: {ok:false,encontrada:false}):
  // no es una falla del puente, y quien llama ya sabe leer ese campo. Solo se
  // relanza cuando el HTTP fallo o Code.gs de verdad atrapo una excepcion (esa
  // rama siempre pone `error`).
  if (!r.ok || datos.error) throw new Error(datos.error || `Apps Script respondio HTTP ${r.status}`);
  return datos;
}
