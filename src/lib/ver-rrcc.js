/**
 * VER RRCC: el fotocheck de riesgos criticos de cada persona, filtrado por
 * situacion (_EstaTE), ESTADO_FINAL, guardia, cargo y area, con el Excel de
 * vigencias y el ZIP de fotochecks de la lista filtrada.
 *
 * La lista es un reporte de lo guardado en `BD AESA` (como ESTADO RRCC). El
 * ESTADO_FINAL se toma tal cual lo dice la hoja: es una formula viva
 * (=IF(DIAS>0,"VIGENTE","VENCIDO")) y es lo que el usuario filtra alli.
 *
 * Sin DOM ni red propios: quien llama pasa `generar` (foto + dibujo del
 * fotocheck), asi que se puede probar sin navegador.
 */

import JSZip from "jszip";
import { aIso, estadoDe, diasEntre, sumarDias, hoyIso, guardiaDe, UMBRAL_VENCIDO } from "../../shared/estados.js";
import { RRCC, porCodigo } from "../../shared/rrcc.js";
import { limpiarNombre } from "./guardar.js";
import { armarXlsx } from "./excel.js";

/** Valor de una celda para filtrar: mayusculas, sin espacios; un error de formula ("#N/A") cuenta como vacio. */
const clave = (v) => {
  const t = String(v ?? "").trim().toUpperCase();
  return t.startsWith("#") ? "" : t;
};

/**
 * Los campos por los que se filtra, cada uno con lo que muestra cuando la
 * celda esta vacia y su orden. "" (sin dato) va siempre al final.
 */
export const CAMPOS = {
  situacion: { valor: (p) => clave(p.estadoTrabajador), vacio: "SIN SITUACIÓN", primeros: ["ACTIVO"] },
  estadoFinal: { valor: (p) => clave(p.estadoFinal), vacio: "SIN ESTADO", primeros: ["VIGENTE", "VENCIDO"] },
  guardia: { valor: (p) => guardiaDe(p), vacio: "SIN GUARDIA", ultimos: ["S/G"] },
  cargo: { valor: (p) => clave(p.cargo), vacio: "SIN CARGO" },
  area: { valor: (p) => clave(p.area), vacio: "SIN ÁREA" },
};

export const rotuloDe = (campo, valor) => valor || CAMPOS[campo]?.vacio || "—";

/**
 * Solo se ve el personal ACTIVO. Cargo tiene dos partes (ver `criterioCargo`):
 * `cargo`, los cargos ya elegidos de la lista, y `cargoTexto`, lo que se esta
 * escribiendo.
 */
export const filtrosIniciales = () => ({
  texto: "",
  cargoTexto: "",
  riesgos: new Set(),
  tipos: new Set(),
  situacion: new Set(["ACTIVO"]),
  estadoFinal: new Set(),
  guardia: new Set(),
  cargo: new Set(),
  area: new Set(),
});

function coincideTexto(p, buscado) {
  if (!buscado) return true;
  return [p.nombreCompleto, p.dni, p.area, p.cargo, p.codigo].some((v) => String(v || "").toUpperCase().includes(buscado));
}

/** Mayusculas, sin tildes ni signos y con un solo espacio entre palabras. */
const normal = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

/**
 * El filtro de cargo como funcion persona -> si/no (null = sin filtro).
 *
 * Entran los cargos ya elegidos (`elegidos`, exactos) y, mientras se escribe,
 * tambien los que encajan con `texto`: se suman, porque lo escrito es el
 * siguiente cargo que se esta buscando para agregar. Lo escrito encaja si es
 * exactamente un cargo ("OPERADOR DE JUMBO I" no trae tambien al "II") o si
 * el cargo contiene todas sus palabras, sin importar tildes ni mayusculas
 * ("maestro mina" -> MAESTRO DE SERVICIOS MINA).
 */
function criterioCargo(personas, texto, elegidos) {
  const q = normal(texto);
  const hayElegidos = Boolean(elegidos?.size);
  if (!q && !hayElegidos) return null;

  let porTexto = () => false;
  if (q) {
    const palabras = q.split(" ");
    porTexto = (personas || []).some((p) => normal(p.cargo) === q)
      ? (p) => normal(p.cargo) === q
      : (p) => {
          const n = normal(p.cargo);
          return palabras.every((w) => n.includes(w));
        };
  }
  return (p) => (hayElegidos && elegidos.has(CAMPOS.cargo.valor(p))) || porTexto(p);
}

/**
 * Los RRCC que aparecen en el fotocheck de `p`: los que llevan letra (A/C) o
 * fecha en su casilla. Con `tipos` ("A" y/o "C"), solo los que llevan esa letra.
 */
export const riesgosDe = (p, tipos = null) =>
  (p?.riesgos || [])
    .filter((r) => (tipos?.size ? tipos.has(r.tipo) : r.tipo === "A" || r.tipo === "C" || r.cap || r.venc))
    .map((r) => r.codigo);

/**
 * El filtro de riesgo critico. Con RRCC marcados, alguno de ellos tiene que
 * aparecer en el fotocheck (basta uno, como en EXPORTACION), y con A o C
 * marcado, con esa letra. Con solo A o C, algun RRCC con esa letra.
 */
function pasaRiesgo(p, riesgos, tipos) {
  if (!riesgos?.size && !tipos?.size) return true;
  const presentes = riesgosDe(p, tipos);
  return riesgos?.size ? presentes.some((c) => riesgos.has(c)) : presentes.length > 0;
}

/** ¿Pasa `p` todos los filtros, salvo el de `excepto`? (un Set vacio = sin filtro) */
function pasa(p, filtros, buscado, excepto = "", cargoOk = null) {
  if (!coincideTexto(p, buscado)) return false;
  if (excepto !== "cargo" && cargoOk && !cargoOk(p)) return false;
  // al contar RRCC o A/C, quien cuenta aplica el filtro de riesgo a su manera
  if (excepto !== "riesgos" && excepto !== "tipos" && !pasaRiesgo(p, filtros?.riesgos, filtros?.tipos)) return false;
  for (const [campo, def] of Object.entries(CAMPOS)) {
    // el cargo va por `cargoOk`: lo elegido y lo escrito se suman
    if (campo === excepto || campo === "cargo") continue;
    const elegidos = filtros?.[campo];
    if (elegidos?.size && !elegidos.has(def.valor(p))) return false;
  }
  return true;
}

const nombreDe = (p) => String(p.nombreCompleto || "").trim();

/**
 * Las personas que pasan los filtros, por apellidos. Las filas sin nombre (la
 * hoja tiene algunas con solo el DNI) van al final, por DNI: arriba solo
 * tapaban a la gente real.
 */
export function filtrarPersonas(personas, filtros = filtrosIniciales()) {
  const buscado = String(filtros.texto || "").trim().toUpperCase();
  const cargoOk = criterioCargo(personas, filtros.cargoTexto, filtros.cargo);
  return (personas || [])
    .filter((p) => pasa(p, filtros, buscado, "", cargoOk))
    .sort(
      (a, b) =>
        !nombreDe(a) - !nombreDe(b) ||
        nombreDe(a).localeCompare(nombreDe(b), "es") ||
        String(a.dni || "").localeCompare(String(b.dni || ""))
    );
}

/**
 * Opciones de cada filtro con cuantas personas tiene cada una, contadas con
 * los DEMAS filtros aplicados (marcar la guardia A deja en "cargo" solo los
 * cargos de la guardia A, con sus cantidades). Lo ya marcado se mantiene
 * aunque quede en 0, para poder desmarcarlo.
 *
 * Devuelve { campo: [{ valor, rotulo, cuenta }] }.
 */
export function facetas(personas, filtros = filtrosIniciales()) {
  const buscado = String(filtros.texto || "").trim().toUpperCase();
  const cargoOk = criterioCargo(personas, filtros.cargoTexto, filtros.cargo);
  const salida = {};
  for (const [campo, def] of Object.entries(CAMPOS)) {
    const cuentas = new Map();
    for (const p of personas || []) {
      if (!pasa(p, filtros, buscado, campo, cargoOk)) continue;
      const v = def.valor(p);
      cuentas.set(v, (cuentas.get(v) || 0) + 1);
    }
    for (const v of filtros?.[campo] || []) if (!cuentas.has(v)) cuentas.set(v, 0);

    const primeros = def.primeros || [];
    const ultimos = def.ultimos || [];
    const peso = (v) => {
      if (v === "") return 3e3;
      if (primeros.includes(v)) return primeros.indexOf(v);
      if (ultimos.includes(v)) return 2e3 + ultimos.indexOf(v);
      return 1e3;
    };
    salida[campo] = [...cuentas]
      .sort(([a], [b]) => peso(a) - peso(b) || a.localeCompare(b, "es", { numeric: true }))
      .map(([valor, cuenta]) => ({ valor, rotulo: rotuloDe(campo, valor), cuenta }));
  }

  // los 18 RRCC siempre, en el orden del fotocheck, con cuantos fotochecks lo
  // llevan (con la letra A/C marcada, si hay una)
  const porRiesgo = new Map(RRCC.map((r) => [r.codigo, 0]));
  for (const p of personas || []) {
    if (!pasa(p, filtros, buscado, "riesgos", cargoOk)) continue;
    for (const c of new Set(riesgosDe(p, filtros?.tipos))) if (porRiesgo.has(c)) porRiesgo.set(c, porRiesgo.get(c) + 1);
  }
  salida.riesgos = RRCC.map((r) => ({ valor: r.codigo, rotulo: `${r.codigo} · ${r.rotulo}`, cuenta: porRiesgo.get(r.codigo) }));

  // A y C: cuantos fotochecks quedarian con cada letra (sobre los RRCC marcados)
  const porTipo = { A: 0, C: 0 };
  for (const p of personas || []) {
    if (!pasa(p, filtros, buscado, "tipos", cargoOk)) continue;
    for (const t of ["A", "C"]) if (pasaRiesgo(p, filtros?.riesgos, new Set([t]))) porTipo[t]++;
  }
  salida.tipos = [
    { valor: "A", rotulo: "A", cuenta: porTipo.A },
    { valor: "C", rotulo: "C", cuenta: porTipo.C },
  ];
  return salida;
}

/* ------------------------------------------------------------------ */
/* Fotocheck                                                           */
/* ------------------------------------------------------------------ */

const preparadas = new WeakMap();

/**
 * La persona del listado tal como la ve la ficha de RENOVACION (`leerFila`),
 * para que el fotocheck salga identico: el listado de Apps Script trae cada
 * RRCC con el codigo como rotulo ("AE") y las fechas personales sin
 * normalizar. Aca cada RRCC lleva el rotulo del catalogo ("Bloq. Energias"),
 * las fechas van en ISO y, sin vencimiento del EMO, se imprime el examen + 365
 * dias, como hace la ficha. Se calcula una vez por persona.
 */
export function paraFotocheck(p) {
  if (!p || typeof p !== "object") return p;
  if (preparadas.has(p)) return preparadas.get(p);
  const examenMedico = aIso(p.examenMedico);
  const lista = {
    ...p,
    examenMedico,
    vencimientoEmo: aIso(p.vencimientoEmo) || (examenMedico ? sumarDias(examenMedico, 365) : ""),
    fechaMinima: aIso(p.fechaMinima),
    riesgos: (p.riesgos || []).map((r) => {
      const def = porCodigo(r.codigo);
      return { ...r, rotulo: def?.rotulo || r.rotulo, nombre: def?.nombre || r.nombre, cap: aIso(r.cap), venc: aIso(r.venc) };
    }),
  };
  preparadas.set(p, lista);
  return lista;
}

/* ------------------------------------------------------------------ */
/* Vigencias                                                           */
/* ------------------------------------------------------------------ */

/**
 * Los RRCC de una persona que tienen algo que decir (un tipo A/C en la hoja o
 * una capacitacion registrada), con su estado recalculado como en ESTADO
 * RRCC: el texto guardado en la fila puede ser de la ultima renovacion.
 */
export function vigenciasDe(persona, { umbrales = {}, hoy = hoyIso() } = {}) {
  const vencido = Number(umbrales.vencido === undefined ? UMBRAL_VENCIDO : umbrales.vencido);
  return (persona?.riesgos || [])
    .filter((r) => r.cap || r.tipo === "A" || r.tipo === "C")
    .map((r) => {
      const venc = r.venc || (r.cap ? sumarDias(r.cap, vencido) : "");
      return {
        codigo: r.codigo,
        // el listado trae el codigo como nombre: el nombre largo sale del catalogo
        nombre: porCodigo(r.codigo)?.nombre || r.nombre || r.codigo,
        tipo: r.tipo === "A" || r.tipo === "C" ? r.tipo : "",
        cap: r.cap || "",
        venc,
        dias: venc ? diasEntre(hoy, venc) : null,
        estado: r.cap ? estadoDe(r.cap, hoy, umbrales) : "SIN FECHA",
      };
    });
}

/** Dias hasta el vencimiento mas proximo (FECHA MINIMA); si no hay fecha, lo que diga la columna DIAS. */
export function diasDe(persona, hoy = hoyIso()) {
  const minima = aIso(persona?.fechaMinima);
  if (minima) return diasEntre(hoy, minima);
  const n = Number(String(persona?.dias ?? "").replace(",", "."));
  return String(persona?.dias ?? "").trim() !== "" && Number.isFinite(n) ? Math.round(n) : null;
}

/** El mismo criterio que la casilla AUTORIZADO del fotocheck. */
export const autorizado = (p) => clave(p.estadoFinal) === "VIGENTE" && (p.riesgos || []).some((r) => r.tipo === "A");

/* ------------------------------------------------------------------ */
/* Excel                                                               */
/* ------------------------------------------------------------------ */

const mayus = (v) => String(v || "").toUpperCase();
const codigos = (lista) => lista.map((r) => r.codigo).join(", ");

/** Una fila por persona: su vigencia general y que RRCC tiene en cada estado. */
const COLUMNAS_PERSONAS = [
  { titulo: "GUARDIA", ancho: 10 },
  { titulo: "CODIGO", ancho: 9 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "AREA", ancho: 24 },
  { titulo: "SITUACION", ancho: 11 },
  { titulo: "ESTADO_FINAL", ancho: 13 },
  { titulo: "AUTORIZADO", ancho: 11 },
  { titulo: "FECHA MINIMA", ancho: 14, tipo: "fecha" },
  { titulo: "DIAS", ancho: 8, tipo: "numero" },
  { titulo: "F. EX. MEDICO", ancho: 14, tipo: "fecha" },
  { titulo: "F. VENC. EMO", ancho: 14, tipo: "fecha" },
  { titulo: "USO DE LENTES", ancho: 13 },
  // un "C" vencido tambien deja a la persona VENCIDA: por eso van los dos tipos por estado
  { titulo: "A VIGENTES", ancho: 26 },
  { titulo: "A POR VENCER", ancho: 22 },
  { titulo: "A VENCIDOS", ancho: 22 },
  { titulo: "C VIGENTES", ancho: 22 },
  { titulo: "C POR VENCER", ancho: 18 },
  { titulo: "C VENCIDOS", ancho: 18 },
];

/** Una fila por RRCC de cada persona, con sus fechas: lo que se filtra y se cuenta en Excel. */
const COLUMNAS_VIGENCIAS = [
  { titulo: "GUARDIA", ancho: 10 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "AREA", ancho: 24 },
  { titulo: "ESTADO_FINAL", ancho: 13 },
  { titulo: "RRCC", ancho: 7 },
  { titulo: "RIESGO CRITICO", ancho: 32 },
  { titulo: "TIPO", ancho: 6 },
  { titulo: "F. CAPACITACION", ancho: 16, tipo: "fecha" },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha" },
  { titulo: "DIAS", ancho: 8, tipo: "numero" },
  { titulo: "ESTADO", ancho: 12 },
];

function filaPersona(p, opciones) {
  const v = vigenciasDe(p, opciones);
  const de = (tipo, estado) => codigos(v.filter((r) => r.tipo === tipo && r.estado === estado));
  const dias = diasDe(p, opciones.hoy);
  return [
    guardiaDe(p),
    p.codigo || "",
    p.dni || "",
    mayus(p.nombreCompleto),
    mayus(p.cargo),
    mayus(p.area),
    clave(p.estadoTrabajador),
    clave(p.estadoFinal),
    autorizado(p) ? "SI" : "NO",
    aIso(p.fechaMinima),
    dias === null ? "" : dias,
    aIso(p.examenMedico),
    aIso(p.vencimientoEmo),
    mayus(p.usoLentes),
    de("A", "VIGENTE"),
    de("A", "ACTUALIZAR"),
    de("A", "VENCIDO"),
    de("C", "VIGENTE"),
    de("C", "ACTUALIZAR"),
    de("C", "VENCIDO"),
  ];
}

/**
 * Las dos hojas del Excel de la lista: PERSONAS (una fila por persona) y
 * VIGENCIAS (una por cada RRCC de cada persona). `extra` agrega columnas al
 * final de PERSONAS (el ZIP le suma el archivo de cada fotocheck).
 */
export function hojasDeVerRrcc(lista, { umbrales = {}, hoy = hoyIso(), extra = null } = {}) {
  const opciones = { umbrales, hoy };
  return [
    {
      nombre: "PERSONAS",
      columnas: [...COLUMNAS_PERSONAS, ...(extra?.columnas || [])],
      filas: lista.map((p, i) => [...filaPersona(p, opciones), ...(extra?.valores?.(p, i) || [])]),
    },
    {
      nombre: "VIGENCIAS",
      columnas: COLUMNAS_VIGENCIAS,
      filas: lista.flatMap((p) =>
        vigenciasDe(p, opciones).map((r) => [
          guardiaDe(p),
          p.dni || "",
          mayus(p.nombreCompleto),
          mayus(p.cargo),
          mayus(p.area),
          clave(p.estadoFinal),
          r.codigo,
          r.nombre,
          r.tipo,
          r.cap,
          r.venc,
          r.dias === null ? "" : r.dias,
          r.estado,
        ])
      ),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Certificados de los RRCC filtrados                                  */
/* ------------------------------------------------------------------ */

/**
 * Lo que va al ZIP de certificados de la lista, en la forma que arma
 * EXPORTACION (`armarZipExportacion`: [{ persona, rrcc }]): por persona, los
 * RRCC marcados en "Riesgo critico" que aparecen en su fotocheck (con la
 * letra A/C marcada, si hay una), con su vigencia. Sin RRCC marcado no hay
 * nada: serian todos los certificados de todo el mundo. Quien no tiene
 * ninguno de los marcados no entra.
 */
export function certificadosDeLista(lista, { riesgos, tipos, umbrales = {}, hoy = hoyIso() } = {}) {
  if (!riesgos?.size) return [];
  return (lista || [])
    .map((persona) => {
      const presentes = new Set(riesgosDe(persona, tipos));
      const rrcc = vigenciasDe(persona, { umbrales, hoy }).filter((r) => riesgos.has(r.codigo) && presentes.has(r.codigo));
      return { persona, rrcc };
    })
    .filter((x) => x.rrcc.length);
}

/* ------------------------------------------------------------------ */
/* ZIP de fotochecks                                                   */
/* ------------------------------------------------------------------ */

/**
 * Nombre del fotocheck en el ZIP. Todos van sueltos en la raiz: el prefijo es
 * el mismo de la carpeta de Drive, los apellidos primero para que queden en
 * orden alfabetico y el DNI al final para que no choquen dos homonimos.
 */
export const nombreFotocheckZip = (p, ext = "jpg") =>
  `${limpiarNombre(["FOTOCHECK", mayus(p.nombreCompleto), p.dni].filter(Boolean).join("_"), 150)}.${ext}`;

/**
 * Tope de fotochecks por ZIP. Todo el ZIP se arma en la memoria del
 * navegador: a ~0.5 MB por fotocheck en alta, 200 son ~100 MB.
 */
export const MAX_FOTOCHECKS_POR_ZIP = 200;

/** Reparte la lista en tandas parejas de hasta `max` (450 son tres de 150, no dos de 200 y una de 50). */
export function partirEnTandas(lista, max = MAX_FOTOCHECKS_POR_ZIP) {
  const total = lista.length;
  if (!total) return [];
  const tam = Math.ceil(total / Math.ceil(total / Math.max(1, max)));
  const partes = [];
  for (let i = 0; i < total; i += tam) partes.push(lista.slice(i, i + tam));
  return partes;
}

const abortado = () => new DOMException("abortado", "AbortError");

/**
 * Arma el ZIP con el fotocheck de cada persona de `lista` y `INDICE.xlsx`
 * (el mismo Excel de vigencias, con el archivo de cada uno y si salio sin foto).
 *
 *   generar(persona, senal) -> { blob, ext, conFoto }   dibuja el fotocheck
 *   alAvanzar({ hechas, total, actual })
 *   log(texto, tipo)
 *   umbrales, hoy   para el INDICE
 *
 * Devuelve { blob, archivos, sinFoto, fallidos }. Si se aborta, lanza
 * AbortError y no entrega un ZIP a medias.
 */
export async function armarZipFotochecks(
  lista,
  { generar, senal, alAvanzar = () => {}, log = () => {}, aLaVez = 3, umbrales = {}, hoy = hoyIso() } = {}
) {
  const zip = new JSZip();
  const resultado = lista.map(() => ({ archivo: "", foto: "", nota: "" }));
  const usados = new Set();
  let hechas = 0;
  let i = 0;

  await Promise.all(
    Array.from({ length: Math.min(aLaVez, lista.length) }, async () => {
      while (!senal?.aborted && i < lista.length) {
        const indice = i++;
        const persona = lista[indice];
        const entrada = resultado[indice];
        alAvanzar({ hechas, total: lista.length, actual: persona });
        try {
          const r = await generar(persona, senal);
          // JSZip solo lee un Blob donde hay FileReader (no en Node): los bytes valen en los dos
          const datos = typeof r.blob?.arrayBuffer === "function" ? await r.blob.arrayBuffer() : r.blob;
          if (senal?.aborted) return;
          let nombre = nombreFotocheckZip(persona, r.ext || "jpg");
          for (let n = 2; usados.has(nombre); n++) nombre = nombre.replace(/( \(\d+\))?(\.\w+)$/, ` (${n})$2`);
          usados.add(nombre);
          zip.file(nombre, datos);
          entrada.archivo = nombre;
          entrada.foto = r.conFoto ? "SI" : "NO";
          if (!r.conFoto) entrada.nota = "sin foto en la carpeta FOTOS";
        } catch (e) {
          if (senal?.aborted) return;
          entrada.nota = `no se pudo generar: ${e.message}`;
          log(`${persona.dni} ${persona.nombreCompleto || ""}: ${entrada.nota}`, "err");
        }
        hechas++;
        alAvanzar({ hechas, total: lista.length, actual: persona });
      }
    })
  );

  if (senal?.aborted) throw abortado();

  const hojas = hojasDeVerRrcc(lista, {
    umbrales,
    hoy,
    extra: {
      columnas: [
        { titulo: "ARCHIVO EN EL ZIP", ancho: 60 },
        { titulo: "FOTO", ancho: 7 },
        { titulo: "OBSERVACION", ancho: 40 },
      ],
      valores: (p, k) => [resultado[k].archivo, resultado[k].foto, resultado[k].nota],
    },
  });
  zip.file("INDICE.xlsx", await armarXlsx(hojas, "uint8array"));

  // los JPG ya vienen comprimidos: DEFLATE no los achica y cuesta CPU
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE" });
  return {
    blob,
    archivos: resultado.filter((e) => e.archivo).length,
    sinFoto: resultado.filter((e) => e.foto === "NO").length,
    fallidos: lista.filter((_, k) => !resultado[k].archivo),
  };
}
