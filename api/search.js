/**
 * POST /api/search
 * Body: { dni }
 *
 * Devuelve el inventario de certificados de un DNI en JOMISER, Drive y EIN.
 * No descarga nada: eso lo pide el navegador uno por uno a /api/download.
 */

import { jomiserBuscar, normalizarDni } from "./_lib/nexa.js";
import { induccionBuscar, driveBuscarRespaldo, sinRespaldoInnecesario } from "./_lib/drive.js";
import { einBuscarConSesion } from "./_lib/ein.js";

/**
 * EIN es opcional: sin EIN_USUARIO/EIN_PASSWORD la fuente queda desactivada
 * en silencio, igual que Drive sin DRIVE_API_KEY.
 *
 * A diferencia de JOMISER/Drive, EIN no sabe si un curso tiene certificado
 * emitido hasta intentar abrir el reporte, asi que aca solo se listan las
 * filas (estado "PENDIENTE"); /api/download resuelve "SIN CERTIFICADO" al
 * descargar. Cada item lleva `datosDescarga` con la cookie de sesion para
 * que la descarga no tenga que loguearse de nuevo.
 */
async function buscarEin(dni) {
  const usuario = process.env.EIN_USUARIO;
  const password = process.env.EIN_PASSWORD;
  if (!usuario || !password) return { items: [], avisos: [] };

  // el login se reutiliza entre pedidos (lambda caliente) via
  // `einBuscarConSesion`: solo se vuelve a loguear si expiro o si esta es la
  // primera busqueda del proceso
  const r = await einBuscarConSesion(dni, usuario, password);

  const avisos = [];
  if (r.descartadas) {
    avisos.push(`EIN: ${r.descartadas} fila(s) de otro documento descartadas (coincidencia parcial)`);
  }

  const items = r.registros.map((reg) => ({
    id: String(reg.indice),
    empresa: reg.cod,
    curso: reg.curso,
    fecha: reg.inicio,
    estado: "PENDIENTE",
    descargable: true,
    origen: "EIN",
    datosDescarga: { dni, indice: reg.indice, cod: reg.cod, cookie: r.cookie, empresa: r.empresa },
  }));

  return { items, avisos, participante: r.registros[0] ? `${r.registros[0].apellidos}, ${r.registros[0].nombres}` : "" };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const norm = normalizarDni(body.dni);
    if (!norm) {
      res.status(400).json({ error: "DNI invalido" });
      return;
    }

    const salida = {
      dni: norm.dni,
      original: norm.original,
      relleno: norm.relleno,
      participante: "",
      items: [],
      error: null,
      avisos: [],
    };

    const [jomiser, drive, ein, respaldo] = await Promise.allSettled([
      jomiserBuscar(norm.dni),
      induccionBuscar(norm.dni),
      buscarEin(norm.dni),
      driveBuscarRespaldo(norm.dni),
    ]);

    if (jomiser.status === "fulfilled") {
      salida.participante = jomiser.value.participante;
      salida.items = salida.items.concat(jomiser.value.items.map((it) => ({ ...it, origen: "JOMISER" })));
      if (jomiser.value.aviso) salida.avisos.push(jomiser.value.aviso);
    } else {
      salida.error = jomiser.reason?.message || String(jomiser.reason);
    }

    if (drive.status === "fulfilled") {
      salida.items = salida.items.concat(drive.value.items);
      if (drive.value.aviso) salida.avisos.push(drive.value.aviso);
    } else {
      salida.avisos.push(drive.reason?.message || String(drive.reason));
    }

    if (ein.status === "fulfilled") {
      salida.items = salida.items.concat(ein.value.items);
      salida.avisos.push(...ein.value.avisos);
      if (!salida.participante && ein.value.participante) salida.participante = ein.value.participante;
    } else {
      salida.avisos.push(`EIN: ${ein.reason?.message || String(ein.reason)}`);
    }

    if (respaldo.status === "fulfilled") {
      salida.avisos.push(...respaldo.value.avisos);
      salida.items = sinRespaldoInnecesario(salida.items.concat(respaldo.value.items));
      const usados = salida.items.filter((i) => i.respaldo).map((i) => i.codigo);
      if (usados.length) salida.avisos.push(`Drive (respaldo): certificado(s) de ${[...new Set(usados)].join(", ")} que no vienen de JOMISER ni de EIN`);
    } else {
      salida.avisos.push(`Drive (respaldo): ${respaldo.reason?.message || String(respaldo.reason)}`);
    }

    salida.total = salida.items.filter((i) => i.descargable).length;
    res.status(200).json(salida);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
}
