/**
 * La carpeta de salida de una persona queda solo con lo de la ultima
 * renovacion: lo de corridas anteriores va a la papelera de Drive.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { limpiarCarpeta } from "../src/lib/renovacion.js";

/** Drive simulado detras de /api/drive-output: lista `enCarpeta` y anota lo que se elimina. */
function driveFalso(enCarpeta, { fallaListar = false } = {}) {
  const pedidos = [];
  globalThis.fetch = async (_ruta, op) => {
    const b = JSON.parse(op.body);
    pedidos.push(b);
    const json = (o, status = 200) =>
      new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (b.accion === "listar") return fallaListar ? json({ error: "Drive caido" }, 502) : json({ ok: true, archivos: enCarpeta });
    if (b.accion === "eliminar") return json({ ok: true, eliminados: b.nombres });
    return json({ error: "inesperado" }, 400);
  };
  return pedidos;
}

const archivo = (name, mimeType = "application/pdf") => ({ id: name, name, mimeType });

test("se eliminan los archivos de renovaciones anteriores y se conserva lo nuevo", async () => {
  const pedidos = driveFalso([
    archivo("2026-11-26_EXCAVACIONES.pdf"),
    archivo("2025-01-10_TRABAJO EN ALTURA.pdf"), // de una renovacion vieja
    archivo("FOTOCHECK_PEREZ JUAN.png", "image/png"),
    archivo("FOTOCHECK_PEREZ  JUAN ANTIGUO.png", "image/png"), // nombre anterior de la persona
    archivo("Autorizacion_RRCC_PEREZ JUAN.docx"),
    archivo("SUBCARPETA", "application/vnd.google-apps.folder"),
  ]);
  const salida = { carpetaId: "C1", certificados: [{ nombre: "2026-11-26_EXCAVACIONES.pdf" }], fotocheck: null, word: null };

  await limpiarCarpeta(salida, [
    "2026-11-26_EXCAVACIONES.pdf",
    "FOTOCHECK_PEREZ JUAN.png",
    "Autorizacion_RRCC_PEREZ JUAN.docx",
  ]);

  const eliminar = pedidos.find((p) => p.accion === "eliminar");
  assert.deepEqual(eliminar.nombres, ["2025-01-10_TRABAJO EN ALTURA.pdf", "FOTOCHECK_PEREZ  JUAN ANTIGUO.png"]);
  assert.deepEqual(salida.eliminados, eliminar.nombres);
});

test("lo que esta renovacion no pudo subir se conserva (la version anterior tiene el mismo nombre)", async () => {
  const pedidos = driveFalso([archivo("2026-05-01_ESPACIOS CONFINADOS.pdf"), archivo("FOTOCHECK_X.png", "image/png")]);
  const salida = { carpetaId: "C1", certificados: [], fotocheck: { nombre: "FOTOCHECK_X.png" } };
  // el certificado de EC fallo al subir, pero estaba pedido
  await limpiarCarpeta(salida, ["2026-05-01_ESPACIOS CONFINADOS.pdf", "FOTOCHECK_X.png"]);
  assert.equal(pedidos.some((p) => p.accion === "eliminar"), false, "no se borra nada");
});

test("los nombres se comparan como los deja la cuenta de servicio (espacios)", async () => {
  const pedidos = driveFalso([archivo("2026-01-01_RIESGOS CRITICOS.pdf")]);
  await limpiarCarpeta({ carpetaId: "C1", certificados: [] }, ["2026-01-01_RIESGOS  CRITICOS.pdf "]);
  assert.equal(pedidos.some((p) => p.accion === "eliminar"), false);
});

test("si no se puede listar la carpeta solo se avisa: la renovacion sigue", async () => {
  driveFalso([], { fallaListar: true });
  const avisos = [];
  await limpiarCarpeta({ carpetaId: "C1", certificados: [] }, [], { log: (m, n) => avisos.push([m, n]) });
  assert.match(avisos[0][0], /no se pudieron quitar/);
  assert.equal(avisos[0][1], "warn");
});
