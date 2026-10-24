/**
 * VERIFICACION: corrige la vigencia de UN riesgo critico con las fechas de
 * JOMISER, para el personal ACTIVO que lo tiene como "A".
 *
 *   1. filtro (sin red): de la hoja, solo los que ese riesgo tiene VENCIDO,
 *      POR VENCER (ACTUALIZAR) o sin fecha. Los vigentes no se consultan.
 *   2. verificar: a esos, el inventario de JOMISER (/api/search con
 *      `solo: "JOMISER"`) y el mismo motor que la renovacion
 *      (`verificarRiesgo`). Solo interesa quien NO CONCUERDA: JOMISER tiene un
 *      curso aprobado mas reciente que la fecha de la hoja. No escribe.
 *   3. aplicar: solo a los elegidos: relee su fila de la hoja, recalcula sobre
 *      ella (otro pudo editarla mientras tanto) y la guarda verificada.
 *
 * El inventario de JOMISER trae TODOS los cursos del DNI: se guarda por DNI
 * durante la sesion, asi que verificar otro riesgo despues sale sin red.
 */

import { buscar } from "./api.js";
import { obtenerPersona } from "./datos.js";
import { guardarFilaVerificada } from "./renovacion.js";
import { copiarFila, verificarRiesgo, aFormatoCorto, estadoDe } from "../../shared/estados.js";
import { colCap, colVenc, colTipo, colEstado } from "../../shared/rrcc.js";

/** Consultas a JOMISER a la vez: mas que esto lo satura y empieza a fallar. */
const CONSULTAS_SIMULTANEAS = 4;
/** Un inventario de JOMISER vale esto antes de volver a pedirlo (ms). */
const VIDA_INVENTARIO = 30 * 60 * 1000;
/** Errores seguidos que significan "no hay conexion", no "fallo esta persona". */
const ERRORES_SEGUIDOS_MAX = 8;

const activo = (p) => String(p?.estadoTrabajador || "").trim().toUpperCase() === "ACTIVO";
const riesgoDe = (persona, codigo) => persona.riesgos?.find((x) => x.codigo === codigo) || {};

/** ACTIVO y con `codigo` como "A" (autorizado). Los "C" y los sin asignar no entran. */
export function autorizadosActivos(personas, codigo) {
  return (personas || []).filter((p) => activo(p) && p.dni && riesgoDe(p, codigo).tipo === "A");
}

/** Estado de `codigo` segun la fecha de la HOJA: VIGENTE, ACTUALIZAR, VENCIDO o SIN FECHA. */
export function estadoEnHoja(persona, codigo, umbrales) {
  const { cap } = riesgoDe(persona, codigo);
  return cap ? estadoDe(cap, undefined, umbrales) : "SIN FECHA";
}

const PRIORIDAD = { VENCIDO: 0, "SIN FECHA": 0, ACTUALIZAR: 1 };

/**
 * Paso 1: los autorizados activos con `codigo` VENCIDO, POR VENCER o sin
 * fecha en la hoja, los vencidos primero (y entre ellos, el que vencio antes).
 * Devuelve [{ persona, estadoHoja }].
 */
export function personasAVerificar(personas, codigo, umbrales) {
  const venc = (x) => String(riesgoDe(x.persona, codigo).venc || "");
  return autorizadosActivos(personas, codigo)
    .map((persona) => ({ persona, estadoHoja: estadoEnHoja(persona, codigo, umbrales) }))
    .filter((x) => x.estadoHoja !== "VIGENTE")
    .sort((a, b) => PRIORIDAD[a.estadoHoja] - PRIORIDAD[b.estadoHoja] || venc(a).localeCompare(venc(b)));
}

/* ------------------------------------------------------------------ */
/* Inventario de JOMISER, guardado por DNI                             */
/* ------------------------------------------------------------------ */

const inventarios = new Map(); // dni -> { ts, promesa }

export function inventarioJomiser(dni, senal, { refrescar = false } = {}) {
  const previo = inventarios.get(dni);
  if (!refrescar && previo && Date.now() - previo.ts < VIDA_INVENTARIO) return previo.promesa;
  const promesa = buscar({ dni, solo: "JOMISER" }, senal).then((r) => {
    // si JOMISER no respondio, `error` viene con la lista vacia: no es "sin certificado"
    if (r.error) throw new Error(`JOMISER: ${r.error}`);
    return (r.items || []).filter((it) => it.origen === "JOMISER");
  });
  inventarios.set(dni, { ts: Date.now(), promesa });
  promesa.catch(() => inventarios.delete(dni)); // un fallo no queda guardado
  return promesa;
}

/* ------------------------------------------------------------------ */
/* Paso 2: verificar (sin escribir)                                    */
/* ------------------------------------------------------------------ */

/** La fila de la hoja reducida a lo que el motor mira para `codigo`: sale del listado, sin pedir la fila. */
function filaDesdeListado(persona, codigo) {
  const fila = copiarFila([]);
  const r = riesgoDe(persona, codigo);
  fila[colCap(codigo)] = r.cap || "";
  fila[colVenc(codigo)] = r.venc || "";
  fila[colTipo(codigo)] = r.tipo || "";
  fila[colEstado(codigo)] = r.estado || "";
  return fila;
}

/**
 * Que pasa con ese riesgo:
 *   NO CONCUERDA    -> JOMISER tiene un curso aprobado mas reciente: se corrige
 *   CONCUERDA       -> JOMISER tiene la misma fecha que la hoja
 *   SIN CURSO NUEVO -> JOMISER no tiene nada mas reciente (ni el curso, uno
 *                      mas viejo, o el ultimo intento fue desaprobado)
 *   ERROR           -> no se pudo consultar
 * Solo NO CONCUERDA y ERROR se listan; los otros se cuentan.
 */
function clasificar(v) {
  if (v.aplica) {
    const hoja = v.capPrevia ? `la hoja dice ${aFormatoCorto(v.capPrevia)}` : "la hoja no tiene fecha";
    return { estado: "NO CONCUERDA", motivo: `JOMISER ${aFormatoCorto(v.cap)} · ${hoja}` };
  }
  if (v.certificado?.fecha && v.certificado.fecha === v.capPrevia) return { estado: "CONCUERDA" };
  // un desaprobado no da capacitacion (`esJalado`)
  return { estado: "SIN CURSO NUEVO", desaprobado: Boolean(v.jalado) };
}

/**
 * Compara con JOMISER a `lista` (lo que devolvio `personasAVerificar`).
 * `alResultado(r)` avisa por cada persona apenas se resuelve, para ir
 * pintando. Si fallan muchas seguidas es la conexion: se corta y lanza.
 */
export async function verificar({ lista, codigo, ctx, senal, alResultado = () => {}, refrescar = false }) {
  const resultados = [];
  let i = 0;
  let seguidos = 0;
  let cortado = "";
  await Promise.all(
    Array.from({ length: Math.min(CONSULTAS_SIMULTANEAS, lista.length) }, async () => {
      while (!senal?.aborted && !cortado && i < lista.length) {
        const { persona, estadoHoja } = lista[i++];
        let r;
        try {
          const items = await inventarioJomiser(persona.dni, senal, { refrescar });
          const v = verificarRiesgo({
            fila: filaDesdeListado(persona, codigo),
            items,
            codigo,
            diccionario: ctx.diccionario,
            config: ctx.config,
          });
          seguidos = 0;
          r = {
            persona,
            codigo,
            estadoHoja,
            ...clasificar(v),
            capPrevia: v.capPrevia,
            vencPrevio: v.vencPrevio,
            cap: v.cap,
            venc: v.venc,
            certificado: v.certificado,
          };
        } catch (e) {
          if (senal?.aborted) break;
          if (++seguidos >= ERRORES_SEGUIDOS_MAX) cortado = e.message;
          r = { persona, codigo, estadoHoja, estado: "ERROR", motivo: e.message };
        }
        resultados.push(r);
        alResultado(r);
      }
    })
  );
  if (cortado) {
    throw new Error(`${ERRORES_SEGUIDOS_MAX} consultas seguidas fallaron (${cortado}): revisa la conexión y vuelve a verificar`);
  }
  return resultados;
}

/* ------------------------------------------------------------------ */
/* Paso 3: aplicar                                                     */
/* ------------------------------------------------------------------ */

/**
 * Escribe la vigencia nueva de `codigo` a cada uno de `elegidos` (resultados
 * de `verificar` con estado NO CONCUERDA). Uno por vez: todo lo que escribe va
 * por la fila de Apps Script. `alAplicado(r, salida)` con salida
 * { ok, motivo } por persona.
 */
export async function aplicar({ elegidos, codigo, ctx, senal, log = () => {}, alAplicado = () => {} }) {
  let ok = 0;
  let fallos = 0;
  for (const r of elegidos) {
    if (senal?.aborted) break;
    const { dni } = r.persona;
    try {
      // sobre la fila de AHORA: la del listado puede ser de hace rato
      const leido = await obtenerPersona(dni, { refrescar: true, senal });
      if (!leido.encontrada) throw new Error("ya no está en la base");
      const items = await inventarioJomiser(dni, senal);
      const v = verificarRiesgo({ fila: leido.valores, items, codigo, diccionario: ctx.diccionario, config: ctx.config });
      if (!v.aplica) {
        log(`${dni} · ${codigo}: la hoja cambió mientras tanto, ya no hay nada que actualizar`, "warn");
        alAplicado(r, { ok: false, motivo: "la hoja ya no lo necesita" });
        continue;
      }
      const g = await guardarFilaVerificada({ fila: leido.fila, valores: v.fila, dni, codigos: [codigo], senal, releer: "si-falla" });
      if (!g.confirmado) throw new Error("la hoja no quedó como se pidió");
      ok++;
      log(`${dni} · ${codigo}: vigencia ${aFormatoCorto(v.vencPrevio) || "—"} → ${aFormatoCorto(v.venc)} (curso ${aFormatoCorto(v.cap)})`, "ok");
      alAplicado(r, { ok: true, venc: v.venc });
    } catch (e) {
      if (senal?.aborted) break;
      fallos++;
      log(`${dni} · ${codigo}: no se pudo guardar: ${e.message}`, "err");
      alAplicado(r, { ok: false, motivo: e.message });
    }
  }
  return { ok, fallos };
}
