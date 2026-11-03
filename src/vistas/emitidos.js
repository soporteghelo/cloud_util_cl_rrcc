/**
 * Vista "EMITIDOS": se elige mes y anio y se baja un ZIP con una carpeta por
 * RRCC y, en cada una, el certificado de JOMISER de quienes tienen ese riesgo
 * como "A" con capacitacion de ese mes segun la hoja. Las reglas viven en
 * `lib/emitidos.js`.
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
import { partirEnZips, MAX_CERTIFICADOS_POR_ZIP } from "../lib/exportacion.js";
import { MESES, claveMes, nombreMes, autorizadosDelMes, armarZipEmitidos, hojasDeEmitidos } from "../lib/emitidos.js";
import { guardiaDe, aFormatoCorto } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

export function montarEmitidos() {
  const consola = crearConsola("em-term", "em-log-clear");
  const barra = crearProgreso("em");

  const el = {
    mes: $("em-mes"),
    anio: $("em-anio"),
    cargar: $("em-cargar"),
    excel: $("em-excel"),
    zip: $("em-zip"),
    stop: $("em-stop"),
    count: $("em-count"),
    resCount: $("em-res-count"),
    resultados: $("em-resultados"),
    recargar: $("em-recargar"),
  };

  let personas = [];
  let contexto = null;
  let cargando = false;
  let lista = []; // lo ultimo pintado: es lo que se exporta
  let abortador = null; // mientras se arma el ZIP

  // mes y anio: arranca en el mes actual; anios desde 2024 hasta el siguiente
  const ahora = new Date();
  el.mes.innerHTML = MESES.map((m, i) => `<option value="${i + 1}">${m}</option>`).join("");
  el.mes.value = String(ahora.getMonth() + 1);
  const anios = [];
  for (let a = ahora.getFullYear() + 1; a >= 2024; a--) anios.push(a);
  el.anio.innerHTML = anios.map((a) => `<option value="${a}">${a}</option>`).join("");
  el.anio.value = String(ahora.getFullYear());
  const mesElegido = () => claveMes(el.anio.value, el.mes.value);

  const selRiesgo = crearMultiSelect(
    "em-riesgo",
    RRCC.map((r) => ({ valor: r.codigo, etiqueta: `${r.codigo} · ${r.rotulo}` })),
    { textoTodos: "TODOS LOS RRCC", resumen: (op) => op.valor }
  );

  /* ------------------------------------------------------------------ */
  /* Tabla                                                               */
  /* ------------------------------------------------------------------ */

  const pastilla = (r) =>
    `<span class="et-badge ${r.tipo === "C" ? "et-actualizar" : "et-vigente"}" title="${escaparHtml(
      `${r.codigo} (${r.tipo}) · ${r.nombre} · capacitación ${aFormatoCorto(r.cap) || "?"} · vence ${aFormatoCorto(r.venc) || "?"}`
    )}">${r.codigo}${r.tipo === "C" ? " (C)" : ""} ${escaparHtml((aFormatoCorto(r.cap) || "").slice(0, 5))}</span>`;

  function filaHtml({ persona, rrcc }) {
    return (
      `<tr>` +
      `<td>${escaparHtml(persona.dni)}</td>` +
      `<td>${escaparHtml(persona.nombreCompleto) || "—"}</td>` +
      `<td>${escaparHtml(persona.cargo) || "—"}</td>` +
      `<td>${escaparHtml(guardiaDe(persona)) || "—"}</td>` +
      `<td class="ex-rrcc">${rrcc.map(pastilla).join("")}</td>` +
      `</tr>`
    );
  }

  function pintar() {
    lista = autorizadosDelMes(personas, mesElegido(), { riesgos: selRiesgo.obtener() });
    const vacio = personas.length
      ? `nadie tiene un RRCC "A" (o IE "C") capacitado en ${nombreMes(mesElegido())}`
      : "carga el personal para ver los RRCC del mes";
    el.resultados.innerHTML = lista.length
      ? `<table class="estado-tabla ex-tabla"><thead><tr>` +
        `<th>DNI</th><th>Apellidos y nombres</th><th>Cargo</th><th>Guardia</th><th>RRCC del mes</th>` +
        `</tr></thead><tbody>${lista.map(filaHtml).join("")}</tbody></table>`
      : `<div class="estado-vacio">${vacio}</div>`;

    const total = lista.reduce((n, x) => n + x.rrcc.length, 0);
    el.resCount.textContent = personas.length ? `${nombreMes(mesElegido())} · ${lista.length} persona(s) · ${total} RRCC` : "";
    actualizarBotones();
  }

  function actualizarBotones() {
    const ocupado = Boolean(abortador);
    el.excel.disabled = !lista.length;
    el.zip.disabled = !lista.length || ocupado;
    el.cargar.disabled = cargando || ocupado;
    el.mes.disabled = ocupado;
    el.anio.disabled = ocupado;
  }

  /* ------------------------------------------------------------------ */
  /* Exportacion                                                         */
  /* ------------------------------------------------------------------ */

  const base = () => {
    const riesgos = [...selRiesgo.obtener()];
    return `CERTIFICADOS JOMISER ${nombreMes(mesElegido())}${riesgos.length ? ` ${riesgos.join(" ")}` : ""}`;
  };

  /** Solo la lista de la hoja (sin consultar JOMISER). */
  async function exportarExcel() {
    if (!lista.length) return;
    const nombre = `${base()}.xlsx`;
    el.excel.disabled = true;
    try {
      const entradas = lista.flatMap(({ persona, rrcc }) => rrcc.map((r) => ({ persona, r })));
      descargarBlob(await armarXlsx(hojasDeEmitidos(entradas)), nombre);
      consola(`${entradas.length} RRCC exportados a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar el Excel: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      actualizarBotones();
    }
  }

  async function descargarZip() {
    if (!lista.length || abortador) return;
    const objetivo = lista;
    const total = objetivo.reduce((n, x) => n + x.rrcc.length, 0);
    const partes = partirEnZips(objetivo);
    if (
      partes.length > 1 &&
      !window.confirm(
        `Son ${objetivo.length} personas y ${total} certificados: se bajarán en ${partes.length} ZIP ` +
          `de hasta ${MAX_CERTIFICADOS_POR_ZIP} certificados, uno tras otro.\n\n` +
          `Si el navegador pregunta, permite que el sitio descargue varios archivos. ¿Continuar?`
      )
    ) {
      return;
    }

    const nombreBase = base();
    const nombreDe = (k) => (partes.length > 1 ? `${nombreBase} (parte ${k + 1} de ${partes.length}).zip` : `${nombreBase}.zip`);

    abortador = new AbortController();
    const senal = abortador.signal;
    actualizarBotones();
    el.stop.hidden = false;
    barra.mostrar(true);
    barra.set(0, objetivo.length, "consultando JOMISER…");
    consola.cabecera(`ZIP · ${nombreMes(mesElegido())} · ${objetivo.length} persona(s) · ${total} RRCC`);
    consola("se busca en JOMISER el certificado de cada RRCC con la fecha de capacitación de la hoja", "info");

    const inicio = Date.now();
    let previas = 0;
    let archivos = 0;
    let faltantes = 0;
    let bajadas = 0;
    try {
      const ctx = contexto || (contexto = await obtenerContexto());
      for (const [k, parte] of partes.entries()) {
        const etiqueta = partes.length > 1 ? `parte ${k + 1}/${partes.length} · ` : "";
        const r = await armarZipEmitidos(parte, {
          diccionario: ctx.diccionario,
          buscar: (dni, s) => buscar({ dni, solo: "JOMISER" }, s),
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
      if (faltantes) consola(`${faltantes} RRCC sin certificado en JOMISER: el motivo de cada uno está en el INDICE.xlsx`, "warn");
      notificar("ZIP listo", `${archivos} de ${total} certificado(s)` + (faltantes ? ` · ${faltantes} sin certificado` : ""));
    } catch (e) {
      if (senal.aborted) {
        consola(bajadas ? `descarga cancelada: ya se bajaron ${bajadas} de ${partes.length} ZIP` : "descarga cancelada: no se generó el ZIP", "warn");
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
  /* Carga del personal (igual que EXPORTACION)                          */
  /* ------------------------------------------------------------------ */

  function adoptar(nuevas, nota = "") {
    personas = nuevas;
    el.count.textContent = `${personas.length} persona(s)${nota ? ` (${nota})` : ""}`;
    el.recargar.hidden = personas.length === 0;
    pintarCuandoSeVea();
  }

  let pintadoPendiente = false;
  function pintarCuandoSeVea() {
    if ($("vista-emitidos").hidden) {
      pintadoPendiente = true;
      return;
    }
    pintadoPendiente = false;
    pintar();
  }
  alMostrarse("vista-emitidos", () => {
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
      if (deLaHoja) consola(`${personas.length} persona(s) leída(s) de la hoja`, "ok");
    } catch (e) {
      consola(`no se pudo cargar: ${e.message}`, "err");
      notificar("No se pudo cargar", e.message, "warn");
    } finally {
      cargando = false;
      actualizarBotones();
    }
  }

  alCambiar((ev) => {
    if (ev.tipo === "contexto") contexto = ev.contexto;
    if (ev.tipo !== "personal" || !ev.completo || ev.personas === personas || cargando) return;
    adoptar(ev.personas, ev.origen === "escritura" ? "actualizado" : hace(edadPersonal()));
  });

  el.cargar.addEventListener("click", () => cargar());
  el.recargar.addEventListener("click", () => cargar({ refrescar: true }));
  el.mes.addEventListener("change", pintar);
  el.anio.addEventListener("change", pintar);
  selRiesgo.alCambiar(pintar);
  el.excel.addEventListener("click", exportarExcel);
  el.zip.addEventListener("click", descargarZip);
  el.stop.addEventListener("click", () => abortador?.abort());

  const yaHay = personalEnMemoria();
  if (yaHay) adoptar(yaHay, hace(edadPersonal()));
  pintarCuandoSeVea();

  return { recargar: () => cargar({ refrescar: true }), cargar };
}
