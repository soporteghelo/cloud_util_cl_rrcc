/**
 * Vista "VERIFICACION": por riesgo critico, toma de la hoja a los autorizados
 * ("A") ACTIVOS que lo tienen VENCIDO o POR VENCER, los compara con JOMISER y
 * lista solo a quienes NO CONCUERDAN (JOMISER tiene un curso aprobado mas
 * reciente), los vencidos primero. Nada se escribe hasta APLICAR, y solo a
 * los marcados. Las reglas viven en `lib/verificacion.js`.
 */

import { $, crearConsola, crearProgreso, notificar, escaparHtml, estimarRestante, textoRestante, alMostrarse } from "./comun.js";
import { obtenerContexto, obtenerPersonal, personalEnMemoria, contextoEnMemoria, alCambiar } from "../lib/datos.js";
import { autorizadosActivos, personasAVerificar, verificar, aplicar } from "../lib/verificacion.js";
import { aFormatoCorto, guardiaDe } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

/** Filtros de la vista previa: que entra en cada uno. */
const vencido = (r) => r.estadoHoja === "VENCIDO" || r.estadoHoja === "SIN FECHA";
const FILTROS = {
  TODOS: (r) => r.estado === "NO CONCUERDA" || r.estado === "ERROR",
  VENCIDOS: (r) => r.estado === "NO CONCUERDA" && vencido(r),
  "POR VENCER": (r) => r.estado === "NO CONCUERDA" && r.estadoHoja === "ACTUALIZAR",
  ERROR: (r) => r.estado === "ERROR",
};
const CLASE_HOJA = { VENCIDO: "et-vencido", "SIN FECHA": "et-vencido", ACTUALIZAR: "et-actualizar" };
const TEXTO_HOJA = { VENCIDO: "VENCIDO", "SIN FECHA": "SIN FECHA", ACTUALIZAR: "POR VENCER" };

export function montarVerificacion() {
  const consola = crearConsola("vf-term", "vf-log-clear");
  const barra = crearProgreso("vf");

  const el = {
    riesgo: $("vf-riesgo"),
    verificar: $("vf-verificar"),
    aplicar: $("vf-aplicar"),
    stop: $("vf-stop"),
    count: $("vf-count"),
    resCount: $("vf-res-count"),
    filtros: $("vf-filtros"),
    resultados: $("vf-resultados"),
  };
  if (!el.riesgo) return;

  let personas = personalEnMemoria() || [];
  let contexto = contextoEnMemoria();
  let resultados = []; // de la ultima verificacion, en el orden de la lista (vencidos primero)
  let revisados = 0; // cuantos entraron a la comparacion
  let codigoVerificado = ""; // el riesgo al que corresponden `resultados`
  const elegidos = new Set(); // DNI marcados para aplicar
  const aplicados = new Map(); // dni -> { ok, motivo }
  let filtro = "TODOS";
  let abortador = null;

  el.riesgo.innerHTML = RRCC.map((r) => `<option value="${r.codigo}">${r.codigo} · ${escaparHtml(r.nombre)}</option>`).join("");

  const codigo = () => el.riesgo.value;
  const umbrales = () => ({
    vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? 365),
    actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? 330),
  });

  function pintarConteo() {
    if (!personas.length) {
      el.count.textContent = "";
      return;
    }
    const a = autorizadosActivos(personas, codigo()).length;
    const lista = personasAVerificar(personas, codigo(), umbrales());
    const v = lista.filter(vencido).length;
    el.count.textContent = `${a} con ${codigo()} "A" · ${v} vencido(s) · ${lista.length - v} por vencer`;
  }

  /* ---------------- tabla ---------------- */

  const corregible = (r) => r.estado === "NO CONCUERDA" && !aplicados.get(r.persona.dni)?.ok;
  const porAplicar = () => resultados.filter((r) => corregible(r) && elegidos.has(r.persona.dni));

  function filaHtml(r) {
    const p = r.persona;
    const hecho = aplicados.get(p.dni);
    const casilla = corregible(r)
      ? `<input type="checkbox" data-vf-dni="${escaparHtml(p.dni)}"${elegidos.has(p.dni) ? " checked" : ""}${abortador ? " disabled" : ""} aria-label="Corregir a ${escaparHtml(p.nombreCompleto)}" />`
      : "";
    const enHoja =
      `<span class="et-badge ${CLASE_HOJA[r.estadoHoja] || ""}">${TEXTO_HOJA[r.estadoHoja] || r.estadoHoja}</span>` +
      `<div class="vf-motivo">${r.capPrevia ? `curso ${aFormatoCorto(r.capPrevia)} · vence ${aFormatoCorto(r.vencPrevio) || "?"}` : "sin fecha"}</div>`;
    const enJomiser =
      r.estado === "NO CONCUERDA" && r.certificado
        ? `<b class="vf-nueva">${aFormatoCorto(r.certificado.fecha)}</b><div class="vf-motivo">${escaparHtml(r.certificado.curso || "")}</div>`
        : "—";
    const nueva = r.estado === "NO CONCUERDA" ? `<b class="vf-nueva">${aFormatoCorto(r.venc)}</b>` : "—";
    const resultado = hecho
      ? hecho.ok
        ? `<span class="et-badge et-vigente">CORREGIDO</span>`
        : `<span class="et-badge et-vencido">NO SE CORRIGIÓ</span><div class="vf-motivo">${escaparHtml(hecho.motivo || "")}</div>`
      : r.estado === "ERROR"
        ? `<span class="et-badge et-vencido">ERROR</span><div class="vf-motivo">${escaparHtml(r.motivo || "")}</div>`
        : `<span class="et-badge et-actualizar">NO CONCUERDA</span>`;
    return (
      `<tr${hecho?.ok ? ' class="vf-hecho"' : ""}>` +
      `<td class="vf-check">${casilla}</td>` +
      `<td>${escaparHtml(p.dni)}</td>` +
      `<td>${escaparHtml(p.nombreCompleto) || "—"}</td>` +
      `<td>${escaparHtml(p.cargo) || "—"}</td>` +
      `<td>${escaparHtml(guardiaDe(p)) || "—"}</td>` +
      `<td>${enHoja}</td>` +
      `<td>${enJomiser}</td>` +
      `<td>${nueva}</td>` +
      `<td>${resultado}</td>` +
      `</tr>`
    );
  }

  function pintar() {
    const cuenta = (f) => resultados.filter(FILTROS[f]).length;
    el.filtros.innerHTML = resultados.length
      ? Object.keys(FILTROS)
          .map((f) => `<button type="button" class="btn btn-ghost btn-sm" data-vf-filtro="${f}" aria-pressed="${filtro === f}">${f} · ${cuenta(f)}</button>`)
          .join("")
      : "";

    const lista = resultados.filter(FILTROS[filtro]);
    const marcables = lista.filter(corregible);
    const todos = marcables.length && marcables.every((r) => elegidos.has(r.persona.dni));
    const cabeza = marcables.length
      ? `<input type="checkbox" data-vf-todos${todos ? " checked" : ""}${abortador ? " disabled" : ""} aria-label="Marcar todos" />`
      : "";

    if (!resultados.length) {
      el.resultados.innerHTML = `<div class="estado-vacio">${
        abortador ? "comparando con JOMISER…" : "elige un riesgo y pulsa VERIFICAR CON JOMISER"
      }</div>`;
    } else if (!lista.length) {
      el.resultados.innerHTML = `<div class="estado-vacio">${
        filtro === "ERROR" ? "sin errores" : "nadie: las fechas de la hoja concuerdan con JOMISER"
      }</div>`;
    } else {
      el.resultados.innerHTML =
        `<table class="estado-tabla vf-tabla"><thead><tr>` +
        `<th class="vf-check">${cabeza}</th><th>DNI</th><th>Apellidos y nombres</th><th>Cargo</th><th>Guardia</th>` +
        `<th>En la hoja</th><th>Curso en JOMISER</th><th>Vigencia nueva</th><th>Resultado</th>` +
        `</tr></thead><tbody>${lista.map(filaHtml).join("")}</tbody></table>`;
    }

    if (resultados.length) {
      const n = (e) => resultados.filter((r) => r.estado === e).length;
      const desaprobados = resultados.filter((r) => r.desaprobado).length;
      el.resCount.textContent =
        `${codigoVerificado} · ${resultados.length}/${revisados} comparados · ${n("NO CONCUERDA")} no concuerdan · ` +
        `${n("CONCUERDA")} concuerdan · ${n("SIN CURSO NUEVO")} sin curso más reciente en JOMISER` +
        (desaprobados ? ` (${desaprobados} desaprobado(s))` : "");
    } else el.resCount.textContent = "";
    actualizarBotones();
  }

  // durante la verificacion llegan resultados de a uno: se repinta a lo sumo cada 300 ms
  let pintado = null;
  const pintarPronto = () => {
    if (!pintado) pintado = setTimeout(() => ((pintado = null), pintar()), 300);
  };

  function actualizarBotones() {
    const ocupado = Boolean(abortador);
    const n = porAplicar().length;
    el.verificar.disabled = ocupado;
    el.riesgo.disabled = ocupado;
    el.aplicar.disabled = ocupado || !n;
    el.aplicar.textContent = n ? `CORREGIR ${n} FECHA(S) EN LA HOJA` : "APLICAR";
    el.stop.hidden = !ocupado;
  }

  /* ---------------- eventos ---------------- */

  el.riesgo.addEventListener("change", () => {
    // la vista previa es de UN riesgo: cambiarlo la descarta
    resultados = [];
    revisados = 0;
    codigoVerificado = "";
    elegidos.clear();
    aplicados.clear();
    pintarConteo();
    pintar();
  });

  el.filtros.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-vf-filtro]");
    if (!b) return;
    filtro = b.dataset.vfFiltro;
    pintar();
  });

  el.resultados.addEventListener("change", (ev) => {
    const caja = ev.target.closest("input[type=checkbox]");
    if (!caja) return;
    if (caja.hasAttribute("data-vf-todos")) {
      for (const r of resultados.filter(FILTROS[filtro]).filter(corregible)) {
        if (caja.checked) elegidos.add(r.persona.dni);
        else elegidos.delete(r.persona.dni);
      }
    } else if (caja.checked) elegidos.add(caja.dataset.vfDni);
    else elegidos.delete(caja.dataset.vfDni);
    pintar();
  });

  el.stop.addEventListener("click", () => abortador?.abort());

  el.verificar.addEventListener("click", async () => {
    const cod = codigo();
    abortador = new AbortController();
    const senal = abortador.signal;
    resultados = [];
    revisados = 0;
    codigoVerificado = cod;
    elegidos.clear();
    aplicados.clear();
    filtro = "TODOS";
    barra.mostrar(true);
    barra.set(0, 1, "leyendo la hoja…");
    pintar();
    try {
      consola.cabecera(`VERIFICACION · ${cod} · JOMISER`);
      [contexto, personas] = await Promise.all([obtenerContexto(), obtenerPersonal()]);
      pintarConteo();
      // paso 1: de la hoja, solo vencidos y por vencer (los vigentes no se consultan)
      const lista = personasAVerificar(personas, cod, umbrales());
      revisados = lista.length;
      const v = lista.filter(vencido).length;
      consola(`${autorizadosActivos(personas, cod).length} activos con ${cod} "A" · ${v} vencido(s) y ${lista.length - v} por vencer en la hoja`);
      if (!lista.length) {
        consola("nadie vencido ni por vencer: no hay nada que comparar", "ok");
        notificar("Nada que verificar", `Todos los ${cod} "A" activos están vigentes en la hoja.`);
        return;
      }
      // paso 2: esos se comparan con JOMISER
      const inicio = Date.now();
      await verificar({
        lista,
        codigo: cod,
        ctx: contexto,
        senal,
        alResultado: (r) => {
          resultados.push(r);
          if (r.estado === "NO CONCUERDA") elegidos.add(r.persona.dni); // marcados de entrada
          if (r.estado === "ERROR") consola(`${r.persona.dni}: ${r.motivo}`, "err");
          const resta = textoRestante(estimarRestante(inicio, resultados.length, lista.length));
          barra.set(resultados.length, lista.length, `${resultados.length}/${lista.length} comparados con JOMISER · ${resta}`);
          pintarPronto();
        },
      });
      if (senal.aborted) {
        consola(`verificación detenida: ${resultados.length}/${lista.length} comparados`, "warn");
      } else {
        const n = resultados.filter((r) => r.estado === "NO CONCUERDA").length;
        const errores = resultados.filter((r) => r.estado === "ERROR").length;
        barra.set(1, 1, "verificación completa");
        consola(`${n} fecha(s) no concuerdan con JOMISER${errores ? ` · ${errores} sin poder consultar` : ""} · revisa la lista y pulsa CORREGIR`, n ? "ok" : "info");
        notificar(
          "Verificación lista",
          `${cod}: ${n} fecha(s) no concuerdan con JOMISER${errores ? `, ${errores} con error` : ""}. Aún no se escribió nada.`,
          errores ? "warn" : "ok"
        );
      }
    } catch (e) {
      if (!senal.aborted) {
        barra.set(0, 1, "no se pudo verificar");
        consola(`no se pudo verificar: ${e.message}`, "err");
        notificar("No se pudo verificar", e.message, "warn");
      }
    } finally {
      // en el orden de la lista (vencidos primero), no en el de llegada
      const orden = new Map(personasAVerificar(personas, cod, umbrales()).map((x, i) => [x.persona.dni, i]));
      resultados.sort((a, b) => (orden.get(a.persona.dni) ?? 1e9) - (orden.get(b.persona.dni) ?? 1e9));
      abortador = null;
      pintar();
    }
  });

  el.aplicar.addEventListener("click", async () => {
    const lista = porAplicar();
    if (!lista.length) return;
    const cod = codigoVerificado;
    if (!window.confirm(`Se corregirá la fecha de ${cod} de ${lista.length} persona(s) en la hoja BD AESA, con la de JOMISER.\n\n¿Continuar?`)) return;
    abortador = new AbortController();
    const senal = abortador.signal;
    barra.mostrar(true);
    barra.set(0, lista.length, "corrigiendo…");
    pintar();
    let hechos = 0;
    try {
      consola.cabecera(`CORRIGIENDO · ${cod} · ${lista.length} persona(s)`);
      const r = await aplicar({
        elegidos: lista,
        codigo: cod,
        ctx: contexto,
        senal,
        log: consola,
        alAplicado: (res, salida) => {
          aplicados.set(res.persona.dni, salida);
          hechos++;
          barra.set(hechos, lista.length, `${hechos}/${lista.length} guardados`);
          pintarPronto();
        },
      });
      const resumen = `${r.ok} corregida(s)${r.fallos ? ` · ${r.fallos} con error` : ""}`;
      consola(senal.aborted ? `detenido · ${resumen}` : resumen, r.fallos ? "warn" : "ok");
      notificar(senal.aborted ? "Corrección detenida" : "Fechas corregidas", `${cod}: ${resumen}.`, r.fallos ? "warn" : "ok");
    } catch (e) {
      consola(`no se pudo corregir: ${e.message}`, "err");
    } finally {
      abortador = null;
      pintar();
    }
  });

  // otra pestana trajo el listado o el contexto: el conteo se pone al dia
  alCambiar((ev) => {
    if (ev.tipo === "personal" && ev.completo) {
      personas = ev.personas;
      pintarConteo();
    }
  });

  // el conteo necesita el listado y los umbrales: se traen (o se toman de
  // otra pestana) recien cuando se mira esta vista
  alMostrarse("vista-verificacion", () => {
    if (personas.length && contexto) return;
    Promise.all([obtenerContexto(), obtenerPersonal()]).then(
      ([ctx, lista]) => {
        contexto = ctx;
        personas = lista;
        pintarConteo();
      },
      () => {}
    );
  });

  pintarConteo();
  pintar();
}
