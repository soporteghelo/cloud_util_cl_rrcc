/**
 * Fuente EIN / WebNexa (ASP.NET WebForms + SAP Crystal Reports).
 * Puerto de escritorio/descargar_certificados.py (clase ClienteEin) a Node,
 * adaptado a dos funciones serverless sin estado compartido: buscar() hace
 * login + busqueda y le pasa al navegador un payload opaco (datosDescarga)
 * con la cookie de sesion, para que descargar() no tenga que loguear de
 * nuevo por cada certificado.
 *
 * EIN busca por coincidencia PARCIAL de documento (ver README): se descarta
 * toda fila cuyo NDocumento no sea exactamente el DNI pedido.
 *
 * El servidor a veces devuelve el certificado de OTRA persona (bug de
 * concurrencia del reporte Crystal, ~1 de cada 4 descargas). Cada PDF se
 * valida (se extrae su texto y se verifica <COD><DNI>) antes de aceptarlo.
 */

import zlib from "node:zlib";
import { desescapar, sinTags, esPdf } from "./nexa.js";

const EIN_BASE = "http://44.193.188.247/WebNexa";
const EIN_LOGIN = `${EIN_BASE}/serviceit/Login_g.aspx`;
const EIN_GRID = `${EIN_BASE}/serviceit/WebFormContraCerti.aspx`;
const PREFIJO_GRID = "ctl00$ContentPlaceHolder1$";

// Vercel Hobby: 60s de limite duro por funcion. El script de escritorio
// reintenta 4 veces si el servidor devuelve el certificado de otra persona;
// aca se recorta a 2 para no arriesgarse a que la funcion se corte a mitad
// de una descarga (cada intento vuelve a buscar + seleccionar + exportar).
const EIN_INTENTOS_VALIDACION = 2;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";

/* ------------------------------------------------------------------ */
/* Cliente HTTP: cookies + redirects a mano                            */
/* ------------------------------------------------------------------ */

function mezclarCookies(cookiePrevia, res) {
  const jar = new Map();
  for (const par of (cookiePrevia || "").split(";")) {
    const i = par.indexOf("=");
    if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  const nuevas =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  for (const sc of nuevas) {
    const par = sc.split(";")[0];
    const i = par.indexOf("=");
    if (i > 0) jar.set(par.slice(0, i).trim(), par.slice(i + 1).trim());
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch con cookie-jar manual y seguimiento de redirects a mano: el fetch de
 * Node no trae cookie-jar propio, y con redirect:"follow" no deja ver los
 * Set-Cookie de saltos intermedios (el login de EIN redirige tras el POST).
 */
async function einPedir(url, { method = "GET", body, cookie = "", referer, timeout = 45000, intentos = 3 } = {}) {
  let ultimo;
  for (let intento = 0; intento < intentos; intento++) {
    try {
      let actual = url;
      let cookieActual = cookie;
      let metodoActual = method;
      let cuerpoActual = body;

      for (let salto = 0; salto < 6; salto++) {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeout);
        let res;
        try {
          const headers = {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,*/*",
            "Accept-Language": "es-ES,es;q=0.9",
          };
          if (cookieActual) headers.Cookie = cookieActual;
          if (referer) headers.Referer = referer;

          let cuerpoEnviado;
          if (metodoActual === "POST" && cuerpoActual) {
            headers["Content-Type"] = "application/x-www-form-urlencoded";
            cuerpoEnviado = new URLSearchParams(cuerpoActual).toString();
          }

          res = await fetch(actual, {
            method: metodoActual,
            headers,
            body: cuerpoEnviado,
            redirect: "manual",
            signal: ctrl.signal,
          });
        } finally {
          clearTimeout(t);
        }

        cookieActual = mezclarCookies(cookieActual, res);

        const ubicacion = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && ubicacion) {
          actual = new URL(ubicacion, actual).toString();
          metodoActual = "GET"; // tras un POST, el redirect se sigue como GET
          cuerpoActual = undefined;
          continue;
        }

        const buffer = Buffer.from(await res.arrayBuffer());
        if (res.status >= 500) throw new Error(`HTTP ${res.status} en ${actual}`);
        return { res, buffer, url: actual, cookie: cookieActual };
      }
      throw new Error("demasiados redirects en EIN");
    } catch (e) {
      ultimo = e;
      if (intento < intentos - 1) await dormir(1500 + intento * 2000);
    }
  }
  throw ultimo;
}

/* ------------------------------------------------------------------ */
/* ASP.NET WebForms                                                    */
/* ------------------------------------------------------------------ */

function camposOcultos(html) {
  const campos = {};
  const tags = html.match(/<input[^>]*type="hidden"[^>]*>/gi) || [];
  for (const tag of tags) {
    const nombre = tag.match(/name="([^"]+)"/i);
    const valor = tag.match(/value="([^"]*)"/i);
    if (nombre) campos[desescapar(nombre[1])] = valor ? desescapar(valor[1]) : "";
  }
  return campos;
}

/* ------------------------------------------------------------------ */
/* Login                                                               */
/* ------------------------------------------------------------------ */

export async function einLogin(usuario, password) {
  const r1 = await einPedir(EIN_LOGIN);
  const campos = camposOcultos(r1.buffer.toString("utf8"));
  Object.assign(campos, { txtusuario: usuario, txtpass: password, btnlogg: "Ingresar" });

  const r2 = await einPedir(EIN_LOGIN, { method: "POST", body: campos, cookie: r1.cookie, referer: EIN_LOGIN });
  const pagina = r2.buffer.toString("utf8");
  if (r2.url.includes("Login_g.aspx") || pagina.includes("txtusuario")) {
    throw new Error("no se pudo iniciar sesion en EIN (revisa usuario y contrasena)");
  }
  return r2.cookie;
}

/**
 * Sesion EIN cacheada ENTRE invocaciones de la funcion serverless.
 *
 * Vercel reutiliza el mismo proceso de Node para pedidos seguidos ("lambda
 * caliente"): en una renovacion en lote, cada persona volvia a pagar el
 * login completo (2 ida y vuelta HTTP) aunque la sesion anterior siguiera
 * viva. Aca se guarda la cookie con su hora y se reutiliza mientras no haya
 * pasado `SESION_VIDA`; si el servidor ya la invalido (o el proceso es uno
 * nuevo), `einBuscar` lo nota (el grid deja de traer "DropInteresados") y
 * se reintenta UNA vez con login fresco.
 */
const SESION_VIDA = 8 * 60 * 1000;
let sesion = null; // { cookie, usuario, ts }

function sesionFresca(usuario) {
  return sesion && sesion.usuario === usuario && Date.now() - sesion.ts < SESION_VIDA ? sesion : null;
}

async function iniciarSesion(usuario, password) {
  const cookie = await einLogin(usuario, password);
  sesion = { cookie, usuario, ts: Date.now() };
  return sesion;
}

/**
 * Busca los cursos de `dni` en EIN, logueandose solo si hace falta.
 * Devuelve lo mismo que `einBuscar` (mas `cookie`/`empresa` ya frescos para
 * que quien llame se los pase a la descarga).
 */
export async function einBuscarConSesion(dni, usuario, password) {
  const previa = sesionFresca(usuario);
  try {
    const activa = previa || (await iniciarSesion(usuario, password));
    return await einBuscar(dni, activa.cookie);
  } catch (e) {
    if (!previa) throw e; // ya era login fresco: no hay nada mas que probar
    sesion = null;
    const nueva = await iniciarSesion(usuario, password);
    return einBuscar(dni, nueva.cookie);
  }
}

/* ------------------------------------------------------------------ */
/* Busqueda                                                            */
/* ------------------------------------------------------------------ */

async function paginaGrid(cookie) {
  const r = await einPedir(EIN_GRID, { cookie });
  const pagina = r.buffer.toString("utf8");
  if (!pagina.includes("DropInteresados")) {
    throw new Error("sesion EIN expirada o sin acceso a Cert. x Persona");
  }
  let empresa = "2"; // NEXA MINERIA, por si no se puede leer el combo
  const combo = pagina.match(/id="ctl00_ContentPlaceHolder1_DropInteresados"[\s\S]*?<\/select>/i);
  if (combo) {
    const sel =
      combo[0].match(/<option[^>]*selected[^>]*value="([^"]*)"/i) ||
      combo[0].match(/<option[^>]*value="([^"]*)"[^>]*selected/i);
    if (sel) empresa = desescapar(sel[1]);
  }
  return { pagina, cookie: r.cookie, empresa };
}

async function buscarHtml(dni, cookie, empresaConocida) {
  const grid = await paginaGrid(cookie);
  const empresa = empresaConocida || grid.empresa;
  const campos = camposOcultos(grid.pagina);
  Object.assign(campos, {
    [PREFIJO_GRID + "DropInteresados"]: empresa,
    [PREFIJO_GRID + "DropOpf"]: "DNI",
    [PREFIJO_GRID + "txtdat"]: dni,
    [PREFIJO_GRID + "btnfil"]: "Buscar",
  });
  const r = await einPedir(EIN_GRID, { method: "POST", body: campos, cookie: grid.cookie, referer: EIN_GRID });
  return { pagina: r.buffer.toString("utf8"), cookie: r.cookie, empresa };
}

/**
 * Lista los cursos del participante (una fila = un curso). Solo se aceptan
 * filas cuyo NDocumento sea EXACTAMENTE el DNI pedido: EIN busca por
 * coincidencia parcial y, por ejemplo, "0350889" tambien devuelve los
 * certificados de "10350889".
 */
export async function einBuscar(dni, cookie, empresaConocida) {
  const { pagina, cookie: cookieNueva, empresa } = await buscarHtml(dni, cookie, empresaConocida);

  const registros = [];
  let descartadas = 0;

  const tabla = pagina.match(/id="ctl00_ContentPlaceHolder1_GridView1"[\s\S]*?<\/table>/i);
  if (!tabla) return { registros, descartadas, cookie: cookieNueva, empresa };

  const filas = tabla[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  let indice = 0;
  for (const fila of filas) {
    if (!/<td/i.test(fila)) continue; // encabezado
    const celdas = (fila.match(/<td[^>]*>[\s\S]*?<\/td>/gi) || []).map((c) =>
      sinTags(c.replace(/^<td[^>]*>|<\/td>$/gi, ""))
    );
    if (celdas.length < 12) continue;

    const registro = {
      indice,
      cod: celdas[1],
      dni: celdas[2],
      apellidos: celdas[3],
      nombres: celdas[4],
      cargo: celdas[5],
      curso: celdas[6],
      promedio: celdas[7],
      condicion: celdas[8],
      inicio: celdas[9],
      final: celdas[10],
    };
    indice++;

    if (registro.dni !== dni) {
      descartadas++;
      continue;
    }
    registros.push(registro);
  }
  return { registros, descartadas, cookie: cookieNueva, empresa };
}

/* ------------------------------------------------------------------ */
/* Apertura del reporte + exportacion a PDF                            */
/* ------------------------------------------------------------------ */

/** Pulsa "Selec." en la fila indicada. null = sin certificado emitido. */
async function einAbrirReporte(dni, indice, cookie, empresa) {
  const { pagina, cookie: cookieNueva } = await buscarHtml(dni, cookie, empresa);
  const campos = camposOcultos(pagina);
  Object.assign(campos, {
    __EVENTTARGET: PREFIJO_GRID + "GridView1",
    __EVENTARGUMENT: `Select$${indice}`,
    [PREFIJO_GRID + "DropInteresados"]: empresa,
    [PREFIJO_GRID + "DropOpf"]: "DNI",
    [PREFIJO_GRID + "txtdat"]: dni,
  });
  delete campos[PREFIJO_GRID + "btnfil"];

  const r = await einPedir(EIN_GRID, { method: "POST", body: campos, cookie: cookieNueva, referer: EIN_GRID });
  const paginaReporte = r.buffer.toString("utf8");
  const camposReporte = camposOcultos(paginaReporte);
  const tieneVisor = Object.keys(camposReporte).some((k) => k.startsWith("__CRYSTALSTATE"));
  if (!tieneVisor) return null; // sin visor Crystal = desaprobado / no emitido

  return { urlReporte: r.url, pagina: paginaReporte, cookie: r.cookie };
}

/** Ejecuta el "Print to PDF" del visor Crystal. Devuelve el buffer. */
async function einExportarPdf(urlReporte, pagina, cookie) {
  const campos = camposOcultos(pagina);
  const claveEstado = Object.keys(campos).find((k) => k.startsWith("__CRYSTALSTATE"));
  const control = claveEstado.slice("__CRYSTALSTATE".length); // ctl00$...$CrystalReportViewer1
  const partesControl = control.split("$");
  const vid = partesControl[partesControl.length - 1];

  Object.assign(campos, {
    __EVENTTARGET: control,
    __EVENTARGUMENT: '{"text":"PDF", "range":"false", "tb":"crexport"}',
    [`${vid}_toptoolbar_search_textField`]: "Find...",
    [`text_${vid}_toptoolbar_selectPg`]: "1 of 1+",
    [`text_${vid}_toptoolbar_zoom`]: "100%",
  });

  const r = await einPedir(urlReporte, { method: "POST", body: campos, cookie, referer: urlReporte, timeout: 60000 });
  return r.buffer;
}

/* ------------------------------------------------------------------ */
/* Validacion del PDF                                                  */
/* ------------------------------------------------------------------ */

/** Extrae el texto visible de un PDF (streams Flate). Devuelve un Buffer. */
function textoDePdf(buffer) {
  const partes = [];
  const crudo = buffer.toString("latin1"); // preserva bytes 1:1 para el regex
  const re = /stream\r?\n([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(crudo))) {
    try {
      partes.push(zlib.inflateSync(Buffer.from(m[1], "latin1")));
    } catch {
      /* stream no comprimido con zlib estandar, se ignora */
    }
  }
  return Buffer.concat(partes);
}

/** true = correcto, false = es de otra persona, null = no verificable. */
function validarPdf(buffer, cod, dni) {
  const texto = textoDePdf(buffer);
  if (!texto.length) return null;
  if (texto.includes(Buffer.from(cod + dni))) return true;

  const encontrados = new Set();
  const re = /Con DNI:\s*(\d+)/g;
  const textoStr = texto.toString("latin1");
  let m;
  while ((m = re.exec(textoStr))) encontrados.add(m[1]);
  if (encontrados.size) return encontrados.has(dni);

  return texto.includes(Buffer.from(dni)) || null;
}

/* ------------------------------------------------------------------ */
/* Descarga                                                             */
/* ------------------------------------------------------------------ */

/**
 * Descarga y valida el certificado de una fila. Devuelve el buffer del PDF,
 * o null si el curso no tiene certificado emitido (desaprobado, por ej.).
 */
export async function einDescargar({ dni, indice, cod, cookie, empresa }) {
  let cookieActual = cookie;

  for (let intento = 1; intento <= EIN_INTENTOS_VALIDACION; intento++) {
    const reporte = await einAbrirReporte(dni, indice, cookieActual, empresa);
    if (!reporte) return null;
    cookieActual = reporte.cookie;

    const pdf = await einExportarPdf(reporte.urlReporte, reporte.pagina, cookieActual);
    if (!esPdf(pdf)) {
      if (intento < EIN_INTENTOS_VALIDACION) continue;
      throw new Error("EIN: respuesta no-PDF");
    }

    const estado = validarPdf(pdf, cod, dni);
    if (estado === true || estado === null) return pdf;
    if (intento === EIN_INTENTOS_VALIDACION) {
      throw new Error(`EIN devolvio siempre un certificado equivocado (${EIN_INTENTOS_VALIDACION} intentos)`);
    }
  }
  return null;
}
