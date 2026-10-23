/**
 * POST /api/download
 * Body: { id }
 *
 * Devuelve UN PDF (binario). El navegador arma el ZIP, porque una funcion
 * serverless no puede escribir en disco ni devolver mas de 4.5 MB por
 * respuesta.
 */

import { jomiserDescargar } from "./_lib/nexa.js";
import { driveDescargar } from "./_lib/drive.js";
import { einDescargar } from "./_lib/ein.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Usa POST" });
    return;
  }

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};

    if (body.origen === "EIN") {
      // las credenciales permiten volver a loguear si la cookie de la busqueda ya expiro
      const pdf = await einDescargar(body, process.env.EIN_USUARIO, process.env.EIN_PASSWORD);
      if (pdf === null) {
        res.status(200).json({ sinCertificado: true, motivo: "sin certificado emitido" });
        return;
      }
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", String(pdf.length));
      res.status(200).send(pdf);
      return;
    }

    const deDrive = body.origen === "DRIVE" || body.origen === "INDUCCION";
    const pdf = deDrive ? await driveDescargar(body.id) : await jomiserDescargar(body.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", String(pdf.length));
    res.status(200).send(pdf);
  } catch (e) {
    res.status(502).json({ error: e?.message || String(e) });
  }
}
