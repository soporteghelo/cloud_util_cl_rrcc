/**
 * Pruebas de EXPORTACION (`src/lib/exportacion.js`): quien entra en la lista
 * de autorizados y que trae el ZIP de certificados.
 *
 * La red se simula: `buscar` y `descargar` son funciones de mentira, asi que
 * lo que se prueba es la regla (que certificado va con cada RRCC, que pasa
 * cuando falta) y no JOMISER/EIN/Drive.
 */

import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import { autorizadosPorPersona, hojasDeExportacion, armarZipExportacion, partirEnZips } from "../src/lib/exportacion.js";
import { construirDiccionario } from "../shared/estados.js";

const HOY = "2026-10-03";

/** Una persona de la hoja con sus RRCC: [codigo, tipo, fecha de capacitacion]. */
const persona = (dni, nombre, riesgos, extra = {}) => ({
  dni,
  nombreCompleto: nombre,
  cargo: "OPERADOR",
  area: "MINA",
  guardia: "A",
  estadoTrabajador: "ACTIVO",
  riesgos: riesgos.map(([codigo, tipo, cap]) => ({ codigo, tipo, cap, venc: "" })),
  ...extra,
});

const PERSONAS = [
  // TA vigente (60 dias), AE por vencer (340 dias), SQ vencido, PM es "C"
  persona("41353513", "ZAPATA RUIZ ANA", [
    ["TA", "A", "2026-08-04"],
    ["AE", "A", "2025-10-28"],
    ["SQ", "A", "2025-01-10"],
    ["PM", "C", "2026-08-04"],
  ]),
  persona("07481337", "ALVARADO QUISPE EDGAR", [["TA", "A", "2026-05-01"]]),
  // cesado: aunque tenga "A" vigente, no se exporta
  persona("70000001", "CESADO PEREZ LUIS", [["TA", "A", "2026-08-04"]], { estadoTrabajador: "CESADO" }),
  // sin ninguna "A" en vigor
  persona("70000002", "SOLO VENCIDO JUAN", [["TA", "A", "2024-01-01"]]),
];

const opciones = (extra = {}) => ({ hoy: HOY, ...extra });

test("solo entra personal ACTIVO con RRCC 'A' VIGENTE o POR VENCER, por apellidos", () => {
  const lista = autorizadosPorPersona(PERSONAS, opciones());
  assert.deepEqual(
    lista.map((x) => [x.persona.dni, x.rrcc.map((r) => `${r.codigo}:${r.estado}`)]),
    [
      ["07481337", ["TA:VIGENTE"]],
      ["41353513", ["AE:ACTUALIZAR", "TA:VIGENTE"]],
    ]
  );
});

test("el filtro de estado deja solo las autorizaciones de ese estado (y a quien las tiene)", () => {
  const vigentes = autorizadosPorPersona(PERSONAS, opciones({ estados: new Set(["VIGENTE"]) }));
  assert.deepEqual(vigentes.map((x) => x.rrcc.map((r) => r.codigo)), [["TA"], ["TA"]]);

  const porVencer = autorizadosPorPersona(PERSONAS, opciones({ estados: new Set(["ACTUALIZAR"]) }));
  assert.deepEqual(porVencer.map((x) => [x.persona.dni, x.rrcc.map((r) => r.codigo)]), [["41353513", ["AE"]]]);

  // un estado que no es exportable no abre la puerta a los vencidos
  const raro = autorizadosPorPersona(PERSONAS, opciones({ estados: new Set(["VENCIDO"]) }));
  assert.ok(raro.every((x) => x.rrcc.every((r) => r.estado !== "VENCIDO")));
});

test("filtros de RRCC y de texto", () => {
  const soloAe = autorizadosPorPersona(PERSONAS, opciones({ riesgos: new Set(["AE"]) }));
  assert.deepEqual(soloAe.map((x) => x.persona.dni), ["41353513"]);

  const porNombre = autorizadosPorPersona(PERSONAS, opciones({ texto: "alvarado" }));
  assert.deepEqual(porNombre.map((x) => x.persona.dni), ["07481337"]);
});

test("Excel: una fila por autorizacion y una por persona", () => {
  const [autorizaciones, personas] = hojasDeExportacion(autorizadosPorPersona(PERSONAS, opciones()));
  assert.equal(autorizaciones.filas.length, 3);
  assert.equal(personas.filas.length, 2);
  const ana = personas.filas.find((f) => f[1] === "41353513");
  assert.deepEqual(ana.slice(5), [2, "TA", "AE"]);
});

/* ------------------------------------------------------------------ */
/* ZIP                                                                 */
/* ------------------------------------------------------------------ */

const DICCIONARIO = construirDiccionario([]);

/** Inventario de mentira por DNI. `codigo` hace que el item se mapee sin diccionario. */
const INVENTARIOS = {
  41353513: [
    { id: "j1", origen: "JOMISER", codigo: "TA", curso: "TRABAJOS EN ALTURA", fecha: "2026-08-04", descargable: true },
    // uno mas viejo del mismo RRCC: no debe ser el que viaje
    { id: "j0", origen: "JOMISER", codigo: "TA", curso: "TRABAJOS EN ALTURA", fecha: "2025-08-01", descargable: true },
    { id: "e1", origen: "EIN", codigo: "AE", curso: "BLOQUEO DE ENERGIAS", fecha: "2025-10-28", descargable: true },
  ],
};

function fuentesDeMentira({ fallaBuscar = [] } = {}) {
  const bajados = [];
  return {
    bajados,
    buscar: async (dni) => {
      if (fallaBuscar.includes(dni)) throw new Error("JOMISER no responde");
      return { items: INVENTARIOS[dni] || [], avisos: [] };
    },
    descargar: async (cert) => {
      bajados.push(cert.id);
      if (cert.origen === "EIN") return { sinCertificado: true };
      return { pdf: new TextEncoder().encode(`%PDF ${cert.id}`).buffer };
    },
  };
}

async function abrirZip(blob) {
  return JSZip.loadAsync(Buffer.from(await blob.arrayBuffer()));
}

test("ZIP: el certificado mas reciente de cada RRCC, suelto en la raiz, y el indice de lo que falta", async () => {
  const lista = autorizadosPorPersona(PERSONAS, opciones());
  const fuentes = fuentesDeMentira();
  const r = await armarZipExportacion(lista, { diccionario: DICCIONARIO, ...fuentes });

  const zip = await abrirZip(r.blob);
  // sin carpetas: ni entradas de directorio ni "/" en los nombres
  assert.ok(Object.values(zip.files).every((f) => !f.dir && !f.name.includes("/")), Object.keys(zip.files).join(", "));
  const nombres = Object.keys(zip.files).sort();
  assert.deepEqual(nombres, ["41353513_TA_2026-08-04_ZAPATA RUIZ ANA.pdf", "INDICE.xlsx"]);
  assert.equal(await zip.file(nombres[0]).async("string"), "%PDF j1");
  assert.ok(!fuentes.bajados.includes("j0"), "el certificado viejo no se descarga");

  assert.equal(r.archivos, 1);
  assert.deepEqual(
    r.faltantes.map((f) => [f.persona.dni, f.r.codigo, f.nota]),
    [
      ["07481337", "TA", "no se encontró certificado en JOMISER, EIN ni Drive"],
      ["41353513", "AE", "EIN no tiene certificado emitido"],
    ]
  );

  // el indice lleva cada autorizacion con su archivo o su motivo
  const indice = await JSZip.loadAsync(await zip.file("INDICE.xlsx").async("uint8array"));
  const hoja = await indice.file("xl/worksheets/sheet1.xml").async("string");
  assert.match(hoja, /41353513_TA_2026-08-04_ZAPATA RUIZ ANA\.pdf/);
  assert.match(hoja, /EIN no tiene certificado emitido/);
});

test("ZIP: si la busqueda de una persona falla, sus autorizaciones quedan anotadas y el resto sigue", async () => {
  const lista = autorizadosPorPersona(PERSONAS, opciones());
  const r = await armarZipExportacion(lista, { diccionario: DICCIONARIO, ...fuentesDeMentira({ fallaBuscar: ["41353513"] }) });
  const deAna = r.faltantes.filter((f) => f.persona.dni === "41353513");
  assert.equal(deAna.length, 2);
  assert.ok(deAna.every((f) => /no se pudo consultar: JOMISER no responde/.test(f.nota)));
});

test("ZIP: abortado no entrega un ZIP a medias", async () => {
  const lista = autorizadosPorPersona(PERSONAS, opciones());
  const control = new AbortController();
  const fuentes = fuentesDeMentira();
  const buscar = async (dni, senal) => {
    control.abort();
    return fuentes.buscar(dni, senal);
  };
  await assert.rejects(
    armarZipExportacion(lista, { diccionario: DICCIONARIO, ...fuentes, buscar, senal: control.signal }),
    { name: "AbortError" }
  );
});

test("ZIP grande: se reparte en tandas sin partir a una persona", () => {
  const item = (dni, n) => ({ persona: { dni }, rrcc: Array.from({ length: n }, (_, i) => ({ codigo: `R${i}` })) });
  const partes = partirEnZips([item("1", 3), item("2", 3), item("3", 5), item("4", 1)], 6);
  assert.deepEqual(
    partes.map((p) => p.map((x) => x.persona.dni)),
    [["1", "2"], ["3", "4"]]
  );
  // quien solo ya supera el tope va en su propio ZIP
  assert.deepEqual(partirEnZips([item("1", 2), item("2", 9), item("3", 2)], 6).map((p) => p.length), [1, 1, 1]);
  assert.deepEqual(partirEnZips([]), []);
});

test("ZIP grande: las partes salen parejas, no una llena y otra casi vacia", () => {
  const lista = Array.from({ length: 209 }, (_, i) => ({ persona: { dni: String(i) }, rrcc: [{}, {}] })); // 418
  const partes = partirEnZips(lista, 400);
  assert.equal(partes.length, 2);
  assert.ok(partes.every((p) => p.length * 2 <= 400 && p.length * 2 >= 200), partes.map((p) => p.length * 2).join("/"));
});
