/**
 * EMITIDOS: los certificados de JOMISER de un mes, en una carpeta por RRCC.
 *
 * Manda la hoja: entra cada RRCC autorizado ("A") del personal ACTIVO cuya
 * fecha de capacitacion en `BD AESA` (desde la que corre la vigencia) cae en
 * el mes elegido. De JOMISER se baja el certificado de ese riesgo con ESA
 * misma fecha; si JOMISER no lo tiene (ES y HM suelen venir de EIN o de la
 * reinduccion) queda anotado en el INDICE con las fechas que si tiene.
 *
 * Sin DOM ni red propios, como `exportacion.js`: quien llama pasa `buscar`
 * y `descargar`.
 */

import JSZip from "jszip";
import { aIso, esJalado, guardiaDe, mapearCurso } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";
import { limpiarNombre } from "./guardar.js";
import { armarXlsx } from "./excel.js";
import { enParalelo } from "./exportacion.js";

export const MESES = [
  "ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO",
  "JULIO", "AGOSTO", "SETIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE",
];

/**
 * Que tipos entran por RRCC: "A" en todos; Instalaciones Electricas tambien
 * con "C" (la mayoria del personal lo lleva como capacitacion, no como
 * autorizacion).
 */
export const TIPOS_POR_RRCC = { IE: ["A", "C"] };
const entraTipo = (codigo, tipo) => (TIPOS_POR_RRCC[codigo] || ["A"]).includes(tipo);

const activo = (p) => String(p?.estadoTrabajador || "").trim().toUpperCase() === "ACTIVO";
const mayus = (v) => String(v || "").toUpperCase();

/** 2026, 10 -> "2026-10" (el prefijo de las fechas ISO de ese mes). */
export const claveMes = (anio, mes) => `${anio}-${String(mes).padStart(2, "0")}`;

/** "2026-10" -> "OCTUBRE 2026". */
export const nombreMes = (clave) => `${MESES[Number(clave.slice(5, 7)) - 1] || "?"} ${clave.slice(0, 4)}`;

/**
 * Personas ACTIVAS con al menos un RRCC "A" (o "C" donde `TIPOS_POR_RRCC` lo admite) capacitado en el mes `clave`
 * ("2026-10"), cada una con esos RRCC (en el orden del catalogo), ordenadas
 * por apellidos. `riesgos`: Set de codigos; vacio = todos.
 */
export function autorizadosDelMes(personas, clave, { riesgos } = {}) {
  const lista = [];
  for (const p of personas || []) {
    if (!activo(p)) continue;
    const rrcc = (p.riesgos || [])
      .filter((r) => entraTipo(r.codigo, r.tipo) && String(r.cap || "").startsWith(clave) && (!riesgos?.size || riesgos.has(r.codigo)))
      .map((r) => ({ codigo: r.codigo, nombre: r.nombre || RRCC.find((x) => x.codigo === r.codigo)?.nombre || r.codigo, tipo: r.tipo, cap: r.cap, venc: r.venc }));
    if (rrcc.length) lista.push({ persona: p, rrcc });
  }
  const nombre = (p) => String(p.nombreCompleto || p.dni || "");
  return lista.sort((a, b) => nombre(a.persona).localeCompare(nombre(b.persona), "es"));
}

/**
 * Del inventario de una persona, el certificado de JOMISER de `codigo` con
 * fecha `cap`. Devuelve { cert } o { cert: null, otras: [fechas ISO que JOMISER
 * si tiene de ese RRCC, la mas nueva primero] }.
 */
export function certificadoDeLaFecha(items, codigo, cap, diccionario) {
  const deJomiser = (items || [])
    .filter((it) => it.origen === "JOMISER" && it.descargable !== false && !esJalado(it))
    .filter((it) => mapearCurso(it.curso, diccionario) === codigo);
  const cert = deJomiser.find((it) => aIso(it.fecha) === cap);
  if (cert) return { cert };
  return { cert: null, otras: [...new Set(deJomiser.map((it) => aIso(it.fecha)).filter(Boolean))].sort().reverse() };
}

/** Carpeta de un RRCC dentro del ZIP: "TA - TRABAJO EN ALTURA". */
export const carpetaDeRrcc = (codigo) =>
  limpiarNombre(`${codigo} - ${RRCC.find((r) => r.codigo === codigo)?.nombre || codigo}`, 80);

/** "TA - TRABAJO EN ALTURA/47887396_URIOL MACUYAMA MAURO_2026-10-07.pdf" */
export const rutaEnZip = (persona, codigo, fecha) =>
  `${carpetaDeRrcc(codigo)}/${limpiarNombre([persona.dni, mayus(persona.nombreCompleto), fecha].filter(Boolean).join("_"), 150)}.pdf`;

const COLUMNAS_INDICE = [
  { titulo: "GUARDIA", ancho: 10 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "RRCC", ancho: 7 },
  { titulo: "RIESGO CRITICO", ancho: 32 },
  { titulo: "TIPO", ancho: 6 },
  { titulo: "F. CAPACITACION (HOJA)", ancho: 16, tipo: "fecha" },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha" },
  { titulo: "CURSO EN JOMISER", ancho: 40 },
  { titulo: "ARCHIVO EN EL ZIP", ancho: 60 },
  { titulo: "OBSERVACION", ancho: 48 },
];

/** Las hojas del indice: una fila por RRCC "A" del mes, y el resumen por RRCC. */
export function hojasDeEmitidos(entradas) {
  const resumen = RRCC.map((r) => {
    const de = entradas.filter((e) => e.r.codigo === r.codigo);
    const con = de.filter((e) => e.archivo).length;
    return [r.codigo, r.nombre, de.length, con, de.length - con];
  }).filter((f) => f[2]);
  return [
    {
      nombre: "INDICE",
      columnas: COLUMNAS_INDICE,
      filas: entradas.map(({ persona: p, r, curso, archivo, nota }) => [
        guardiaDe(p), p.dni || "", mayus(p.nombreCompleto), mayus(p.cargo),
        r.codigo, r.nombre, r.tipo || "A", r.cap || "", r.venc || "", curso || "", archivo || "", nota || "",
      ]),
    },
    {
      nombre: "RESUMEN",
      columnas: [
        { titulo: "RRCC", ancho: 8 },
        { titulo: "RIESGO CRITICO", ancho: 36 },
        { titulo: "CAPACITADOS EN EL MES", ancho: 14, tipo: "numero" },
        { titulo: "CON CERTIFICADO", ancho: 14, tipo: "numero" },
        { titulo: "SIN CERTIFICADO", ancho: 14, tipo: "numero" },
      ],
      filas: resumen,
    },
  ];
}

const abortado = () => new DOMException("abortado", "AbortError");

/**
 * Arma el ZIP: una carpeta por RRCC con el certificado de JOMISER de cada
 * persona, e `INDICE.xlsx` con lo que se bajo y por que falta lo que falta.
 *
 *   buscar(dni, senal)      inventario de JOMISER ({ items, avisos })
 *   descargar(cert, senal)  { pdf } o { sinCertificado: true }
 *
 * Devuelve { blob, archivos, faltantes, personas }. Si se aborta, lanza
 * AbortError y no entrega un ZIP a medias.
 */
export async function armarZipEmitidos(
  lista,
  { diccionario, buscar, descargar, senal, alAvanzar = () => {}, log = () => {}, personasALaVez = 3, descargasALaVez = 4 } = {}
) {
  const zip = new JSZip();
  const resultado = lista.map(({ persona, rrcc }) => rrcc.map((r) => ({ persona, r, curso: "", archivo: "", nota: "" })));
  let hechas = 0;
  let archivos = 0;

  await enParalelo(
    lista,
    personasALaVez,
    async ({ persona }, i) => {
      alAvanzar({ hechas, total: lista.length, archivos, actual: persona });
      let items = [];
      let fallo = "";
      try {
        const inv = await buscar(persona.dni, senal);
        for (const a of inv?.avisos || []) log(`${persona.dni}: ${a}`, "warn");
        if (inv?.error) throw new Error(inv.error);
        items = inv?.items || [];
      } catch (e) {
        if (senal?.aborted) return;
        fallo = `no se pudo consultar JOMISER: ${e.message}`;
        log(`${persona.dni}: ${fallo}`, "err");
      }

      async function bajar(entrada) {
        if (fallo) return fallo;
        const { cert, otras } = certificadoDeLaFecha(items, entrada.r.codigo, entrada.r.cap, diccionario);
        if (!cert) {
          return otras.length
            ? `JOMISER no tiene uno del ${entrada.r.cap}; tiene: ${otras.join(", ")}`
            : "JOMISER no tiene este RRCC (puede venir de EIN o de la reinducción)";
        }
        entrada.curso = cert.curso;
        const r = await descargar(cert, senal);
        if (r?.sinCertificado || !r?.pdf) return "JOMISER no tiene certificado emitido";
        const ruta = rutaEnZip(persona, entrada.r.codigo, entrada.r.cap);
        entrada.archivo = ruta;
        zip.file(ruta, r.pdf);
        archivos++;
        return "";
      }

      await enParalelo(
        resultado[i],
        descargasALaVez,
        async (entrada) => {
          try {
            entrada.nota = await bajar(entrada);
          } catch (e) {
            if (senal?.aborted) return;
            entrada.nota = `no se pudo descargar: ${e.message}`;
            log(`${persona.dni} · ${entrada.r.codigo}: ${entrada.nota}`, "err");
          }
        },
        senal
      );
      if (senal?.aborted) return;

      hechas++;
      const faltan = resultado[i].filter((e) => !e.archivo).length;
      log(
        `${persona.dni} ${persona.nombreCompleto || ""}: ${resultado[i].length - faltan}/${resultado[i].length} certificado(s)`,
        faltan ? "warn" : "ok"
      );
      alAvanzar({ hechas, total: lista.length, archivos, actual: persona });
    },
    senal
  );

  if (senal?.aborted) throw abortado();

  const entradas = resultado.flat();
  zip.file("INDICE.xlsx", await armarXlsx(hojasDeEmitidos(entradas), "uint8array"));
  // los PDF ya vienen comprimidos: DEFLATE no los achica y cuesta CPU
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return { blob, archivos, faltantes: entradas.filter((e) => !e.archivo), personas: lista.length };
}
