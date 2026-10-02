/**
 * Pruebas de las reglas de negocio.
 *
 *   node --test tests/
 *
 * Sin dependencias: `node --test` viene en Node. `estados.js` es puro, asi
 * que todo esto corre sin red y sin credenciales.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  normalizarDocumento,
  aIso,
  serialAIso,
  sumarDias,
  sumarAnios,
  diasEntre,
  aFormatoCorto,
  normalizarCurso,
  construirDiccionario,
  mapearCurso,
  estadoDe,
  vencimientoDe,
  elegirCertificados,
  renovarFila,
  aplicarCapacitacionC,
  EXCLUIDOS_APLICAR_C,
  admiteAplicarC,
  aplicarEdicionesManuales,
  copiarFila,
  aplicarCierre,
  filaNueva,
  tiposDeMatriz,
  cargoMasParecido,
  leerFila,
  personasPorRiesgo,
  riesgosProblemaDe,
} from "../shared/estados.js";
import { CABECERA, INDICE, CODIGOS_RRCC, colCap, colVenc, colTipo, colEstado } from "../shared/rrcc.js";

const HOY = "2026-09-21";
const dic = construirDiccionario([]);
const filaVacia = () => CABECERA.map(() => "");

/* ------------------------------------------------------------------ */

test("el layout de PERSONAL conserva el orden de BD AESA", () => {
  assert.equal(CODIGOS_RRCC.length, 18);
  // P es la primera columna de riesgos en el Excel: indice 15 (A=0)
  assert.equal(colCap("AE"), 15);
  assert.equal(colEstado("RIG"), 86);
  assert.equal(INDICE["DNI"], 6);
  assert.equal(INDICE["Codigo"], 2);
});

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

test("aIso entiende las tres formas en que llegan las fechas", () => {
  assert.equal(aIso("2026-08-28"), "2026-08-28", "ISO de JOMISER");
  assert.equal(aIso("02/09/2026"), "2026-09-02", "dd/mm/yyyy de EIN");
  assert.equal(aIso("2 9 2026"), "2026-09-02");
  assert.equal(aIso(45658), "2025-01-01", "serial de Excel");
  assert.equal(serialAIso(45947), "2025-10-17");
});

test("aIso no inventa fechas cuando el dato no sirve", () => {
  assert.equal(aIso(""), "");
  assert.equal(aIso(null), "");
  assert.equal(aIso("31/02/2026"), "", "el 31 de febrero no existe");
  assert.equal(aIso("2026"), "", "un anio suelto no es un serial");
  assert.equal(aIso("pendiente"), "");
});

test("sumarDias y diasEntre cuadran con el ano de vigencia", () => {
  assert.equal(sumarDias("2026-09-12", 365), "2027-09-12");
  assert.equal(diasEntre("2026-09-12", "2027-09-12"), 365);
  assert.equal(aFormatoCorto("2027-09-12"), "12/09/2027");
});

test("sumarAnios resta un anio de calendario (examen medico desde el vencimiento del EMO)", () => {
  assert.equal(sumarAnios("2026-10-15", -1), "2025-10-15");
  assert.equal(sumarAnios("2029-03-01", -1), "2028-03-01", "cruza un 29/02 sin correrse un dia");
  assert.equal(sumarAnios("2028-02-29", -1), "2027-02-28", "29/02 en anio comun pasa al 28/02");
  assert.equal(sumarAnios("15/10/2026", -1), "2025-10-15");
  assert.equal(sumarAnios("", -1), "");
});

/* ------------------------------------------------------------------ */
/* ESTADO                                                              */
/* ------------------------------------------------------------------ */

test("ESTADO replica los umbrales del Excel (330 y 365 dias)", () => {
  assert.equal(estadoDe("", HOY), "NO APLICA", "sin capacitacion");
  assert.equal(estadoDe(sumarDias(HOY, -329), HOY), "VIGENTE");
  assert.equal(estadoDe(sumarDias(HOY, -330), HOY), "ACTUALIZAR", "justo en el umbral");
  assert.equal(estadoDe(sumarDias(HOY, -365), HOY), "ACTUALIZAR", "el dia 365 todavia no vence");
  assert.equal(estadoDe(sumarDias(HOY, -366), HOY), "VENCIDO");
  assert.equal(estadoDe(sumarDias(HOY, 5), HOY), "VIGENTE", "capacitacion futura");
});

test("los umbrales se pueden mover desde CONFIG", () => {
  const umbrales = { vencido: 730, actualizar: 700 };
  assert.equal(estadoDe(sumarDias(HOY, -400), HOY, umbrales), "VIGENTE");
  assert.equal(estadoDe(sumarDias(HOY, -731), HOY, umbrales), "VENCIDO");
});

test("el vencimiento es capacitacion + 365, salvo que el certificado traiga el suyo", () => {
  assert.equal(vencimientoDe("TA", "2026-09-12"), "2027-09-12");
  assert.equal(vencimientoDe("TA", ""), "", "sin capacitacion no hay vencimiento");
  // ES y HM las emite EIN: si el certificado declara vigencia, manda esa
  assert.equal(vencimientoDe("ES", "2026-09-12", { vence: "2028-01-31" }), "2028-01-31");
  assert.equal(vencimientoDe("ES", "2026-09-12", { vence: "" }), "2027-09-12", "si no la declara, +365");
  assert.equal(vencimientoDe("TA", "2026-09-12", { vence: "2028-01-31" }), "2027-09-12", "solo aplica a ES y HM");
});

/* ------------------------------------------------------------------ */
/* Diccionario de cursos                                               */
/* ------------------------------------------------------------------ */

test("normalizarCurso borra tildes, signos, plurales y palabras de relleno", () => {
  assert.equal(normalizarCurso("Excavación Subterránea "), "EXCAVACION SUBTERRANEA");
  assert.equal(normalizarCurso("EXCAVACIONES SUBTERRANEAS"), "EXCAVACION SUBTERRANEA");
  assert.equal(normalizarCurso("TRABAJO EN ALTURA"), "TRABAJO ALTURA");
});

test("mapearCurso reconoce los nombres reales de JOMISER, EIN y Drive", () => {
  assert.equal(mapearCurso("AISLAMIENTO, BLOQUEO Y ETIQUETADO DE ENERGÍAS", dic), "AE");
  assert.equal(mapearCurso("SUSTANCIAS QUÍMICAS PELIGROSAS", dic), "SQ");
  assert.equal(mapearCurso("PROTECCIÓN DE MÁQUINAS", dic), "PM");
  assert.equal(mapearCurso("Excavación Subterránea", dic), "ES");
});

test("mapearCurso saca el curso de un nombre de archivo con la persona pegada", () => {
  assert.equal(mapearCurso("ROBLES GOMEZ JUAN MARCELINO - T_C", dic), "TC");
  assert.equal(mapearCurso("YAURI QUISPE FERNANDO - B_A_E", dic), "AE");
  assert.equal(mapearCurso("T_A - PARIACHI VILLAR VICTOR ANTOLIN", dic), "TA");
});

test("mapearCurso distingue lo ignorable de lo que hay que revisar", () => {
  assert.equal(mapearCurso("INDUCCIÓN", dic), "IGNORADO");
  assert.equal(mapearCurso("RIESGOS CRITICOS", dic), "IGNORADO");
  assert.equal(mapearCurso("CURSO QUE NO EXISTE", dic), null, "lo desconocido se reporta, no se asume");
});

test("la hoja CURSO_RRCC amplia el diccionario sin tocar codigo", () => {
  const propio = construirDiccionario([
    ["CHARLA DE IZAJE CRITICO", "RIG", ""],
    ["CURSO INTERNO X", "IGNORAR", ""],
  ]);
  assert.equal(mapearCurso("Charla de Izaje Critico", propio), "RIG");
  assert.equal(mapearCurso("CURSO INTERNO X", propio), "IGNORADO");
});

/* ------------------------------------------------------------------ */
/* Seleccion de certificados                                           */
/* ------------------------------------------------------------------ */

test("de dos certificados del mismo riesgo gana el mas reciente", () => {
  const { porRrcc } = elegirCertificados(
    [
      { curso: "TRABAJOS EN ALTURA", fecha: "2025-09-12", origen: "JOMISER" },
      { curso: "TRABAJO EN ALTURA", fecha: "2026-09-13", origen: "JOMISER" },
    ],
    dic
  );
  assert.equal(porRrcc.get("TA").fecha, "2026-09-13");
});

test("en ES y HM manda EIN aunque otra fuente traiga algo mas nuevo", () => {
  const { porRrcc } = elegirCertificados(
    [
      { curso: "EXCAVACIONES SUBTERRÁNEAS", fecha: "2026-09-20", origen: "JOMISER" },
      { curso: "EXCAVACIONES SUBTERRÁNEAS", fecha: "2026-09-12", origen: "EIN" },
    ],
    dic
  );
  assert.equal(porRrcc.get("ES").origen, "EIN");
  assert.equal(porRrcc.get("ES").fecha, "2026-09-12");
});

test("los cursos sin mapear se listan y los ignorados no ensucian", () => {
  const r = elegirCertificados(
    [
      { curso: "INDUCCIÓN", fecha: "2026-09-01", origen: "JOMISER" },
      { curso: "CURSO RARO", fecha: "2026-09-01", origen: "DRIVE" },
    ],
    dic
  );
  assert.equal(r.noMapeados.length, 1);
  assert.equal(r.noMapeados[0].curso, "CURSO RARO");
  assert.equal(r.ignorados.length, 1);
});

/* ------------------------------------------------------------------ */
/* Motor de renovacion                                                 */
/* ------------------------------------------------------------------ */

function personaDePrueba() {
  const fila = filaVacia();
  fila[INDICE["DNI"]] = "40018082";
  fila[INDICE["Apellidos"]] = "CCENCHO TAYPE";
  fila[INDICE["Nombres"]] = "NICOLAS";
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2025-09-10";
  fila[colTipo("TA")] = "A";
  fila[colCap("TA")] = "2025-09-10";
  fila[colTipo("OB")] = "A"; // autorizado sin certificado
  fila[colTipo("IE")] = "C";
  return fila;
}

test("la renovacion actualiza la fecha y mantiene la A de la persona", () => {
  const r = renovarFila({
    fila: personaDePrueba(),
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "AISLAMIENTO, BLOQUEO Y ETIQUETADO DE ENERGÍAS", fecha: "2026-09-12", origen: "JOMISER" }],
  });
  const ae = r.detalle.find((d) => d.codigo === "AE");
  assert.equal(ae.cap, "2026-09-12");
  assert.equal(ae.venc, "2027-09-12");
  assert.equal(ae.estado, "VIGENTE");
  assert.equal(ae.tipo, "A", "la renovacion no toca las autorizaciones");
  assert.equal(ae.cambio, "ACTUALIZADO");
});

test("no se pisa una capacitacion con un certificado mas viejo", () => {
  const fila = filaVacia();
  fila[colCap("TA")] = "2026-09-13";
  fila[colTipo("TA")] = "A";
  const r = renovarFila({
    fila,
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "TRABAJOS EN ALTURA", fecha: "2025-01-01", origen: "DRIVE" }],
  });
  const ta = r.detalle.find((d) => d.codigo === "TA");
  assert.equal(ta.cap, "2026-09-13");
  assert.equal(ta.cambio, "SIN CAMBIO");
});

test("no se pisa una fecha de la hoja que sigue vigente aunque el certificado sea mas nuevo", () => {
  // corregida a mano: cada renovacion la devolvia a la del certificado
  const fila = filaVacia();
  fila[colCap("TA")] = "2026-08-13";
  fila[colTipo("TA")] = "A";
  const r = renovarFila({
    fila,
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "TRABAJOS EN ALTURA", fecha: "2026-08-26", origen: "DRIVE" }],
  });
  const ta = r.detalle.find((d) => d.codigo === "TA");
  assert.equal(ta.cap, "2026-08-13", "se queda la de la hoja");
  assert.equal(ta.cambio, "SIN CAMBIO");
  assert.equal(ta.certificado.fecha, "2026-08-26", "el certificado sigue a mano para ofrecer USAR");
});

test("una fecha de la hoja por vencer si se actualiza con un certificado mas nuevo", () => {
  const fila = filaVacia();
  fila[colCap("TA")] = "2025-10-01"; // 355 dias: ACTUALIZAR
  fila[colTipo("TA")] = "A";
  const r = renovarFila({
    fila,
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "TRABAJOS EN ALTURA", fecha: "2026-09-01", origen: "DRIVE" }],
  });
  const ta = r.detalle.find((d) => d.codigo === "TA");
  assert.equal(ta.cap, "2026-09-01");
  assert.equal(ta.cambio, "ACTUALIZADO");
});

test('una "A" sin certificado vigente se mantiene y se avisa', () => {
  const r = renovarFila({ fila: personaDePrueba(), hoy: HOY, diccionario: dic, items: [] });
  const ob = r.detalle.find((d) => d.codigo === "OB");
  assert.equal(ob.tipo, "A", "no se pierde la autorizacion por un certificado atrasado");
  assert.equal(ob.estado, "NO APLICA");
  assert.ok(r.alertas.some((a) => a.codigo === "OB"), "pero queda alertado");

  const ta = r.detalle.find((d) => d.codigo === "TA");
  assert.equal(ta.estado, "VENCIDO");
  assert.ok(r.alertas.some((a) => a.codigo === "TA" && a.nivel === "error"));
});

test('con A_SIN_CERT=DEGRADAR la "A" vencida baja a "C"', () => {
  const r = renovarFila({
    fila: personaDePrueba(),
    hoy: HOY,
    diccionario: dic,
    items: [],
    config: { A_SIN_CERT: "DEGRADAR" },
  });
  assert.equal(r.detalle.find((d) => d.codigo === "TA").tipo, "C");
});

test("un curso nuevo sin autorizacion previa entra como CAPACITADO", () => {
  const r = renovarFila({
    fila: personaDePrueba(),
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "CARGAS SUSPENDIDAS", fecha: "2026-09-13", origen: "JOMISER" }],
  });
  const cs = r.detalle.find((d) => d.codigo === "CS");
  assert.equal(cs.cambio, "NUEVO");
  assert.equal(cs.tipo, "C");
});

test("la renovacion no muta la fila que recibe", () => {
  const original = personaDePrueba();
  const copia = original.slice();
  renovarFila({
    fila: original,
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "TRABAJOS EN ALTURA", fecha: "2026-09-13", origen: "JOMISER" }],
  });
  assert.deepEqual(original, copia);
});

/* ------------------------------------------------------------------ */
/* Cierre de la fila                                                   */
/* ------------------------------------------------------------------ */

test("FECHA MINIMA, DIAS y ESTADO_FINAL salen del vencimiento mas proximo", () => {
  const fila = filaVacia();
  fila[INDICE["Apellidos"]] = "PEREZ GOMEZ";
  fila[INDICE["Nombres"]] = "JUAN";
  fila[INDICE["DNI"]] = "12345678";
  fila[colVenc("AE")] = "2027-09-12";
  fila[colVenc("TA")] = "2026-12-01";
  fila[colVenc("CS")] = "2028-01-01";
  aplicarCierre(fila, HOY);

  assert.equal(fila[INDICE["FECHA MINIMA"]], "2026-12-01");
  assert.equal(fila[INDICE["DIAS"]], diasEntre(HOY, "2026-12-01"));
  assert.equal(fila[INDICE["ESTADO_FINAL"]], "VIGENTE");
  assert.equal(fila[INDICE["FullName"]], "PEREZ GOMEZ JUAN");
  assert.equal(fila[INDICE["Columna1"]], "12345678", "el Excel usa esta columna en sus BUSCARV");
});

test("si el vencimiento mas proximo ya paso, ESTADO_FINAL es VENCIDO", () => {
  const fila = filaVacia();
  fila[colVenc("AE")] = "2026-09-20";
  aplicarCierre(fila, HOY);
  assert.equal(fila[INDICE["ESTADO_FINAL"]], "VENCIDO");
});

test("el vencimiento del EMO se completa a partir del examen medico", () => {
  const fila = filaVacia();
  fila[INDICE["F. Ex. Medico"]] = "2026-01-15";
  aplicarCierre(fila, HOY);
  assert.equal(fila[INDICE["F. Vencimiento"]], "2027-01-15");
});

/* ------------------------------------------------------------------ */
/* Personal nuevo                                                      */
/* ------------------------------------------------------------------ */

test("la matriz por puesto decide las A del personal nuevo", () => {
  const matriz = [
    ["Cargo", "Area", ...CODIGOS_RRCC],
    ["MECANICO GENERAL I", "MINA", "A", "C", "", "A", "A", ...Array(13).fill("")],
    ["", "MINA", "C", "", "", "", "", ...Array(13).fill("")],
  ];
  const tipos = tiposDeMatriz(matriz, "MECANICO GENERAL I", "MINA");
  assert.deepEqual(tipos, { AE: "A", IE: "C", PM: "A", TA: "A" });

  const general = tiposDeMatriz(matriz, "OTRO CARGO", "MINA");
  assert.deepEqual(general, { AE: "C" }, "sin cargo exacto, vale la regla del area");

  assert.deepEqual(tiposDeMatriz(matriz, "OTRO CARGO", "PLANTA"), {}, "sin match, ninguna A");
});

test("con el cargo exacto, el area de la matriz no tiene que coincidir con la del formulario", () => {
  const matriz = [
    ["Cargo", "Area", ...CODIGOS_RRCC],
    ["FACILITADOR DE OPERACIONES", "Avances", "", "", "", "", "", "", "", "", "A", ...Array(8).fill("")],
    ["FACILITADOR DE OPERACIONES", "Servicios", "A", ...Array(17).fill("")],
    ["", "MINA", "C", ...Array(17).fill("")],
  ];
  const hm = { HM: "A" };
  assert.deepEqual(tiposDeMatriz(matriz, "facilitador de operaciones", ""), hm, "area vacia");
  assert.deepEqual(tiposDeMatriz(matriz, "FACILITADOR DE OPERACIONES", "MINA"), hm, "area de planilla distinta");
  assert.deepEqual(
    tiposDeMatriz(matriz, "FACILITADOR DE OPERACIONES", "servicios"),
    { AE: "A" },
    "si el area coincide, desempata entre filas del mismo cargo"
  );
});

test("cargoMasParecido sugiere el cargo de la matriz mas cercano a un typo", () => {
  const matriz = [
    ["Cargo", "Area", ...CODIGOS_RRCC],
    ["MAESTRO DE SERVICIOS MINA", "Avances", ...Array(18).fill("")],
    ["MECANICO GENERAL I", "MINA", ...Array(18).fill("")],
  ];
  assert.equal(cargoMasParecido(matriz, "MAESTO DE SERVICIOS MINA"), "MAESTRO DE SERVICIOS MINA", "1 letra de menos: es un typo");
  assert.equal(cargoMasParecido(matriz, "MAESTRO DE SERVICIOS MINA"), null, "coincidencia exacta: nada que sugerir");
  assert.equal(cargoMasParecido(matriz, "SUPERVISOR DE ACEROS"), null, "muy distinto: no es un typo, es otro cargo");
  assert.equal(cargoMasParecido(matriz, ""), null, "sin cargo no hay nada que sugerir");
  assert.equal(cargoMasParecido([], "MAESTO DE SERVICIOS MINA"), null, "sin matriz no hay nada que sugerir");
});

test("filaNueva arma la fila del alta con sus datos y sus tipos", () => {
  const fila = filaNueva({
    datos: {
      apellidos: "quispe mamani",
      nombres: "luis",
      dni: "07481337",
      cargo: "AYUDANTE",
      area: "MINA",
      examenMedico: "15/01/2026",
      usoLentes: "SI",
    },
    tipos: { AE: "A", TA: "C", XX: "A" },
  });
  const p = leerFila(fila);
  assert.equal(p.apellidos, "QUISPE MAMANI");
  assert.equal(p.nombres, "LUIS");
  assert.equal(p.dni, "07481337");
  assert.equal(p.examenMedico, "2026-01-15");
  assert.equal(fila[colTipo("AE")], "A");
  assert.equal(fila[colTipo("TA")], "C");
  assert.equal(p.empresa, "AESA", "por defecto");
});

test("leerFila devuelve los 18 riesgos con su tipo y estado", () => {
  const r = renovarFila({
    fila: personaDePrueba(),
    hoy: HOY,
    diccionario: dic,
    items: [{ curso: "AISLAMIENTO, BLOQUEO Y ETIQUETADO DE ENERGÍAS", fecha: "2026-09-12", origen: "JOMISER" }],
  });
  const p = leerFila(r.fila);
  assert.equal(p.riesgos.length, 18);
  assert.equal(p.nombreCompleto, "CCENCHO TAYPE NICOLAS");
  assert.equal(p.riesgos.find((x) => x.codigo === "AE").venc, "2027-09-12");
});

/* ------------------------------------------------------------------ */
/* Reporte de vencimientos por RRCC                                    */
/* ------------------------------------------------------------------ */

function personaConRiesgo(dni, codigo, cap, venc) {
  const fila = filaVacia();
  fila[INDICE["DNI"]] = dni;
  fila[colTipo(codigo)] = "A";
  fila[colCap(codigo)] = cap;
  if (venc !== undefined) fila[colVenc(codigo)] = venc;
  return leerFila(fila);
}

test("personasPorRiesgo agrupa por RRCC y ordena de vencido a por vencer", () => {
  const personas = [
    personaConRiesgo("10000001", "AE", "2025-01-01", "2026-01-01"), // muy vencido para HOY=2026-09-21
    personaConRiesgo("10000002", "AE", "2026-09-01", "2027-09-01"), // vigente, le falta mucho
    personaConRiesgo("10000003", "AE", "2025-10-01", "2026-10-01"), // por vencer pronto
    personaConRiesgo("10000004", "TA", "2026-01-01", "2027-01-01"), // otro riesgo, no debe mezclarse
  ];

  const grupos = personasPorRiesgo(personas, { hoy: HOY });
  const ae = grupos.find((g) => g.codigo === "AE");
  const ta = grupos.find((g) => g.codigo === "TA");

  assert.equal(ae.items.length, 3);
  assert.deepEqual(ae.items.map((i) => i.persona.dni), ["10000001", "10000003", "10000002"], "vencido primero, vigente al final");
  assert.equal(ae.items[0].estado, "VENCIDO");
  assert.ok(ae.items[0].dias < 0, "vencido hace dias, no faltan dias");
  assert.equal(ae.items[2].estado, "VIGENTE");

  assert.equal(ta.items.length, 1);
  assert.equal(ta.items[0].persona.dni, "10000004");

  // sin capacitacion no hay fecha de la que ordenar: no entra al reporte
  const sc = grupos.find((g) => g.codigo === "SQ");
  assert.equal(sc.items.length, 0);
});

test("personasPorRiesgo invierte el orden con descendente:true", () => {
  const personas = [
    personaConRiesgo("20000001", "TA", "2025-01-01", "2026-01-01"),
    personaConRiesgo("20000002", "TA", "2026-09-01", "2027-09-01"),
  ];
  const grupos = personasPorRiesgo(personas, { hoy: HOY, descendente: true });
  const ta = grupos.find((g) => g.codigo === "TA");
  assert.deepEqual(ta.items.map((i) => i.persona.dni), ["20000002", "20000001"]);
});

test("personasPorRiesgo calcula la vigencia si falta (cap + umbral) sin tocar la fila original", () => {
  const personas = [personaConRiesgo("30000001", "TA", "2026-01-01")]; // sin venc en la fila
  const grupos = personasPorRiesgo(personas, { hoy: HOY });
  const item = grupos.find((g) => g.codigo === "TA").items[0];
  assert.equal(item.riesgo.venc, "2027-01-01");
  assert.equal(personas[0].riesgos.find((r) => r.codigo === "TA").venc, "", "no muta la persona de entrada");
});

test("riesgosProblemaDe separa lo vencido de lo por vencer y deja fuera lo vigente", () => {
  const fila = filaVacia();
  fila[INDICE["DNI"]] = "40000001";
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2025-01-01"; // muy vencido para HOY
  fila[colTipo("TA")] = "A";
  fila[colCap("TA")] = "2025-10-01"; // por vencer (dentro del umbral ACTUALIZAR)
  fila[colTipo("IE")] = "A";
  fila[colCap("IE")] = "2026-09-01"; // vigente, no entra en ninguna lista

  const persona = leerFila(fila);
  const { vencidos, porVencer } = riesgosProblemaDe(persona, { hoy: HOY });

  assert.equal(vencidos.length, 1);
  assert.equal(vencidos[0].codigo, "AE");
  assert.ok(vencidos[0].dias < 0);

  assert.equal(porVencer.length, 1);
  assert.equal(porVencer[0].codigo, "TA");

  assert.ok(!vencidos.some((r) => r.codigo === "IE"));
  assert.ok(!porVencer.some((r) => r.codigo === "IE"));
});

test("riesgosProblemaDe ordena cada lista de lo mas urgente a lo menos urgente", () => {
  const fila = filaVacia();
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2024-01-01"; // el mas vencido
  fila[colTipo("TA")] = "A";
  fila[colCap("TA")] = "2025-06-01"; // vencido, pero menos que AE

  const persona = leerFila(fila);
  const { vencidos } = riesgosProblemaDe(persona, { hoy: HOY });
  assert.deepEqual(vencidos.map((r) => r.codigo), ["AE", "TA"]);
});

test("el PDF consolidado de Drive no se toma por un curso sin mapear", () => {
  const r = elegirCertificados(
    [
      { curso: "40018082_CCENCHO TAYPE NICOLAS", origen: "DRIVE", fecha: "", descargable: true },
      { curso: "TRABAJOS EN ALTURA", origen: "JOMISER", fecha: "2026-09-13" },
    ],
    dic
  );
  assert.equal(r.noMapeados.length, 0, "no es un curso: no debe pedir revision");
  assert.equal(r.personales.length, 1, "pero sigue siendo un certificado de la persona");
  assert.equal(r.porRrcc.size, 1);
});

test("un curso de JOMISER que empieza con numeros si se intenta mapear", () => {
  const r = elegirCertificados([{ curso: "2026 CURSO NUEVO", origen: "JOMISER", fecha: "2026-01-01" }], dic);
  assert.equal(r.personales.length, 0, "la regla solo aplica a la carpeta de Drive");
  assert.equal(r.noMapeados.length, 1);
});

test("aplicar C actualiza los no autorizados y excluye IE, AP, OB, MD y RIG", () => {
  const fila = filaVacia();
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2026-01-01";
  const r = aplicarCapacitacionC(fila, "2026-09-10", { hoy: HOY });
  assert.equal(r[colTipo("AE")], "A", "una autorizacion A no se toca");
  assert.equal(r[colTipo("PM")], "C");
  assert.equal(r[colCap("PM")], "2026-09-10");
  assert.equal(r[colVenc("PM")], "2027-09-10");
  for (const codigo of ["IE", "AP", "OB", "MD", "RIG"]) {
    assert.equal(r[colTipo(codigo)], "", `${codigo} queda excluido`);
    assert.equal(r[colCap(codigo)], "", `${codigo} no recibe fecha`);
  }
  assert.deepEqual(EXCLUIDOS_APLICAR_C, ["IE", "AP", "OB", "MD", "RIG"]);
});

test("aplicar C no pisa lo que IE y AP ya tienen, ni con fecha ni al limpiar", () => {
  const fila = filaVacia();
  for (const codigo of ["IE", "AP"]) {
    fila[colCap(codigo)] = "2026-03-01";
    fila[colVenc(codigo)] = "2027-03-01";
    fila[colTipo(codigo)] = "C";
    fila[colEstado(codigo)] = "VIGENTE";
  }
  for (const fecha of ["2026-09-10", ""]) {
    const r = aplicarCapacitacionC(fila, fecha, { hoy: HOY });
    for (const codigo of ["IE", "AP"]) {
      assert.deepEqual(
        [r[colCap(codigo)], r[colVenc(codigo)], r[colTipo(codigo)], r[colEstado(codigo)]],
        ["2026-03-01", "2027-03-01", "C", "VIGENTE"],
        `${codigo} intacto con fecha "${fecha}"`
      );
    }
  }
});

test("aplicar C solo actua sobre las tarjetas elegidas y sin eleccion no toca nada", () => {
  const fila = filaVacia();
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2026-01-01";
  const r = aplicarCapacitacionC(fila, "2026-09-10", { hoy: HOY, solo: ["PM", "CS", "AE", "IE"] });
  assert.equal(r[colTipo("PM")], "C");
  assert.equal(r[colTipo("CS")], "C");
  assert.equal(r[colTipo("TA")], "", "TA no estaba elegida");
  assert.equal(r[colTipo("AE")], "A", "una A elegida tampoco se toca");
  assert.equal(r[colCap("AE")], "2026-01-01");
  assert.equal(r[colTipo("IE")], "", "IE esta excluida aunque se elija");

  const ninguna = aplicarCapacitacionC(fila, "2026-09-10", { hoy: HOY, solo: [] });
  for (const codigo of CODIGOS_RRCC) {
    assert.equal(ninguna[colTipo(codigo)], fila[colTipo(codigo)], `${codigo} sin cambios`);
    assert.equal(ninguna[colCap(codigo)], fila[colCap(codigo)], `${codigo} sin fecha nueva`);
  }
});

test("admiteAplicarC deja fuera a las A y a los riesgos excluidos", () => {
  assert.equal(admiteAplicarC("PM", ""), true);
  assert.equal(admiteAplicarC("PM", "C"), true);
  assert.equal(admiteAplicarC("PM", "a"), false);
  for (const codigo of EXCLUIDOS_APLICAR_C) assert.equal(admiteAplicarC(codigo, ""), false, codigo);
});

test("aplicar C con fecha vacia limpia los bloques no A", () => {
  const fila = filaVacia();
  fila[colCap("PM")] = "2026-01-01";
  fila[colVenc("PM")] = "2027-01-01";
  fila[colTipo("PM")] = "C";
  fila[colEstado("PM")] = "VIGENTE";
  const r = aplicarCapacitacionC(fila, "", { hoy: HOY });
  assert.deepEqual([r[colCap("PM")], r[colVenc("PM")], r[colTipo("PM")], r[colEstado("PM")] ], ["", "", "", ""]);
});

test("editar la vigencia a mano fija el vencimiento y retrocede la capacitacion", () => {
  const fila = filaVacia();
  fila[colTipo("SP")] = "A";
  fila[colCap("SP")] = "2026-01-01";
  fila[colVenc("SP")] = "2027-01-01";
  const r = aplicarEdicionesManuales(fila, { SP: { venc: "2027-07-20" } }, { hoy: HOY });
  assert.equal(r[colVenc("SP")], "2027-07-20");
  assert.equal(r[colCap("SP")], "2026-07-20", "cap = vigencia - 365");
  assert.equal(r[colEstado("SP")], "VIGENTE");
  assert.equal(r[colTipo("SP")], "A", "el tipo no se toca si no se edita");
  assert.equal(fila[colVenc("SP")], "2027-01-01", "no muta la fila recibida");
});

test("una vigencia editada a mano cerca de vencer sale como ACTUALIZAR", () => {
  const r = aplicarEdicionesManuales(filaVacia(), { AE: { venc: "2026-10-05" } }, { hoy: HOY });
  assert.equal(r[colEstado("AE")], "ACTUALIZAR");
  assert.equal(r[INDICE["FECHA MINIMA"]], "2026-10-05");
});

test("editar el tipo a mano cambia solo el tipo, y un valor raro lo deja vacio", () => {
  const fila = filaVacia();
  fila[colTipo("TA")] = "C";
  fila[colCap("TA")] = "2026-05-01";
  fila[colVenc("TA")] = "2027-05-01";
  const r = aplicarEdicionesManuales(fila, { TA: { tipo: "a" }, HM: { tipo: "X" } }, { hoy: HOY });
  assert.equal(r[colTipo("TA")], "A");
  assert.equal(r[colCap("TA")], "2026-05-01", "las fechas quedan como estaban");
  assert.equal(r[colTipo("HM")], "");
});

test("vaciar la vigencia a mano limpia el bloque de fechas del riesgo", () => {
  const fila = filaVacia();
  fila[colTipo("IE")] = "A";
  fila[colCap("IE")] = "2026-01-01";
  fila[colVenc("IE")] = "2027-01-01";
  fila[colEstado("IE")] = "VIGENTE";
  const r = aplicarEdicionesManuales(fila, { IE: { venc: "" } }, { hoy: HOY });
  assert.deepEqual([r[colCap("IE")], r[colVenc("IE")], r[colEstado("IE")]], ["", "", ""]);
  assert.equal(r[colTipo("IE")], "A");
});

test("las ediciones manuales respetan el umbral de CONFIG y ignoran codigos ajenos", () => {
  const r = aplicarEdicionesManuales(filaVacia(), { CS: { venc: "2027-01-31" }, ZZ: { tipo: "A" } }, {
    hoy: HOY,
    config: { UMBRAL_VENCIDO: 300 },
  });
  assert.equal(r[colCap("CS")], "2026-04-06", "31/01/2027 - 300 dias");
  assert.equal(r.length, CABECERA.length);
});

test("aIso lee el instante ISO con que Apps Script entrega las fechas de la hoja", () => {
  assert.equal(aIso("2026-08-09T07:00:00.000Z"), "2026-08-09", "medianoche de un huso al oeste de UTC");
  assert.equal(aIso("2026-08-09T05:00:00.000Z"), "2026-08-09", "medianoche de Lima");
  assert.equal(aIso("2026-08-08T19:00:00.000Z"), "2026-08-09", "medianoche de un huso al este de UTC");
  assert.equal(aIso("2026-08-09T00:00:00"), "2026-08-09", "sin huso");
  assert.equal(aIso("2026-13-09T07:00:00.000Z"), "", "una fecha imposible sigue sin inventarse");
});

test("copiarFila deja como ISO las fechas del bloque de riesgos y no toca lo demas", () => {
  const fila = filaVacia();
  fila[colCap("AE")] = "2026-08-09T07:00:00.000Z";
  fila[colVenc("AE")] = "2027-08-10T07:00:00.000Z";
  fila[colTipo("AE")] = "A";
  fila[INDICE["ANEXO 04"]] = "2026-01-01T07:00:00.000Z";
  fila[colCap("IE")] = "texto raro";
  const r = copiarFila(fila);
  assert.equal(r[colCap("AE")], "2026-08-09");
  assert.equal(r[colVenc("AE")], "2027-08-10");
  assert.equal(r[colTipo("AE")], "A");
  assert.equal(r[INDICE["ANEXO 04"]], "2026-01-01T07:00:00.000Z", "solo se normaliza el bloque RRCC");
  assert.equal(r[colCap("IE")], "texto raro", "lo que no es fecha se conserva");
  assert.equal(fila[colCap("AE")], "2026-08-09T07:00:00.000Z", "no muta la fila recibida");
});

test("una hoja con fechas de Apps Script no se borra ni se marca como nueva al renovar", () => {
  const fila = filaVacia();
  fila[colTipo("OB")] = "A";
  fila[colCap("OB")] = "2026-07-20T07:00:00.000Z";
  fila[colVenc("OB")] = "2027-07-20T07:00:00.000Z";
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2026-08-09T07:00:00.000Z";
  const items = [{ curso: "BLOQUEO Y AISLAMIENTO DE ENERGIAS", origen: "JOMISER", fecha: "2026-08-09", descargable: true }];
  const r = renovarFila({ fila, items, diccionario: dic, hoy: HOY });
  const ob = r.detalle.find((d) => d.codigo === "OB");
  assert.equal(r.fila[colCap("OB")], "2026-07-20", "sin certificado, la fecha de la hoja se conserva");
  assert.equal(ob.estado, "VIGENTE");
  assert.equal(r.detalle.find((d) => d.codigo === "AE").cambio, "SIN CAMBIO", "misma fecha que la hoja");
});

test("aplicar C y las ediciones manuales no reenvian a la hoja el instante crudo de Apps Script", () => {
  const fila = filaVacia();
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2026-08-09T07:00:00.000Z";
  fila[colVenc("AE")] = "2027-08-10T07:00:00.000Z";
  const c = aplicarCapacitacionC(fila, "2026-08-24", { hoy: HOY });
  assert.equal(c[colCap("AE")], "2026-08-09");
  assert.equal(c[colVenc("AE")], "2027-08-10");
  assert.equal(c[INDICE["FECHA MINIMA"]], "2027-08-10", "la A cuenta para la fecha minima");
  const e = aplicarEdicionesManuales(fila, { IE: { tipo: "C" } }, { hoy: HOY });
  assert.equal(e[colCap("AE")], "2026-08-09");
  assert.equal(e[colVenc("AE")], "2027-08-10");
});

test("la persona con las ediciones aplicadas lleva el tipo, la vigencia y el estado final del fotocheck", () => {
  const fila = filaVacia();
  fila[INDICE["DNI"]] = "04060472";
  fila[colTipo("AE")] = "A";
  fila[colCap("AE")] = "2026-08-22";
  fila[colVenc("AE")] = "2027-08-22";
  fila[colTipo("HP")] = "C";
  fila[colCap("HP")] = "2026-08-24";
  fila[colVenc("HP")] = "2027-08-24";
  const editada = leerFila(
    aplicarEdicionesManuales(fila, { AE: { tipo: "A", venc: "2027-09-30" }, HP: { tipo: "A", venc: "2027-08-24" } }, { hoy: HOY })
  );
  const ae = editada.riesgos.find((r) => r.codigo === "AE");
  const hp = editada.riesgos.find((r) => r.codigo === "HP");
  assert.equal(ae.venc, "2027-09-30", "el fotocheck imprime la vigencia editada");
  assert.equal(hp.tipo, "A", "y el tipo editado");
  assert.equal(editada.fechaMinima, "2027-08-24", "la fecha minima sale de las vigencias editadas");
  assert.equal(editada.estadoFinal, "VIGENTE");

  const vencida = leerFila(aplicarEdicionesManuales(fila, { AE: { venc: "2026-09-01" } }, { hoy: HOY }));
  assert.equal(vencida.estadoFinal, "VENCIDO", "una vigencia ya pasada vuelve la persona NO AUTORIZADA");
});

/* ------------------------------------------------------------------ */
/* Documentos                                                          */
/* ------------------------------------------------------------------ */

test("el documento se lleva siempre a 8 digitos", () => {
  // Sheets y Excel guardan 07481337 como el numero 7481337
  assert.equal(normalizarDocumento(7481337), "07481337");
  assert.equal(normalizarDocumento("07481337"), "07481337");
  assert.equal(normalizarDocumento(" 4075286 "), "04075286");
  assert.equal(normalizarDocumento("350889"), "00350889");
});

test("un documento largo no se recorta y uno vacio no se inventa", () => {
  assert.equal(normalizarDocumento("001234567890"), "001234567890", "carne de extranjeria");
  assert.equal(normalizarDocumento(""), "");
  assert.equal(normalizarDocumento(null), "");
  assert.equal(normalizarDocumento("sin dni"), "");
});

test("el fotocheck imprime el DNI con sus 8 digitos aunque la hoja lo traiga corto", () => {
  const fila = filaVacia();
  fila[INDICE["DNI"]] = 4075286; // como lo devuelve Sheets, sin el cero
  assert.equal(leerFila(fila).dni, "04075286");
});

test("las dos grafias de la foto en Drive apuntan al mismo documento", () => {
  // en la carpeta FOTOS conviven "4075286.png" y "04065624.png"
  assert.equal(normalizarDocumento("4075286"), normalizarDocumento("04075286"));
  assert.notEqual(normalizarDocumento("4075286"), normalizarDocumento("14075286"));
});
