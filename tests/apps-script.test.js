/**
 * Pruebas de las escrituras de Apps Script (`apps-script/Code.gs`).
 *
 * Code.gs no es un modulo: se carga tal cual en un contexto `vm` con una hoja
 * simulada (cada celda guarda valor y formula). Lo que se comprueba es la regla
 * de la base: el ESTADO de cada RRCC es una formula de la hoja y ni el guardado
 * de fechas ni el alta de una persona nueva pueden reemplazarla por texto.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const CODIGO = fs.readFileSync(new URL("../apps-script/Code.gs", import.meta.url), "utf8");

/* ---------------- hoja simulada ---------------- */

function hojaSimulada(nombre, columnas) {
  const celdas = new Map(); // "fila,col" -> { v, f }
  const celda = (r, c) => {
    const k = `${r},${c}`;
    if (!celdas.has(k)) celdas.set(k, { v: "", f: "" });
    return celdas.get(k);
  };
  const ponerCelda = (r, c, x) => {
    const t = celda(r, c);
    if (typeof x === "string" && x.startsWith("=")) Object.assign(t, { f: x, v: "(calculado)" });
    else Object.assign(t, { f: "", v: x });
  };
  // A1 <-> R1C1 para las referencias relativas que usan estas pruebas (Q4, T9...)
  const letras = (n) => {
    let s = "";
    for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  };
  const numero = (l) => [...l].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  const aR1C1 = (f, r, c) => f.replace(/([A-Z]+)(\d+)/g, (_, col, n) => `R[${Number(n) - r}]C[${numero(col) - c}]`);
  const deR1C1 = (f, r, c) => f.replace(/R\[(-?\d+)\]C\[(-?\d+)\]/g, (_, dr, dc) => letras(c + Number(dc)) + (r + Number(dr)));

  const hoja = {
    celdas,
    celda,
    fallarFormulas: false, // simula un error de Google al escribir el bloque de riesgos
    getName: () => nombre,
    getMaxColumns: () => columnas,
    getLastRow: () => Math.max(0, ...[...celdas].filter(([, t]) => t.v !== "" || t.f).map(([k]) => Number(k.split(",")[0]))),
    getRange(fila, col, nf = 1, nc = 1) {
      const cada = (fn) => Array.from({ length: nf }, (_, i) => Array.from({ length: nc }, (_, j) => fn(fila + i, col + j)));
      return {
        getValues: () => cada((r, c) => celda(r, c).v),
        getFormulas: () => cada((r, c) => celda(r, c).f),
        setValues(matriz) {
          matriz.forEach((fila_, i) => fila_.forEach((x, j) => ponerCelda(fila + i, col + j, x)));
        },
        setValue: (x) => ponerCelda(fila, col, x),
        getFormula: () => celda(fila, col).f,
        // R1C1 es relativo: la misma formula puesta en otra fila queda como si se arrastrara
        getFormulasR1C1: () => cada((r, c) => (celda(r, c).f ? aR1C1(celda(r, c).f, r, c) : "")),
        setFormulasR1C1(matriz) {
          if (hoja.fallarFormulas) throw new Error("Exception: error de Google al escribir formulas");
          matriz.forEach((fila_, i) =>
            fila_.forEach((x, j) => {
              const r = fila + i;
              const c = col + j;
              ponerCelda(r, c, typeof x === "string" && x.startsWith("=") ? deR1C1(x, r, c) : x);
            })
          );
        },
        clearContent() {
          cada((r, c) => Object.assign(celda(r, c), { v: "", f: "" }));
        },
        // Google lo rechaza si el rango de origen tiene filas ocultas por un filtro, y la hoja
        // real lo tiene activo ("Se muestran 2 de 617 filas"): el codigo no puede depender de el.
        copyTo() {
          throw new Error("No se admite esta operación en un rango con una fila filtrada.");
        },
      };
    },
  };
  return hoja;
}

function cargar(hoja, servicios = {}) {
  const libro = { getSheets: () => [hoja], getSheetByName: () => null, getId: () => "x" };
  const cache = new Map();
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => "" }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache.get(k) ?? null, put: (k, v) => cache.set(k, v) }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { openById: () => libro, flush() {}, CopyPasteType: { PASTE_FORMULA: "PASTE_FORMULA" } },
    ContentService: {},
    DriveApp: {},
    Utilities: {},
    Session: {},
    ...servicios,
  };
  return vm.runInNewContext(`${CODIGO}\n;({ guardar, alta, listado, formulaEstado, CABECERA, DATOS, COL_ESTADO })`, sandbox);
}

/* ---------------- ayudas ---------------- */

const IE_CAP = 20; // T: Fecha de capacitacion_IE (1-based)
const IE_ESTADO = 23; // W: ESTADO_IE
const FORMULA_IE = (fila) =>
  `=IF(TODAY()-T${fila}=TODAY(),"NO APLICA",IF(TODAY()-T${fila}>365,"VENCIDO",IF(TODAY()-T${fila}>=330,"ACTUALIZAR","VIGENTE")))`;

function filaDe(api, datos = {}) {
  const fila = api.CABECERA.map(() => "");
  for (const [nombre, valor] of Object.entries(datos)) fila[api.CABECERA.indexOf(nombre)] = valor;
  return fila;
}

/** Una persona ya cargada en la fila 4 con formulas en ESTADO_xx y FECHA MINIMA. */
function hojaConPersona(api, hoja) {
  const p = filaDe(api, { Codigo: "AE001", DNI: 11111111, "Fecha de capacitacion_IE": "2025-10-17", TIPO_IE: "A" });
  hoja.getRange(4, 1, 1, p.length).setValues([p]);
  for (const e of api.COL_ESTADO) hoja.celda(4, e + 1).f = api.formulaEstado(e, 4);
  const iMin = api.CABECERA.indexOf("FECHA MINIMA") + 1;
  hoja.celda(4, iMin).f = "=MIN(Q4,U4)";
  hoja.celda(4, iMin).v = "(calculado)";
}

/* ---------------- pruebas ---------------- */

test("formulaEstado replica la formula de la hoja para cada riesgo", () => {
  const api = cargar(hojaSimulada("BD_AESA", 98));
  assert.equal(api.COL_ESTADO[1] + 1, IE_ESTADO, "ESTADO_IE es la columna W");
  assert.equal(api.formulaEstado(api.COL_ESTADO[1], 9), FORMULA_IE(9), "cuenta desde la capacitacion (T)");
  assert.match(api.formulaEstado(api.COL_ESTADO[0], 9), /P9/, "AE: capacitacion en P");
});

test("guardar escribe fechas y tipos pero no pisa las formulas de ESTADO", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);
  const antes = api.COL_ESTADO.map((e) => hoja.celda(4, e + 1).f);

  const nueva = filaDe(api, {
    "Fecha de capacitacion_IE": "2026-08-09",
    "Fecha de vencimiento_IE": "2027-08-09",
    TIPO_IE: "A",
    ESTADO_IE: "VIGENTE", // texto calculado por la app: no debe llegar a la hoja
    ESTADO_AE: "VIGENTE",
    "FECHA MINIMA": "2027-08-09",
  });
  const r = api.guardar({ fila: 4, valores: nueva });

  assert.equal(r.ok, true);
  assert.equal(hoja.celda(4, IE_CAP).v, "2026-08-09", "la fecha si se guarda");
  assert.equal(hoja.celda(4, IE_CAP + 1).v, "2027-08-09");
  assert.deepEqual(api.COL_ESTADO.map((e) => hoja.celda(4, e + 1).f), antes, "las 18 formulas de ESTADO siguen ahi");
  assert.equal(hoja.celda(4, IE_ESTADO).v, "(calculado)", "y nadie las sobrescribio con texto");
  const iMin = api.CABECERA.indexOf("FECHA MINIMA") + 1;
  assert.equal(hoja.celda(4, iMin).f, "=MIN(Q4,U4)", "cualquier otra formula tambien se respeta");
});

test("una escritura vieja que termina tarde no revierte un guardado posterior", () => {
  // Google devuelve una pagina rota con el script todavia corriendo y el puente
  // reintenta: la ejecucion vieja (la renovacion con la fecha del certificado)
  // podia terminar DESPUES de la correccion a mano y devolver la fila a lo anterior.
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);
  const conFecha = (f) => filaDe(api, { "Fecha de capacitacion_IE": f, TIPO_IE: "A" });

  api.guardar({ fila: 4, valores: conFecha("2025-11-26"), marca: 1000 }); // renovacion
  api.guardar({ fila: 4, valores: conFecha("2025-11-13"), marca: 2000 }); // correccion a mano
  const tarde = api.guardar({ fila: 4, valores: conFecha("2025-11-26"), marca: 1000 }); // la vieja, tarde

  assert.equal(tarde.obsoleto, true, "se reconoce como vieja");
  assert.equal(hoja.celda(4, IE_CAP).v, "2025-11-13", "la correccion a mano se queda");

  const reintento = api.guardar({ fila: 4, valores: conFecha("2025-11-13"), marca: 2000 });
  assert.equal(reintento.obsoleto, undefined, "un reintento del mismo guardado si se escribe");
});

test("guardar deja formula en un ESTADO que estaba como texto", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const p = filaDe(api, { DNI: 22222222, ESTADO_IE: "VENCIDO" }); // migrada como valor
  hoja.getRange(5, 1, 1, p.length).setValues([p]);

  api.guardar({ fila: 5, valores: filaDe(api, { "Fecha de capacitacion_IE": "2026-08-09", ESTADO_IE: "VIGENTE" }) });

  assert.equal(hoja.celda(5, IE_ESTADO).f, FORMULA_IE(5));
});

test("una persona nueva recibe las formulas de la hoja en su fila", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);

  const nueva = filaDe(api, {
    Apellidos: "PEREZ",
    Nombres: "JUAN",
    DNI: "33333333",
    "Cargo Planilla": "OPERADOR",
    "Fecha de capacitacion_IE": "2026-08-09",
    "Fecha de vencimiento_IE": "2027-08-09",
    TIPO_IE: "A",
    ESTADO_IE: "VIGENTE",
    ESTADO_AE: "NO APLICA",
    "FECHA MINIMA": "2027-08-09",
  });
  const r = api.alta({ valores: nueva });

  assert.equal(r.ok, true);
  assert.equal(r.fila, 5, "se agrega debajo de la ultima persona");
  assert.equal(r.codigo, "AE002");
  for (const e of api.COL_ESTADO) {
    assert.equal(hoja.celda(5, e + 1).f, api.formulaEstado(e, 5), `ESTADO en la columna ${e + 1} es formula de la fila 5`);
  }
  const iMin = api.CABECERA.indexOf("FECHA MINIMA") + 1;
  assert.equal(hoja.celda(5, iMin).f, "=MIN(Q5,U5)", "las demas formulas se heredan ajustadas");
  assert.equal(hoja.celda(5, IE_CAP).v, "2026-08-09", "las fechas de la persona nueva no son las de la anterior");
  assert.equal(hoja.celda(5, 5).v, "PEREZ", "A:O se escribe como valores");
  assert.equal(hoja.celda(5, 7).v, "33333333");
});

test("el alta guarda cada A y C elegida en su columna TIPO", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);
  const col = (nombre) => api.CABECERA.indexOf(nombre) + 1;

  const r = api.alta({ valores: filaDe(api, { DNI: "33333333", TIPO_IE: "A", TIPO_SP: "C", TIPO_ES: "A" }) });

  assert.equal(r.ok, true);
  assert.equal(hoja.celda(5, col("TIPO_IE")).v, "A");
  assert.equal(hoja.celda(5, col("TIPO_SP")).v, "C");
  assert.equal(hoja.celda(5, col("TIPO_ES")).v, "A");
  assert.equal(hoja.celda(5, col("TIPO_AE")).v, "", "los riesgos sin marcar quedan vacios");
  assert.equal(hoja.celda(5, col("ESTADO_ES")).f, api.formulaEstado(col("ESTADO_ES") - 1, 5), "y ESTADO_ES es formula");
});

test("una alta que falla a medias no deja la fila escrita ni bloquea el reintento", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);
  const valores = filaDe(api, { Apellidos: "PRUEBA 01", Nombres: "XD", DNI: "12345678", TIPO_IE: "A" });

  hoja.fallarFormulas = true;
  assert.throws(() => api.alta({ valores }), /error de Google/);
  assert.equal(hoja.getLastRow(), 4, "no queda una fila 5 con solo A:O");

  hoja.fallarFormulas = false;
  const r = api.alta({ valores });
  assert.equal(r.ok, true, "el DNI no quedo ocupado por la fila a medias");
  assert.equal(r.fila, 5);
});

test("una fila anterior a medias no sirve de modelo: se heredan las formulas de la ultima completa", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hojaConPersona(api, hoja);
  const aMedias = filaDe(api, { Codigo: "AE611", DNI: "55555555" });
  hoja.getRange(5, 1, 1, 15).setValues([aMedias.slice(0, 15)]); // solo A:O, sin formulas

  const r = api.alta({ valores: filaDe(api, { DNI: "66666666", TIPO_IE: "A" }) });

  assert.equal(r.fila, 6);
  const iMin = api.CABECERA.indexOf("FECHA MINIMA") + 1;
  assert.equal(hoja.celda(6, iMin).f, "=MIN(Q6,U6)", "FECHA MINIMA viene de la fila 4, no de la incompleta");
  assert.equal(hoja.celda(6, IE_ESTADO).f, FORMULA_IE(6));
});

test("el alta en una hoja sin personas tambien deja ESTADO como formula", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hoja.celda(3, 1).v = "Columna1"; // solo la cabecera (fila 3)

  const r = api.alta({ valores: filaDe(api, { DNI: "44444444", ESTADO_IE: "VIGENTE" }) });

  assert.equal(r.fila, 4);
  assert.equal(hoja.celda(4, IE_ESTADO).f, FORMULA_IE(4));
});

/* ---------------- columnas editables de A:O (EMO y area) ---------------- */

const COL_EMO_VENC = 14; // N: F. Vencimiento
const COL_AREA = 12; // L: Area Planilla

test("guardar puede corregir el vencimiento del EMO y el area sin tocar el resto de A:O", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const p = filaDe(api, { Codigo: "AE001", DNI: 11111111, EMPRESA: "AESA", "F. Ex. Medico": "2025-10-03", "F. Vencimiento": "2026-10-03" });
  hoja.getRange(4, 1, 1, p.length).setValues([p]);

  const r = api.guardar({
    fila: 4,
    valores: filaDe(api, { "Fecha de capacitacion_IE": "2026-08-09" }),
    datos: { "F. Vencimiento": "2027-01-15", "Area Planilla": " MINA " },
  });

  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.formulaReemplazada), []);
  assert.equal(hoja.celda(4, COL_EMO_VENC).v, "2027-01-15");
  assert.equal(hoja.celda(4, COL_AREA).v, "MINA", "el area se guarda sin espacios sobrantes");
  assert.equal(hoja.celda(4, 13).v, "2025-10-03", "F. Ex. Medico no se toca");
  assert.equal(hoja.celda(4, 8).v, "AESA", "el resto de A:O tampoco");
  assert.equal(hoja.celda(4, IE_CAP).v, "2026-08-09", "y el bloque de riesgos se escribe como siempre");
});

test("guardar puede escribir el examen medico junto con su vencimiento", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const p = filaDe(api, { DNI: 11111111, "F. Ex. Medico": "2025-10-03", "F. Vencimiento": "2026-10-03" });
  hoja.getRange(4, 1, 1, p.length).setValues([p]);

  api.guardar({ fila: 4, valores: filaDe(api, {}), datos: { "F. Vencimiento": "2026-10-15", "F. Ex. Medico": "2025-10-15" } });

  assert.equal(hoja.celda(4, COL_EMO_VENC).v, "2026-10-15");
  assert.equal(hoja.celda(4, 13).v, "2025-10-15");
});

test("un vencimiento del EMO en blanco deja la celda vacia", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const p = filaDe(api, { DNI: 11111111, "F. Vencimiento": "2026-10-03" });
  hoja.getRange(4, 1, 1, p.length).setValues([p]);
  api.guardar({ fila: 4, valores: filaDe(api, {}), datos: { "F. Vencimiento": "" } });
  assert.equal(hoja.celda(4, COL_EMO_VENC).v, "");
});

test("si la celda del EMO tenia una formula se reemplaza por lo escrito y se avisa", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hoja.celda(4, COL_EMO_VENC).f = "=M4+365";
  hoja.celda(4, COL_EMO_VENC).v = "(calculado)";

  const r = api.guardar({ fila: 4, valores: filaDe(api, {}), datos: { "F. Vencimiento": "2027-01-15" } });

  assert.deepEqual(Array.from(r.formulaReemplazada), ["F. Vencimiento"]);
  assert.equal(hoja.celda(4, COL_EMO_VENC).f, "");
  assert.equal(hoja.celda(4, COL_EMO_VENC).v, "2027-01-15");
});

test("una columna que no es editable desde la app se rechaza ANTES de escribir nada", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  hoja.celda(4, COL_EMO_VENC).v = "2026-10-03";

  assert.throws(
    () => api.guardar({ fila: 4, valores: filaDe(api, { "Fecha de capacitacion_IE": "2026-08-09" }), datos: { "F. Vencimiento": "2027-01-15", DNI: "99999999" } }),
    /columna no editable/
  );
  assert.equal(hoja.celda(4, COL_EMO_VENC).v, "2026-10-03", "ni siquiera la columna valida se escribio");
  assert.equal(hoja.celda(4, IE_CAP).v, "", "ni el bloque de riesgos");
});

test("guardar sin datos sigue funcionando igual y avisa que no reemplazo formulas", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const r = api.guardar({ fila: 4, valores: filaDe(api, { "Fecha de capacitacion_IE": "2026-08-09" }) });
  assert.equal(r.ok, true);
  assert.deepEqual(Array.from(r.formulaReemplazada), []);
});

/* ---------------- listado (reporte "estado total") ---------------- */

test("listado sin filtro trae a todos; con 'vencidos_activos' solo a quien esta VENCIDO y ACTIVO", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);

  const filas = [
    filaDe(api, { DNI: "10000001", ESTADO_FINAL: "VENCIDO", _EstaTE: "ACTIVO" }),
    filaDe(api, { DNI: "10000002", ESTADO_FINAL: " VENCIDO ", _EstaTE: " CESADO " }), // con espacios, pero no activo
    filaDe(api, { DNI: "10000003", ESTADO_FINAL: "VIGENTE", _EstaTE: "ACTIVO" }), // activo pero no vencido
    filaDe(api, { DNI: "10000004", ESTADO_FINAL: "vencido", _EstaTE: "activo" }), // minusculas: cuenta igual
    filaDe(api, { DNI: "10000005", ESTADO_FINAL: "VENCIDO", _EstaTE: " ACTIVO " }), // con espacios: tambien cuenta
  ];
  filas.forEach((f, i) => hoja.getRange(4 + i, 1, 1, f.length).setValues([f]));

  assert.equal(api.listado().personas.length, 5, "sin filtro trae a todos");

  const filtrados = api.listado("vencidos_activos").personas;
  assert.deepEqual(filtrados.map((p) => p.dni).sort(), ["10000001", "10000004", "10000005"]);
});

test("listado entrega las fechas personales en ISO, no como String(fecha)", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja, {
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => "UTC" },
  });
  const f = filaDe(api, {
    DNI: "10000006",
    "F. Ex. Medico": new Date(Date.UTC(2025, 9, 10)),
    "F. Vencimiento": new Date(Date.UTC(2026, 9, 10)),
    "FECHA MINIMA": new Date(Date.UTC(2027, 6, 31)),
  });
  hoja.getRange(4, 1, 1, f.length).setValues([f]);

  const [p] = api.listado().personas;
  assert.equal(p.examenMedico, "2025-10-10");
  assert.equal(p.vencimientoEmo, "2026-10-10");
  assert.equal(p.fechaMinima, "2027-07-31");
});

test("listado con un filtro desconocido no filtra (compatibilidad hacia atras)", () => {
  const hoja = hojaSimulada("BD_AESA", 98);
  const api = cargar(hoja);
  const f = filaDe(api, { DNI: "10000005", ESTADO_FINAL: "VIGENTE", _EstaTE: "ACTIVO" });
  hoja.getRange(4, 1, 1, f.length).setValues([f]);

  assert.equal(api.listado("otro_filtro_futuro").personas.length, 1);
});
