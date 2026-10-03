/**
 * EXPORTACION: el personal ACTIVO con RRCC autorizados ("A") en vigor
 * (VIGENTE o POR VENCER), y el ZIP con los certificados que respaldan cada
 * una de esas autorizaciones.
 *
 * La lista es un reporte de lo guardado en `BD AESA`, con el mismo calculo
 * que ESTADO RRCC (`personasPorRiesgo`). El ZIP, en cambio, consulta JOMISER,
 * EIN y Drive persona por persona, como la renovacion: el certificado de cada
 * RRCC es el mismo que muestra la ficha (`elegirCertificados`, el mas reciente
 * de ese riesgo).
 *
 * Sin DOM ni red propios: quien llama pasa `buscar` y `descargar`, asi que se
 * puede probar sin conexion.
 */

import JSZip from "jszip";
import { personasPorRiesgo, elegirCertificados, guardiaDe } from "../../shared/estados.js";
import { limpiarNombre } from "./guardar.js";
import { armarXlsx } from "./excel.js";

/** Los estados que se exportan: los de una autorizacion que sigue en vigor. */
export const ESTADOS_EXPORTABLES = ["VIGENTE", "ACTUALIZAR"];

const activo = (p) => String(p?.estadoTrabajador || "").trim().toUpperCase() === "ACTIVO";

/**
 * Personas con al menos un RRCC "A" en los estados pedidos, cada una con esos
 * RRCC (en el orden del catalogo), ordenadas por apellidos.
 *
 *   estados   Set con "VIGENTE" y/o "ACTUALIZAR"; vacio = los dos
 *   riesgos   Set de codigos RRCC; vacio = todos
 *   texto     busca en nombre, DNI, area y cargo
 *   umbrales, hoy  como en `personasPorRiesgo`
 *
 * Un "A" VENCIDO o sin fecha nunca entra: no hay autorizacion que respaldar.
 */
export function autorizadosPorPersona(personas, { estados, riesgos, texto = "", umbrales, hoy } = {}) {
  const validos = new Set(
    estados?.size ? [...estados].filter((e) => ESTADOS_EXPORTABLES.includes(e)) : ESTADOS_EXPORTABLES
  );
  const buscado = String(texto).trim().toUpperCase();
  const coincide = (p) =>
    !buscado || [p.nombreCompleto, p.dni, p.area, p.cargo].some((v) => String(v || "").toUpperCase().includes(buscado));

  const porPersona = new Map();
  for (const grupo of personasPorRiesgo(personas, { umbrales, hoy })) {
    if (riesgos?.size && !riesgos.has(grupo.codigo)) continue;
    for (const it of grupo.items) {
      if (!validos.has(it.estado) || !activo(it.persona) || !coincide(it.persona)) continue;
      const clave = it.persona.dni || it.persona;
      if (!porPersona.has(clave)) porPersona.set(clave, { persona: it.persona, rrcc: [] });
      porPersona.get(clave).rrcc.push({
        codigo: grupo.codigo,
        nombre: grupo.nombre,
        cap: it.riesgo.cap,
        venc: it.riesgo.venc,
        estado: it.estado,
        dias: it.dias,
      });
    }
  }

  const nombre = (p) => String(p.nombreCompleto || p.dni || "");
  return [...porPersona.values()].sort((a, b) => nombre(a.persona).localeCompare(nombre(b.persona), "es"));
}

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

const mayus = (v) => String(v || "").toUpperCase();

/** Una fila por autorizacion: lo que se filtra y se cuenta en Excel. */
const COLUMNAS_AUTORIZACIONES = [
  { titulo: "GUARDIA", ancho: 10, valor: (p) => guardiaDe(p) },
  { titulo: "DNI", ancho: 12, valor: (p) => p.dni || "" },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34, valor: (p) => mayus(p.nombreCompleto) },
  { titulo: "CARGO", ancho: 30, valor: (p) => mayus(p.cargo) },
  { titulo: "AREA", ancho: 24, valor: (p) => mayus(p.area) },
  { titulo: "RRCC", ancho: 7, valor: (p, r) => r.codigo },
  { titulo: "RIESGO CRITICO", ancho: 32, valor: (p, r) => r.nombre },
  { titulo: "ESTADO", ancho: 12, valor: (p, r) => r.estado },
  { titulo: "F. CAPACITACION", ancho: 16, tipo: "fecha", valor: (p, r) => r.cap || "" },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha", valor: (p, r) => r.venc || "" },
  { titulo: "DIAS", ancho: 8, tipo: "numero", valor: (p, r) => (r.dias === null || r.dias === undefined ? "" : r.dias) },
];

/** Una fila por persona, con sus RRCC "A" ya juntos. */
const COLUMNAS_PERSONAS = [
  { titulo: "GUARDIA", ancho: 10 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "AREA", ancho: 24 },
  { titulo: "RRCC A", ancho: 8, tipo: "numero" },
  { titulo: "VIGENTES", ancho: 30 },
  { titulo: "POR VENCER", ancho: 30 },
];

const filaDeAutorizacion = (persona, r) => COLUMNAS_AUTORIZACIONES.map((c) => c.valor(persona, r));

/** Las dos hojas del Excel de la lista (y del indice del ZIP, con sus columnas extra). */
export function hojasDeExportacion(lista) {
  const codigos = (rrcc, estado) => rrcc.filter((r) => r.estado === estado).map((r) => r.codigo).join(", ");
  return [
    {
      nombre: "AUTORIZACIONES",
      columnas: COLUMNAS_AUTORIZACIONES,
      filas: lista.flatMap(({ persona, rrcc }) => rrcc.map((r) => filaDeAutorizacion(persona, r))),
    },
    {
      nombre: "PERSONAS",
      columnas: COLUMNAS_PERSONAS,
      filas: lista.map(({ persona: p, rrcc }) => [
        guardiaDe(p),
        p.dni || "",
        mayus(p.nombreCompleto),
        mayus(p.cargo),
        mayus(p.area),
        rrcc.length,
        codigos(rrcc, "VIGENTE"),
        codigos(rrcc, "ACTUALIZAR"),
      ]),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* ZIP de certificados                                                 */
/* ------------------------------------------------------------------ */

/**
 * Nombre del PDF en el ZIP. Van todos sueltos en la raiz, asi que el nombre
 * dice de quien es y de que RRCC, con el mismo formato que los certificados
 * de respaldo de Drive: "DNI_CODIGO_AAAA-MM-DD_APELLIDOS NOMBRES.pdf". Al
 * ordenar por nombre quedan juntos los de cada persona.
 */
export const nombreDeCertificado = (persona, codigo, cert) =>
  `${limpiarNombre([persona.dni, codigo, cert.fecha, mayus(persona.nombreCompleto)].filter(Boolean).join("_"), 150)}.pdf`;

/**
 * Tope de certificados por ZIP. Todo el ZIP se arma en la memoria del
 * navegador: a ~400 KB por PDF, 400 certificados son ~150 MB, que cualquier
 * PC aguanta. La lista completa (miles de autorizaciones, mas de 1 GB) se
 * reparte en varios ZIP con `partirEnZips`.
 */
export const MAX_CERTIFICADOS_POR_ZIP = 400;

/**
 * Reparte la lista en tandas de hasta `max` autorizaciones, parejas (418 son
 * dos ZIP de ~209, no uno de 400 y otro de 18), sin partir a una persona
 * entre dos ZIP: quien tenga mas que el tope va sola en el suyo.
 */
export function partirEnZips(lista, max = MAX_CERTIFICADOS_POR_ZIP) {
  const total = lista.reduce((n, item) => n + item.rrcc.length, 0);
  // la meta de cada parte; `max` sigue siendo el limite que no se pasa
  const meta = Math.ceil(total / Math.max(1, Math.ceil(total / max)));
  const partes = [];
  let actual = [];
  let cuenta = 0;
  for (const item of lista) {
    if (actual.length && (cuenta >= meta || cuenta + item.rrcc.length > max)) {
      partes.push(actual);
      actual = [];
      cuenta = 0;
    }
    actual.push(item);
    cuenta += item.rrcc.length;
  }
  if (actual.length) partes.push(actual);
  return partes;
}

/** Recorre `lista` con hasta `n` trabajos a la vez, sin seguir si se aborta. */
async function enParalelo(lista, n, fn, senal) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, lista.length) }, async () => {
      while (!senal?.aborted && i < lista.length) {
        const indice = i++;
        await fn(lista[indice], indice);
      }
    })
  );
}

const abortado = () => new DOMException("abortado", "AbortError");

/**
 * Arma el ZIP de la lista: el certificado de cada autorizacion, todos sueltos
 * en la raiz (sin carpetas, ver `nombreDeCertificado`), y `INDICE.xlsx`, que
 * dice que archivo respalda cada autorizacion y por que falta el que falta.
 *
 *   diccionario   el de los cursos (contexto), para mapear curso -> RRCC
 *   buscar(dni, senal)    inventario de JOMISER + EIN + Drive ({ items, avisos })
 *   descargar(cert, senal)  { pdf } o { sinCertificado: true }
 *   alAvanzar({ hechas, total, archivos, actual })
 *   log(texto, tipo)
 *
 * Devuelve { blob, archivos, faltantes, personas }. Si se aborta, lanza
 * AbortError y no entrega un ZIP a medias.
 */
export async function armarZipExportacion(
  lista,
  { diccionario, buscar, descargar, senal, alAvanzar = () => {}, log = () => {}, personasALaVez = 2, descargasALaVez = 4 } = {}
) {
  const zip = new JSZip();
  // una entrada por autorizacion, en el orden de la lista (las personas van
  // en paralelo, pero el indice sale ordenado)
  const resultado = lista.map(({ persona, rrcc }) => rrcc.map((r) => ({ persona, r, archivo: "", nota: "" })));
  const usados = new Set(); // nombres ya puestos: todo va en la misma raiz
  let hechas = 0;
  let archivos = 0;

  await enParalelo(
    lista,
    personasALaVez,
    async ({ persona }, i) => {
      alAvanzar({ hechas, total: lista.length, archivos, actual: persona });
      let porRrcc = new Map();
      let fallo = "";
      try {
        const inv = await buscar(persona.dni, senal);
        for (const a of inv?.avisos || []) log(`${persona.dni}: ${a}`, "warn");
        porRrcc = elegirCertificados(inv?.items || [], diccionario).porRrcc;
      } catch (e) {
        if (senal?.aborted) return;
        fallo = `no se pudo consultar: ${e.message}`;
        log(`${persona.dni}: ${fallo}`, "err");
      }

      /** Baja el certificado de una autorizacion; devuelve por que falta, o "" si quedo en el ZIP. */
      async function bajar(entrada) {
        if (fallo) return fallo;
        const cert = porRrcc.get(entrada.r.codigo);
        if (!cert) return "no se encontró certificado en JOMISER, EIN ni Drive";
        if (cert.descargable === false) return `${cert.origen || "la fuente"} no permite descargarlo`;
        const r = await descargar(cert, senal);
        if (r?.sinCertificado || !r?.pdf) return `${cert.origen} no tiene certificado emitido`;

        let nombre = nombreDeCertificado(persona, entrada.r.codigo, cert);
        for (let n = 2; usados.has(nombre); n++) nombre = nombre.replace(/( \(\d+\))?\.pdf$/, ` (${n}).pdf`);
        usados.add(nombre);
        entrada.archivo = nombre;
        zip.file(nombre, r.pdf);
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
      // abortada a mitad: lo que no bajo no es un faltante, no se anota
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
  const [autorizaciones] = hojasDeExportacion(lista);
  const indice = {
    nombre: "INDICE",
    columnas: [
      ...autorizaciones.columnas,
      { titulo: "ARCHIVO EN EL ZIP", ancho: 60 },
      { titulo: "OBSERVACION", ancho: 48 },
    ],
    filas: entradas.map((e) => [...filaDeAutorizacion(e.persona, e.r), e.archivo, e.nota]),
  };
  zip.file("INDICE.xlsx", await armarXlsx([indice], "uint8array"));

  // los PDF ya vienen comprimidos: DEFLATE no los achica y cuesta CPU
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return { blob, archivos, faltantes: entradas.filter((e) => !e.archivo), personas: lista.length };
}
