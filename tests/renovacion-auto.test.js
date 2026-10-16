/**
 * Pruebas de RENOVAR AUTOMATICO (pestana RENOVACION): los criterios que antes
 * aplicaba el robot de AUTO_RRCC. Solo la parte que decide, sin DOM ni red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  candidatosLaterales,
  elegirCertificadoLateral,
  candidatoPorReintentar,
  CRITERIOS_AUTO,
  planFechas,
  planQuitar,
  faltaActualizar,
  fechaDeInduccion,
  fechasDeCursosPdf,
  nombreZipAuto,
  erroresPorDni,
  calificarAuto,
  hojaDetalleAuto,
  cursoVigente,
  sumarDiasIso,
  isoDeCorta,
} from "../src/lib/renovacion.js";

const HOY = "2026-10-15";

const riesgo = (codigo, tipo, venc = "", extra = {}) => ({
  codigo, tipo, venc, sinCert: false, certVigencia: "", certCurso: "", certClave: "", certExcluido: false, ...extra,
});

function ficha(extra = {}) {
  return {
    riesgos: [
      riesgo("HM", "A", "2026-01-10", { certClave: "JOMISER|hm|", certCurso: "curso 10/01/2025 · JOMISER", certVigencia: "10/01/2026" }),
      riesgo("ES", "A", "2026-01-10"),
      riesgo("CS", "C", "2025-05-01"),
      riesgo("TA", "C", "2025-05-01"), // Trabajo en Altura en C: sigue en C con la fecha de HM/ES
      riesgo("HP", "C", "2025-05-01"), // un C fuera de la lista: pasa a "–"
      riesgo("EC", "A", "2026-03-01", { certCurso: "curso 02/03/2026 · DRIVE", certVigencia: "02/03/2027" }),
      riesgo("IZ", "A", "2026-03-01", { certCurso: "curso 02/03/2026 · EIN", certVigencia: "02/03/2027" }),
      riesgo("SP", "A", "", { sinCert: true }),
      riesgo("VEM", "A", "2026-12-01"),
    ],
    laterales: [
      { origen: "EIN", clave: "EIN|rc1|", curso: "RIESGOS CRITICOS", fecha: "20/08/2026", descargable: true, excluido: false },
      { origen: "EIN", clave: "EIN|ind|", curso: "INDUCCION", fecha: "01/10/2026", descargable: true, excluido: false },
      { origen: "INDUCCION", clave: "INDUCCION|pdf|", curso: "Induccion", fecha: "", descargable: true, excluido: false },
    ],
    emo: "2027-01-01",
    nombre: "PEREZ JUAN",
    ...extra,
  };
}

test("fechas: vigencia de 365 dias y formatos", () => {
  assert.equal(isoDeCorta("1/9/2026"), "2026-09-01");
  assert.equal(isoDeCorta("31/02/2026"), null);
  assert.equal(sumarDiasIso("2026-08-20", 365), "2027-08-20");
  assert.ok(cursoVigente("2025-10-15", HOY)); // justo 365 dias: aun vigente
  assert.ok(!cursoVigente("2025-10-14", HOY));
  assert.ok(!cursoVigente("2026-10-16", HOY)); // fecha futura no cuenta
});

test("candidatos: RIESGOS CRITICOS de EIN y las inducciones; el item INDUCCION de EIN no cuenta", () => {
  const c = candidatosLaterales(ficha());
  assert.deepEqual(c.map((x) => x.clave), ["EIN|rc1|", "INDUCCION|pdf|"]);
  assert.equal(c[0].fechaIso, "2026-08-20");
  assert.equal(c[1].leerPdf, true);
});

test("elegido: el mas reciente entre los vigentes", () => {
  const c = candidatosLaterales(ficha());
  c[1].fechaIso = "2026-09-23";
  assert.equal(elegirCertificadoLateral(c, HOY).clave, "INDUCCION|pdf|");
  c[1].fechaIso = "2024-09-23"; // vencida: manda EIN
  assert.equal(elegirCertificadoLateral(c, HOY).clave, "EIN|rc1|");
  c[0].fechaIso = "2024-01-01";
  assert.equal(elegirCertificadoLateral(c, HOY), null);
});

test("elegido: un RIESGOS CRITICOS de EIN que no abre se salta y manda el siguiente que abre", () => {
  // el caso real: varios RIESGOS CRITICOS en EIN, los mas nuevos "sin certificado emitido"
  const laterales = [
    ["rc0410", "04/10/2026"],
    ["rc2509", "25/09/2026"],
    ["rc2009", "20/09/2026"],
    ["rc1309", "13/09/2026"],
  ].map(([id, fecha]) => ({ origen: "EIN", clave: `EIN|${id}|`, curso: "RIESGOS CRITICOS", fecha, descargable: true, excluido: false }));
  const f = ficha({ laterales });
  const c = candidatosLaterales(f);
  for (const x of c) x.abre = x.clave === "EIN|rc1309|";
  const elegido = elegirCertificadoLateral(c, HOY);
  assert.equal(elegido.clave, "EIN|rc1309|");
  assert.equal(candidatoPorReintentar(c, elegido, HOY), null, "sin certificado emitido no se reintenta");
  // del panel queda el que abre; los que no abren se quitan
  const quitar = planQuitar(f, elegido, c).map((q) => q.clave);
  assert.ok(!quitar.includes("EIN|rc1309|"));
  assert.ok(["EIN|rc0410|", "EIN|rc2509|", "EIN|rc2009|"].every((k) => quitar.includes(k)));
  // ninguno vigente: el respaldo tampoco es uno que no abre
  for (const x of c) x.fechaIso = x.fechaIso.replace("2026", "2024");
  assert.ok(!planQuitar(f, null, c).some((q) => q.clave === "EIN|rc1309|"));
});

test("elegido: el panel SIN CERTIFICADO (no descargable) no cuenta", () => {
  const f = ficha();
  f.laterales[0].descargable = false;
  const c = candidatosLaterales(f);
  assert.equal(c[0].abre, false);
  assert.equal(c[0].leerPdf, false);
  c[1].fechaIso = "2024-01-01";
  assert.equal(elegirCertificadoLateral(c, HOY), null);
});

test("candidatoPorReintentar: un error pasajero en uno mas nuevo pide otra vuelta", () => {
  const c = [
    { origen: "EIN", clave: "a", fechaIso: "2026-10-04", abre: false, fallaPasajera: true },
    { origen: "EIN", clave: "b", fechaIso: "2026-09-13", abre: true },
  ];
  const elegido = elegirCertificadoLateral(c, HOY);
  assert.equal(elegido.clave, "b");
  assert.equal(candidatoPorReintentar(c, elegido, HOY).clave, "a");
  c[0].fechaIso = "2026-09-01"; // mas viejo que el elegido: no hace falta
  assert.equal(candidatoPorReintentar(c, elegido, HOY), null);
  // una induccion que no se pudo leer no tiene fecha: se reintenta
  c.push({ origen: "INDUCCION", clave: "i", fechaIso: null, abre: false, fallaPasajera: true });
  assert.equal(candidatoPorReintentar(c, elegido, HOY).clave, "i");
});

test("planFechas: HM/ES y los C de la lista con la fecha del elegido; demas C a –; A segun su certificado", () => {
  const f = ficha();
  const elegido = { origen: "EIN", clave: "EIN|rc1|", fechaIso: "2026-08-20" };
  const plan = planFechas(f, elegido);
  assert.deepEqual(plan.esperadas, {
    HM: "2027-08-20",
    ES: "2027-08-20",
    CS: "2027-08-20",
    TA: "2027-08-20",
    HP: null,
    EC: "2027-03-02",
    SP: null,
  });
  assert.deepEqual(plan.acciones.find((a) => a.codigo === "HP"), { codigo: "HP", tipo: "" });
  assert.deepEqual(plan.acciones.find((a) => a.codigo === "TA"), { codigo: "TA", venc: "2027-08-20" }, "TA en C no pasa a –");
  assert.ok(plan.avisos.some((a) => a.startsWith("IZ (A): su certificado es de EIN")));
  // un A sin certificado pasa a –
  assert.deepEqual(plan.acciones.find((a) => a.codigo === "SP"), { codigo: "SP", tipo: "" });
  // una fecha que ya esta bien no se toca
  f.riesgos.find((r) => r.codigo === "EC").venc = "2027-03-02";
  assert.ok(!planFechas(f, elegido).acciones.some((a) => a.codigo === "EC"));
});

test("planFechas: A sin certificado pasa a –, salvo HM y ES", () => {
  const f = ficha();
  f.riesgos.find((r) => r.codigo === "HM").sinCert = true;
  f.riesgos.find((r) => r.codigo === "ES").sinCert = true;
  f.riesgos.push(riesgo("CS2", "A", "2027-10-14", { sinCert: true }));
  const plan = planFechas(f, { origen: "EIN", clave: "EIN|rc1|", fechaIso: "2026-08-20" });
  assert.deepEqual(plan.acciones.find((a) => a.codigo === "CS2"), { codigo: "CS2", tipo: "" });
  assert.equal(plan.esperadas.CS2, null);
  for (const codigo of ["HM", "ES"]) {
    assert.ok(!plan.acciones.some((a) => a.codigo === codigo && a.tipo === ""), `${codigo} no pasa a –`);
    assert.equal(plan.esperadas[codigo], "2027-08-20");
  }
  // sin elegido HM/ES tampoco pasan a –
  assert.ok(!planFechas(f, null).acciones.some((a) => ["HM", "ES"].includes(a.codigo) && a.tipo === ""));
  // con el interruptor apagado solo avisa
  const apagado = planFechas(f, null, { ...CRITERIOS_AUTO, aSinCertificadoSinTipo: false });
  assert.ok(!apagado.acciones.some((a) => a.codigo === "CS2"));
  assert.ok(apagado.avisos.some((a) => a.startsWith("CS2 (A): sin certificado")));
});

test("planFechas sin elegido: HM/ES y los C de la lista no se tocan y se avisa", () => {
  const plan = planFechas(ficha(), null);
  assert.ok(!plan.acciones.some((a) => ["HM", "ES", "CS", "TA"].includes(a.codigo)));
  assert.ok(plan.avisos.some((a) => a.includes("HM/ES sin actualizar")));
  assert.ok(plan.avisos.some((a) => a.startsWith("CS (C): sin actualizar")));
});

test("planFechas: HM/ES en C pasan a A; IE, PM, OC, VEM y AP en C pasan a –", () => {
  const f = ficha();
  f.riesgos = f.riesgos.filter((r) => r.codigo !== "VEM");
  f.riesgos.find((r) => r.codigo === "HM").tipo = "C";
  for (const codigo of ["IE", "PM", "OC", "VEM", "AP"]) f.riesgos.push(riesgo(codigo, "C", "2025-05-01"));
  const plan = planFechas(f, { origen: "EIN", clave: "EIN|rc1|", fechaIso: "2026-08-20" });
  assert.deepEqual(plan.acciones[0], { codigo: "HM", tipo: "A" });
  assert.equal(plan.esperadas.HM, "2027-08-20");
  assert.equal(f.riesgos.find((r) => r.codigo === "HM").tipo, "C", "no muta la ficha");
  for (const codigo of ["IE", "PM", "OC", "VEM", "AP"]) {
    assert.deepEqual(plan.acciones.find((a) => a.codigo === codigo), { codigo, tipo: "" }, codigo);
    assert.equal(plan.esperadas[codigo], null);
  }
  // sin elegido HM sigue pasando a A
  assert.ok(planFechas(f, null).acciones.some((a) => a.codigo === "HM" && a.tipo === "A"));
});

test("planFechas: Trabajo en Altura en A sigue en A con la vigencia de su certificado", () => {
  const f = ficha();
  f.riesgos.find((r) => r.codigo === "TA").tipo = "A";
  Object.assign(f.riesgos.find((r) => r.codigo === "TA"), { certCurso: "curso 01/06/2026 · JOMISER", certVigencia: "01/06/2027" });
  const plan = planFechas(f, { origen: "EIN", clave: "EIN|rc1|", fechaIso: "2026-08-20" });
  assert.deepEqual(plan.acciones.filter((a) => a.codigo === "TA"), [{ codigo: "TA", venc: "2027-06-01" }]);
});

test("planQuitar: x a HM/ES y del panel lateral solo queda el elegido; una vez por clave", () => {
  const f = ficha();
  const candidatos = candidatosLaterales(f);
  const elegido = { ...candidatos[0], fechaIso: "2026-08-20" };
  const quitar = planQuitar(f, elegido, candidatos);
  assert.deepEqual(quitar.map((q) => q.clave), ["JOMISER|hm|", "EIN|ind|", "INDUCCION|pdf|"]);
  assert.equal(quitar[0].codigo, "HM");
  // ninguno vigente: queda el mas reciente con fecha
  candidatos[0].fechaIso = "2024-01-01";
  const sinVigente = planQuitar(f, null, candidatos);
  assert.ok(!sinVigente.some((q) => q.clave === "EIN|rc1|"));
});

test("faltaActualizar: EMO vencido o VEM A vencido; vence hoy = aun vale", () => {
  assert.deepEqual(faltaActualizar(ficha({ emo: HOY }), HOY), []);
  assert.deepEqual(faltaActualizar(ficha({ emo: "2026-10-14" }), HOY), ["EMO: vencido el 14/10/2026"]);
  assert.deepEqual(faltaActualizar(ficha({ emo: "" }), HOY), ["EMO: sin fecha de vencimiento"]);
  const f = ficha();
  f.riesgos.find((r) => r.codigo === "VEM").venc = "2026-01-01";
  assert.deepEqual(faltaActualizar(f, HOY), ["Vehiculos y Equipos Moviles (A): vencido el 01/01/2026"]);
});

test("fechaDeInduccion: INICIO del PDF o 'Realizado el dia'", () => {
  assert.deepEqual(fechaDeInduccion("DNI 04086358  INICIO: 23/9/2026 FIN: 24/9/2026", "04086358"), { fecha: "2026-09-23", problema: "" });
  assert.deepEqual(fechaDeInduccion("dni 4086358 Realizado el día 23 de Setiembre del 2026", "04086358"), { fecha: "2026-09-23", problema: "" });
  assert.equal(fechaDeInduccion("INICIO: 23/9/2026", "04086358").problema, "el PDF no trae este DNI");
  assert.equal(fechaDeInduccion("DNI 04086358", "04086358").problema, "no se encontró la fecha en el PDF");
});

test("nombreZipAuto: DNI_NOMBRE y FALTA ACTUALIZAR", () => {
  assert.deepEqual(nombreZipAuto("PEREZ JUAN.zip", "04086358"), { base: "04086358_PEREZ JUAN", nombre: "04086358_PEREZ JUAN.zip" });
  assert.equal(nombreZipAuto("PEREZ JUAN.zip", "04086358", ["EMO"]).nombre, "04086358_PEREZ JUAN - FALTA ACTUALIZAR.zip");
});

test("erroresPorDni: reparte los certificados que no bajaron por DNI", () => {
  const errores = erroresPorDni([
    { t: "[1/2] DNI 11111111", c: "ln ln-head" },
    { t: "· HM no se pudo bajar", c: "ln ln-err" },
    { t: "[22222222] no se pudo subir ES.pdf", c: "ln ln-err" },
    { t: "[22222222] otra cosa", c: "ln ln-err" },
    { t: "· aviso sin error", c: "ln ln-warn" },
  ]);
  assert.deepEqual(errores, { 11111111: ["· HM no se pudo bajar"], 22222222: ["no se pudo subir ES.pdf"] });
});

test("Excel de detalle: una fila por DNI con su calificacion", () => {
  const r = { dni: "1", nombre: "X", estado: "OK", zip: "1_X.zip", faltaActualizar: "", cambios: "a | b", guardadoHoja: "SI", drive: "OK", avisos: "", intentos: 1 };
  assert.equal(calificarAuto(r), "OK");
  assert.equal(calificarAuto({ ...r, faltaActualizar: "EMO" }), "OBSERVACION");
  assert.equal(calificarAuto({ ...r, estado: "ERROR" }), "FALLA");
  const hoja = hojaDetalleAuto([r, { ...r, dni: "2", estado: "ERROR", zip: "" }]);
  assert.equal(hoja.filas.length, 2);
  assert.equal(hoja.filas[0][6], "a\nb");
  assert.match(hoja.filas[1][4], /NO SE GENERÓ EL ZIP/);
});

/* Pagina 2 de un certificado RIESGOS CRITICOS de EIN, con las posiciones que
   da pdf.js: la columna FECHA son dos celdas combinadas (1-7 y 8-13). */
function paginaTablaEin(dia1 = "08/10/2025", dia2 = "09/10/2025") {
  const it = (str, x, y, ancho = 10) => ({ str, x, y, ancho });
  return {
    items: [
      it("CURSO RIESGOS CRITICOS - NEXA RESOURCES", 136, 487, 300),
      it("FECHA", 543, 485, 40),
      it("DURACIÓN", 624, 484, 60),
      it("1.- BLOQUEO Y AISLAMIENTO DE ENERGÍA", 58, 465, 250),
      it("2.- INSTALACIONES ELÉCTRICAS", 58, 448, 200),
      it("3.- SUSTANCIAS QUÍMICAS PELIGROSAS", 58, 430, 230),
      it("4.- PROTECCIÓN DE MÁQUINAS", 58, 410, 190),
      it("5.- TRABAJO EN ALTURA", 57, 389, 150),
      it("6.- CARGAS SUSPENDIDAS", 57, 369, 160),
      it("7.- SISTEMAS PRESURIZADOS", 57, 350, 170),
      it("8.- EXCAVACIÓN SUBTERRÁNEA: MANEJO DE EXPLOSIVOS, GASEAMIENTO,CAÍDA DE ROCAS Y", 56, 332, 470),
      it("BLOQUEO DE LABORES.", 56, 320, 130),
      it("9.- HERRAMIENTAS MANUALES", 58, 302, 180),
      it("10.- EXCAVACIÓN EN OBRAS CIVILES", 58, 282, 220),
      it("11.- ESPACIO CONFINADO", 58, 264, 160),
      it("12.- VEHÍCULOS Y EQUIPOS MÓVILES", 58, 245, 220),
      it("13.- ANIMALES PONZOÑOSOS", 57, 227, 170),
      it("2 Hrs.", 648, 465), it("30 Min.", 645, 353), it("4 Hrs.", 648, 331),
      it(dia2, 544, 282, 50),
      it(dia1, 541, 411, 50),
      it("TOTAL", 542, 207, 30),
      it("Lima; 9 de Octubre de 2025", 47, 135, 150),
    ],
  };
}

test("fechasDeCursosPdf: cada curso con la fecha de su celda combinada", () => {
  const f = fechasDeCursosPdf([{ items: [it0()] }, paginaTablaEin()]);
  for (const c of ["AE", "IE", "SQ", "PM", "TA", "CS", "SP"]) assert.equal(f[c], "2025-10-08", c);
  for (const c of ["ES", "HM", "OC", "EC", "VEM", "AP"]) assert.equal(f[c], "2025-10-09", c);
  // una pagina sin tabla (la de induccion basica) no aporta nada
  assert.deepEqual(fechasDeCursosPdf([{ items: [it0()] }]), {});
  function it0() {
    return { str: "INICIO: 8/10/2025", x: 47, y: 100, ancho: 80 };
  }
});

test("planFechas: HM/ES y los C con la fecha de SU curso en la tabla, no la general", () => {
  const f = ficha();
  f.riesgos.find((r) => r.codigo === "EC").tipo = "C";
  const fechas = fechasDeCursosPdf([paginaTablaEin()]);
  const elegido = { origen: "EIN", clave: "EIN|rc1|", fechaIso: "2025-10-08", fechas };
  const plan = planFechas(f, elegido);
  assert.equal(plan.esperadas.HM, "2026-10-09");
  assert.equal(plan.esperadas.ES, "2026-10-09");
  assert.equal(plan.esperadas.CS, "2026-10-08", "CS va en el primer bloque");
  assert.equal(plan.esperadas.TA, "2026-10-08");
  assert.equal(plan.esperadas.EC, "2026-10-09", "EC va en el segundo bloque");
  assert.ok(!plan.avisos.some((a) => a.includes("no trae la tabla")));
  // sin tabla: la fecha general del certificado, con aviso
  const sinTabla = planFechas(ficha(), { ...elegido, fechas: {} });
  assert.equal(sinTabla.esperadas.HM, "2026-10-08");
  assert.ok(sinTabla.avisos.some((a) => a.includes("no trae la tabla")));
});

/* Induccion de Drive: un certificado por curso (pagina del certificado +
   pagina del TEMARIO), todos con la misma fecha. */
test("fechasDeCursosPdf: induccion de Drive con un certificado por curso", () => {
  const pagina = (texto) => ({ items: texto.split(" ").map((str, k) => ({ str, x: k * 10, y: 100, ancho: 8 })) });
  const cert = (curso) =>
    pagina(`Otorga el presente certificado a: PEREZ JUAN Con DNI: 12345678 Por haber culminado satisfactoriamente el curso de: ${curso} Realizado el día 7 de octubre del 2026 Duración 1 Hora INICIO: 7 / 10 / 2026 FIN AL : 8 / 3 0 / 2027`);
  const temario = (titulo, curso) => pagina(`TEMARIO ${titulo} • Referencias Normativas • Definiciones CURSO DURACIÓN NOTA ${curso} 1 H O R A 18 Lima; 7 de octubre del 2026`);
  const paginas = [
    // nombre mal escrito: vale el del TEMARIO
    cert("EXCAVACACIONES SUBTERRANEAS: MANEJO DE EXPLOSIVOS, GASEAMIENTO Y CAIDA DE ROCAS"),
    temario("Excavaciones Subterráneas: Manejo de explosivos, Gaseamiento y Caída de rocas", "EXCAVACIONES SUBTERRANEAS"),
    cert("TRABAJOS EN ALTURA"),
    temario("Trabajos en Altura", "TRABAJOS EN ALTURA"),
    // el nombre quedo fuera de lugar en el texto: vale el del TEMARIO
    pagina("Por haber culminado satisfactoriamente el curso de: Realizado el día 7 de octubre del 2026 Duración 1 Hora REGISTRO HERRAMIENTAS MANUALES"),
    temario("Herramientas Manuales", "HERRAMIENTAS MANUALES"),
    cert("VEHÍCULOS Y EQUIPOS MÓVILES"),
    temario("Vehículo y Equipo Móviles", "VEHÍCULOS Y EQUIPOS MÓVILES"),
  ];
  assert.deepEqual(fechasDeCursosPdf(paginas), { ES: "2026-10-07", TA: "2026-10-07", HM: "2026-10-07", VEM: "2026-10-07" });
  // el INICIO con espacios tambien vale para la fecha general
  assert.equal(fechaDeInduccion("CON DNI: 12345678 INICIO: 7 / 10 / 2026", "12345678").fecha, "2026-10-07");
});
