/**
 * USO DE LENTES (columna O) editable desde la ficha de RENOVACION: solo "SI"
 * o "NO", y las tres listas de columnas editables (la regla compartida, el
 * backend de cuenta de servicio y Code.gs) tienen que coincidir, o una de las
 * dos vias rechaza el guardado.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { normalizarLentes, diferenciasFila, DATOS_EDITABLES } from "../shared/estados.js";
import { COLUMNAS_EDITABLES } from "../api/_lib/sheets.js";
import { CABECERA, INDICE } from "../shared/rrcc.js";

test("normalizarLentes deja solo SI o NO; lo que no reconoce queda vacio", () => {
  for (const v of ["SI", "si", " Sí ", "S", "s"]) assert.equal(normalizarLentes(v), "SI", v);
  for (const v of ["NO", "no", " No ", "N"]) assert.equal(normalizarLentes(v), "NO", v);
  for (const v of ["", null, undefined, "CON LENTES", "x"]) assert.equal(normalizarLentes(v), "", String(v));
});

test("diferenciasFila compara USO DE LENTES cuando se escribio", () => {
  const fila = () => CABECERA.map(() => "");
  const esperada = fila();
  const leida = fila();
  esperada[INDICE["USO DE LENTES"]] = "SI";
  leida[INDICE["USO DE LENTES"]] = "NO";
  assert.deepEqual(diferenciasFila(esperada, leida, [], ["USO DE LENTES"]), [
    { codigo: "LENTES", campo: "uso de lentes", esperado: "SI", real: "NO" },
  ]);
  leida[INDICE["USO DE LENTES"]] = "SI";
  assert.deepEqual(diferenciasFila(esperada, leida, [], ["USO DE LENTES"]), []);
});

test("las columnas editables coinciden en la regla compartida, la cuenta de servicio y Code.gs", () => {
  const codigo = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");
  const literal = /const EDITABLES = (\{[^}]*\});/.exec(codigo)?.[1];
  assert.ok(literal, "Code.gs define EDITABLES");
  const deCodeGs = vm.runInNewContext(`(${literal})`);

  const ordenadas = (o) => Object.keys(o).sort();
  assert.deepEqual(ordenadas(COLUMNAS_EDITABLES), ordenadas(DATOS_EDITABLES));
  assert.deepEqual(ordenadas(deCodeGs), ordenadas(DATOS_EDITABLES));
  assert.ok(DATOS_EDITABLES["USO DE LENTES"], "USO DE LENTES es editable");
  // y cada una es una columna real de la hoja
  for (const columna of Object.keys(DATOS_EDITABLES)) assert.ok(columna in INDICE, columna);
});
