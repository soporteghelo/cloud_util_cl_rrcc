/**
 * Que certificados van a la carpeta de la persona y al ZIP: los de los RRCC
 * que siguen en vigor, tambien los POR VENCER (los de respaldo de Drive del
 * ultimo anio suelen estar asi y se quedaban fuera del ZIP).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { certificadosDeCarpeta, claveCertificado } from "../src/lib/renovacion.js";

const deDrive = (codigo, fecha) => ({
  id: `drive-${codigo}`,
  codigo,
  curso: `CURSO ${codigo}`,
  fecha,
  descargable: true,
  origen: "DRIVE",
  respaldo: true,
  archivo: `46041028_${codigo}_${fecha}_PEREZ JUAN.pdf`,
});

const fila = (codigo, estado, certificado) => ({ codigo, estado, certificado });

test("los certificados POR VENCER (ACTUALIZAR) entran a la carpeta y al ZIP, igual que los vigentes", () => {
  const { tareas } = certificadosDeCarpeta({
    detalle: [
      fila("TA", "ACTUALIZAR", deDrive("TA", "2025-10-21")),
      fila("CS", "VIGENTE", deDrive("CS", "2026-03-01")),
    ],
  });
  assert.deepEqual(
    tareas.map((t) => t.archivo),
    ["2025-10-21_CURSO TA.pdf", "2026-03-01_CURSO CS.pdf"]
  );
});

test("vencidos, sin certificado, no descargables y los de EIN de la grilla no entran por la grilla", () => {
  const { tareas } = certificadosDeCarpeta({
    detalle: [
      fila("AE", "VENCIDO", deDrive("AE", "2024-01-10")),
      fila("IE", "NO APLICA", null),
      fila("SQ", "VIGENTE", { ...deDrive("SQ", "2026-02-02"), descargable: false }),
      fila("ES", "VIGENTE", { id: "0", origen: "EIN", descargable: true, curso: "ES", fecha: "2026-01-01" }),
    ],
  });
  assert.deepEqual(tareas, []);
});

test("lo quitado con la x no entra, y un certificado repetido entra una sola vez", () => {
  const ta = deDrive("TA", "2025-10-21");
  const ec = deDrive("EC", "2025-10-19");
  const { tareas } = certificadosDeCarpeta(
    {
      detalle: [fila("TA", "ACTUALIZAR", ta), fila("EC", "ACTUALIZAR", ec), fila("TC", "ACTUALIZAR", ec)],
    },
    new Set([claveCertificado(ta)])
  );
  assert.deepEqual(
    tareas.map((t) => t.codigo),
    ["EC"]
  );
});
