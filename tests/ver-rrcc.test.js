/**
 * Pruebas de VER RRCC (`src/lib/ver-rrcc.js`): quien se ve con cada filtro,
 * que cuenta cada opcion, que trae el Excel de vigencias y que trae el ZIP.
 *
 * El dibujo del fotocheck se simula: `generar` es una funcion de mentira, asi
 * que lo que se prueba es la regla y no el canvas.
 */

import test from "node:test";
import assert from "node:assert/strict";
import JSZip from "jszip";

import {
  filtrarPersonas,
  facetas,
  filtrosIniciales,
  hojasDeVerRrcc,
  vigenciasDe,
  diasDe,
  partirEnTandas,
  armarZipFotochecks,
  nombreFotocheckZip,
  paraFotocheck,
  certificadosDeLista,
} from "../src/lib/ver-rrcc.js";

const HOY = "2026-10-06";

/** Una persona de la hoja. `riesgos` = [codigo, tipo, fecha de capacitacion]. */
const persona = (dni, nombre, extra = {}, riesgos = []) => ({
  dni,
  codigo: `AE${dni.slice(-3)}`,
  nombreCompleto: nombre,
  apellidos: nombre.split(" ").slice(0, 2).join(" "),
  nombres: nombre.split(" ").slice(2).join(" "),
  cargo: "OPERADOR",
  area: "MINA",
  guardia: "A",
  estadoTrabajador: "ACTIVO",
  estadoFinal: "VIGENTE",
  fechaMinima: "2026-11-08",
  dias: "33.00",
  riesgos: riesgos.map(([codigo, tipo, cap]) => ({ codigo, nombre: codigo, tipo, cap, venc: "" })),
  ...extra,
});

const PERSONAS = [
  persona("41353513", "ZAPATA RUIZ ANA", {}, [
    ["TA", "A", "2026-08-04"],
    ["AE", "A", "2025-10-28"],
    ["SQ", "A", "2025-01-10"],
    ["PM", "C", "2026-08-04"],
  ]),
  persona("07481337", "ALVARADO QUISPE EDGAR", { guardia: "GUARDIA B", cargo: "MECANICO", area: "PLANTA" }),
  persona("72381092", "ORE VASQUEZ LUIS", { estadoTrabajador: "CESADO" }),
  persona("70000002", "GOMEZ ROCA JHEMY", { estadoFinal: "VENCIDO", fechaMinima: "2026-09-26", dias: "-10" }),
  persona("70000003", "SIN FECHA PEDRO", { estadoFinal: "", fechaMinima: "", dias: "", guardia: "#N/A", cargo: "" }),
];

const dnis = (lista) => lista.map((p) => p.dni);
const filtros = (extra = {}) => ({ ...filtrosIniciales(), ...extra });

test("por defecto solo el personal ACTIVO, por apellidos", () => {
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS)), ["07481337", "70000002", "70000003", "41353513"]);
});

test("las filas sin nombre van al final, por DNI", () => {
  const sinNombre = [persona("21505654", "", { nombreCompleto: "" }), persona("19977672", "", { nombreCompleto: "" })];
  assert.deepEqual(dnis(filtrarPersonas([...sinNombre, ...PERSONAS.slice(0, 2)])), [
    "07481337",
    "41353513",
    "19977672",
    "21505654",
  ]);
});

test("sin filtro de situacion se ven todos, cesados incluidos", () => {
  assert.equal(filtrarPersonas(PERSONAS, filtros({ situacion: new Set() })).length, PERSONAS.length);
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ situacion: new Set(["CESADO"]) }))), ["72381092"]);
});

test("ESTADO_FINAL: cada estado por separado, y la celda vacia como SIN ESTADO", () => {
  const de = (...estados) => dnis(filtrarPersonas(PERSONAS, filtros({ estadoFinal: new Set(estados) })));
  assert.deepEqual(de("VENCIDO"), ["70000002"]);
  assert.deepEqual(de("VIGENTE"), ["07481337", "41353513"]);
  assert.deepEqual(de(""), ["70000003"]);
  assert.deepEqual(de("VIGENTE", "VENCIDO"), ["07481337", "70000002", "41353513"]);
});

test("guardia (sin el prefijo GUARDIA; #N/A cuenta como sin guardia), cargo, area y texto", () => {
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ guardia: new Set(["B"]) }))), ["07481337"]);
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ guardia: new Set([""]) }))), ["70000003"]);
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ cargo: new Set(["MECANICO"]) }))), ["07481337"]);
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ area: new Set(["PLANTA"]) }))), ["07481337"]);
  assert.deepEqual(dnis(filtrarPersonas(PERSONAS, filtros({ texto: "zapata" }))), ["41353513"]);
});

test("cargo escrito: filtra mientras se teclea, sin tildes ni orden; uno elegido de la lista va exacto", () => {
  const gente = [
    persona("10000001", "UNO A", { cargo: "MAESTRO DE SERVICIOS MINA" }),
    persona("10000002", "DOS B", { cargo: "OPERADOR DE JUMBO I" }),
    persona("10000003", "TRES C", { cargo: "OPERADOR DE JUMBO II" }),
    persona("10000004", "CUATRO D", { cargo: "MECÁNICO" }),
  ];
  const con = (cargoTexto) => dnis(filtrarPersonas(gente, filtros({ cargoTexto }))).sort();
  assert.deepEqual(con("maes"), ["10000001"]);
  assert.deepEqual(con("mina maestro"), ["10000001"], "las palabras en cualquier orden");
  assert.deepEqual(con("mecanico"), ["10000004"], "sin importar la tilde");
  assert.deepEqual(con("operador jumbo"), ["10000002", "10000003"]);
  assert.deepEqual(con("OPERADOR DE JUMBO I"), ["10000002"], "elegido de la lista: no trae tambien al II");
  assert.deepEqual(con("  "), ["10000001", "10000002", "10000003", "10000004"]);
  assert.deepEqual(con("soldador"), []);

  // varios elegidos de la lista, y lo que se esta escribiendo se suma
  const elegidos = (cargo, cargoTexto = "") =>
    dnis(filtrarPersonas(gente, filtros({ cargo: new Set(cargo), cargoTexto }))).sort();
  assert.deepEqual(elegidos(["MAESTRO DE SERVICIOS MINA", "MECÁNICO"]), ["10000001", "10000004"]);
  assert.deepEqual(elegidos(["MAESTRO DE SERVICIOS MINA"], "jumbo"), ["10000001", "10000002", "10000003"]);

  // las sugerencias de cargo no se recortan con lo que se esta escribiendo
  const f = facetas(gente, filtros({ cargoTexto: "maes" }));
  assert.equal(f.cargo.length, 4);
  assert.equal(f.guardia[0].cuenta, 1, "las demas opciones si cuentan con el cargo escrito");
});

test("riesgo critico: solo los fotochecks donde aparece ese RRCC (letra o fecha); con varios, basta uno", () => {
  const gente = [
    persona("10000001", "UNO A", {}, [["TA", "A", "2026-08-04"], ["EC", "C", "2026-08-04"]]),
    persona("10000002", "DOS B", {}, [["EC", "C", ""]]),
    persona("10000003", "TRES C", {}, [["AE", "", "2026-01-10"]]),
    persona("10000004", "CUATRO D", {}, [["TA", "", ""]]), // casilla vacia: no aparece
  ];
  const con = (...riesgos) => dnis(filtrarPersonas(gente, filtros({ riesgos: new Set(riesgos) }))).sort();
  assert.deepEqual(con("TA"), ["10000001"]);
  assert.deepEqual(con("EC"), ["10000001", "10000002"], "con letra C aunque no tenga fecha");
  assert.deepEqual(con("AE"), ["10000003"], "con fecha aunque no tenga letra");
  assert.deepEqual(con("TA", "AE"), ["10000001", "10000003"]);
  assert.equal(con().length, 4);

  const f = facetas(gente, filtros({ riesgos: new Set(["TA"]) }));
  assert.equal(f.riesgos.length, 18, "los 18 RRCC siempre, en el orden del fotocheck");
  assert.deepEqual(f.riesgos[0], { valor: "AE", rotulo: "AE · Bloq. Energias", cuenta: 1 });
  assert.equal(f.riesgos.find((o) => o.valor === "EC").cuenta, 2, "no se recorta con su propio filtro");
  assert.equal(f.guardia[0].cuenta, 1, "los demas filtros si cuentan con el RRCC elegido");
});

test("A / C: el RRCC marcado con esa letra; sin RRCC, cualquiera con esa letra", () => {
  const gente = [
    persona("10000001", "UNO A", {}, [["TA", "A", "2026-08-04"], ["EC", "C", "2026-08-04"]]),
    persona("10000002", "DOS B", {}, [["TA", "C", "2026-08-04"]]),
    persona("10000003", "TRES C", {}, [["EC", "A", "2026-08-04"]]),
    persona("10000004", "CUATRO D", {}, [["AE", "", "2026-01-10"]]), // fecha sin letra
  ];
  const con = (riesgos, tipos) =>
    dnis(filtrarPersonas(gente, filtros({ riesgos: new Set(riesgos), tipos: new Set(tipos) }))).sort();
  assert.deepEqual(con(["TA"], ["A"]), ["10000001"]);
  assert.deepEqual(con(["TA"], ["C"]), ["10000002"]);
  assert.deepEqual(con(["TA"], []), ["10000001", "10000002"]);
  assert.deepEqual(con([], ["C"]), ["10000001", "10000002"], "sin RRCC: cualquiera con C");
  assert.deepEqual(con([], ["A", "C"]), ["10000001", "10000002", "10000003"], "con las dos, cualquiera con letra");

  // los RRCC cuentan con la letra marcada, y A / C con los RRCC marcados
  const f = facetas(gente, filtros({ riesgos: new Set(["TA"]), tipos: new Set(["A"]) }));
  assert.equal(f.riesgos.find((o) => o.valor === "EC").cuenta, 1, "EC como A: solo TRES");
  assert.deepEqual(
    f.tipos.map((o) => [o.valor, o.cuenta]),
    [
      ["A", 1],
      ["C", 1],
    ]
  );
});

test("facetas: cada opcion cuenta con los demas filtros puestos, sin vacio al principio", () => {
  const f = facetas(PERSONAS, filtros({ guardia: new Set(["A"]) }));
  // situacion no se filtra a si misma: ACTIVO y CESADO de la guardia A
  assert.deepEqual(
    f.situacion.map((o) => [o.valor, o.cuenta]),
    [
      ["ACTIVO", 2],
      ["CESADO", 1],
    ]
  );
  assert.deepEqual(
    f.estadoFinal.map((o) => [o.rotulo, o.cuenta]),
    [
      ["VIGENTE", 1],
      ["VENCIDO", 1],
    ]
  );
  // la guardia elegida no recorta sus propias opciones
  assert.deepEqual(
    f.guardia.map((o) => [o.rotulo, o.cuenta]),
    [
      ["A", 2],
      ["B", 1],
      ["SIN GUARDIA", 1],
    ]
  );
});

test("facetas: lo marcado se mantiene en la lista aunque quede en 0", () => {
  const f = facetas(PERSONAS, filtros({ cargo: new Set(["SOLDADOR"]) }));
  assert.ok(f.cargo.some((o) => o.valor === "SOLDADOR" && o.cuenta === 0));
});

test("vigencias: estado recalculado y vencimiento a 365 dias si la hoja no lo trae", () => {
  const v = vigenciasDe(PERSONAS[0], { hoy: HOY });
  assert.deepEqual(
    v.map((r) => [r.codigo, r.tipo, r.estado, r.venc]),
    [
      ["TA", "A", "VIGENTE", "2027-08-04"],
      ["AE", "A", "ACTUALIZAR", "2026-10-28"],
      ["SQ", "A", "VENCIDO", "2026-01-10"],
      ["PM", "C", "VIGENTE", "2027-08-04"],
    ]
  );
  assert.equal(v[1].dias, 22);
});

test("dias: desde la FECHA MINIMA; sin fecha, lo que diga la columna DIAS", () => {
  assert.equal(diasDe(PERSONAS[0], HOY), 33);
  // como llega del listado de Apps Script
  assert.equal(diasDe({ fechaMinima: "Sun Nov 08 2026 02:00:00 GMT-0500 (Peru Standard Time)" }, HOY), 33);
  assert.equal(diasDe({ dias: "-35.00" }, HOY), -35);
  assert.equal(diasDe({ dias: "" }, HOY), null);
});

test("Excel: una fila por persona con su vigencia y una por cada RRCC", () => {
  const lista = filtrarPersonas(PERSONAS);
  const [personas, vigencias] = hojasDeVerRrcc(lista, { hoy: HOY });
  assert.equal(personas.filas.length, 4);
  const col = (titulo) => personas.columnas.findIndex((c) => c.titulo === titulo);
  const ana = personas.filas.find((f) => f[col("DNI")] === "41353513");
  assert.equal(ana[col("ESTADO_FINAL")], "VIGENTE");
  assert.equal(ana[col("AUTORIZADO")], "SI");
  assert.equal(ana[col("FECHA MINIMA")], "2026-11-08");
  assert.equal(ana[col("DIAS")], 33);
  assert.equal(ana[col("A VIGENTES")], "TA");
  assert.equal(ana[col("A POR VENCER")], "AE");
  assert.equal(ana[col("A VENCIDOS")], "SQ");
  assert.equal(ana[col("C VIGENTES")], "PM");
  assert.equal(ana[col("C VENCIDOS")], "");
  // sin ninguna "A" no puede estar autorizado aunque figure VIGENTE
  assert.equal(personas.filas.find((f) => f[col("DNI")] === "07481337")[col("AUTORIZADO")], "NO");

  assert.equal(vigencias.filas.length, 4); // solo Ana tiene RRCC
  assert.ok(vigencias.filas.every((f) => f[1] === "41353513"));
});

test("paraFotocheck: la persona del listado queda como la lee la renovacion", () => {
  // asi llega del listado de Apps Script: el codigo como rotulo y fechas sin normalizar
  const delListado = persona("45949983", "ABARCA CRISTOBAL JUNIOR ALEXIS", {
    examenMedico: "Fri Oct 10 2025 02:00:00 GMT-0500 (Peru Standard Time)",
    vencimientoEmo: "",
    fechaMinima: "Sat Jul 31 2027 02:00:00 GMT-0500 (Peru Standard Time)",
    riesgos: [{ codigo: "AE", rotulo: "AE", nombre: "AE", tipo: "A", cap: "2026-08-01", venc: "2027-08-01" }],
  });
  const p = paraFotocheck(delListado);
  assert.equal(p.riesgos[0].rotulo, "Bloq. Energias");
  assert.equal(p.riesgos[0].nombre, "BLOQUEO Y AISLAMIENTO DE ENERGIAS");
  assert.equal(p.examenMedico, "2025-10-10");
  assert.equal(p.vencimientoEmo, "2026-10-10", "sin vencimiento del EMO, el examen + 365 como en la ficha");
  assert.equal(p.fechaMinima, "2027-07-31");
  assert.equal(paraFotocheck(delListado), p, "se calcula una vez por persona");
  assert.equal(delListado.riesgos[0].rotulo, "AE", "no toca el listado compartido");
  assert.equal(vigenciasDe(delListado, { hoy: HOY })[0].nombre, "BLOQUEO Y AISLAMIENTO DE ENERGIAS");
});

test("certificados: los RRCC marcados de cada persona (con la letra marcada), quien no tiene ninguno no va", () => {
  const gente = [
    persona("10000001", "UNO A", {}, [["TA", "A", "2026-08-04"], ["EC", "C", "2025-01-10"], ["AE", "A", "2026-08-04"]]),
    persona("10000002", "DOS B", {}, [["TA", "C", "2026-08-04"]]),
    persona("10000003", "TRES C", {}, [["AE", "A", "2026-08-04"]]),
  ];
  const de = (riesgos, tipos = []) =>
    certificadosDeLista(gente, { riesgos: new Set(riesgos), tipos: new Set(tipos), hoy: HOY }).map((x) => [
      x.persona.dni,
      x.rrcc.map((r) => `${r.codigo}:${r.estado}`),
    ]);
  assert.deepEqual(de(["TA", "EC"]), [
    ["10000001", ["TA:VIGENTE", "EC:VENCIDO"]],
    ["10000002", ["TA:VIGENTE"]],
  ]);
  assert.deepEqual(de(["TA"], ["A"]), [["10000001", ["TA:VIGENTE"]]]);
  assert.deepEqual(de([]), [], "sin RRCC marcado no se baja nada");
  // la vigencia viaja con el nombre largo, que es lo que lleva el INDICE
  assert.equal(certificadosDeLista(gente, { riesgos: new Set(["AE"]), hoy: HOY })[0].rrcc[0].nombre, "BLOQUEO Y AISLAMIENTO DE ENERGIAS");
});

test("partirEnTandas: tandas parejas que no pasan el tope", () => {
  const lista = Array.from({ length: 450 }, (_, i) => i);
  assert.deepEqual(partirEnTandas(lista, 200).map((p) => p.length), [150, 150, 150]);
  assert.deepEqual(partirEnTandas(lista.slice(0, 10), 200).map((p) => p.length), [10]);
  assert.deepEqual(partirEnTandas([], 200), []);
});

test("ZIP: un fotocheck por persona, suelto en la raiz, con el INDICE de vigencias", async () => {
  const lista = filtrarPersonas(PERSONAS);
  const r = await armarZipFotochecks(lista, {
    hoy: HOY,
    generar: async (p) => {
      if (p.dni === "70000003") throw new Error("canvas roto");
      return { blob: new Blob([`JPG ${p.dni}`]), ext: "jpg", conFoto: p.dni !== "07481337" };
    },
  });

  const zip = await JSZip.loadAsync(Buffer.from(await r.blob.arrayBuffer()));
  const nombres = Object.keys(zip.files).sort();
  assert.ok(Object.values(zip.files).every((f) => !f.dir && !f.name.includes("/")));
  assert.deepEqual(nombres, [
    "FOTOCHECK_ALVARADO QUISPE EDGAR_07481337.jpg",
    "FOTOCHECK_GOMEZ ROCA JHEMY_70000002.jpg",
    "FOTOCHECK_ZAPATA RUIZ ANA_41353513.jpg",
    "INDICE.xlsx",
  ]);
  assert.equal(await zip.file("FOTOCHECK_ZAPATA RUIZ ANA_41353513.jpg").async("string"), "JPG 41353513");
  assert.equal(r.archivos, 3);
  assert.equal(r.sinFoto, 1);
  assert.deepEqual(dnis(r.fallidos), ["70000003"]);
});

test("ZIP: dos personas con el mismo nombre y DNI no se pisan", async () => {
  const doble = [persona("41353513", "ZAPATA RUIZ ANA"), persona("41353513", "ZAPATA RUIZ ANA")];
  const r = await armarZipFotochecks(doble, {
    generar: async () => ({ blob: new Blob(["x"]), ext: "jpg", conFoto: true }),
  });
  const zip = await JSZip.loadAsync(Buffer.from(await r.blob.arrayBuffer()));
  assert.equal(Object.keys(zip.files).filter((n) => n.endsWith(".jpg")).length, 2);
  assert.equal(nombreFotocheckZip(doble[0]), "FOTOCHECK_ZAPATA RUIZ ANA_41353513.jpg");
});

test("ZIP: abortado no entrega un ZIP a medias", async () => {
  const abortador = new AbortController();
  await assert.rejects(
    armarZipFotochecks(filtrarPersonas(PERSONAS), {
      senal: abortador.signal,
      generar: async () => {
        abortador.abort();
        return { blob: new Blob(["x"]), ext: "jpg", conFoto: true };
      },
    }),
    { name: "AbortError" }
  );
});
