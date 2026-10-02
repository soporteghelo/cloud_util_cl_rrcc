/**
 * Que certificados van a la carpeta de la persona y al ZIP: solo los de los
 * RRCC autorizados ("A") que siguen en vigor, tambien los POR VENCER (los de
 * respaldo de Drive del ultimo anio suelen estar asi y se quedaban fuera).
 * Los de un RRCC "C" o sin tipo no van.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { certificadosDeCarpeta, certificadosDeRrcc, claveCertificado } from "../src/lib/renovacion.js";

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

const deEin = (id, curso) => ({ id, curso, fecha: "2026-01-01", descargable: true, origen: "EIN", datosDescarga: { dni: "46041028" } });

const fila = (codigo, tipo, estado, certificado) => ({ codigo, tipo, estado, certificado });

test("los certificados POR VENCER (ACTUALIZAR) de un RRCC A entran, igual que los vigentes", () => {
  const { tareas } = certificadosDeCarpeta({
    detalle: [
      fila("TA", "A", "ACTUALIZAR", deDrive("TA", "2025-10-21")),
      fila("CS", "A", "VIGENTE", deDrive("CS", "2026-03-01")),
    ],
  });
  assert.deepEqual(
    tareas.map((t) => t.archivo),
    ["2025-10-21_CURSO TA.pdf", "2026-03-01_CURSO CS.pdf"]
  );
});

test("los certificados de un RRCC C o sin tipo no van a la carpeta ni al ZIP", () => {
  const { tareas } = certificadosDeCarpeta({
    detalle: [
      fila("SQ", "C", "VIGENTE", deDrive("SQ", "2026-09-28")),
      fila("PM", "C", "ACTUALIZAR", deDrive("PM", "2025-10-26")),
      fila("IE", "", "VIGENTE", deDrive("IE", "2026-09-25")),
      fila("TA", "A", "VIGENTE", deDrive("TA", "2026-09-26")),
    ],
  });
  assert.deepEqual(
    tareas.map((t) => t.codigo),
    ["TA"]
  );
});

test("vencidos, sin certificado, no descargables y los de EIN de la grilla no entran por la grilla", () => {
  const { tareas } = certificadosDeCarpeta({
    detalle: [
      fila("AE", "A", "VENCIDO", deDrive("AE", "2024-01-10")),
      fila("IE", "A", "NO APLICA", null),
      fila("SQ", "A", "VIGENTE", { ...deDrive("SQ", "2026-02-02"), descargable: false }),
      fila("ES", "A", "VIGENTE", deEin("0", "EXCAVACIONES SUBTERRANEAS")),
    ],
  });
  assert.deepEqual(tareas, []);
});

test("un certificado de EIN del panel no entra si es el de un RRCC C; el de un A y los generales si", () => {
  const esC = deEin("0", "HERRAMIENTAS MANUALES");
  const esA = deEin("1", "EXCAVACIONES SUBTERRANEAS");
  const general = deEin("2", "RIESGOS CRITICOS");
  const { tareas } = certificadosDeCarpeta({
    detalle: [fila("HM", "C", "VIGENTE", esC), fila("ES", "A", "VENCIDO", esA)],
    inventario: { items: [esC, esA, general] },
  });
  assert.deepEqual(
    tareas.map((t) => t.cert.id),
    ["1", "2"]
  );
});

test("lo quitado con la x no entra, y un certificado repetido entra una sola vez", () => {
  const ta = deDrive("TA", "2025-10-21");
  const ec = deDrive("EC", "2025-10-19");
  const { tareas } = certificadosDeCarpeta(
    {
      detalle: [fila("TA", "A", "ACTUALIZAR", ta), fila("EC", "A", "ACTUALIZAR", ec), fila("TC", "A", "ACTUALIZAR", ec)],
    },
    new Set([claveCertificado(ta)])
  );
  assert.deepEqual(
    tareas.map((t) => t.codigo),
    ["EC"]
  );
});

test("certificadosDeRrcc marca cuales entran y con que nombre, segun el tipo que se le pase", () => {
  const ta = deDrive("TA", "2025-10-21");
  const [comoA] = certificadosDeRrcc([fila("TA", " a ", "ACTUALIZAR", ta)]);
  assert.equal(comoA.entra, true, "la A se reconoce aunque venga en minuscula o con espacios");
  assert.equal(comoA.archivo, "2025-10-21_CURSO TA.pdf");
  // la misma tarjeta cambiada a C en la ficha: sale de la carpeta
  const [comoC] = certificadosDeRrcc([fila("TA", "C", "ACTUALIZAR", ta)]);
  assert.equal(comoC.entra, false);
  assert.equal(comoC.archivo, comoA.archivo, "mismo nombre: asi se encuentra para quitarlo");
});
