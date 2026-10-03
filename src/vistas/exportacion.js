/**
 * Vista "EXPORTACION": el personal ACTIVO con RRCC autorizados ("A") VIGENTES
 * o POR VENCER, para bajarlo en Excel o en un ZIP con el certificado que
 * respalda cada autorizacion.
 *
 * La lista es un reporte de lo guardado en `BD AESA` (como ESTADO RRCC); el
 * ZIP si consulta JOMISER / EIN / Drive persona por persona, como la
 * renovacion. Las reglas viven en `lib/exportacion.js`.
 */

import {
  $,
  crearConsola,
  crearMultiSelect,
  crearProgreso,
  notificar,
  escaparHtml,
  conReintento,
  descargarBlob,
  hace,
  alMostrarse,
  estimarRestante,
  textoRestante,
} from "./comun.js";
import {
  obtenerContexto,
  obtenerPersonal,
  personalEnMemoria,
  personalGuardado,
  edadPersonal,
  alCambiar,
} from "../lib/datos.js";
import { buscar } from "../lib/api.js";
import { armarXlsx } from "../lib/excel.js";
import { descargarCertificado } from "../lib/renovacion.js";
import {
  autorizadosPorPersona,
  hojasDeExportacion,
  armarZipExportacion,
  partirEnZips,
  MAX_CERTIFICADOS_POR_ZIP,
} from "../lib/exportacion.js";
import { guardiaDe, aFormatoCorto, hoyIso } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

const CLASE_ESTADO = { VIGENTE: "et-vigente", ACTUALIZAR: "et-actualizar" };

export function montarExportacion() {
  const consola = crearConsola("ex-term", "ex-log-clear");
  const barra = crearProgreso("ex");

  const el = {
    buscar: $("ex-buscar"),
    estados: [$("ex-estado-vigente"), $("ex-estado-actualizar")],
    cargar: $("ex-cargar"),
    excel: $("ex-excel"),
    zip: $("ex-zip"),
    stop: $("ex-stop"),
    count: $("ex-count"),
    resCount: $("ex-res-count"),
    resultados: $("ex-resultados"),
    recargar: $("ex-recargar"),
  };

  let personas = [];
  let contexto = null;
  let configSnapshot = null; // config del ultimo snapshot, solo hasta que llegue el contexto real
  let cargando = false;
  let lista = []; // lo ultimo pintado: es lo que se exporta
  let abortador = null; // mientras se arma el ZIP
  const estadosElegidos = new Set(); // "VIGENTE" y/o "ACTUALIZAR"; vacio = los dos

  const selRiesgo = crearMultiSelect(
    "ex-riesgo",
    RRCC.map((r) => ({ valor: r.codigo, etiqueta: `${r.codigo} · ${r.rotulo}` })),
    { textoTodos: "TODOS LOS RRCC", resumen: (op) => op.valor }
  );

  const umbrales = () => ({
    vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? configSnapshot?.UMBRAL_VENCIDO ?? 365),
    actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? configSnapshot?.UMBRAL_ACTUALIZAR ?? 330),
  });

  /* ------------------------------------------------------------------ */
  /* Tabla                                                               */
  /* ------------------------------------------------------------------ */

  /** Cada RRCC "A" como pastilla del color de su estado; el detalle va en el title. */
  const pastilla = (r) =>
    `<span class="et-badge ${CLASE_ESTADO[r.estado] || ""}" title="${escaparHtml(
      `${r.codigo} · ${r.nombre} · ${r.estado} · vence ${aFormatoCorto(r.venc) || "?"}`
    )}">${r.codigo}</span>`;

  function filaHtml({ persona, rrcc }) {
    return (
      `<tr>` +
      `<td>${escaparHtml(persona.dni)}</td>` +
      `<td>${escaparHtml(persona.nombreCompleto) || "—"}</td>` +
      `<td>${escaparHtml(persona.cargo) || "—"}</td>` +
      `<td>${escaparHtml(persona.area) || "—"}</td>` +
      `<td>${escaparHtml(guardiaDe(persona)) || "—"}</td>` +
      `<td class="ex-rrcc">${rrcc.map(pastilla).join("")}</td>` +
      `</tr>`
    );
  }

  function pintar() {
    lista = autorizadosPorPersona(personas, {
      estados: estadosElegidos,
      riesgos: selRiesgo.obtener(),
      texto: el.buscar.value,
      umbrales: umbrales(),
    });

    const vacio = personas.length ? "nadie coincide con el filtro" : "carga el personal para ver a los autorizados";
    el.resultados.innerHTML = lista.length
      ? `<table class="estado-tabla ex-tabla"><thead><tr>` +
        `<th>DNI</th><th>Apellidos y nombres</th><th>Cargo</th><th>Área</th><th>Guardia</th><th>RRCC "A"</th>` +
        `</tr></thead><tbody>${lista.map(filaHtml).join("")}</tbody></table>`
      : `<div class="estado-vacio">${vacio}</div>`;

    const autorizaciones = lista.flatMap((x) => x.rrcc);
    const porVencer = autorizaciones.filter((r) => r.estado === "ACTUALIZAR").length;
    el.resCount.textContent = personas.length
      ? `${lista.length} persona(s) · ${autorizaciones.length} autorización(es)` +
        ` · ${autorizaciones.length - porVencer} vigente(s) · ${porVencer} por vencer`
      : "";
    actualizarBotones();
  }

  function actualizarBotones() {
    const ocupado = Boolean(abortador);
    el.excel.disabled = !lista.length;
    el.zip.disabled = !lista.length || ocupado;
    el.cargar.disabled = cargando || ocupado;
  }

  /* ------------------------------------------------------------------ */
  /* Exportacion                                                         */
  /* ------------------------------------------------------------------ */

  /** Lo que dice el nombre del archivo sobre el filtro: "VIGENTE", "TA AE"... */
  function sufijoFiltro() {
    const partes = [...estadosElegidos];
    const riesgos = [...selRiesgo.obtener()];
    if (riesgos.length) partes.push(riesgos.join(" "));
    return partes.length ? ` ${partes.join(" ")}` : "";
  }

  async function exportarExcel() {
    if (!lista.length) return;
    const nombre = `EXPORTACION RRCC A ${hoyIso()}${sufijoFiltro()}.xlsx`;
    el.excel.disabled = true;
    try {
      descargarBlob(await armarXlsx(hojasDeExportacion(lista)), nombre);
      consola(`${lista.length} persona(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar el Excel: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      actualizarBotones();
    }
  }

  /**
   * El ZIP con los certificados de la lista que se esta viendo. Se congela la
   * lista al empezar: cambiar el filtro mientras baja no la altera.
   *
   * Con mas de MAX_CERTIFICADOS_POR_ZIP autorizaciones se baja en varios ZIP,
   * uno tras otro (cada uno con su INDICE): un solo ZIP de miles de PDF no
   * cabe en la memoria del navegador. Se pide confirmacion antes.
   */
  async function descargarZip() {
    if (!lista.length || abortador) return;
    const objetivo = lista;
    const total = objetivo.reduce((n, x) => n + x.rrcc.length, 0);
    const partes = partirEnZips(objetivo);
    if (
      partes.length > 1 &&
      !window.confirm(
        `Son ${objetivo.length} personas y ${total} certificados: se bajarán en ${partes.length} ZIP ` +
          `de hasta ${MAX_CERTIFICADOS_POR_ZIP} certificados, uno tras otro, y puede tardar bastante.\n\n` +
          `Si el navegador pregunta, permite que el sitio descargue varios archivos.\n\n` +
          `Para algo más corto, filtra por RRCC o por estado. ¿Continuar?`
      )
    ) {
      return;
    }

    const base = `EXPORTACION RRCC A ${hoyIso()}${sufijoFiltro()}`;
    const nombreDe = (k) => (partes.length > 1 ? `${base} (parte ${k + 1} de ${partes.length}).zip` : `${base}.zip`);

    abortador = new AbortController();
    const senal = abortador.signal;
    actualizarBotones();
    el.stop.hidden = false;
    barra.mostrar(true);
    barra.set(0, objetivo.length, "consultando certificados…");
    consola.cabecera(`ZIP · ${objetivo.length} persona(s) · ${total} autorización(es)`);
    consola(
      "se busca el certificado de cada una en JOMISER, EIN y Drive" +
        (partes.length > 1 ? ` · ${partes.length} ZIP de hasta ${MAX_CERTIFICADOS_POR_ZIP} certificados` : ""),
      "info"
    );

    const inicio = Date.now();
    let previas = 0; // personas de las partes ya bajadas, para una sola barra
    let archivos = 0;
    let faltantes = 0;
    let bajadas = 0;
    try {
      // el contexto trae el diccionario de cursos (curso -> RRCC)
      const ctx = contexto || (contexto = await obtenerContexto());
      for (const [k, parte] of partes.entries()) {
        const etiqueta = partes.length > 1 ? `parte ${k + 1}/${partes.length} · ` : "";
        const r = await armarZipExportacion(parte, {
          diccionario: ctx.diccionario,
          buscar: (dni, s) => buscar({ dni }, s),
          descargar: descargarCertificado,
          senal,
          log: (texto, tipo) => consola(texto, tipo),
          alAvanzar: ({ hechas, archivos: n }) => {
            const listas = previas + hechas;
            barra.set(
              listas,
              objetivo.length,
              `${etiqueta}${listas}/${objetivo.length} persona(s) · ${archivos + n} certificado(s) · ` +
                textoRestante(estimarRestante(inicio, listas, objetivo.length))
            );
          },
        });
        descargarBlob(r.blob, nombreDe(k));
        consola(`${r.archivos} certificado(s) en ${nombreDe(k)}`, "ok");
        previas += parte.length;
        archivos += r.archivos;
        faltantes += r.faltantes.length;
        bajadas++;
      }

      barra.set(1, 1, `${archivos} de ${total} certificado(s) en ${bajadas} ZIP`);
      if (faltantes) {
        consola(`${faltantes} autorización(es) sin certificado: el motivo de cada una está en el INDICE.xlsx del ZIP`, "warn");
      }
      notificar("ZIP listo", `${archivos} de ${total} certificado(s)` + (faltantes ? ` · ${faltantes} sin certificado` : ""));
    } catch (e) {
      if (senal.aborted) {
        consola(
          bajadas
            ? `descarga cancelada: ya se bajaron ${bajadas} de ${partes.length} ZIP; la parte en curso no se generó`
            : "descarga cancelada: no se generó el ZIP",
          "warn"
        );
      } else {
        consola(`no se pudo armar el ZIP: ${e.message}`, "err");
        notificar("No se pudo armar el ZIP", e.message, "warn");
      }
    } finally {
      abortador = null;
      el.stop.hidden = true;
      actualizarBotones();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Carga del personal (igual que ESTADO RRCC)                          */
  /* ------------------------------------------------------------------ */

  /** Deja la vista mostrando `lista` sin pedirle nada a la hoja. */
  function adoptar(nuevas, nota = "") {
    personas = nuevas;
    el.count.textContent = `${personas.length} persona(s)${nota ? ` (${nota})` : ""}`;
    el.recargar.hidden = personas.length === 0;
    pintarCuandoSeVea();
  }

  /** Con la pestana oculta no se arma la tabla: se pinta al mostrarse. */
  let pintadoPendiente = false;
  function pintarCuandoSeVea() {
    if ($("vista-exportacion").hidden) {
      pintadoPendiente = true;
      return;
    }
    pintadoPendiente = false;
    pintar();
  }
  alMostrarse("vista-exportacion", () => {
    if (!pintadoPendiente) return;
    pintadoPendiente = false;
    pintar();
  });

  async function cargar({ refrescar = false } = {}) {
    if (cargando) return;
    cargando = true;
    actualizarBotones();
    consola.limpiar();
    consola.cabecera(refrescar ? "RECARGANDO PERSONAL" : "CARGANDO PERSONAL");

    if (!refrescar) {
      const compartido = personalEnMemoria();
      if (compartido) {
        adoptar(compartido, hace(edadPersonal()));
        consola(`${compartido.length} persona(s) ya cargadas ${hace(edadPersonal())}; usa "recargar" para traerlas de nuevo`, "ok");
      } else if (!personas.length) {
        const snap = personalGuardado();
        if (snap) {
          configSnapshot = snap.config;
          adoptar(snap.personas, "de la última carga, actualizando…");
          consola(`${snap.personas.length} persona(s) de la última carga guardada; trayendo datos actuales…`, "info");
        }
      }
    }

    try {
      const [ctx, nuevas] = await conReintento(
        () => Promise.all([obtenerContexto({ refrescar }), obtenerPersonal({ refrescar })]),
        consola
      );
      contexto = ctx;
      const deLaHoja = nuevas !== personas;
      adoptar(nuevas);
      if (deLaHoja) {
        consola(`${personas.length} persona(s) leída(s) de la hoja`, "ok");
        notificar("Personal cargado", `${personas.length} persona(s) listas para exportar.`);
      }
    } catch (e) {
      consola(`no se pudo cargar: ${e.message}`, "err");
      notificar("No se pudo cargar", e.message, "warn");
    } finally {
      cargando = false;
      actualizarBotones();
    }
  }

  /**
   * Lo que cargue o guarde otra pestana llega por aca. Solo listados
   * COMPLETOS: el de ESTADO TOTAL viene filtrado a los vencidos.
   */
  alCambiar((ev) => {
    if (ev.tipo === "contexto") contexto = ev.contexto;
    if (ev.tipo !== "personal" || !ev.completo || ev.personas === personas || cargando) return;
    adoptar(ev.personas, ev.origen === "escritura" ? "actualizado" : hace(edadPersonal()));
  });

  el.cargar.addEventListener("click", () => cargar());
  el.recargar.addEventListener("click", () => cargar({ refrescar: true }));
  el.buscar.addEventListener("input", pintar);
  selRiesgo.alCambiar(pintar);
  for (const boton of el.estados) {
    boton.addEventListener("click", () => {
      const estado = boton.dataset.estado;
      if (!estadosElegidos.delete(estado)) estadosElegidos.add(estado);
      boton.setAttribute("aria-pressed", String(estadosElegidos.has(estado)));
      pintar();
    });
  }
  el.excel.addEventListener("click", exportarExcel);
  el.zip.addEventListener("click", descargarZip);
  el.stop.addEventListener("click", () => abortador?.abort());

  // ya puede haber datos de otra pestana (o de la precarga del arranque)
  const yaHay = personalEnMemoria();
  if (yaHay) adoptar(yaHay, hace(edadPersonal()));
  pintarCuandoSeVea();

  return { recargar: () => cargar({ refrescar: true }), cargar };
}
