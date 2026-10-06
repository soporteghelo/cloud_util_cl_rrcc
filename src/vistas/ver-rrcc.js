/**
 * Vista "VER RRCC": el fotocheck de RRCC de cada persona, como imagen, en una
 * grilla. Solo el personal ACTIVO; se filtra por ESTADO_FINAL, guardia, cargo
 * (escribiendo), area y riesgo critico, y la lista filtrada se baja en Excel
 * (vigencias) o en un ZIP con todos sus fotochecks.
 *
 * Como ESTADO RRCC, es un reporte de lo guardado en `BD AESA`: el fotocheck
 * se dibuja en el navegador con lo que dice la hoja (el mismo dibujo que deja
 * la renovacion en Drive) y la foto sale de la carpeta FOTOS. Las reglas
 * viven en `lib/ver-rrcc.js`.
 *
 * Cientos de fotochecks no se dibujan de una: cada tarjeta se dibuja recien
 * cuando entra en pantalla, en miniatura, y se guarda ya dibujada mientras la
 * persona no cambie. El ZIP los dibuja en alta, como la carpeta de Drive.
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
import { armarXlsx } from "../lib/excel.js";
import { limpiarNombre } from "../lib/guardar.js";
import { cargarImagen, dibujarFotocheck, fotocheckImagen, fotoReducida, FOTOCHECK } from "../lib/fotocheck.js";
import { fotoDeDni, descargarCertificado } from "../lib/renovacion.js";
import { buscar } from "../lib/api.js";
import { armarZipExportacion, partirEnZips, MAX_CERTIFICADOS_POR_ZIP } from "../lib/exportacion.js";
import { abrirFotocheck, actualizarFotocheck, fotocheckAbiertoDe } from "./fotocheck-modal.js";
import { autocompletar } from "./autocompletar.js";
import {
  filtrarPersonas,
  facetas,
  filtrosIniciales,
  hojasDeVerRrcc,
  armarZipFotochecks,
  partirEnTandas,
  diasDe,
  paraFotocheck,
  certificadosDeLista,
  rotuloDe,
  CAMPOS,
  MAX_FOTOCHECKS_POR_ZIP,
} from "../lib/ver-rrcc.js";
import { guardiaDe, hoyIso } from "../../shared/estados.js";

const CLASE_ESTADO = { VIGENTE: "vigente", VENCIDO: "vencido" };
const claseEstado = (valor) => CLASE_ESTADO[valor] || "noaplica";

/** Miniaturas que se dibujan a la vez; el resto espera a que le toque. */
const MINIATURAS_A_LA_VEZ = 3;

/** Fotos que se piden a Drive a la vez (las comparten la grilla y el ZIP). */
const FOTOS_A_LA_VEZ = 4;

/** Hasta `n` tareas a la vez; las demas esperan en orden de llegada. */
function limitador(n) {
  let activas = 0;
  const cola = [];
  const siguiente = () => {
    if (activas >= n || !cola.length) return;
    activas++;
    const { tarea, listo, falla } = cola.shift();
    Promise.resolve()
      .then(tarea)
      .then(listo, falla)
      .finally(() => {
        activas--;
        siguiente();
      });
  };
  return (tarea) =>
    new Promise((listo, falla) => {
      cola.push({ tarea, listo, falla });
      siguiente();
    });
}

/** Lo que se dibuja en el fotocheck: si no cambia, la miniatura ya hecha sirve. */
const firmaDe = (p) =>
  JSON.stringify([
    p.dni,
    p.apellidos,
    p.nombres,
    p.area,
    p.cargo,
    p.examenMedico,
    p.vencimientoEmo,
    p.usoLentes,
    p.estadoFinal,
    (p.riesgos || []).map((r) => `${r.tipo}${r.venc}`),
  ]);

export function montarVerRrcc() {
  const consola = crearConsola("vr-term", "vr-log-clear");
  const barra = crearProgreso("vr");

  const el = {
    buscar: $("vr-buscar"),
    cargo: $("vr-cargo"),
    cargosSel: $("vr-cargo-sel"),
    estadoFinal: $("vr-estado-final"),
    guardia: $("vr-guardia"),
    tipos: $("vr-tipos"),
    limpiar: $("vr-limpiar"),
    cargar: $("vr-cargar"),
    excel: $("vr-excel"),
    zip: $("vr-zip"),
    certs: $("vr-certs"),
    stop: $("vr-stop"),
    count: $("vr-count"),
    resCount: $("vr-res-count"),
    resultados: $("vr-resultados"),
    recargar: $("vr-recargar"),
  };
  if (!el.resultados) return null;

  let personas = [];
  let contexto = null;
  let configSnapshot = null; // config del ultimo snapshot, solo hasta que llegue el contexto real
  let cargando = false;
  let lista = []; // lo ultimo pintado: es lo que se exporta
  let abortador = null; // mientras se arma el ZIP

  /* Solo personal ACTIVO, siempre. ESTADO_FINAL y guardia se marcan con
     botones, el cargo se escribe (y se eligen varios) y el area es un desplegable. */
  const SOLO_ACTIVOS = new Set(filtrosIniciales().situacion);
  const elegidos = { estadoFinal: new Set(), guardia: new Set(), tipos: new Set() };
  const opcionMsel = () => (o) => ({ valor: o.valor, rotulo: o.rotulo, etiqueta: `${o.rotulo} (${o.cuenta})` });
  const selArea = crearMultiSelect("vr-area", [], { textoTodos: "TODAS LAS ÁREAS", resumen: (op) => op?.rotulo || "" });
  const selRiesgo = crearMultiSelect("vr-riesgo", [], { textoTodos: "TODOS LOS RRCC", resumen: (op) => op?.rotulo || "" });

  /* Cargo: lo que se escribe filtra en vivo; lo que se elige de la lista
     queda como etiqueta y se pueden juntar varios. Las sugerencias son los
     cargos de quienes pasan los demas filtros, con cuantas personas tiene
     cada uno, sin los ya elegidos. */
  const cargosElegidos = new Set();
  let cargosSugeridos = new Map();
  autocompletar(el.cargo, {
    obtener: () => [...cargosSugeridos.keys()].filter((c) => !cargosElegidos.has(c)),
    nombre: "cargos",
    detalle: (cargo) => cargosSugeridos.get(cargo),
    textos: { sinOpciones: "carga el personal para ver los cargos", sinCoincidencias: "ningún cargo coincide" },
    alElegir: (cargo) => {
      cargosElegidos.add(cargo);
      el.cargo.value = "";
      pintar();
    },
  });

  const filtros = () => ({
    texto: el.buscar.value,
    cargoTexto: el.cargo.value,
    cargo: cargosElegidos,
    situacion: SOLO_ACTIVOS,
    ...elegidos,
    area: selArea.obtener(),
    riesgos: selRiesgo.obtener(),
  });

  const umbrales = () => ({
    vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? configSnapshot?.UMBRAL_VENCIDO ?? 365),
    actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? configSnapshot?.UMBRAL_ACTUALIZAR ?? 330),
  });

  /* ------------------------------------------------------------------ */
  /* Fotos y miniaturas                                                  */
  /* ------------------------------------------------------------------ */

  const logo = cargarImagen("/logo-aesa.png");
  const pedirFoto = limitador(FOTOS_A_LA_VEZ);

  /** DNI -> Promise<Blob|null> con la foto ya achicada. */
  const fotos = new Map();
  /** DNI a los que ni Apps Script les encontro foto: no se vuelve a preguntar. */
  const sinFotoConfirmado = new Set();

  /**
   * La foto de FOTOS por la lectura publica de Drive, que no hace fila detras
   * de Apps Script: con cientos de personas, preguntarle a Apps Script por
   * cada una lo dejaria ocupado para la renovacion. Un fallo de red no se
   * recuerda, para que el siguiente intento vuelva a probar.
   */
  function fotoDe(dni) {
    if (!dni) return Promise.resolve(null);
    if (!fotos.has(dni)) {
      const p = pedirFoto(() => fotoDeDni(dni, null, { soloPublica: true }))
        .then((url) => (url ? fotoReducida(url) : null))
        .catch((e) => {
          if (!/no hay foto/i.test(e?.message || "")) fotos.delete(dni);
          return null;
        });
      fotos.set(dni, p);
    }
    return fotos.get(dni);
  }

  /** firma -> { url, conFoto } de las miniaturas ya dibujadas; y las que estan en curso. */
  const hechas = new Map();
  const enCurso = new Map();
  const escalaMiniatura = () => Math.min(1, Math.max(0.5, 0.5 * (window.devicePixelRatio || 1)));

  function dibujarMiniatura(persona, firma) {
    if (!enCurso.has(firma)) {
      const p = (async () => {
        const foto = await fotoDe(persona.dni);
        const lienzo = await dibujarFotocheck(paraFotocheck(persona), { foto, logo: await logo, escala: escalaMiniatura() });
        const blob = await new Promise((r) => lienzo.toBlob(r, "image/jpeg", 0.86));
        if (!blob) throw new Error("el navegador no pudo dibujar el fotocheck");
        const m = { url: URL.createObjectURL(blob), conFoto: Boolean(foto) };
        hechas.set(firma, m);
        return m;
      })().finally(() => enCurso.delete(firma));
      enCurso.set(firma, p);
    }
    return enCurso.get(firma);
  }

  /** Suelta las miniaturas de quien ya no esta (o cambio): cada una ocupa memoria. */
  function podarMiniaturas(vigentes) {
    for (const [firma, m] of hechas) {
      if (vigentes.has(firma)) continue;
      URL.revokeObjectURL(m.url);
      hechas.delete(firma);
    }
  }

  function mostrarMiniatura(tarjeta, m) {
    const img = tarjeta.querySelector("img");
    img.src = m.url;
    tarjeta.classList.add("lista");
    tarjeta.querySelector(".vr-sinfoto").hidden = m.conFoto;
  }

  /* Cola de las tarjetas visibles que faltan dibujar: se dibujan primero las
     que se ven, y una que salio de pantalla antes de su turno se salta. */
  const personaDe = new WeakMap();
  const visibles = new Set();
  let dibujando = 0;
  let observador = null;

  function bombear() {
    while (dibujando < MINIATURAS_A_LA_VEZ && visibles.size) {
      const tarjeta = visibles.values().next().value;
      visibles.delete(tarjeta);
      observador?.unobserve(tarjeta);
      const persona = personaDe.get(tarjeta);
      if (!persona || !tarjeta.isConnected) continue;
      dibujando++;
      dibujarMiniatura(persona, tarjeta.dataset.firma)
        .then((m) => tarjeta.isConnected && mostrarMiniatura(tarjeta, m))
        .catch((e) => {
          tarjeta.classList.add("fallo");
          consola(`${persona.dni}: no se pudo dibujar el fotocheck: ${e.message}`, "err");
        })
        .finally(() => {
          dibujando--;
          bombear();
        });
    }
  }

  const movil = window.matchMedia("(max-width: 900px)");

  function observar(tarjetas) {
    observador?.disconnect();
    visibles.clear();
    // en escritorio la grilla se desplaza por dentro; en el celular, la pagina
    observador = new IntersectionObserver(
      (entradas) => {
        for (const e of entradas) {
          if (e.isIntersecting) visibles.add(e.target);
          else visibles.delete(e.target);
        }
        bombear();
      },
      { root: movil.matches ? null : el.resultados, rootMargin: "300px 0px" }
    );
    for (const t of tarjetas) observador.observe(t);
  }

  /* ------------------------------------------------------------------ */
  /* Grilla                                                              */
  /* ------------------------------------------------------------------ */

  function tarjetaHtml(p) {
    const estado = CAMPOS.estadoFinal.valor(p);
    const dias = diasDe(p);
    const guardia = guardiaDe(p);
    const meta = [p.dni, guardia ? `G. ${guardia}` : "", p.cargo].filter(Boolean).join(" · ");
    return (
      `<button type="button" class="vr-card vr-c-${claseEstado(estado)}" title="Ver el fotocheck en grande">` +
      `<span class="vr-img"><img alt="Fotocheck de ${escaparHtml(p.nombreCompleto || p.dni)}" decoding="async" /></span>` +
      `<span class="vr-pie">` +
      `<span class="vr-nom">${escaparHtml(p.nombreCompleto) || "—"}</span>` +
      `<span class="vr-estado"><span class="et-badge et-${claseEstado(estado)}">${escaparHtml(rotuloDe("estadoFinal", estado))}</span>` +
      (dias === null ? "" : `<span class="vr-dias">${dias} d</span>`) +
      `</span>` +
      `<span class="vr-meta">${escaparHtml(meta)}</span>` +
      `<span class="vr-sinfoto" hidden>SIN FOTO</span>` +
      `</span>` +
      `</button>`
    );
  }

  function pintarGrilla() {
    if (!lista.length) {
      observador?.disconnect();
      visibles.clear();
      const vacio = personas.length ? "nadie coincide con el filtro" : "carga el personal para ver sus fotochecks";
      el.resultados.innerHTML = `<div class="estado-vacio">${vacio}</div>`;
      return;
    }
    el.resultados.innerHTML = `<div class="vr-grid">${lista.map(tarjetaHtml).join("")}</div>`;
    const tarjetas = [...el.resultados.querySelectorAll(".vr-card")];
    const pendientes = [];
    tarjetas.forEach((t, i) => {
      const persona = lista[i];
      const firma = firmaDe(persona);
      t.dataset.firma = firma;
      t.dataset.indice = String(i);
      personaDe.set(t, persona);
      const m = hechas.get(firma);
      if (m) mostrarMiniatura(t, m);
      else pendientes.push(t);
    });
    observar(pendientes);
  }

  /* ------------------------------------------------------------------ */
  /* Filtros                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Botones de un filtro. Solo se rehacen si cambian las opciones: rehacerlos
   * con cada tecla del buscador le quitaria el foco al que se acaba de pulsar.
   */
  function pintarBotones(contenedor, campo, opciones) {
    if (!contenedor) return;
    const llave = opciones.map((o) => o.valor).join("\u0001");
    if (contenedor.dataset.llave !== llave || !contenedor.children.length) {
      contenedor.dataset.llave = llave;
      contenedor.innerHTML = opciones.length
        ? opciones
            .map(
              (o) =>
                `<button type="button" class="btn btn-ghost vr-chip${campo === "estadoFinal" ? ` vr-c-${claseEstado(o.valor)}` : ""}" ` +
                `data-valor="${escaparHtml(o.valor)}" aria-pressed="false">` +
                `<span>${escaparHtml(o.rotulo)}</span><span class="vr-n"></span></button>`
            )
            .join("")
        : `<span class="vr-chips-vacio">sin datos todavía</span>`;
    }
    const cuentas = new Map(opciones.map((o) => [o.valor, o.cuenta]));
    for (const b of contenedor.querySelectorAll(".vr-chip")) {
      b.setAttribute("aria-pressed", String(elegidos[campo].has(b.dataset.valor)));
      b.querySelector(".vr-n").textContent = String(cuentas.get(b.dataset.valor) ?? 0);
    }
  }

  /** El desplegable solo se rehace si cambian sus opciones (no al marcar una de ellas). */
  function pintarDesplegable(sel, idBase, campo, opciones) {
    const raiz = $(idBase);
    const nuevas = opciones.map(opcionMsel(campo));
    const llave = nuevas.map((o) => o.etiqueta).join("\u0001");
    if (raiz && raiz.dataset.llave === llave) return;
    if (raiz) raiz.dataset.llave = llave;
    sel.cambiarOpciones(nuevas);
  }

  /** Las etiquetas de los cargos elegidos, con cuantas personas tiene cada uno ahora. */
  function pintarCargosElegidos(cuentas) {
    if (!el.cargosSel) return;
    el.cargosSel.hidden = !cargosElegidos.size;
    el.cargosSel.innerHTML = [...cargosElegidos]
      .map(
        (c) =>
          `<button type="button" class="vr-tag" data-valor="${escaparHtml(c)}" title="Quitar este cargo del filtro">` +
          `<span>${escaparHtml(c)}</span><span class="vr-n">${cuentas.get(c) ?? 0}</span><span class="vr-x" aria-hidden="true">×</span></button>`
      )
      .join("");
    el.cargo.placeholder = cargosElegidos.size ? "agregar otro cargo…" : "escribe un cargo, ej. maestro mina";
  }

  function pintarFiltros() {
    const f = facetas(personas, filtros());
    pintarBotones(el.estadoFinal, "estadoFinal", f.estadoFinal);
    pintarBotones(el.guardia, "guardia", f.guardia);
    pintarBotones(el.tipos, "tipos", f.tipos);
    cargosSugeridos = new Map(f.cargo.filter((o) => o.valor && o.cuenta).map((o) => [o.valor, o.cuenta]));
    pintarCargosElegidos(new Map(f.cargo.map((o) => [o.valor, o.cuenta])));
    pintarDesplegable(selArea, "vr-area", "area", f.area);
    pintarDesplegable(selRiesgo, "vr-riesgo", "riesgos", f.riesgos);
  }

  function pintar() {
    lista = filtrarPersonas(personas, filtros());
    pintarFiltros();
    pintarGrilla();

    const cuenta = (estado) => lista.filter((p) => CAMPOS.estadoFinal.valor(p) === estado).length;
    el.resCount.textContent = personas.length
      ? `${lista.length} fotocheck(s) · ${cuenta("VIGENTE")} vigente(s) · ${cuenta("VENCIDO")} vencido(s)`
      : "";
    actualizarBotones();
  }

  /** Los certificados que bajaria el boton CERTIFICADOS RRCC con el filtro actual. */
  const certificadosAhora = () => {
    const f = filtros();
    return certificadosDeLista(lista, { riesgos: f.riesgos, tipos: f.tipos, umbrales: umbrales() });
  };

  function actualizarBotones() {
    const ocupado = Boolean(abortador);
    el.excel.disabled = !lista.length;
    el.zip.disabled = !lista.length || ocupado;
    el.cargar.disabled = cargando || ocupado;
    if (el.certs) {
      const hayRiesgo = selRiesgo.obtener().size > 0;
      const total = hayRiesgo ? certificadosAhora().reduce((n, x) => n + x.rrcc.length, 0) : 0;
      el.certs.disabled = !total || ocupado;
      el.certs.textContent = total ? `CERTIFICADOS RRCC · ${total}` : "CERTIFICADOS RRCC";
      el.certs.title = !hayRiesgo
        ? "Elige uno o más RRCC en Riesgo crítico para bajar sus certificados"
        : total
          ? `Bajar en un ZIP el certificado de ${[...selRiesgo.obtener()].join(", ")} de cada persona de la lista ` +
            "(se busca en JOMISER, EIN y Drive, como en EXPORTACIÓN), con un INDICE.xlsx de lo que falte"
          : "Nadie de la lista tiene esos RRCC";
    }
  }

  /* ------------------------------------------------------------------ */
  /* Fotocheck en grande                                                 */
  /* ------------------------------------------------------------------ */

  /**
   * Abre el panel flotante con el fotocheck (de ahi se baja en JPG o Word).
   * Si la lectura publica no encontro la foto, se le pregunta a Apps Script
   * solo por esta persona y se redibuja cuando llegue.
   */
  async function verEnGrande(persona) {
    const clave = `vr:${persona.dni}`;
    const config = contexto?.config || configSnapshot || {};
    const foto = await fotoDe(persona.dni);
    await abrirFotocheck(paraFotocheck(persona), { clave, foto, config, vivo: false });
    if (foto || !persona.dni || sinFotoConfirmado.has(persona.dni)) return;

    try {
      const url = await fotoDeDni(persona.dni, null);
      const reducida = url ? await fotoReducida(url) : null;
      if (!reducida) return;
      fotos.set(persona.dni, Promise.resolve(reducida));
      // la miniatura sin foto ya no sirve
      const firma = firmaDe(persona);
      const vieja = hechas.get(firma);
      if (vieja) {
        URL.revokeObjectURL(vieja.url);
        hechas.delete(firma);
      }
      if (fotocheckAbiertoDe(clave)) await actualizarFotocheck(paraFotocheck(persona), { foto: reducida });
      const tarjeta = [...el.resultados.querySelectorAll(".vr-card")].find((t) => personaDe.get(t) === persona);
      if (tarjeta) {
        tarjeta.classList.remove("lista");
        dibujarMiniatura(persona, firma).then((m) => tarjeta.isConnected && mostrarMiniatura(tarjeta, m)).catch(() => {});
      }
    } catch {
      sinFotoConfirmado.add(persona.dni);
    }
  }

  el.resultados.addEventListener("click", (ev) => {
    const tarjeta = ev.target.closest(".vr-card");
    const persona = tarjeta && personaDe.get(tarjeta);
    if (persona) verEnGrande(persona).catch((e) => consola(`no se pudo abrir el fotocheck: ${e.message}`, "err"));
  });

  /* ------------------------------------------------------------------ */
  /* Exportacion                                                         */
  /* ------------------------------------------------------------------ */

  /** Lo que dice el nombre del archivo sobre el filtro: "VENCIDO GUARDIA A MAESTRO"... */
  function sufijoFiltro() {
    const f = filtros();
    const partes = [...f.estadoFinal].map((v) => v || "SIN ESTADO");
    if (f.guardia.size) partes.push(`GUARDIA ${[...f.guardia].map((g) => g || "SIN").join(" ")}`);
    if (f.cargo.size === 1) partes.push([...f.cargo][0]);
    else if (f.cargo.size > 1) partes.push(`${f.cargo.size} CARGOS`);
    if (f.cargoTexto.trim()) partes.push(f.cargoTexto.trim().toUpperCase());
    if (f.area.size === 1) partes.push(rotuloDe("area", [...f.area][0]));
    else if (f.area.size > 1) partes.push(`${f.area.size} AREAS`);
    if (f.riesgos.size) partes.push([...f.riesgos].join(" "));
    if (f.tipos.size) partes.push(`TIPO ${[...f.tipos].join(" ")}`);
    return partes.length ? ` ${partes.join(" ")}` : "";
  }

  const nombreArchivo = (base, ext) => `${limpiarNombre(`${base} ${hoyIso()}${sufijoFiltro()}`, 140)}.${ext}`;

  async function exportarExcel() {
    if (!lista.length) return;
    const nombre = nombreArchivo("VER RRCC", "xlsx");
    el.excel.disabled = true;
    try {
      descargarBlob(await armarXlsx(hojasDeVerRrcc(lista, { umbrales: umbrales() })), nombre);
      consola(`${lista.length} persona(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar el Excel: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      actualizarBotones();
    }
  }

  /**
   * El ZIP con el fotocheck (en alta, como el de Drive) de cada persona de la
   * lista que se esta viendo, y el Excel de vigencias como INDICE. Se congela
   * la lista al empezar: cambiar el filtro mientras se arma no la altera. Con
   * mas de MAX_FOTOCHECKS_POR_ZIP se baja en varios ZIP, uno tras otro.
   */
  async function descargarZip() {
    if (!lista.length || abortador) return;
    const objetivo = lista;
    const partes = partirEnTandas(objetivo);
    if (
      partes.length > 1 &&
      !window.confirm(
        `Son ${objetivo.length} fotochecks: se bajarán en ${partes.length} ZIP de hasta ` +
          `${MAX_FOTOCHECKS_POR_ZIP}, uno tras otro.\n\n` +
          `Si el navegador pregunta, permite que el sitio descargue varios archivos. ¿Continuar?`
      )
    ) {
      return;
    }

    const base = nombreArchivo("FOTOCHECKS RRCC", "zip").replace(/\.zip$/, "");
    const nombreDe = (k) => (partes.length > 1 ? `${base} (parte ${k + 1} de ${partes.length}).zip` : `${base}.zip`);

    abortador = new AbortController();
    const senal = abortador.signal;
    actualizarBotones();
    el.stop.hidden = false;
    barra.mostrar(true);
    barra.set(0, objetivo.length, "dibujando fotochecks…");
    consola.cabecera(`ZIP · ${objetivo.length} fotocheck(s)`);
    consola("cada fotocheck se dibuja en alta con la foto de la carpeta FOTOS", "info");

    const inicio = Date.now();
    const logoListo = await logo;
    let previas = 0;
    let archivos = 0;
    let sinFoto = 0;
    let fallidos = 0;
    let bajadas = 0;
    try {
      for (const [k, parte] of partes.entries()) {
        const etiqueta = partes.length > 1 ? `parte ${k + 1}/${partes.length} · ` : "";
        const r = await armarZipFotochecks(parte, {
          senal,
          umbrales: umbrales(),
          log: (texto, tipo) => consola(texto, tipo),
          generar: async (persona) => {
            const foto = await fotoDe(persona.dni);
            const img = await fotocheckImagen(paraFotocheck(persona), { foto, logo: logoListo });
            return { blob: img.blob, ext: FOTOCHECK.ext, conFoto: Boolean(foto) };
          },
          alAvanzar: ({ hechas: n }) => {
            const listas = previas + n;
            barra.set(
              listas,
              objetivo.length,
              `${etiqueta}${listas}/${objetivo.length} fotocheck(s) · ` +
                textoRestante(estimarRestante(inicio, listas, objetivo.length))
            );
          },
        });
        descargarBlob(r.blob, nombreDe(k));
        consola(`${r.archivos} fotocheck(s) en ${nombreDe(k)}`, "ok");
        previas += parte.length;
        archivos += r.archivos;
        sinFoto += r.sinFoto;
        fallidos += r.fallidos.length;
        bajadas++;
      }

      barra.set(1, 1, `${archivos} de ${objetivo.length} fotocheck(s) en ${bajadas} ZIP`);
      if (sinFoto) consola(`${sinFoto} fotocheck(s) salieron sin foto: no está en la carpeta FOTOS (ver INDICE.xlsx)`, "warn");
      if (fallidos) consola(`${fallidos} fotocheck(s) no se pudieron generar (ver INDICE.xlsx)`, "warn");
      notificar(
        "ZIP listo",
        `${archivos} de ${objetivo.length} fotocheck(s)` + (sinFoto ? ` · ${sinFoto} sin foto` : "")
      );
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

  /**
   * El ZIP con el certificado de cada RRCC marcado en "Riesgo critico" de las
   * personas de la lista: el mismo de EXPORTACION (busca en JOMISER, EIN y
   * Drive el certificado mas reciente de cada RRCC, todos sueltos y nombrados
   * DNI_RRCC_FECHA_NOMBRE.pdf, con un INDICE.xlsx de lo que falte). Se congela
   * la lista al empezar; con muchos certificados se baja en varios ZIP.
   */
  async function descargarCertificados() {
    if (abortador) return;
    const objetivo = certificadosAhora();
    const total = objetivo.reduce((n, x) => n + x.rrcc.length, 0);
    if (!total) return;
    const partes = partirEnZips(objetivo);
    if (
      partes.length > 1 &&
      !window.confirm(
        `Son ${objetivo.length} personas y ${total} certificados: se bajarán en ${partes.length} ZIP ` +
          `de hasta ${MAX_CERTIFICADOS_POR_ZIP} certificados, uno tras otro, y puede tardar bastante.\n\n` +
          `Si el navegador pregunta, permite que el sitio descargue varios archivos. ¿Continuar?`
      )
    ) {
      return;
    }

    const base = nombreArchivo("CERTIFICADOS RRCC", "zip").replace(/\.zip$/, "");
    const nombreDe = (k) => (partes.length > 1 ? `${base} (parte ${k + 1} de ${partes.length}).zip` : `${base}.zip`);

    abortador = new AbortController();
    const senal = abortador.signal;
    actualizarBotones();
    el.stop.hidden = false;
    barra.mostrar(true);
    barra.set(0, objetivo.length, "consultando certificados…");
    consola.cabecera(`CERTIFICADOS · ${objetivo.length} persona(s) · ${total} RRCC`);
    consola("se busca el certificado de cada uno en JOMISER, EIN y Drive", "info");

    const inicio = Date.now();
    let previas = 0;
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
      if (faltantes) consola(`${faltantes} sin certificado: el motivo de cada uno está en el INDICE.xlsx del ZIP`, "warn");
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
  /* Carga del personal (igual que EXPORTACION)                          */
  /* ------------------------------------------------------------------ */

  function adoptar(nuevas, nota = "") {
    personas = nuevas;
    podarMiniaturas(new Set(personas.map(firmaDe)));
    el.count.textContent = `${personas.length} persona(s)${nota ? ` (${nota})` : ""}`;
    el.recargar.hidden = personas.length === 0;
    pintarCuandoSeVea();
  }

  /** Con la pestana oculta no se arma la grilla: se pinta al mostrarse. */
  let pintadoPendiente = false;
  function pintarCuandoSeVea() {
    if ($("vista-ver-rrcc").hidden) {
      pintadoPendiente = true;
      return;
    }
    pintadoPendiente = false;
    pintar();
  }
  alMostrarse("vista-ver-rrcc", () => {
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
    if (refrescar) {
      // una foto recien subida a FOTOS tiene que verse
      fotos.clear();
      sinFotoConfirmado.clear();
      podarMiniaturas(new Set());
    }

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
        notificar("Personal cargado", `${personas.length} persona(s): ${lista.length} fotocheck(s) con el filtro actual.`);
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

  /* ------------------------------------------------------------------ */
  /* Eventos                                                             */
  /* ------------------------------------------------------------------ */

  // buscador y cargo esperan a que se deje de teclear: cada pintada rehace la grilla
  let esperaBuscar = null;
  const pintarAlTeclear = () => {
    clearTimeout(esperaBuscar);
    esperaBuscar = setTimeout(pintar, 180);
  };
  el.buscar.addEventListener("input", pintarAlTeclear);
  el.cargo.addEventListener("input", pintarAlTeclear);
  // con el campo vacio, Retroceso quita el ultimo cargo elegido
  el.cargo.addEventListener("keydown", (ev) => {
    if (ev.key !== "Backspace" || el.cargo.value || !cargosElegidos.size) return;
    cargosElegidos.delete([...cargosElegidos].pop());
    pintar();
  });
  el.cargosSel?.addEventListener("click", (ev) => {
    const etiqueta = ev.target.closest(".vr-tag");
    if (!etiqueta) return;
    cargosElegidos.delete(etiqueta.dataset.valor);
    pintar();
    el.cargo.focus();
  });

  for (const [campo, contenedor] of [
    ["estadoFinal", el.estadoFinal],
    ["guardia", el.guardia],
    ["tipos", el.tipos],
  ]) {
    contenedor?.addEventListener("click", (ev) => {
      const boton = ev.target.closest(".vr-chip");
      if (!boton) return;
      const valor = boton.dataset.valor;
      if (!elegidos[campo].delete(valor)) elegidos[campo].add(valor);
      pintar();
    });
  }
  selArea.alCambiar(pintar);
  selRiesgo.alCambiar(pintar);

  el.limpiar?.addEventListener("click", () => {
    el.buscar.value = "";
    el.cargo.value = "";
    cargosElegidos.clear();
    for (const campo of Object.keys(elegidos)) elegidos[campo] = new Set();
    selArea.limpiar();
    selRiesgo.limpiar();
    pintar();
  });

  movil.addEventListener?.("change", () => {
    if (!$("vista-ver-rrcc").hidden) pintarGrilla();
  });

  el.cargar.addEventListener("click", () => cargar());
  el.recargar.addEventListener("click", () => cargar({ refrescar: true }));
  el.excel.addEventListener("click", exportarExcel);
  el.zip.addEventListener("click", descargarZip);
  el.certs?.addEventListener("click", descargarCertificados);
  el.stop.addEventListener("click", () => abortador?.abort());

  // ya puede haber datos de otra pestana (o de la precarga del arranque)
  const yaHay = personalEnMemoria();
  if (yaHay) adoptar(yaHay, hace(edadPersonal()));
  pintarCuandoSeVea();

  return { recargar: () => cargar({ refrescar: true }), cargar };
}
