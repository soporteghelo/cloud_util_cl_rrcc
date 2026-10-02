/**
 * Servidor local que emula el enrutado de Vercel (estatico + /api/*).
 * Sirve para probar sin instalar la CLI de Vercel:
 *
 *    npm run build && node dev-server.js      ->  http://localhost:3000
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(RAIZ, "dist");

/**
 * Carga .env (gitignorado) para que EIN_USUARIO/EIN_PASSWORD/DRIVE_* etc.
 * funcionen en local igual que en Vercel, sin tener que exportarlas a mano
 * en cada terminal. Una variable ya presente en el entorno no se pisa.
 */
function cargarEnv() {
  const ruta = path.join(RAIZ, ".env");
  if (!fs.existsSync(ruta)) return;
  for (const linea of fs.readFileSync(ruta, "utf8").split(/\r?\n/)) {
    const t = linea.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const clave = t.slice(0, i).trim();
    let valor = t.slice(i + 1).trim();
    if (/^".*"$/.test(valor) || /^'.*'$/.test(valor)) valor = valor.slice(1, -1);
    if (!(clave in process.env)) process.env[clave] = valor;
  }
}
cargarEnv();

const PUERTO = Number(process.env.PORT || 3000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Envoltorio con la forma de req/res que esperan las funciones de Vercel. */
function adaptar(res) {
  res.status = (c) => {
    res.statusCode = c;
    return res;
  };
  res.json = (o) => {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(o));
    return res;
  };
  res.send = (b) => {
    res.end(Buffer.isBuffer(b) ? b : String(b));
    return res;
  };
  return res;
}

/**
 * Un pedido que el navegador corta a mitad de camino (AbortController al
 * detener o reintentar) hace fallar la lectura del cuerpo con "aborted". En un
 * handler async eso era una promesa rechazada sin atrapar, y Node tumbaba el
 * servidor entero: desde ahi todo daba "Failed to fetch". Cualquier error de
 * un pedido se queda en ese pedido.
 */
const servidor = http.createServer((req, res) => {
  atender(req, res).catch((e) => {
    if (req.destroyed || res.destroyed) return; // el navegador ya se fue
    console.error(e);
    if (!res.headersSent) adaptar(res).status(500).json({ error: e.message });
    else res.end();
  });
});

async function atender(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith("/api/")) {
    const nombre = url.pathname.slice("/api/".length).replace(/[^a-z0-9_-]/gi, "");
    const archivo = path.join(RAIZ, "api", `${nombre}.js`);
    if (!fs.existsSync(archivo)) {
      adaptar(res).status(404).json({ error: "función no encontrada" });
      return;
    }

    const trozos = [];
    for await (const t of req) trozos.push(t);
    const crudo = Buffer.concat(trozos).toString("utf8");
    try {
      req.body = crudo ? JSON.parse(crudo) : {};
    } catch {
      adaptar(res).status(400).json({ error: "cuerpo JSON inválido" });
      return;
    }

    try {
      const mod = await import(`file://${archivo}?t=${Date.now()}`);
      await mod.default(req, adaptar(res));
    } catch (e) {
      console.error(e);
      if (!res.headersSent) adaptar(res).status(500).json({ error: e.message });
    }
    return;
  }

  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  let archivo = path.join(DIST, rel);
  if (!fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
    archivo = path.join(DIST, "index.html"); // SPA fallback
  }
  res.setHeader("Content-Type", MIME[path.extname(archivo)] || "application/octet-stream");
  fs.createReadStream(archivo)
    .on("error", (e) => {
      console.error(e);
      res.destroy();
    })
    .pipe(res);
}

// Lo que una funcion deje rechazado o lanzado por fuera del pedido (una
// promesa sin await, un timer) se anota y el servidor sigue atendiendo.
process.on("unhandledRejection", (e) => console.error("promesa sin atrapar:", e));
process.on("uncaughtException", (e) => console.error("error sin atrapar:", e));

// el puerto ocupado si cierra el proceso: sin esto quedaria vivo sin escuchar
servidor.on("error", (e) => {
  console.error(e.message);
  process.exit(1);
});

servidor.listen(PUERTO, () => {
  console.log(`listo -> http://localhost:${PUERTO}`);
});
