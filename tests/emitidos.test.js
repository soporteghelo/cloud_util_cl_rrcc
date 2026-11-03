/**
 * Pruebas de EMITIDOS (`src/lib/emitidos.js`): que RRCC entran por la fecha
 * de la hoja y que certificado de JOMISER va en la carpeta de cada uno.
 *
 * La red se simula: `buscar` y `descargar` son funciones de mentira.
 */

import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { autorizadosDelMes, certificadoDeLaFecha, armarZipEmitidos, claveMes, nombreMes } from "../src/lib/emitidos.js";
import { construirDiccionario } from "../shared/estados.js";

const DIC = construirDiccionario([]);

/** Una persona de la hoja con sus RRCC: [codigo, tipo, fecha de capacitacion]. */
const persona = (dni, nombre, riesgos, extra = {}) => ({
  dni,
  nombreCompleto: nombre,
  cargo: "OPERADOR",
  guardia: "A",
  estadoTrabajador: "ACTIVO",
  riesgos: riesgos.map(([codigo, tipo, cap]) => ({ codigo, tipo, cap, venc: "" })),
  ...extra,
});

const PERSONAS = [
  persona("41353513", "ZAPATA RUIZ ANA", [
    ["TA", "A", "2026-10-07"],
    ["AE", "A", "2026-09-30"], // otro mes
    ["PM", "C", "2026-10-07"], // no es "A"
    ["ES", "A", "2026-10-08"],
    ["IE", "C", "2026-10-19"], // IE entra tambien con "C"
    ["SQ", "C", "2026-10-19"], // los demas "C" no
  ]),
  persona("07481337", "ALVARADO QUISPE EDGAR", [["AE", "A", "2026-10-02"]]),
  persona("12345678", "CESADO PEREZ LUIS", [["TA", "A", "2026-10-07"]], { estadoTrabajador: "CESADO" }),
];

test("claveMes y nombreMes", () => {
  assert.equal(claveMes(2026, 10), "2026-10");
  assert.equal(claveMes("2026", "3"), "2026-03");
  assert.equal(nombreMes("2026-10"), "OCTUBRE 2026");
});

test("autorizadosDelMes: solo ACTIVOS, solo 'A' (IE tambien 'C') y solo capacitacion del mes", () => {
  const lista = autorizadosDelMes(PERSONAS, "2026-10");
  assert.deepEqual(
    lista.map((x) => [x.persona.dni, x.rrcc.map((r) => `${r.codigo}${r.tipo}`)]),
    [
      ["07481337", ["AEA"]],
      ["41353513", ["TAA", "ESA", "IEC"]],
    ]
  );
  assert.deepEqual(
    autorizadosDelMes(PERSONAS, "2026-10", { riesgos: new Set(["AE"]) }).map((x) => x.persona.dni),
    ["07481337"]
  );
  assert.equal(autorizadosDelMes(PERSONAS, "2026-11").length, 0);
});

test("certificadoDeLaFecha: el de JOMISER de ese RRCC con la fecha de la hoja", () => {
  const items = [
    { id: "1", origen: "JOMISER", curso: "TRABAJOS EN ALTURA", fecha: "2026-05-01", descargable: true },
    { id: "2", origen: "JOMISER", curso: "TRABAJOS EN ALTURA", fecha: "2026-10-07", descargable: true },
    { id: "3", origen: "EIN", curso: "TRABAJOS EN ALTURA", fecha: "07/10/2026", descargable: true },
  ];
  assert.equal(certificadoDeLaFecha(items, "TA", "2026-10-07", DIC).cert.id, "2");
  const sin = certificadoDeLaFecha(items, "TA", "2026-10-09", DIC);
  assert.equal(sin.cert, null);
  assert.deepEqual(sin.otras, ["2026-10-07", "2026-05-01"]);
  assert.deepEqual(certificadoDeLaFecha(items, "AE", "2026-10-07", DIC).otras, []);
});

test("armarZipEmitidos: una carpeta por RRCC y el INDICE con lo que falta", async () => {
  const inventarios = {
    "41353513": [{ id: "10", origen: "JOMISER", curso: "TRABAJOS EN ALTURA", fecha: "2026-10-07", descargable: true }],
    "07481337": [{ id: "20", origen: "JOMISER", curso: "BLOQUEO Y AISLAMIENTO DE ENERGIAS", fecha: "2026-10-02", descargable: true }],
  };
  const pedidos = [];
  const r = await armarZipEmitidos(autorizadosDelMes(PERSONAS, "2026-10"), {
    diccionario: DIC,
    buscar: async (dni) => {
      pedidos.push(dni);
      return { items: inventarios[dni] || [] };
    },
    descargar: async (cert) => ({ pdf: new TextEncoder().encode(`%PDF ${cert.id}`) }),
  });

  assert.deepEqual(pedidos.sort(), ["07481337", "41353513"]); // el cesado ni se consulta
  assert.equal(r.archivos, 2);
  assert.deepEqual(r.faltantes.map((e) => e.r.codigo), ["ES", "IE"]);
  assert.match(r.faltantes[0].nota, /JOMISER no tiene este RRCC/);

  const zip = await JSZip.loadAsync(await r.blob.arrayBuffer());
  const nombres = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
  assert.deepEqual(nombres, [
    "AE - BLOQUEO Y AISLAMIENTO DE ENERGIAS/07481337_ALVARADO QUISPE EDGAR_2026-10-02.pdf",
    "INDICE.xlsx",
    "TA - TRABAJO EN ALTURA/41353513_ZAPATA RUIZ ANA_2026-10-07.pdf",
  ]);
});
