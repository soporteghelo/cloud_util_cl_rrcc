/**
 * Pruebas del PDF que se genera para el informe de ESTADO TOTAL.
 *
 * Un PDF roto no avisa: el lector dice "archivo dañado" y ya. Lo que se
 * vigila aqui es justo eso — que la tabla de posiciones (xref) apunte a donde
 * empieza cada objeto, que la longitud declarada de cada flujo sea la real, y
 * que los acentos salgan en WinAnsi y no como signos de interrogacion.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { armarPdf, armarPdfTabla, anchoTexto, recortar } from "../src/lib/pdf.js";

const BLOQUE = [
  { tipo: "cabecera", indice: 1, texto: "ÑOPO QUISPE JOSÉ", derecha: "DNI 10000003" },
  { tipo: "nota", texto: "MECANICO GENERAL I · MANTENIMIENTO · 2 vencido(s)" },
  { tipo: "grupo", texto: "A · AUTORIZACIONES VENCIDAS (1)", color: [0.66, 0.09, 0.16] },
  {
    tipo: "item",
    cols: [
      { texto: "PM", x: 18, ancho: 34, negrita: true },
      { texto: "PROTECCION DE MAQUINAS", x: 56, ancho: 230 },
      { texto: "05/09/2026", x: 292, ancho: 72 },
    ],
  },
];

async function texto(bloques, opciones = {}) {
  const blob = await armarPdf({ titulo: "ESTADO TOTAL", subtitulo: "prueba", bloques, ...opciones });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // cada byte es un caracter: el flujo va sin comprimir a proposito
  return { bytes, crudo: Array.from(bytes, (b) => String.fromCharCode(b)).join("") };
}

test("el archivo es un PDF completo, con cabecera y remate", async () => {
  const { crudo } = await texto([BLOQUE]);
  assert.match(crudo, /^%PDF-1\.4\n/);
  assert.match(crudo, /%%EOF\n$/);
  assert.match(crudo, /\/Type \/Catalog/);
  assert.match(crudo, /\/BaseFont \/Helvetica-Bold/);
});

test("cada posicion del xref cae justo donde empieza su objeto", async () => {
  const { crudo } = await texto([BLOQUE]);
  const inicio = Number(/startxref\n(\d+)\n%%EOF/.exec(crudo)[1]);
  assert.equal(crudo.slice(inicio, inicio + 4), "xref");

  const tabla = crudo.slice(inicio);
  const total = Number(/^xref\n0 (\d+)\n/.exec(tabla)[1]);
  const entradas = [...tabla.matchAll(/^(\d{10}) \d{5} n $/gm)];
  assert.equal(entradas.length, total - 1, "una entrada por objeto (el 0 es el libre)");

  entradas.forEach((m, i) => {
    const pos = Number(m[1]);
    assert.equal(crudo.slice(pos, pos + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`);
  });
});

test("el /Length de cada flujo es el tamaño real del flujo", async () => {
  const { crudo } = await texto([BLOQUE]);
  const flujos = [...crudo.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)];
  assert.ok(flujos.length, "tiene que haber al menos un flujo");
  for (const [, largo, contenido] of flujos) assert.equal(contenido.length, Number(largo));
});

test("los acentos y la Ñ viajan en WinAnsi, no como '?'", async () => {
  const { bytes, crudo } = await texto([BLOQUE]);
  assert.ok(bytes.includes(0xd1), "Ñ = 0xD1");
  assert.ok(bytes.includes(0xc9), "É = 0xC9");
  assert.ok(bytes.includes(0xb7), "· = 0xB7");
  assert.ok(!crudo.includes("?OPO"), "la Ñ no debe degradarse a '?'");
});

test("los parentesis del texto se escapan: si no, cortan el literal del PDF", async () => {
  const { crudo } = await texto([[{ tipo: "nota", texto: "CARGO (INTERINO) \\ TURNO" }]]);
  assert.match(crudo, /CARGO \\\(INTERINO\\\) \\\\ TURNO/);
});

test("el informe se reparte en varias hojas y todas llevan cabecera y pie", async () => {
  const { crudo } = await texto(Array.from({ length: 60 }, () => BLOQUE));
  const hojas = [...crudo.matchAll(/\/Type \/Page /g)].length;
  assert.ok(hojas > 1, `deberia ocupar varias hojas, salieron ${hojas}`);
  assert.equal([...crudo.matchAll(/\/Count (\d+)/g)][0][1], String(hojas));
  assert.equal([...crudo.matchAll(/Página \d+ de /g)].length, hojas);
  assert.ok(crudo.includes(`Página ${hojas} de ${hojas}`));
});

test("un texto que no entra se recorta en vez de pisar la columna de al lado", () => {
  const largo = "CARGO MUY LARGO QUE NO ENTRA EN LA COLUMNA DE NINGUNA MANERA";
  const cortado = recortar(largo, 9, 80);
  assert.ok(cortado.length < largo.length);
  assert.ok(cortado.endsWith("…"));
  assert.ok(anchoTexto(cortado, 9) <= 80);
});

test("el ancho de los digitos es el de Helvetica (556/1000): el DNI cuadra a la derecha", () => {
  assert.equal(Math.round(anchoTexto("00000000", 10) * 100) / 100, 44.48);
});

/* ------------------------------------------------------------------ */
/* PDF de la vista (la tabla de ESTADO TOTAL tal cual)                 */
/* ------------------------------------------------------------------ */

const COLUMNAS_TABLA = [
  { titulo: "DNI", ancho: 92, valor: (f) => f.dni },
  { titulo: "Nombre", ancho: 295, valor: (f) => f.nombre },
  { titulo: "Vencidos", ancho: 95, valor: (f) => f.vencidos, pastilla: () => "#a3122a" },
  { titulo: "Días", ancho: 200, valor: (f) => f.dias, color: () => "#a3122a" },
];

const filasDePrueba = (n) =>
  Array.from({ length: n }, (_, i) => ({
    dni: String(40000000 + i),
    nombre: `PERSONA ${i + 1}`,
    vencidos: (i % 7) + 1,
    dias: `vencido hace ${i + 1} día(s)`,
  }));

async function tabla(filas, opciones = {}) {
  const blob = await armarPdfTabla({
    titulo: "ESTADO TOTAL",
    subtitulo: "prueba",
    tarjetas: [{ numero: filas.length, rotulo: "personas vencidas" }],
    columnas: COLUMNAS_TABLA,
    filas,
    pie: "AESA · prueba",
    ...opciones,
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return Array.from(bytes, (b) => String.fromCharCode(b)).join("");
}

test("el PDF de la vista va apaisado y es un PDF valido (xref y /Length cuadran)", async () => {
  const crudo = await tabla(filasDePrueba(3));
  assert.match(crudo, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  const inicio = Number(/startxref\n(\d+)\n%%EOF/.exec(crudo)[1]);
  assert.equal(crudo.slice(inicio, inicio + 4), "xref");
  for (const [, largo, contenido] of crudo.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) {
    assert.equal(contenido.length, Number(largo));
  }
});

test("el PDF de la vista lleva TODAS las filas y repite el encabezado en cada hoja", async () => {
  const filas = filasDePrueba(90);
  const crudo = await tabla(filas);
  const hojas = [...crudo.matchAll(/\/Type \/Page /g)].length;
  assert.ok(hojas > 1, `90 filas no caben en una hoja, salieron ${hojas}`);
  for (const f of filas) assert.ok(crudo.includes(`(${f.dni})`), `falta la fila ${f.dni}`);
  // el titulo de la columna DNI, una vez por hoja
  assert.equal([...crudo.matchAll(/\(DNI\) Tj/g)].length, hojas);
  // las tarjetas solo en la primera hoja
  assert.equal([...crudo.matchAll(/\(PERSONAS VENCIDAS\) Tj/g)].length, 1);
  assert.equal([...crudo.matchAll(/Página \d+ de /g)].length, hojas);
});

test("los colores \"#rrggbb\" de las columnas de la imagen sirven tal cual en el PDF", async () => {
  const crudo = await tabla(filasDePrueba(1));
  // #a3122a = 163/255, 18/255, 42/255
  assert.ok(crudo.includes("0.639 0.071 0.165 rg"), "texto en rojo");
  assert.ok(crudo.includes("0.639 0.071 0.165 RG"), "contorno de la pastilla en rojo");
});

test("el PDF de la vista sin columnas avisa en vez de salir en blanco", async () => {
  await assert.rejects(() => armarPdfTabla({ columnas: [], filas: [] }), /columnas/);
});

test("agrupado: cada grupo abre con su banda y lleva todas sus filas", async () => {
  const filas = filasDePrueba(12);
  const crudo = await tabla([], {
    grupos: [
      { titulo: "GUARDIA A", detalle: "5 persona(s)", filas: filas.slice(0, 5) },
      { titulo: "GUARDIA B", detalle: "7 persona(s)", filas: filas.slice(5) },
    ],
  });
  const a = crudo.indexOf("(GUARDIA A) Tj");
  const b = crudo.indexOf("(GUARDIA B) Tj");
  assert.ok(a > 0 && b > a, "las bandas salen en el orden recibido");
  // los parentesis del texto van escapados dentro del literal del PDF
  assert.ok(crudo.includes(String.raw`(5 persona\(s\)) Tj`), "el detalle va a la derecha de la banda");
  // las filas de A entre su banda y la de B; las de B despues
  for (const f of filas.slice(0, 5)) assert.ok(crudo.indexOf(`(${f.dni})`) > a && crudo.indexOf(`(${f.dni})`) < b);
  for (const f of filas.slice(5)) assert.ok(crudo.indexOf(`(${f.dni})`) > b);
  assert.ok(!crudo.includes("continuación"), "nada se parte: no hay continuacion");
});

test("agrupado: un grupo que pasa de hoja repite su banda como continuacion", async () => {
  const filas = filasDePrueba(60);
  const crudo = await tabla([], { grupos: [{ titulo: "GUARDIA C", filas }] });
  const hojas = [...crudo.matchAll(/\/Type \/Page /g)].length;
  assert.ok(hojas > 1);
  assert.equal([...crudo.matchAll(/\(GUARDIA C\) Tj/g)].length, 1);
  // WinAnsi: la o con tilde es el byte 0xF3; los parentesis del texto, escapados
  assert.equal([...crudo.matchAll(/\(GUARDIA C \\\(continuaci\xf3n\\\)\) Tj/g)].length, hojas - 1);
  for (const f of filas) assert.ok(crudo.includes(`(${f.dni})`), `falta la fila ${f.dni}`);
});
