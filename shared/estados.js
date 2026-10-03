/**
 * Reglas de negocio de la Autorizacion de Riesgos Criticos.
 *
 * Modulo PURO: sin fetch, sin Node, sin DOM. Todo entra por parametros y
 * todo sale por el retorno, para poder probarlo con `node --test` y para
 * que el navegador y las funciones de `api/` compartan exactamente el mismo
 * calculo.
 *
 * Las formulas replican las de la hoja `BD AESA` del Excel original:
 *
 *   ESTADO       = IF(HOY-cap = HOY,"NO APLICA",
 *                  IF(HOY-cap > 365,"VENCIDO",
 *                  IF(HOY-cap >= 330,"ACTUALIZAR","VIGENTE")))
 *   VENCIMIENTO  = IF(cap="","",cap+365)
 *   FECHA MINIMA = MIN(vencimientos)
 *   ESTADO_FINAL = IF(DIAS>0,"VIGENTE","VENCIDO")
 */

import { RRCC, CODIGOS_RRCC, CABECERA, INDICE, colCap, colVenc, colTipo, colEstado } from "./rrcc.js";

export const UMBRAL_VENCIDO = 365;
export const UMBRAL_ACTUALIZAR = 330;

const DIA = 86400000;

/* ------------------------------------------------------------------ */
/* Fechas                                                              */
/* ------------------------------------------------------------------ */

/**
 * Serial de Excel -> ISO. El origen de Excel es 1899-12-30 y no 1899-12-31
 * porque Excel cree que 1900 fue bisiesto; ese dia de mas es el que cuadra
 * la cuenta con el calendario real.
 */
export function serialAIso(serial) {
  const n = Number(serial);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(Date.UTC(1899, 11, 30) + Math.round(n) * DIA).toISOString().slice(0, 10);
}

export function isoASerial(iso) {
  const t = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(t)) return "";
  return Math.round((t - Date.UTC(1899, 11, 30)) / DIA);
}

/**
 * Normaliza a "YYYY-MM-DD" cualquiera de las formas que llegan: ISO
 * (JOMISER), dd/mm/yyyy (EIN), dd-mm-yyyy, "dd mm yyyy" y seriales de Excel.
 * Devuelve "" si no se puede interpretar: nunca inventa una fecha.
 */
export function aIso(valor) {
  if (valor === null || valor === undefined) return "";
  const t = String(valor).trim();
  if (!t) return "";

  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(t);
  if (m) return armar(m[1], m[2], m[3]);

  m = /^(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{4})$/.exec(t);
  if (m) return armar(m[3], m[2], m[1]);

  // Apps Script serializa cada celda de fecha como un instante ("2026-08-09T07:00:00.000Z"):
  // la medianoche de la hoja llevada a UTC. Al oeste de UTC cae el mismo dia
  // (00:00-12:00Z); al este cae la noche anterior, asi que se suma un dia.
  m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  if (m) {
    const dia = armar(m[1], m[2], m[3]);
    return dia && m[5] === "Z" && Number(m[4]) >= 13 ? sumarDias(dia, 1) : dia;
  }

  // Serial de Excel. Se acota a partir de 1990 (32874) para que un "2026"
  // suelto no se interprete como serial.
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n >= 32874 && n <= 80000) return serialAIso(n);
    return "";
  }
  return "";
}

function armar(a, m, d) {
  const anio = Number(a);
  const mes = Number(m);
  const dia = Number(d);
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return "";
  const f = new Date(Date.UTC(anio, mes - 1, dia));
  // 31/02 no existe: si el Date rebota a marzo, la fecha era invalida.
  if (f.getUTCMonth() !== mes - 1) return "";
  return f.toISOString().slice(0, 10);
}

export function sumarDias(iso, dias) {
  const t = Date.parse(iso + "T00:00:00Z");
  if (!Number.isFinite(t)) return "";
  return new Date(t + dias * DIA).toISOString().slice(0, 10);
}

/**
 * El mismo dia `anios` anios despues (o antes, si es negativo): 15/10/2026
 * menos un anio es 15/10/2025. Un 29/02 que cae en anio comun pasa al 28/02.
 */
export function sumarAnios(iso, anios) {
  const v = aIso(iso);
  if (!v) return "";
  const p = v.split("-").map(Number);
  const anio = p[0] + anios;
  const ultimo = new Date(Date.UTC(anio, p[1], 0)).getUTCDate();
  return new Date(Date.UTC(anio, p[1] - 1, Math.min(p[2], ultimo))).toISOString().slice(0, 10);
}

/** Dias enteros entre dos fechas ISO (b - a). */
export function diasEntre(a, b) {
  const ta = Date.parse(a + "T00:00:00Z");
  const tb = Date.parse(b + "T00:00:00Z");
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / DIA);
}

export const hoyIso = () => new Date().toISOString().slice(0, 10);

/** dd/mm/yyyy, que es como se imprime en el fotocheck. */
export function aFormatoCorto(iso) {
  const v = aIso(iso);
  if (!v) return "";
  const p = v.split("-");
  return p[2] + "/" + p[1] + "/" + p[0];
}

/* ------------------------------------------------------------------ */
/* Documentos                                                          */
/* ------------------------------------------------------------------ */

/**
 * Deja el documento en 8 digitos, que es lo que mide un DNI peruano.
 *
 * Hace falta en los dos extremos: Sheets y Excel guardan "07481337" como el
 * numero 7481337 y se comen el cero, y en Drive hay fotos subidas con las dos
 * grafias ("4075286.png" y "04065624.png"). En el fotocheck impreso el
 * documento SIEMPRE va con sus 8 digitos.
 *
 * Un documento de mas de 8 digitos (carne de extranjeria, pasaporte) se deja
 * tal cual: rellenar no aplica y recortar seria destruirlo.
 */
export function normalizarDocumento(valor, largo = 8) {
  const d = String(valor === null || valor === undefined ? "" : valor).replace(/\D/g, "");
  if (!d) return "";
  return d.length < largo ? d.padStart(largo, "0") : d;
}

/* ------------------------------------------------------------------ */
/* Normalizacion de nombres de curso                                   */
/* ------------------------------------------------------------------ */

const RELLENO = ["DE", "DEL", "LA", "LAS", "EL", "LOS", "Y", "EN"];

/**
 * Singular aproximado. En castellano el plural de una palabra terminada en
 * consonante es "-es" (INSTALACIONES -> INSTALACION, MOVILES -> MOVIL) y el
 * de una terminada en vocal es "-s" (ALTURAS -> ALTURA). Sin esta distincion
 * "EXCAVACIONES" quedaria en "EXCAVACIONE" y no casaria con "EXCAVACION".
 * Los largos minimos evitan destrozar palabras cortas como "MES" o "TRES".
 */
function singular(palabra) {
  if (palabra.length > 5 && palabra.endsWith("ES")) return palabra.slice(0, -2);
  if (palabra.length > 4 && palabra.endsWith("S")) return palabra.slice(0, -1);
  return palabra;
}

/**
 * "Excavación Subterránea " y "EXCAVACIONES SUBTERRANEAS" tienen que caer en
 * la misma clave: sin tildes, sin signos, sin palabras de relleno y en
 * singular.
 */
export function normalizarCurso(texto) {
  return String(texto === null || texto === undefined ? "" : texto)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((p) => p && !RELLENO.includes(p))
    .map(singular)
    .join(" ");
}

/**
 * Alias conocidos, sembrados con los nombres reales que devuelven JOMISER y
 * EIN y con los de los certificados que ya estan en Drive nombrados a mano.
 * La hoja CURSO_RRCC amplia esta lista sin tocar codigo.
 */
export const ALIAS_BASE = [
  ["AISLAMIENTO, BLOQUEO Y ETIQUETADO DE ENERGIAS", "AE"],
  ["BLOQUEO Y AISLAMIENTO DE ENERGIAS", "AE"],
  ["AISLAMIENTO Y BLOQUEO", "AE"],
  ["AISLAMIENTO BLOQUEO", "AE"],
  ["AISLAMIENTO", "AE"],
  ["BLOQUEOS", "AE"],
  ["B_A_E", "AE"],
  ["INSTALACIONES ELECTRICAS", "IE"],
  ["I_E", "IE"],
  ["SUSTANCIAS QUIMICAS PELIGROSAS", "SQ"],
  ["SUSTANCIAS QUIMICAS", "SQ"],
  ["SUST QUIMICAS", "SQ"],
  ["S_Q_P", "SQ"],
  ["PROTECCION DE MAQUINAS", "PM"],
  ["PROTECCION MAQUINAS", "PM"],
  ["PROTECCION MAQ", "PM"],
  ["P_M", "PM"],
  ["TRABAJOS EN ALTURA", "TA"],
  ["TRABAJO EN ALTURA", "TA"],
  ["ALTURA", "TA"],
  ["T_A", "TA"],
  ["CARGAS SUSPENDIDAS", "CS"],
  ["C_S", "CS"],
  ["SISTEMAS PRESURIZADOS", "SP"],
  ["PRESURIZADOS", "SP"],
  ["S_P", "SP"],
  ["EXCAVACIONES SUBTERRANEAS", "ES"],
  ["EXCAVACION SUBTERRANEA", "ES"],
  ["EX SUBTERRANEAS", "ES"],
  ["EX SUBT", "ES"],
  ["E_S", "ES"],
  ["HERRAMIENTAS MANUALES", "HM"],
  ["HERR MANUALES", "HM"],
  ["H_M", "HM"],
  ["EXCAVACION EN OBRAS CIVILES", "OC"],
  ["OBRAS CIVILES", "OC"],
  ["ESPACIOS CONFINADOS", "EC"],
  ["ESPACIO CONFINADO", "EC"],
  ["CONFINADOS", "EC"],
  ["E_C", "EC"],
  ["VEHICULOS Y EQUIPOS MOVILES", "VEM"],
  ["EQUIPOS MOVILES", "VEM"],
  ["ANIMALES PONZONOSOS", "AP"],
  ["HERRAMIENTAS DE PODER", "HP"],
  ["HERR PODER", "HP"],
  ["H_P", "HP"],
  ["TRABAJOS EN CALIENTE", "TC"],
  ["TRABAJO EN CALIENTE", "TC"],
  ["T_C", "TC"],
  ["OFICIAL DE BLOQUEO", "OB"],
  ["MONTAJE Y DESMONTAJE", "MD"],
  ["RIGGER", "RIG"],
  ["AISLAMIENTO Y BLOQUO", "AE"],
  ["ASILAMIENTO", "AE"],
  ["INSTALACIONES ELE", "IE"],
  ["SUSTANCIAS QUI", "SQ"],
  ["SUS QUIMICAS", "SQ"],
  ["PROTEC MAQUINAS", "PM"],
  ["SIST PRESURIZADOS", "SP"],
  ["SIST PRESURI", "SP"],
  ["SIS PRESURIZADOS", "SP"],
  ["CARGAS S", "CS"],
  ["ESPACIOS", "EC"],
  ["OFICIAL", "OB"],
  ["TRAB ALTURA", "TA"],
];

/**
 * Cursos que NO son riesgos criticos. Se listan para que no ensucien el log
 * de "cursos sin mapear": son otros certificados de la misma persona.
 */
export const CURSOS_IGNORADOS = [
  "INDUCCION",
  "RIESGOS CRITICOS",
  "RRCC",
  "RRCC 1",
  "RRCC 2",
  "RRCC CAPACITADOS",
  "FOTOCHECK",
];

/**
 * Arma el diccionario curso -> RRCC. `filas` son las de la hoja CURSO_RRCC:
 * [nombre_certificado, codigo_rrcc, fuente_preferida].
 */
export function construirDiccionario(filas) {
  const mapa = new Map();
  const fuente = new Map();
  const ignorar = new Set(CURSOS_IGNORADOS.map(normalizarCurso));

  for (const par of ALIAS_BASE) mapa.set(normalizarCurso(par[0]), par[1]);
  // el nombre y el rotulo del catalogo siempre mapean a su propio codigo
  for (const r of RRCC) {
    mapa.set(normalizarCurso(r.nombre), r.codigo);
    mapa.set(normalizarCurso(r.rotulo), r.codigo);
  }

  for (const fila of filas || []) {
    const nombre = String((fila && fila[0]) || "").trim();
    const codigo = String((fila && fila[1]) || "").trim().toUpperCase();
    const pref = String((fila && fila[2]) || "").trim().toUpperCase();
    if (!nombre) continue;
    if (!codigo || codigo === "-" || codigo === "IGNORAR") {
      ignorar.add(normalizarCurso(nombre));
      continue;
    }
    if (!CODIGOS_RRCC.includes(codigo)) continue;
    mapa.set(normalizarCurso(nombre), codigo);
    if (pref) fuente.set(codigo, pref);
  }

  // ES y HM las emite EIN: si el mismo curso llega de dos fuentes, manda EIN.
  if (!fuente.has("ES")) fuente.set("ES", "EIN");
  if (!fuente.has("HM")) fuente.set("HM", "EIN");

  return { mapa, fuente, ignorar };
}

/**
 * Nombre de curso -> codigo RRCC. null si no hay match; "IGNORADO" si es un
 * curso conocido que no es riesgo critico.
 */
export function mapearCurso(nombre, dic) {
  const clave = normalizarCurso(nombre);
  if (!clave) return null;
  if (dic.mapa.has(clave)) return dic.mapa.get(clave);
  if (dic.ignorar.has(clave)) return "IGNORADO";

  // Coincidencia parcial: los archivos de Drive suelen traer el nombre de la
  // persona pegado al del curso ("ROBLES GOMEZ JUAN MARCELINO - T_C"). Se
  // exige que el alias caiga en limites de palabra, porque los codigos
  // cortos ("T C", "E S") dentro de otra palabra darian falsos positivos.
  for (const par of dic.ignorar) {
    if (contienePalabras(clave, par)) return "IGNORADO";
  }
  let mejor = null;
  for (const entrada of dic.mapa) {
    const alias = entrada[0];
    if (contienePalabras(clave, alias)) {
      // gana el alias mas largo: "EXCAVACION SUBTERRANEA" antes que "EXCAVACION"
      if (!mejor || alias.length > mejor[0].length) mejor = entrada;
    }
  }
  return mejor ? mejor[1] : null;
}

/** ¿`alias` aparece en `clave` como secuencia completa de palabras? */
function contienePalabras(clave, alias) {
  if (alias.length < 3) return false;
  const i = clave.indexOf(alias);
  if (i < 0) return false;
  const antes = i === 0 || clave[i - 1] === " ";
  const fin = i + alias.length;
  const despues = fin === clave.length || clave[fin] === " ";
  return antes && despues;
}

/* ------------------------------------------------------------------ */
/* Estado de un riesgo critico                                         */
/* ------------------------------------------------------------------ */

/**
 * ESTADO a partir de la fecha de capacitacion. Los umbrales se cuentan desde
 * la capacitacion, no desde el vencimiento, igual que en el Excel.
 */
export function estadoDe(capIso, hoy, umbrales) {
  const cap = aIso(capIso);
  if (!cap) return "NO APLICA";
  const u = umbrales || {};
  const vencido = Number(u.vencido === undefined ? UMBRAL_VENCIDO : u.vencido);
  const actualizar = Number(u.actualizar === undefined ? UMBRAL_ACTUALIZAR : u.actualizar);
  const dias = diasEntre(cap, hoy || hoyIso());
  if (dias === null) return "NO APLICA";
  if (dias > vencido) return "VENCIDO";
  if (dias >= actualizar) return "ACTUALIZAR";
  return "VIGENTE";
}

/**
 * Fecha de vencimiento de un RRCC.
 * - Regla general: capacitacion + 365.
 * - `vigencia: "CERT"` (ES y HM, que emite EIN): la que declare el
 *   certificado si la trae; si no la trae, cae a capacitacion + 365, que es
 *   lo que hace hoy el Excel.
 */
export function vencimientoDe(codigo, capIso, certificado, dias) {
  const cap = aIso(capIso);
  if (!cap) return "";
  const def = RRCC.find((r) => r.codigo === codigo);
  if (def && def.vigencia === "CERT") {
    const declarada = aIso(certificado && certificado.vence);
    if (declarada) return declarada;
  }
  return sumarDias(cap, dias === undefined ? UMBRAL_VENCIDO : dias);
}

/* ------------------------------------------------------------------ */
/* Seleccion de certificados                                           */
/* ------------------------------------------------------------------ */

function mejorQue(a, b, preferida) {
  if (preferida) {
    const pa = a.origen === preferida;
    const pb = b.origen === preferida;
    if (pa !== pb) return pa;
  }
  // sin fecha no puede ganarle a uno que si la tiene
  if (!a.fecha) return false;
  if (!b.fecha) return true;
  return a.fecha > b.fecha;
}

/**
 * La carpeta de inducciones tiene UN PDF por persona y anio, llamado
 * "<DNI>_<APELLIDOS NOMBRES>". Es un certificado suyo, pero no es de ningun
 * RRCC: intentar mapearlo solo produciria un falso "sin mapear".
 */
export function esArchivoDePersona(item) {
  if (!item) return false;
  if (item.origen === "INDUCCION") return true;
  if (item.origen !== "DRIVE") return false;
  return /^\d{6,12}[ _-]/.test(String(item.curso || "").trim());
}

/**
 * Codigo RRCC de un item: el que ya trae (los certificados de Drive lo llevan en
 * el nombre del archivo) o, si no, el que sale del nombre del curso.
 */
function codigoDeItem(item, dic) {
  const propio = String(item.codigo || "").trim().toUpperCase();
  if (propio && CODIGOS_RRCC.includes(propio)) return propio;
  return mapearCurso(item.curso, dic);
}

/**
 * Del inventario de /api/search deja UN certificado por riesgo critico: el
 * mas reciente. Si el RRCC tiene fuente preferida (ES/HM -> EIN) y hay algo
 * de esa fuente, gana esa fuente aunque otra traiga algo mas nuevo: quien
 * define la vigencia es el emisor.
 *
 * Los items con `respaldo` (los PDF por RRCC de las carpetas de Drive) solo
 * entran donde la fuente principal no tiene un certificado descargable de ese
 * riesgo: son para cuando JOMISER no lo trae, no compiten por fecha con el.
 */
export function elegirCertificados(items, dic) {
  const porRrcc = new Map();
  const respaldos = new Map();
  const noMapeados = [];
  const ignorados = [];
  const personales = [];

  for (const it of items || []) {
    if (esArchivoDePersona(it)) {
      personales.push(it);
      continue;
    }
    const codigo = codigoDeItem(it, dic);
    if (codigo === "IGNORADO") {
      ignorados.push(it.curso);
      continue;
    }
    if (!codigo) {
      noMapeados.push({ curso: it.curso, origen: it.origen, fecha: it.fecha });
      continue;
    }
    const cand = Object.assign({}, it, { codigo, fecha: aIso(it.fecha) });
    const destino = it.respaldo ? respaldos : porRrcc;
    const previo = destino.get(codigo);
    if (!previo || mejorQue(cand, previo, it.respaldo ? undefined : dic.fuente.get(codigo))) destino.set(codigo, cand);
  }

  for (const [codigo, cand] of respaldos) {
    const principal = porRrcc.get(codigo);
    if (!principal || principal.descargable === false) porRrcc.set(codigo, cand);
  }

  return { porRrcc, noMapeados, ignorados, personales };
}

/* ------------------------------------------------------------------ */
/* Motor de renovacion                                                 */
/* ------------------------------------------------------------------ */

const vacio = (v) => v === null || v === undefined || String(v).trim() === "";

/**
 * Copia una fila al largo de CABECERA y deja las fechas del bloque de riesgos
 * como "YYYY-MM-DD". Lo que llega de la hoja puede traer el instante completo
 * de Apps Script o un serial; escribirlo de vuelta tal cual mete texto donde
 * la hoja espera fechas. Lo que no se puede leer como fecha se conserva igual.
 */
export function copiarFila(fila) {
  const nueva = CABECERA.map((_, i) => (fila?.[i] === undefined || fila?.[i] === null ? "" : fila[i]));
  for (const codigo of CODIGOS_RRCC) {
    for (const i of [colCap(codigo), colVenc(codigo)]) nueva[i] = aIso(nueva[i]) || nueva[i];
  }
  return nueva;
}

/**
 * Recalcula la fila completa de una persona a partir de su inventario de
 * certificados. NO muta la fila recibida.
 *
 * Regla central: en una renovacion, los cursos que la persona DEBE tener son
 * los que ya llevan "A" en su fila; no se consulta la matriz por puesto. Si
 * un RRCC con "A" se queda sin certificado vigente, por defecto se MANTIENE
 * la "A" y se levanta una alerta (configurable con `A_SIN_CERT`), para no
 * borrar autorizaciones por un certificado atrasado.
 */
export function renovarFila(opciones) {
  const fila = opciones.fila;
  const items = opciones.items || [];
  const config = opciones.config || {};
  const hoy = opciones.hoy || hoyIso();
  const dic = opciones.diccionario || construirDiccionario([]);

  const nueva = copiarFila(fila);
  const elegidos = elegirCertificados(items, dic);

  const umbrales = {
    vencido: Number(config.UMBRAL_VENCIDO === undefined ? UMBRAL_VENCIDO : config.UMBRAL_VENCIDO),
    actualizar: Number(config.UMBRAL_ACTUALIZAR === undefined ? UMBRAL_ACTUALIZAR : config.UMBRAL_ACTUALIZAR),
  };
  const modoA = String(config.A_SIN_CERT || "MANTENER").toUpperCase();

  const detalle = [];
  const alertas = [];

  for (const def of RRCC) {
    const codigo = def.codigo;
    const iCap = colCap(codigo);
    const capPrevia = aIso(nueva[iCap]);
    const tipoPrevio = String(nueva[colTipo(codigo)] || "").trim().toUpperCase();

    const cert = elegidos.porRrcc.get(codigo) || null;
    let cap = capPrevia;
    let cambio = "";

    if (cert && cert.fecha) {
      if (!capPrevia) {
        cap = cert.fecha;
        cambio = "NUEVO";
      } else if (cert.fecha > capPrevia && estadoDe(capPrevia, hoy, umbrales) !== "VIGENTE") {
        cap = cert.fecha;
        cambio = "ACTUALIZADO";
      } else {
        // Tampoco se pisa una fecha de la hoja que sigue VIGENTE, aunque el
        // certificado sea mas nuevo: puede ser una correccion a mano, y cada
        // renovacion la devolvia a la del certificado. Se actualiza sola al
        // entrar en ACTUALIZAR; antes, la ficha ofrece "USAR" para tomarla.
        // el certificado no es mas nuevo que lo ya registrado: no se pisa
        cambio = "SIN CAMBIO";
      }
    }

    const venc = vencimientoDe(codigo, cap, cert, umbrales.vencido);
    const estado = estadoDe(cap, hoy, umbrales);

    let tipo = tipoPrevio;
    if (!tipo && cap) tipo = "C"; // capacitado, pero no autorizado

    if (tipoPrevio === "A" && estado !== "VIGENTE") {
      const motivo = cap
        ? 'autorizado ("A") con capacitacion ' + estado.toLowerCase() + " — vence " + (venc || "?")
        : 'autorizado ("A") sin ninguna capacitacion registrada';
      alertas.push({ codigo, nivel: estado === "VENCIDO" ? "error" : "aviso", motivo });
      if (modoA === "DEGRADAR" && estado === "VENCIDO") tipo = "C";
    }

    nueva[iCap] = cap;
    nueva[colVenc(codigo)] = venc;
    nueva[colTipo(codigo)] = tipo;
    nueva[colEstado(codigo)] = estado;

    detalle.push({
      codigo,
      rotulo: def.rotulo,
      capPrevia,
      cap,
      venc,
      tipo,
      tipoPrevio,
      estado,
      cambio,
      origen: cert ? cert.origen : "",
      certificado: cert,
    });
  }

  for (const nm of elegidos.noMapeados) {
    alertas.push({ codigo: "", nivel: "aviso", motivo: 'curso sin mapear: "' + nm.curso + '" (' + nm.origen + ")" });
  }

  aplicarCierre(nueva, hoy);

  return {
    fila: nueva,
    detalle,
    alertas,
    noMapeados: elegidos.noMapeados,
    ignorados: elegidos.ignorados,
    personales: elegidos.personales,
  };
}

/**
 * Riesgos a los que la capacitacion comun (C) NO se aplica: Instalaciones
 * Electricas, Animales Ponzoñosos, Oficial de Bloqueo, Montaje y Desmontaje y
 * Rigger. Se llevan aparte y se editan a mano en su tarjeta.
 */
export const EXCLUIDOS_APLICAR_C = ["IE", "AP", "OB", "MD", "RIG"];

/** ¿Puede un riesgo recibir la capacitacion C? No los autorizados (A) ni los excluidos. */
export function admiteAplicarC(codigo, tipo) {
  return String(tipo || "").trim().toUpperCase() !== "A" && !EXCLUIDOS_APLICAR_C.includes(codigo);
}

/**
 * Aplica una capacitacion comun (C) a los riesgos que no estan autorizados
 * (A), salvo los de EXCLUIDOS_APLICAR_C, que no se tocan (ni con fecha ni al
 * limpiar). `opciones.solo` limita la carga a esos codigos: es la seleccion de
 * tarjetas de la ficha, y una lista vacia no toca nada. Una fecha vacia limpia
 * el bloque completo para que no queden estados o vencimientos antiguos sin una
 * capacitacion que los respalde.
 */
export function aplicarCapacitacionC(fila, fecha, opciones = {}) {
  const hoy = opciones.hoy || hoyIso();
  const excluidos = new Set(opciones.excluidos || EXCLUIDOS_APLICAR_C);
  const solo = opciones.solo ? new Set(opciones.solo) : null;
  const cap = aIso(fecha);
  const nueva = copiarFila(fila);

  for (const { codigo } of RRCC) {
    if (excluidos.has(codigo)) continue;
    if (solo && !solo.has(codigo)) continue;
    const iTipo = colTipo(codigo);
    if (String(nueva[iTipo] || "").trim().toUpperCase() === "A") continue;

    if (!cap) {
      nueva[colCap(codigo)] = "";
      nueva[colVenc(codigo)] = "";
      nueva[iTipo] = "";
      nueva[colEstado(codigo)] = "";
      continue;
    }

    nueva[colCap(codigo)] = cap;
    nueva[colVenc(codigo)] = sumarDias(cap, UMBRAL_VENCIDO);
    nueva[iTipo] = "C";
    nueva[colEstado(codigo)] = estadoDe(cap, hoy, {
      vencido: UMBRAL_VENCIDO,
      actualizar: UMBRAL_ACTUALIZAR,
    });
  }
  aplicarCierre(nueva, hoy);
  return nueva;
}

/**
 * Aplica a una fila las correcciones hechas a mano en la ficha.
 * `ediciones` es { AE: { tipo: "A", venc: "2027-08-09" }, ... } y cada campo
 * es opcional: solo se toca lo que viene.
 *
 * La vigencia manda. Se guarda tal cual y la capacitacion se retrocede
 * `vencido` dias, que es la unica fecha con la que el ESTADO del riesgo
 * (calculado desde la capacitacion, como en el Excel) coincide con la
 * vigencia escrita. Una vigencia vacia limpia el bloque de fechas del riesgo.
 */
export function aplicarEdicionesManuales(fila, ediciones, opciones = {}) {
  const hoy = opciones.hoy || hoyIso();
  const config = opciones.config || {};
  const umbrales = {
    vencido: Number(config.UMBRAL_VENCIDO === undefined ? UMBRAL_VENCIDO : config.UMBRAL_VENCIDO),
    actualizar: Number(config.UMBRAL_ACTUALIZAR === undefined ? UMBRAL_ACTUALIZAR : config.UMBRAL_ACTUALIZAR),
  };
  const nueva = copiarFila(fila);

  for (const [codigo, ed] of Object.entries(ediciones || {})) {
    if (!CODIGOS_RRCC.includes(codigo) || !ed) continue;

    if (ed.tipo !== undefined) {
      const tipo = String(ed.tipo || "").trim().toUpperCase();
      nueva[colTipo(codigo)] = tipo === "A" || tipo === "C" ? tipo : "";
    }

    if (ed.venc !== undefined) {
      const venc = aIso(ed.venc);
      const cap = venc ? sumarDias(venc, -umbrales.vencido) : "";
      nueva[colVenc(codigo)] = venc;
      nueva[colCap(codigo)] = cap;
      nueva[colEstado(codigo)] = cap ? estadoDe(cap, hoy, umbrales) : "";
    }
  }
  aplicarCierre(nueva, hoy);
  return nueva;
}

/**
 * Columnas de datos personales (A:O) que la ficha puede corregir a mano, con
 * como se comparan y como se llaman en los avisos.
 */
export const DATOS_EDITABLES = {
  "F. Ex. Medico": { tipo: "fecha", codigo: "EMO", campo: "examen médico" },
  "F. Vencimiento": { tipo: "fecha", codigo: "EMO", campo: "vencimiento del EMO" },
  "Area Planilla": { tipo: "texto", codigo: "AREA", campo: "área" },
  Apellidos: { tipo: "texto", codigo: "APELLIDOS", campo: "apellidos" },
  Nombres: { tipo: "texto", codigo: "NOMBRES", campo: "nombres" },
  "Cargo Planilla": { tipo: "texto", codigo: "CARGO", campo: "cargo" },
  EMPRESA: { tipo: "texto", codigo: "EMPRESA", campo: "empresa" },
};

/**
 * Compara lo que se quiso escribir con lo que la hoja tiene despues de
 * guardar, para los riesgos indicados (tipo, capacitacion y vigencia, leidos
 * como fecha, asi que "2026-08-09" y el instante de Apps Script coinciden) y
 * para las columnas de datos personales indicadas en `datos` (nombres de
 * DATOS_EDITABLES). Devuelve la lista de diferencias; vacia = la hoja quedo
 * como se pidio.
 *
 * Solo mira lo que la app escribe. Las columnas con formula (ESTADO,
 * FECHA MINIMA...) las calcula la hoja y no se comparan.
 */
export function diferenciasFila(esperada, leida, codigos = CODIGOS_RRCC, datos = []) {
  const dif = [];
  const tipo = (f, c) => String(f?.[colTipo(c)] ?? "").trim().toUpperCase();
  const fecha = (f, col) => aIso(f?.[col]);
  for (const codigo of codigos) {
    const pares = [
      ["tipo", tipo(esperada, codigo), tipo(leida, codigo)],
      ["capacitacion", fecha(esperada, colCap(codigo)), fecha(leida, colCap(codigo))],
      ["vigencia", fecha(esperada, colVenc(codigo)), fecha(leida, colVenc(codigo))],
    ];
    for (const [campo, esperado, real] of pares) {
      if (esperado !== real) dif.push({ codigo, campo, esperado, real });
    }
  }
  for (const columna of datos) {
    const def = DATOS_EDITABLES[columna];
    const i = INDICE[columna];
    if (!def || i === undefined) continue;
    const leer = (f) => (def.tipo === "fecha" ? aIso(f?.[i]) : String(f?.[i] ?? "").trim());
    const esperado = leer(esperada);
    const real = leer(leida);
    if (esperado !== real) dif.push({ codigo: def.codigo, campo: def.campo, esperado, real });
  }
  return dif;
}

/**
 * FECHA MINIMA / DIAS / ESTADO_FINAL / FullName / Columna1 / ACTUALIZADO.
 *
 * El Excel calcula FECHA MINIMA con un MIN que se saltea una columna y
 * referencia por error una de ESTADO; aca se toma el minimo de los 18
 * vencimientos, que es lo que la formula queria decir.
 */
export function aplicarCierre(fila, hoy) {
  const dia = hoy || hoyIso();
  const vencimientos = CODIGOS_RRCC.map((c) => aIso(fila[colVenc(c)])).filter(Boolean).sort();
  const minima = vencimientos[0] || "";
  const dias = minima ? diasEntre(dia, minima) : "";

  fila[INDICE["FECHA MINIMA"]] = minima;
  fila[INDICE["DIAS"]] = dias;
  fila[INDICE["ESTADO_FINAL"]] = minima ? (dias > 0 ? "VIGENTE" : "VENCIDO") : "";

  const apellidos = String(fila[INDICE["Apellidos"]] || "").trim();
  const nombres = String(fila[INDICE["Nombres"]] || "").trim();
  fila[INDICE["FullName"]] = [apellidos, nombres].filter(Boolean).join(" ");

  const dni = String(fila[INDICE["DNI"]] || "").trim();
  if (dni) fila[INDICE["Columna1"]] = dni;

  const emo = aIso(fila[INDICE["F. Ex. Medico"]]);
  if (emo && vacio(fila[INDICE["F. Vencimiento"]])) {
    fila[INDICE["F. Vencimiento"]] = sumarDias(emo, UMBRAL_VENCIDO);
  }

  fila[INDICE["ACTUALIZADO"]] = new Date().toISOString();
  return fila;
}

/* ------------------------------------------------------------------ */
/* Alta de personal nuevo                                              */
/* ------------------------------------------------------------------ */

/**
 * Fila en blanco con los datos del formulario y las "A"/"C" que dicte la
 * matriz por puesto. Aca SI se usa MATRIZ_PUESTO: la persona no tiene fila
 * previa de donde heredar sus autorizaciones.
 */
export function filaNueva(opciones) {
  const datos = (opciones && opciones.datos) || {};
  const tipos = (opciones && opciones.tipos) || {};
  const fila = CABECERA.map(() => "");
  const poner = (col, valor) => {
    if (INDICE[col] !== undefined) fila[INDICE[col]] = valor === undefined || valor === null ? "" : valor;
  };

  poner("Codigo", datos.codigo);
  poner("Item", datos.item);
  poner("Apellidos", String(datos.apellidos || "").toUpperCase().trim());
  poner("Nombres", String(datos.nombres || "").toUpperCase().trim());
  poner("DNI", datos.dni);
  poner("Columna1", datos.dni);
  poner("EMPRESA", datos.empresa || "AESA");
  poner("Guardia", datos.guardia);
  poner("Cargo Planilla", datos.cargo);
  poner("Area Planilla", datos.area);
  poner("COMENTARIO", datos.comentario);
  poner("F. Ex. Medico", aIso(datos.examenMedico));
  poner("F. Vencimiento", aIso(datos.vencimientoEmo));
  poner("USO DE LENTES", datos.usoLentes);
  poner("RESTRICCIONES_EMO", datos.restricciones);
  poner("FOTO", datos.foto || (datos.dni ? "FOTOS/" + datos.dni + ".png" : ""));
  poner("FOTOCHECK_ANTIGUO_DRIVE_ID", datos.fotocheckAntiguoDriveId);
  poner("_EstaTE", datos.estadoTrabajador || "ACTIVO");

  for (const codigo of CODIGOS_RRCC) {
    const t = String(tipos[codigo] || "").trim().toUpperCase();
    if (t === "A" || t === "C") fila[colTipo(codigo)] = t;
  }
  return fila;
}

/**
 * Lee MATRIZ_PUESTO y devuelve { AE:"A", TA:"C", ... } para un cargo/area.
 * `filas[0]` es la cabecera: ["Cargo","Area", ...codigos]. Una fila sin
 * Cargo vale como regla general del Area.
 *
 * Con el cargo exacto, el area solo desempata: la MATRIZ agrupa por frente
 * ("Avances", "Servicios"...) y la planilla por area ("MINA", "MANTENIMIENTO"),
 * asi que exigir que coincidan descartaba casi siempre la fila correcta.
 */
export function tiposDeMatriz(filas, cargo, area) {
  if (!filas || !filas.length) return {};
  const norm = (s) => String(s === undefined || s === null ? "" : s).trim().toUpperCase();
  const cab = filas[0].map(norm);
  const iCargo = cab.indexOf("CARGO");
  const iArea = cab.indexOf("AREA");

  let mejor = null;
  let mejorPuntaje = -1;
  for (const fila of filas.slice(1)) {
    const fc = iCargo >= 0 ? norm(fila[iCargo]) : "";
    const fa = iArea >= 0 ? norm(fila[iArea]) : "";
    if (fc && fc !== norm(cargo)) continue;
    if (!fc && fa && fa !== norm(area)) continue;
    let puntaje = fc ? 2 : 0;
    if (fa && fa === norm(area)) puntaje += 1;
    if (puntaje > mejorPuntaje) {
      mejorPuntaje = puntaje;
      mejor = fila;
    }
  }
  if (!mejor) return {};

  const tipos = {};
  for (const codigo of CODIGOS_RRCC) {
    const i = cab.indexOf(codigo);
    if (i < 0) continue;
    const v = norm(mejor[i]);
    if (v === "A" || v === "C") tipos[codigo] = v;
  }
  return tipos;
}

function distanciaEdicion(a, b) {
  const fila = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) fila[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let anterior = fila[0];
    fila[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const actual = fila[j];
      fila[j] = a[i - 1] === b[j - 1] ? anterior : 1 + Math.min(anterior, fila[j], fila[j - 1]);
      anterior = actual;
    }
  }
  return fila[b.length];
}

/** Texto comparable de un cargo: sin tildes, en mayusculas y con un solo espacio. */
const claveCargo = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();

/** Los cargos de MATRIZ_PUESTO (sin la cabecera), sin repetir y en orden alfabetico. */
export function cargosDeMatriz(filas) {
  if (!filas || !filas.length) return [];
  const iCargo = filas[0].map(claveCargo).indexOf("CARGO");
  if (iCargo < 0) return [];
  const vistos = new Map();
  for (const fila of filas.slice(1)) {
    const cargo = String(fila?.[iCargo] ?? "").trim();
    if (cargo && !vistos.has(claveCargo(cargo))) vistos.set(claveCargo(cargo), cargo);
  }
  return [...vistos.values()].sort((a, b) => a.localeCompare(b, "es"));
}

/**
 * Lo que MATRIZ_PUESTO exige a un cargo: sus RRCC "A" y "C", en el orden del
 * catalogo. Un mismo cargo puede estar en mas de un frente/area: las filas que
 * piden lo mismo se juntan (con sus areas) y las que no, van aparte.
 *
 * Devuelve [{ areas: ["AVANCES", ...], autorizados: ["AE", ...], capacitados: [...] }],
 * vacio si el cargo no esta en la matriz. Las tildes, mayusculas y espacios
 * de mas no cuentan.
 */
export function exigenciasDeCargo(filas, cargo) {
  if (!filas || !filas.length || !claveCargo(cargo)) return [];
  const cab = filas[0].map(claveCargo);
  const iCargo = cab.indexOf("CARGO");
  const iArea = cab.indexOf("AREA");
  if (iCargo < 0) return [];

  const grupos = new Map();
  for (const fila of filas.slice(1)) {
    if (claveCargo(fila?.[iCargo]) !== claveCargo(cargo)) continue;
    const de = (tipo) =>
      CODIGOS_RRCC.filter((codigo) => cab.includes(codigo) && claveCargo(fila[cab.indexOf(codigo)]) === tipo);
    const autorizados = de("A");
    const capacitados = de("C");
    const clave = `${autorizados.join(",")}|${capacitados.join(",")}`;
    if (!grupos.has(clave)) grupos.set(clave, { areas: [], autorizados, capacitados });
    const area = iArea >= 0 ? String(fila[iArea] ?? "").trim() : "";
    const g = grupos.get(clave);
    if (area && !g.areas.includes(area)) g.areas.push(area);
  }
  return [...grupos.values()];
}

/**
 * Cargo de la matriz mas parecido al escrito, para avisar de un typo cuando
 * `tiposDeMatriz` no encuentra fila exacta (la planilla arrastra variantes:
 * "MAESTO" por "MAESTRO", "BODEQUERO" por "BODEGUERO"...).
 *
 * Solo sugiere si esta a 1-2 ediciones: mas que eso ya es "otro cargo
 * distinto" y sugerirlo confundiria mas de lo que ayuda. Nunca se usa para
 * decidir las "A" solo, para que el usuario decida con la sugerencia en la mano.
 */
export function cargoMasParecido(filas, cargo) {
  if (!filas || !filas.length) return null;
  const norm = (s) => String(s === undefined || s === null ? "" : s).trim().toUpperCase();
  const objetivo = norm(cargo);
  if (!objetivo) return null;

  const cab = filas[0].map(norm);
  const iCargo = cab.indexOf("CARGO");
  if (iCargo < 0) return null;

  const candidatos = new Set();
  for (const fila of filas.slice(1)) {
    const fc = norm(fila[iCargo]);
    if (fc) candidatos.add(fc);
  }

  let mejor = null;
  let mejorDistancia = Infinity;
  for (const c of candidatos) {
    const d = distanciaEdicion(objetivo, c);
    if (d < mejorDistancia) {
      mejorDistancia = d;
      mejor = c;
    }
  }
  return mejor && mejorDistancia > 0 && mejorDistancia <= 2 ? mejor : null;
}

/* ------------------------------------------------------------------ */
/* Vencimientos por RRCC (reporte de estado, para imprimir)            */
/* ------------------------------------------------------------------ */

/**
 * Agrupa personas (formato `leerFila`) por RRCC para el reporte de
 * vencimientos: una lista por riesgo, cada una ordenada por dias restantes
 * hasta su vigencia (vencido primero, con los dias negativos que le tocan) o
 * al reves si `descendente` es true. Solo entran los riesgos tipo "A"
 * (autorizacion, respaldada por certificado) con capacitacion registrada:
 * los "C" (solo capacitacion) no se reportan aca, y sin fecha no hay nada
 * que ordenar ni que imprimir.
 *
 * El estado se recalcula con `estadoDe` en vez de leer el ESTADO ya guardado
 * en la fila: ese valor puede ser un texto escrito la ultima vez que se
 * renovo a la persona y quedarse desactualizado con el paso de los dias.
 */
export function personasPorRiesgo(personas, opciones = {}) {
  const hoy = opciones.hoy || hoyIso();
  const umbrales = opciones.umbrales || {};
  const vencido = Number(umbrales.vencido === undefined ? UMBRAL_VENCIDO : umbrales.vencido);
  const descendente = Boolean(opciones.descendente);

  const grupos = new Map(CODIGOS_RRCC.map((c) => [c, []]));
  for (const persona of personas || []) {
    for (const riesgo of persona.riesgos || []) {
      if (riesgo.tipo !== "A") continue;
      if (!riesgo.cap) continue;
      const venc = riesgo.venc || sumarDias(riesgo.cap, vencido);
      const dias = diasEntre(hoy, venc);
      const estado = estadoDe(riesgo.cap, hoy, umbrales);
      grupos.get(riesgo.codigo)?.push({ persona, riesgo: { ...riesgo, venc }, dias, estado });
    }
  }

  return RRCC.map((def) => {
    const items = grupos.get(def.codigo) || [];
    items.sort((a, b) => (descendente ? b.dias - a.dias : a.dias - b.dias));
    return { codigo: def.codigo, nombre: def.nombre, rotulo: def.rotulo, items };
  });
}

/**
 * Guardia de una persona (columna `Guardia`: A, B, C... o S/G), sin el
 * prefijo "GUARDIA" si alguien lo escribio, para que "A" y "GUARDIA A" caigan
 * juntas. "" = la hoja no la tiene: celda vacia, o un error de formula como
 * "#N/A" (la columna sale de una busqueda y hay filas donde no encuentra).
 */
export function guardiaDe(persona) {
  const g = String(persona?.guardia ?? "").trim().toUpperCase();
  if (!g || g.startsWith("#")) return "";
  const sinPrefijo = g.replace(/^GUARDIA\s+/, "");
  return ["SG", "SINGUARDIA"].includes(sinPrefijo.replace(/[^A-Z0-9]/g, "")) ? "S/G" : sinPrefijo;
}

/** S/G es quien no hace guardia; sin guardia en la hoja es un dato que falta. */
export const rotuloGuardia = (g) =>
  !g ? "GUARDIA NO REGISTRADA EN LA HOJA" : g === "S/G" ? "SIN GUARDIA (S/G)" : `GUARDIA ${g}`;

/**
 * Reparte `items` por guardia: A, B, C... en orden, despues S/G y al final
 * los que no tienen guardia en la hoja. Dentro de cada guardia se respeta el
 * orden en que llegaron (el del reporte: por dias, o el de la columna que se
 * ordeno). `personaDe(item)` dice de quien es cada item.
 * Devuelve [{ guardia, rotulo, items }].
 */
export function agruparPorGuardia(items, personaDe = (it) => it.persona) {
  const grupos = new Map();
  for (const it of items || []) {
    const g = guardiaDe(personaDe(it));
    if (!grupos.has(g)) grupos.set(g, []);
    grupos.get(g).push(it);
  }
  const peso = (g) => (!g ? 2 : g === "S/G" ? 1 : 0);
  return [...grupos]
    .sort(([a], [b]) => peso(a) - peso(b) || a.localeCompare(b, "es", { numeric: true }))
    .map(([guardia, lista]) => ({ guardia, rotulo: rotuloGuardia(guardia), items: lista }));
}

/**
 * RRCC de UNA persona que estan vencidos o por vencer (ACTUALIZAR), para el
 * detalle que se muestra al hacer clic sobre alguien en el reporte de
 * "estado total". Igual que `personasPorRiesgo`, recalcula el estado con
 * `estadoDe` en vez de confiar en el guardado en la fila.
 */
export function riesgosProblemaDe(persona, opciones = {}) {
  const hoy = opciones.hoy || hoyIso();
  const umbrales = opciones.umbrales || {};
  const vencido = Number(umbrales.vencido === undefined ? UMBRAL_VENCIDO : umbrales.vencido);

  const vencidos = [];
  const porVencer = [];
  for (const riesgo of persona?.riesgos || []) {
    if (!riesgo.cap) continue;
    const venc = riesgo.venc || sumarDias(riesgo.cap, vencido);
    const item = { ...riesgo, venc, dias: diasEntre(hoy, venc), estado: estadoDe(riesgo.cap, hoy, umbrales) };
    if (item.estado === "VENCIDO") vencidos.push(item);
    else if (item.estado === "ACTUALIZAR") porVencer.push(item);
  }
  vencidos.sort((a, b) => a.dias - b.dias);
  porVencer.sort((a, b) => a.dias - b.dias);
  return { vencidos, porVencer };
}

/* ------------------------------------------------------------------ */
/* Lectura comoda de una fila                                          */
/* ------------------------------------------------------------------ */

/** Fila (array) -> objeto con los datos de la persona y sus 18 riesgos. */
export function leerFila(fila) {
  const f = fila || [];
  const v = (col) => String(f[INDICE[col]] === undefined || f[INDICE[col]] === null ? "" : f[INDICE[col]]).trim();
  return {
    codigo: v("Codigo"),
    item: v("Item"),
    apellidos: v("Apellidos"),
    nombres: v("Nombres"),
    dni: normalizarDocumento(v("DNI")),
    empresa: v("EMPRESA"),
    guardia: v("Guardia"),
    cargo: v("Cargo Planilla"),
    area: v("Area Planilla"),
    comentario: v("COMENTARIO"),
    examenMedico: aIso(v("F. Ex. Medico")),
    vencimientoEmo: aIso(v("F. Vencimiento")),
    usoLentes: v("USO DE LENTES"),
    restricciones: v("RESTRICCIONES_EMO"),
    foto: v("FOTO"),
    fotocheckAntiguoDriveId: v("FOTOCHECK_ANTIGUO_DRIVE_ID"),
    carpetaDriveId: v("CARPETA_DRIVE_ID"),
    estadoFinal: v("ESTADO_FINAL"),
    fechaMinima: aIso(v("FECHA MINIMA")),
    dias: v("DIAS"),
    estadoTrabajador: v("_EstaTE"),
    nombreCompleto: [v("Apellidos"), v("Nombres")].filter(Boolean).join(" "),
    riesgos: RRCC.map((r) => ({
      codigo: r.codigo,
      rotulo: r.rotulo,
      nombre: r.nombre,
      cap: aIso(f[colCap(r.codigo)]),
      venc: aIso(f[colVenc(r.codigo)]),
      tipo: String(f[colTipo(r.codigo)] || "").trim().toUpperCase(),
      estado: String(f[colEstado(r.codigo)] || "").trim().toUpperCase(),
    })),
  };
}
