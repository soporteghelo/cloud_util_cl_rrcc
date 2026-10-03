/**
 * Cargo -> cursos "A" de MATRIZ_PUESTO (panel de RENOVACION) y la lista de
 * cargos que alimenta los buscadores.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { cargosDeMatriz, exigenciasDeCargo } from "../shared/estados.js";

// cabecera como la arma Code.gs: ["Cargo", "Area", ...codigos]
const MATRIZ = [
  ["Cargo", "Area", "AE", "IE", "TA", "CS", "EC", "OB"],
  ["OPERADOR DE SCOOP", "AVANCES", "A", "", "A", "", "C", ""],
  ["OPERADOR DE SCOOP", "SERVICIOS", "A", "", "A", "", "C", ""],
  ["MECÁNICO GENERAL II", "MANTENIMIENTO", "A", "A", "", "A", "", "A"],
  ["MECÁNICO GENERAL II", "AVANCES", "A", "", "", "", "", ""],
  ["PERSONAL DE LIMPIEZA", "SERVICIOS", "", "", "", "", "C", ""],
  ["", "", "", "", "", "", "", ""],
];

test("cargosDeMatriz: sin la cabecera, sin repetir y en orden", () => {
  assert.deepEqual(cargosDeMatriz(MATRIZ), ["MECÁNICO GENERAL II", "OPERADOR DE SCOOP", "PERSONAL DE LIMPIEZA"]);
  assert.deepEqual(cargosDeMatriz([]), []);
  assert.deepEqual(cargosDeMatriz([["Puesto", "Area"]]), [], "sin columna Cargo no hay cargos");
});

test("exigenciasDeCargo: las A en el orden del catalogo, y las filas iguales juntan sus areas", () => {
  assert.deepEqual(exigenciasDeCargo(MATRIZ, "OPERADOR DE SCOOP"), [
    { areas: ["AVANCES", "SERVICIOS"], autorizados: ["AE", "TA"], capacitados: ["EC"] },
  ]);
});

test("exigenciasDeCargo: el mismo cargo con otras A en otra area va aparte", () => {
  const grupos = exigenciasDeCargo(MATRIZ, "MECÁNICO GENERAL II");
  assert.equal(grupos.length, 2);
  assert.deepEqual(grupos[0], { areas: ["MANTENIMIENTO"], autorizados: ["AE", "IE", "CS", "OB"], capacitados: [] });
  assert.deepEqual(grupos[1], { areas: ["AVANCES"], autorizados: ["AE"], capacitados: [] });
});

test("exigenciasDeCargo: no importan tildes, mayusculas ni espacios de mas", () => {
  assert.equal(exigenciasDeCargo(MATRIZ, "  mecanico   general ii ").length, 2);
});

test("exigenciasDeCargo: un cargo sin A se devuelve igual (con sus C); uno que no esta, vacio", () => {
  assert.deepEqual(exigenciasDeCargo(MATRIZ, "PERSONAL DE LIMPIEZA"), [
    { areas: ["SERVICIOS"], autorizados: [], capacitados: ["EC"] },
  ]);
  assert.deepEqual(exigenciasDeCargo(MATRIZ, "OPERADOR DE RAPTOR"), []);
  assert.deepEqual(exigenciasDeCargo(MATRIZ, ""), []);
});
