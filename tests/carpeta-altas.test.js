import test from "node:test";
import assert from "node:assert/strict";
import {
  agruparFilas,
  leerEmo,
  leerCaptura,
  dniDeOcr,
  empresaDeEmpleador,
  regionesDeFoto,
  armarPersonas,
  planDeCarga,
  partirNombre,
} from "../src/lib/carpeta-altas.js";
import { CABECERA, INDICE } from "../shared/rrcc.js";

/* Palabras como las entrega pdf.js (ya en coordenadas de arriba a abajo). */
const p = (texto, x, y, ancho = texto.length * 5, alto = 8) => ({ texto, x0: x, y0: y, x1: x + ancho, y1: y + alto });

function emoDePrueba({ marca = "X", fila = 373, restriccion = "Uso permanente de lentes correctores." } = {}) {
  return [
    p("CERTIFICADO DE APTITUD MÉDICO", 195, 42),
    p("OCUPACIONAL", 247, 57),
    p("APROBADO:02/10/2024", 460, 67),
    p("Fecha de examen :", 31, 148),
    p("15/09/2026", 161, 148),
    p("Empleador:", 31, 164),
    p("ADMINISTRACION DE EMPRESAS S.A.C.", 161, 166),
    p("Apellidos y Nombres:", 31, 180),
    p("PEREZ QUISPE , JUAN CARLOS", 161, 180),
    p("Documento de Identidad", 31, 198),
    p("12345678", 161, 197),
    p("Edad (años):", 251, 198),
    p("30", 330, 198),
    p("Puesto al que postula (sólo preocupacional):", 31, 216, 148),
    p("AYUDANTE DE MINA", 316, 215),
    p("APTITUD MÉDICA (EMITIDA POR EL CSOA)", 210, 393),
    p("RESTRICCIONES", 351, 420),
    p("APTO", 43, 444),
    p("APTO CON RESTRICCIÓN", 43, 468),
    p(marca, 175, fila === 373 ? 467 : 443, 6),
    p(restriccion, 330, 432),
    p("NO APTO", 43, 492),
    p("Grupo sanguíneo y factor Rh (sólo preocuocupacional):", 32, 523, 185),
    p("APTITUD EMITIDA POR SERVICIO DE SALUD OCUPACIONAL DEL TITULAR", 200, 790),
    p("APTO", 140, 805),
    p("APTO CON RESTRICCIÓN", 250, 805),
    p("NO APTO", 420, 805),
    p("Digitally signed ... SERIALNUMBER=DNI-87654321", 66, 830, 300),
  ];
}

test("agruparFilas junta rotulo y valor de la misma linea, de izquierda a derecha", () => {
  const filas = agruparFilas([p("12345678", 161, 197), p("Documento de Identidad", 31, 198)]);
  assert.equal(filas.length, 1);
  assert.equal(filas[0].texto, "Documento de Identidad 12345678");
});

test("leerEmo saca los datos de un certificado de aptitud", () => {
  const emo = leerEmo(emoDePrueba());
  assert.deepEqual(emo, {
    dni: "12345678",
    apellidos: "PEREZ QUISPE",
    nombres: "JUAN CARLOS",
    fechaExamen: "2026-09-15",
    vencimiento: "2027-09-15",
    empleador: "ADMINISTRACION DE EMPRESAS S.A.C.",
    puesto: "AYUDANTE DE MINA",
    aptitud: "APTO CON RESTRICCION",
    restricciones: "Uso permanente de lentes correctores.",
    usoLentes: "SI",
  });
});

test("leerEmo reconoce la casilla marcada tal como la lee el OCR de un escaneo", () => {
  assert.equal(leerEmo(emoDePrueba({ marca: "Xx]" })).aptitud, "APTO CON RESTRICCION");
  // una casilla vacia leida como "CC]" no cuenta como marca
  assert.equal(leerEmo(emoDePrueba({ marca: "CC]" })).aptitud, "");
});

test("leerEmo: sin restricciones ('---') no lleva lentes", () => {
  const emo = leerEmo(emoDePrueba({ restriccion: "---" }));
  assert.equal(emo.restricciones, "");
  assert.equal(emo.usoLentes, "NO");
});

test("leerEmo devuelve null para un PDF que no es un EMO", () => {
  assert.equal(leerEmo([p("CERTIFICADO DE CAPACITACION", 10, 10), p("TRABAJO EN ALTURA", 10, 30)]), null);
});

test("dniDeOcr corrige las confusiones tipicas del OCR", () => {
  assert.equal(dniDeOcr("7O4446S7"), "70444657");
  assert.equal(dniDeOcr("1234567"), "");
});

test("leerCaptura lee nombre, DNI y cargo de cada cabecera del chat", () => {
  const lineas = [
    { texto: "PEREZ QUISPE JUAN CARLOS", x0: 24, y0: 8, x1: 233, y1: 17 },
    { texto: "12345678 TECNICO ELECTRICISTA | _.", x0: 24, y0: 27, x1: 268, y1: 38 },
    { texto: "5:37 p.m.", x0: 260, y0: 35, x1: 308, y1: 45 },
    { texto: "RECIEN VALIDO ESE 5:38 p.m.", x0: 24, y0: 498, x1: 197, y1: 516 },
    { texto: "ANA MARIA TORRES LUNA. « o", x0: 24, y0: 532, x1: 265, y1: 541 },
    { texto: "87654321 ADMINISTRADOR 7:16 p.m.", x0: 24, y0: 551, x1: 265, y1: 568 },
  ];
  assert.deepEqual(
    leerCaptura(lineas).map(({ dni, nombre, cargo }) => ({ dni, nombre, cargo })),
    [
      { dni: "12345678", nombre: "PEREZ QUISPE JUAN CARLOS", cargo: "TECNICO ELECTRICISTA I" },
      { dni: "87654321", nombre: "ANA MARIA TORRES LUNA", cargo: "ADMINISTRADOR" },
    ]
  );
});

test("empresaDeEmpleador: AESA y contratistas ya conocidas en la base", () => {
  assert.equal(empresaDeEmpleador("ADMINISTRACION DE EMPRESAS S.A.C."), "AESA");
  const conocidas = ["AESA", "LUCARBAL", "LUCARBAL RENT A CAR EIRL"];
  assert.equal(
    empresaDeEmpleador("LUCARBAL RENT A CAR EMPRESA INDIVIDUAL DE RESPONSABILIDAD LI", conocidas),
    "LUCARBAL RENT A CAR EIRL"
  );
  assert.equal(empresaDeEmpleador("OTRA CONTRATISTA SAC", conocidas), "OTRA CONTRATISTA SAC");
});

test("partirNombre: sin coma, dos apellidos y el resto nombres", () => {
  assert.deepEqual(partirNombre("perez quispe juan carlos"), { apellidos: "PEREZ QUISPE", nombres: "JUAN CARLOS" });
});

/** Captura de prueba: chat oscuro con una foto (fondo blanco y una "cara" de color) y la vista previa gris de un PDF. */
function capturaDePrueba() {
  const ancho = 300;
  const alto = 400;
  const datos = new Uint8ClampedArray(ancho * alto * 4);
  const pintar = (x0, y0, x1, y1, [r, g, b]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * ancho + x) * 4;
        datos[i] = r;
        datos[i + 1] = g;
        datos[i + 2] = b;
        datos[i + 3] = 255;
      }
    }
  };
  pintar(0, 0, ancho, alto, [12, 20, 26]); // fondo del chat
  pintar(20, 40, 220, 240, [245, 245, 245]); // foto: fondo blanco
  pintar(90, 80, 150, 160, [200, 150, 120]); // la cara
  pintar(20, 270, 220, 360, [235, 235, 235]); // vista previa del PDF: gris
  pintar(40, 300, 200, 304, [40, 40, 40]);
  return { datos, ancho, alto };
}

test("regionesDeFoto encuentra la foto y descarta la vista previa gris del PDF", () => {
  const regiones = regionesDeFoto(capturaDePrueba(), [{ texto: "FileProvider (58).pdf", x0: 30, y0: 365, x1: 180, y1: 378 }]);
  assert.equal(regiones.length, 1);
  const [r] = regiones;
  assert.ok(r.y0 >= 40 && r.y0 < 50, `arriba en ${r.y0}`);
  assert.ok(r.y1 > 200 && r.y1 <= 240, `abajo en ${r.y1}`);
  // recorte vertical (0.8) centrado en la cara (x 90..150)
  assert.ok(Math.abs((r.x1 - r.x0) / (r.y1 - r.y0) - 0.8) < 0.02);
  assert.ok(r.x0 <= 90 && r.x1 >= 150);
});

test("armarPersonas: la foto va a la cabecera de encima, o a la de la captura anterior", () => {
  const { personas, huerfanas } = armarPersonas(
    [
      { nombre: "a.pdf", tipo: "emo", emo: { dni: "87654321", apellidos: "TORRES LUNA", nombres: "ANA MARIA", fechaExamen: "2026-08-22", vencimiento: "2027-08-22", empleador: "LUCARBAL RENT A CAR EMPRESA INDIVIDUAL", puesto: "ADMINISTRADOR GESTION HUMANA", restricciones: "Uso de lentes", usoLentes: "SI" } },
      {
        nombre: "captura 1.png",
        tipo: "captura",
        cabeceras: [
          { dni: "12345678", nombre: "PEREZ QUISPE JUAN CARLOS", cargo: "TECNICO", y0: 27, y1: 38 },
          { dni: "87654321", nombre: "ANA MARIA TORRES LUNA", cargo: "ADMINISTRADOR", y0: 551, y1: 568 },
        ],
        fotos: [{ y0: 56, area: 100, imagen: "foto-juan" }],
      },
      { nombre: "captura 2.png", tipo: "captura", cabeceras: [], fotos: [{ y0: 10, area: 90, imagen: "foto-ana" }] },
      { nombre: "suelta.jpg", tipo: "foto", foto: "foto-x", area: 5 },
    ],
    { empresas: ["AESA", "LUCARBAL RENT A CAR EIRL"] }
  );
  const juan = personas.find((x) => x.dni === "12345678");
  const ana = personas.find((x) => x.dni === "87654321");
  assert.equal(juan.foto, "foto-juan");
  assert.equal(ana.foto, "foto-ana"); // arrastrada desde la captura anterior
  // el EMO manda en el nombre (el chat lo escribe con los nombres primero)
  assert.equal(ana.apellidos, "TORRES LUNA");
  assert.equal(ana.nombres, "ANA MARIA");
  // el cargo del chat (el de planilla) manda sobre el puesto del EMO
  assert.equal(ana.cargo, "ADMINISTRADOR");
  assert.equal(ana.empresa, "LUCARBAL RENT A CAR EIRL");
  assert.equal(ana.usoLentes, "SI");
  assert.ok(juan.avisos.includes("sin EMO"));
  assert.equal(huerfanas.length, 1);
});

function filaHoja(datos) {
  const v = CABECERA.map(() => "");
  for (const [col, valor] of Object.entries(datos)) v[INDICE[col]] = valor;
  return { encontrada: true, fila: 650, valores: v };
}

const persona = {
  dni: "12345678",
  apellidos: "PEREZ QUISPE",
  nombres: "JUAN CARLOS",
  cargo: "TECNICO",
  empresa: "AESA",
  examenMedico: "2026-09-15",
  vencimientoEmo: "2027-09-15",
  usoLentes: "NO",
  restricciones: "",
  foto: "foto",
};

test("planDeCarga: alta cuando el DNI no esta en la hoja", () => {
  assert.equal(planDeCarga(persona, { encontrada: false }).accion, "alta");
});

test("planDeCarga: solo llena celdas vacias y reporta lo que difiere", () => {
  const leido = filaHoja({ DNI: "12345678", Apellidos: "PEREZ QUISPE", "F. Ex. Medico": "2026-09-10T05:00:00.000Z", _EstaTE: "ACTIVO" });
  const plan = planDeCarga(persona, leido, { tieneFoto: false });
  assert.equal(plan.accion, "completar");
  assert.deepEqual(plan.datos, {
    Nombres: "JUAN CARLOS",
    "Cargo Planilla": "TECNICO",
    EMPRESA: "AESA",
    "F. Vencimiento": "2027-09-15",
    "USO DE LENTES": "NO",
  });
  assert.equal(plan.subirFoto, true);
  assert.deepEqual(plan.diferencias, [{ columna: "F. Ex. Medico", hoja: "2026-09-10", archivo: "2026-09-15" }]);
});

test("planDeCarga: completo cuando no falta nada", () => {
  const leido = filaHoja({
    Apellidos: "PEREZ QUISPE",
    Nombres: "JUAN CARLOS",
    "Cargo Planilla": "TECNICO",
    EMPRESA: "AESA",
    "F. Ex. Medico": "2026-09-15",
    "F. Vencimiento": "2027-09-15",
    "USO DE LENTES": "NO",
    _EstaTE: "ACTIVO",
  });
  assert.equal(planDeCarga(persona, leido, { tieneFoto: true }).accion, "completo");
});
