/**
 * Vista "ESTADO TOTAL": quienes ya perdieron alguna autorizacion de riesgo
 * critico y siguen activos — ESTADO_FINAL = VENCIDO y _EstaTE = ACTIVO en
 * `BD AESA` — con un dashboard de cuantos RRCC estan vencidos y cuantos por
 * vencer, y el detalle por persona en un flotante al hacer clic en su fila.
 *
 * Igual que ESTADO RRCC, es un reporte de lo guardado: no vuelve a consultar
 * JOMISER/EIN/Drive.
 */

import {
  $,
  crearConsola,
  notificar,
  escaparHtml,
  textoDias,
  conReintento,
  descargarBlob,
  hace,
  alMostrarse,
} from "./comun.js";
import {
  obtenerContexto,
  obtenerPersonal,
  personalEnMemoria,
  edadPersonal,
  alCambiar,
} from "../lib/datos.js";
import { armarXlsx } from "../lib/excel.js";
import { armarPdf, COLOR } from "../lib/pdf.js";
import { armarPngTabla, TINTA } from "../lib/imagen.js";
import { riesgosProblemaDe, aFormatoCorto, hoyIso } from "../../shared/estados.js";
import { porCodigo } from "../../shared/rrcc.js";

/**
 * Los vencidos de una persona van siempre repartidos en dos bloques: primero
 * las AUTORIZACIONES (tipo A, las que respalda un certificado y son las que
 * sacan a alguien de operacion) y despues las CAPACITACIONES (tipo C). Una
 * fila sin tipo no se descarta: se muestra aparte para que se vea que esta
 * mal puesta en la hoja.
 */
const TIPOS = [
  { tipo: "A", rotulo: "A · AUTORIZACIONES VENCIDAS" },
  { tipo: "C", rotulo: "C · CAPACITACIONES VENCIDAS" },
  { tipo: "", rotulo: "SIN TIPO EN LA HOJA" },
];

const TITULO_INFORME = "ESTADO TOTAL · RRCC VENCIDOS POR PERSONA";

const tipoDe = (riesgo) => (riesgo.tipo === "A" || riesgo.tipo === "C" ? riesgo.tipo : "");

/** Mismo codigo de color en la vista previa (CSS) y en el PDF. */
const COLOR_TIPO = { A: COLOR.rojo, C: COLOR.ambar, "": COLOR.gris };

/** El nombre largo del RRCC sale del catalogo: la hoja en vivo devuelve el codigo. */
const nombreRiesgo = (riesgo) => porCodigo(riesgo.codigo)?.nombre || riesgo.nombre || riesgo.codigo;

/** Vencidos agrupados por tipo, cada grupo de lo mas vencido a lo menos. */
function vencidosPorTipo(vencidos) {
  return TIPOS.map((t) => ({
    ...t,
    items: vencidos.filter((r) => tipoDe(r) === t.tipo).sort((a, b) => (a.venc < b.venc ? -1 : a.venc > b.venc ? 1 : 0)),
  })).filter((g) => g.items.length);
}

/**
 * Las mismas columnas de la tabla de pantalla, en el mismo orden. Los anchos
 * son pixeles y se reparten tal cual: el DNI y los contadores son de tamano
 * fijo, y lo que puede crecer (nombre, cargo) se lleva el resto.
 */
const COLUMNAS_IMAGEN = [
  { titulo: "DNI", ancho: 92, valor: (f) => f.persona.dni || "—" },
  { titulo: "Apellidos y nombres", ancho: 295, valor: (f) => (f.persona.nombreCompleto || "—").toUpperCase() },
  {
    titulo: "Cargo / Área",
    ancho: 340,
    valor: (f) => [f.persona.cargo, f.persona.area].filter(Boolean).join(" · ").toUpperCase() || "—",
  },
  { titulo: "Vencidos", ancho: 95, valor: (f) => f.vencidos.length, pastilla: () => TINTA.rojo },
  { titulo: "Por vencer", ancho: 105, valor: (f) => f.porVencer.length, pastilla: () => TINTA.ambar },
  {
    titulo: "Días",
    ancho: 200,
    valor: (f) => textoDias(Number(f.persona.dias)),
    // los que ya vencieron, en rojo: es lo primero que se busca en la imagen
    color: (f) => (Number(f.persona.dias) < 0 ? TINTA.rojo : TINTA.tinta),
  },
];

/**
 * Encabezados de la tabla de pantalla. Un clic en uno ordena por esa columna
 * (otro clic invierte); el boton de urgencia vuelve al orden por dias.
 */
const COLUMNAS_TABLA = [
  { campo: "dni", texto: "DNI", valor: (f) => f.persona.dni || "" },
  { campo: "nombre", texto: "Nombre", valor: (f) => (f.persona.nombreCompleto || "").toUpperCase() },
  {
    campo: "cargo",
    texto: "Cargo / Área",
    valor: (f) => [f.persona.cargo, f.persona.area].filter(Boolean).join(" · ").toUpperCase(),
  },
  { campo: "vencidos", texto: "Vencidos", valor: (f) => f.vencidos.length },
  { campo: "porVencer", texto: "Por vencer", valor: (f) => f.porVencer.length },
  { campo: "dias", texto: "Días", valor: (f) => Number(f.persona.dias) || 0 },
];

const COLUMNAS_DETALLE = [
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "AREA", ancho: 26 },
  { titulo: "TIPO", ancho: 7 },
  { titulo: "RRCC", ancho: 7 },
  { titulo: "RIESGO CRITICO", ancho: 32 },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha" },
  { titulo: "DIAS", ancho: 8, tipo: "numero" },
];

const COLUMNAS_RESUMEN = [
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34 },
  { titulo: "DNI", ancho: 12 },
  { titulo: "CARGO", ancho: 30 },
  { titulo: "AREA", ancho: 26 },
  { titulo: "AUTORIZACIONES (A)", ancho: 18, tipo: "numero" },
  { titulo: "RRCC TIPO A", ancho: 30 },
  { titulo: "CAPACITACIONES (C)", ancho: 18, tipo: "numero" },
  { titulo: "RRCC TIPO C", ancho: 30 },
  { titulo: "TOTAL VENCIDOS", ancho: 15, tipo: "numero" },
  { titulo: "POR VENCER", ancho: 12, tipo: "numero" },
];

export function montarEstadoTotal() {
  const consola = crearConsola("et-term", "et-log-clear");

  const el = {
    buscar: $("et-buscar"),
    orden: $("et-orden"),
    cargar: $("et-cargar"),
    previaModal: $("et-previa-modal"),
    previaCuerpo: $("et-previa-cuerpo"),
    previaCount: $("et-previa-count"),
    previaCerrar: $("et-previa-cerrar"),
    previaImprimir: $("et-previa-imprimir"),
    previaDescargar: $("et-previa-descargar"),
    pdf: $("et-pdf"),
    excel: $("et-excel"),
    count: $("et-count"),
    resCount: $("et-res-count"),
    dash: $("et-dash"),
    dashPersonas: $("et-dash-personas"),
    dashVencidos: $("et-dash-vencidos"),
    dashPorVencer: $("et-dash-porvencer"),
    resultados: $("et-resultados"),
    recargar: $("et-recargar"),
    imagen: $("et-imagen"),
  };

  let personas = [];
  let contexto = null;
  let descendente = false;
  let ordenColumna = null; // { campo, direccion } al hacer clic en un encabezado
  let cargando = false;
  let filas = []; // lo ultimo pintado, para abrir el flotante por indice

  function actualizarBotonOrden() {
    el.orden.textContent = descendente ? "MENOS URGENTE → MÁS" : "MÁS URGENTE → MENOS";
    el.orden.title = descendente
      ? "De lo que menos urge a lo mas vencido. Clic para invertir"
      : "De lo mas vencido a lo que menos urge. Clic para invertir";
    el.orden.setAttribute("aria-pressed", String(descendente));
  }
  actualizarBotonOrden();

  /* ------------------------------------------------------------------ */
  /* Flotante de detalle                                                 */
  /* ------------------------------------------------------------------ */

  let flotante = null;

  function cerrarFlotante() {
    flotante?.remove();
    flotante = null;
    document.removeEventListener("click", alClicFuera, true);
    document.removeEventListener("keydown", alEscape, true);
  }
  function alClicFuera(ev) {
    if (flotante && !flotante.contains(ev.target)) cerrarFlotante();
  }
  function alEscape(ev) {
    if (ev.key === "Escape") cerrarFlotante();
  }

  /**
   * En la hoja en vivo (Apps Script) `rotulo` viene igual al `codigo` (Code.gs
   * no tiene el catalogo completo): se muestra el nombre largo solo cuando de
   * verdad aporta algo distinto, y siempre con el tipo A/C a la vista — es lo
   * que el usuario pidio distinguir en el flotante.
   */
  function filaDeRiesgo(r) {
    const tipo = r.tipo === "A" || r.tipo === "C" ? r.tipo : "";
    const titulo = tipo === "A" ? "Autorizado" : tipo === "C" ? "Capacitado" : "sin tipo";
    const etiqueta = r.rotulo && r.rotulo !== r.codigo ? `${r.codigo} · ${r.rotulo}` : r.codigo;
    return (
      `<li><span>` +
      `<b class="et-tipo${tipo ? " et-tipo-" + tipo.toLowerCase() : ""}" title="${titulo}">${tipo || "?"}</b>` +
      `${escaparHtml(etiqueta)}</span>` +
      `<span>${aFormatoCorto(r.venc) || "—"} · ${textoDias(r.dias)}</span></li>`
    );
  }

  function contenidoFlotante({ persona, vencidos, porVencer }) {
    const grupo = (titulo, clase, items) =>
      items.length
        ? `<div class="et-flotante-grupo"><b class="${clase}">${titulo} (${items.length})</b><ul>${items
            .map(filaDeRiesgo)
            .join("")}</ul></div>`
        : "";
    return (
      `<div class="et-flotante-head">` +
      `<b>${escaparHtml(persona.nombreCompleto || persona.dni)}<span>${escaparHtml(persona.dni)}</span></b>` +
      `<button class="et-flotante-x" type="button" aria-label="Cerrar">×</button>` +
      `</div>` +
      grupo("VENCIDO", "et-vencido", vencidos) +
      grupo("POR VENCER", "et-actualizar", porVencer) +
      (!vencidos.length && !porVencer.length ? `<div class="estado-vacio">sin riesgos vencidos ni por vencer</div>` : "")
    );
  }

  function abrirFlotante(item, x, y) {
    cerrarFlotante();
    const div = document.createElement("div");
    div.className = "et-flotante";
    div.innerHTML = contenidoFlotante(item);
    document.body.appendChild(div);
    flotante = div;

    const margen = 10;
    const maxX = window.innerWidth - div.offsetWidth - margen;
    const maxY = window.innerHeight - div.offsetHeight - margen;
    div.style.left = `${Math.min(Math.max(margen, x), Math.max(margen, maxX))}px`;
    div.style.top = `${Math.min(Math.max(margen, y), Math.max(margen, maxY))}px`;

    div.querySelector(".et-flotante-x")?.addEventListener("click", cerrarFlotante);
    // se registra en el siguiente turno: el clic que abrio el flotante no debe cerrarlo de una
    setTimeout(() => {
      document.addEventListener("click", alClicFuera, true);
      document.addEventListener("keydown", alEscape, true);
    }, 0);
  }

  /** Clic en un encabezado: ordena por esa columna; otro clic en la misma la
      invierte. Los contadores empiezan de mayor a menor (lo que mas interesa). */
  function ordenarPorEncabezado(th) {
    const campo = th.dataset.campo;
    const inicial = campo === "vencidos" || campo === "porVencer" ? -1 : 1;
    const direccion = ordenColumna?.campo === campo ? -ordenColumna.direccion : inicial;
    ordenColumna = { campo, direccion };
    pintar();
    el.resultados.querySelector(`th[data-campo="${campo}"]`)?.focus();
  }

  function alClicEnFila(ev) {
    const th = ev.target.closest("th[data-campo]");
    if (th) return ordenarPorEncabezado(th);
    const fila = ev.target.closest(".et-fila");
    if (!fila) return;
    const item = filas[Number(fila.dataset.indice)];
    if (item) abrirFlotante(item, ev.clientX + 12, ev.clientY + 12);
  }
  function alTecladoEnFila(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const th = ev.target.closest("th[data-campo]");
    if (th) {
      ev.preventDefault();
      return ordenarPorEncabezado(th);
    }
    const fila = ev.target.closest(".et-fila");
    if (!fila) return;
    ev.preventDefault();
    const item = filas[Number(fila.dataset.indice)];
    if (!item) return;
    const r = fila.getBoundingClientRect();
    abrirFlotante(item, r.left + 12, r.bottom + 6);
  }

  /* ------------------------------------------------------------------ */
  /* Informe (vista previa de lo que se imprime y se exporta)            */
  /* ------------------------------------------------------------------ */

  const CLASE_TIPO = { A: "et-inf-a", C: "et-inf-c", "": "et-inf-x" };

  /**
   * El informe que se ve en pantalla es EL MISMO que sale por la impresora y
   * el que se vuelca al PDF: misma gente, mismo orden (por apellidos) y mismos
   * grupos A/C. Asi no hace falta imprimir para saber que va a salir.
   */
  function informeHtml(lista) {
    return lista
      .map(({ persona, vencidos, porVencer }, i) => {
        const grupos = vencidosPorTipo(vencidos)
          .map(
            (g) =>
              `<div class="et-inf-grupo ${CLASE_TIPO[g.tipo] || "et-inf-x"}">` +
              `<b>${g.rotulo} (${g.items.length})</b>` +
              `<table><tbody>` +
              g.items
                .map(
                  (r) =>
                    `<tr><td class="et-inf-cod">${escaparHtml(r.codigo)}</td>` +
                    `<td>${escaparHtml(nombreRiesgo(r))}</td>` +
                    `<td class="et-inf-fecha">${aFormatoCorto(r.venc) || "—"}</td>` +
                    `<td class="et-inf-dias">${escaparHtml(textoDias(r.dias))}</td></tr>`
                )
                .join("") +
              `</tbody></table></div>`
          )
          .join("");

        return (
          `<article class="et-inf-persona">` +
          `<header><b><span class="et-inf-n">${i + 1}.</span>${escaparHtml(persona.nombreCompleto) || "—"}</b>` +
          `<span>DNI ${escaparHtml(persona.dni) || "—"}</span></header>` +
          `<div class="et-inf-sub">${escaparHtml(cargoArea(persona)) || "sin cargo ni área"} · ` +
          `${vencidos.length} vencido(s) · ${porVencer.length} por vencer</div>` +
          (grupos || `<div class="et-inf-vacio">sin RRCC vencidos</div>`) +
          `</article>`
        );
      })
      .join("");
  }

  /**
   * El informe no entra en la vista (ahi manda la tabla resumen): se enseña en
   * un flotante antes de bajar el PDF, para no tener que abrir el archivo solo
   * para comprobar que sale lo que se espera. Desde ahi se descarga o se
   * imprime, y lo impreso es exactamente esto.
   */
  function abrirPrevia() {
    const lista = porApellidos();
    if (!lista.length) return;
    // el encabezado solo se ve al imprimir (en pantalla ya esta el del
    // flotante), y dice lo mismo que la cabecera del PDF
    el.previaCuerpo.innerHTML =
      `<div class="et-inf-cabecera"><b>${TITULO_INFORME}</b>` +
      `<span>${escaparHtml(subtituloInforme(lista))}</span></div>` +
      informeHtml(lista);
    el.previaCount.textContent = `${lista.length} persona(s) · ordenado por apellidos`;
    el.previaModal.hidden = false;
    el.previaCuerpo.scrollTop = 0;
    document.addEventListener("keydown", alEscapePrevia, true);
  }

  function cerrarPrevia() {
    el.previaModal.hidden = true;
    el.previaCuerpo.innerHTML = "";
    document.removeEventListener("keydown", alEscapePrevia, true);
  }

  function alEscapePrevia(ev) {
    if (ev.key === "Escape") cerrarPrevia();
  }

  /* ------------------------------------------------------------------ */
  /* Tabla + dashboard                                                   */
  /* ------------------------------------------------------------------ */

  function filaHtml({ persona, vencidos, porVencer }, indice) {
    return (
      `<tr class="et-fila" data-indice="${indice}" tabindex="0">` +
      `<td>${escaparHtml(persona.dni)}</td>` +
      `<td>${escaparHtml(persona.nombreCompleto) || "—"}</td>` +
      `<td>${escaparHtml([persona.cargo, persona.area].filter(Boolean).join(" · ")) || "—"}</td>` +
      `<td><span class="et-badge et-vencido">${vencidos.length}</span></td>` +
      `<td><span class="et-badge et-actualizar">${porVencer.length}</span></td>` +
      `<td>${textoDias(Number(persona.dias))}</td>` +
      `</tr>`
    );
  }

  function pintar() {
    cerrarFlotante();
    if (!el.previaModal.hidden) cerrarPrevia(); // lo que se veia ya no coincide con el filtro
    const textoFiltro = el.buscar.value.trim().toUpperCase();
    const normalizar = (valor) => String(valor ?? "").trim().toUpperCase();
    const umbrales = {
      vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? 365),
      actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? 330),
    };

    filas = personas
      .filter((p) => normalizar(p.estadoFinal) === "VENCIDO" && normalizar(p.estadoTrabajador) === "ACTIVO")
      .filter(
        (p) =>
          !textoFiltro ||
          [p.nombreCompleto, p.dni, p.area, p.cargo].some((v) => String(v || "").toUpperCase().includes(textoFiltro))
      )
      .map((persona) => ({ persona, ...riesgosProblemaDe(persona, { umbrales }) }));

    const porDias = (a, b) => {
      const da = Number(a.persona.dias) || 0;
      const db = Number(b.persona.dias) || 0;
      return descendente ? db - da : da - db;
    };
    const clave = ordenColumna && COLUMNAS_TABLA.find((c) => c.campo === ordenColumna.campo)?.valor;
    filas.sort(
      clave
        ? (a, b) => {
            const va = clave(a);
            const vb = clave(b);
            const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb), "es");
            // a igualdad, desempata la urgencia
            return cmp * ordenColumna.direccion || porDias(a, b);
          }
        : porDias
    );

    const vacio = `<div class="estado-vacio">${
      personas.length ? "nadie coincide con el filtro" : "carga el personal para ver el estado total"
    }</div>`;

    const encabezado = COLUMNAS_TABLA.map(({ campo, texto }) => {
      const activo = ordenColumna?.campo === campo;
      const flecha = activo ? (ordenColumna.direccion === 1 ? " ▲" : " ▼") : "";
      return (
        `<th data-campo="${campo}" tabindex="0" role="button" aria-label="Ordenar por ${texto}"` +
        `${activo ? ' class="es-th-activo"' : ""}>${texto}${flecha}</th>`
      );
    }).join("");

    el.resultados.innerHTML = !filas.length
      ? vacio
      : `<table class="estado-tabla et-tabla"><thead><tr>${encabezado}</tr></thead>` +
        `<tbody>${filas.map(filaHtml).join("")}</tbody></table>`;

    const totalVencidos = filas.reduce((n, f) => n + f.vencidos.length, 0);
    const totalPorVencer = filas.reduce((n, f) => n + f.porVencer.length, 0);
    el.dash.hidden = !personas.length;
    el.dashPersonas.textContent = String(filas.length);
    el.dashVencidos.textContent = String(totalVencidos);
    el.dashPorVencer.textContent = String(totalPorVencer);

    el.resCount.textContent = personas.length ? `${filas.length} persona(s) vencida(s)` : "";
    el.pdf.disabled = filas.length === 0;
    el.excel.disabled = filas.length === 0;
    el.imagen.disabled = filas.length === 0;
  }

  /* ------------------------------------------------------------------ */
  /* Exportacion (PDF y Excel)                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Lo mismo que se ve en pantalla (mismos filtros), pero ordenado por
   * apellidos: en pantalla manda la urgencia, y para repartir el informe
   * manda el orden alfabetico.
   */
  const porApellidos = () =>
    [...filas].sort((a, b) =>
      String(a.persona.nombreCompleto || a.persona.dni || "").localeCompare(
        String(b.persona.nombreCompleto || b.persona.dni || ""),
        "es"
      )
    );

  const cargoArea = (p) => [p.cargo, p.area].filter(Boolean).join(" · ");

  /** Texto del encabezado del informe, con el filtro puesto si lo hay. */
  function subtituloInforme(lista) {
    const filtro = el.buscar.value.trim();
    return (
      `${lista.length} persona(s) activa(s) con al menos un RRCC vencido · ` +
      `ordenado por apellidos · ${aFormatoCorto(hoyIso())}` +
      (filtro ? ` · filtro: ${filtro.toUpperCase()}` : "")
    );
  }

  async function exportarPdf() {
    const lista = porApellidos();
    if (!lista.length) return;

    const bloques = lista.map(({ persona, vencidos, porVencer }, i) => {
      const partes = [
        {
          tipo: "cabecera",
          indice: i + 1,
          texto: persona.nombreCompleto || "—",
          derecha: `DNI ${persona.dni || "—"}`,
        },
        {
          tipo: "nota",
          texto:
            (cargoArea(persona) || "sin cargo ni área") +
            ` · ${vencidos.length} vencido(s) · ${porVencer.length} por vencer`,
        },
      ];
      for (const grupo of vencidosPorTipo(vencidos)) {
        partes.push({
          tipo: "grupo",
          texto: `${grupo.rotulo} (${grupo.items.length})`,
          color: COLOR_TIPO[grupo.tipo] || COLOR.gris,
        });
        // fondo alterno: con ocho o diez vencimientos seguidos, la vista se
        // pierde de columna a columna sin una guia
        grupo.items.forEach((r, n) => {
          partes.push({
            tipo: "item",
            fondo: n % 2 === 1,
            cols: [
              { texto: r.codigo, x: 18, ancho: 34, negrita: true },
              { texto: nombreRiesgo(r), x: 56, ancho: 230 },
              { texto: aFormatoCorto(r.venc) || "—", x: 292, ancho: 72 },
              { texto: textoDias(r.dias), x: 370, ancho: 145, color: COLOR.gris },
            ],
          });
        });
      }
      if (!vencidos.length) partes.push({ tipo: "nota", texto: "sin RRCC vencidos" });
      partes.push({ tipo: "espacio", alto: 6 });
      return partes;
    });

    const nombre = `ESTADO TOTAL ${hoyIso()}.pdf`;
    el.pdf.disabled = true;
    try {
      descargarBlob(
        await armarPdf({
          titulo: TITULO_INFORME,
          subtitulo: subtituloInforme(lista),
          bloques,
        }),
        nombre
      );
      consola(`${lista.length} persona(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar el PDF: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      el.pdf.disabled = filas.length === 0;
    }
  }

  async function exportarExcel() {
    const lista = porApellidos();
    if (!lista.length) return;

    // una fila por RRCC vencido, con el tipo delante para poder agrupar en Excel
    const detalle = lista.flatMap(({ persona, vencidos }) =>
      vencidosPorTipo(vencidos).flatMap((grupo) =>
        grupo.items.map((r) => [
          persona.nombreCompleto || "",
          persona.dni || "",
          (persona.cargo || "").toUpperCase(),
          (persona.area || "").toUpperCase(),
          grupo.tipo || "?",
          r.codigo,
          nombreRiesgo(r),
          r.venc || "",
          r.dias === null ? "" : r.dias,
        ])
      )
    );

    // y una fila por persona, con sus RRCC vencidos ya separados en A y C
    const codigos = (vencidos, tipo) =>
      vencidos.filter((r) => tipoDe(r) === tipo).map((r) => r.codigo).join(", ");
    const resumen = lista.map(({ persona, vencidos, porVencer }) => [
      persona.nombreCompleto || "",
      persona.dni || "",
      (persona.cargo || "").toUpperCase(),
      (persona.area || "").toUpperCase(),
      vencidos.filter((r) => tipoDe(r) === "A").length,
      codigos(vencidos, "A"),
      vencidos.filter((r) => tipoDe(r) === "C").length,
      codigos(vencidos, "C"),
      vencidos.length,
      porVencer.length,
    ]);

    const nombre = `ESTADO TOTAL ${hoyIso()}.xlsx`;
    el.excel.disabled = true;
    try {
      descargarBlob(
        await armarXlsx([
          { nombre: "VENCIDOS POR PERSONA", columnas: COLUMNAS_DETALLE, filas: detalle },
          { nombre: "RESUMEN", columnas: COLUMNAS_RESUMEN, filas: resumen },
        ]),
        nombre
      );
      consola(`${lista.length} persona(s) y ${detalle.length} vencimiento(s) exportados a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar el Excel: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      el.excel.disabled = filas.length === 0;
    }
  }

  /** Deja la vista mostrando `lista` sin pedirle nada a la hoja: por aca entra
      lo que ya cargo otra pestana y los parches de cada guardado. */
  function adoptar(lista, nota = "") {
    personas = lista;
    el.count.textContent = `${personas.length} persona(s)${nota ? ` (${nota})` : ""}`;
    el.recargar.hidden = personas.length === 0;
    pintarCuandoSeVea();
  }

  /** La precarga del arranque puede traer datos con esta pestana sin abrir:
      armar la tabla entonces es trabajo tirado, asi que se deja apuntado y se
      pinta al mostrarse. */
  let pintadoPendiente = false;
  function pintarCuandoSeVea() {
    if ($("vista-estado-total").hidden) {
      pintadoPendiente = true;
      return;
    }
    pintadoPendiente = false;
    pintar();
  }
  alMostrarse("vista-estado-total", () => {
    if (!pintadoPendiente) return;
    pintadoPendiente = false;
    pintar();
  });

  /**
   * Trae al personal vencido y activo.
   *
   * Si ESTADO RRCC (u otra pestana) ya bajo el listado completo, el filtro sale
   * de ahi sin tocar la red; si no, se lo pide al backend ya filtrado, que es
   * lo que evita bajar 1.5 MB para mostrar unas pocas decenas de personas.
   */
  /**
   * La tabla entera como PNG sobre fondo claro.
   *
   * Sale lo mismo que se esta viendo (mismo filtro, mismo orden) pero con
   * TODAS las filas, no solo las que caben en el scroll, para poder pegarla en
   * un mensaje sin adjuntar un archivo que haya que abrir.
   */
  async function exportarImagen() {
    if (!filas.length) return;
    const nombre = `ESTADO TOTAL ${hoyIso()}.png`;
    el.imagen.disabled = true;
    try {
      const filtro = el.buscar.value.trim();
      const png = await armarPngTabla({
        titulo: TITULO_INFORME,
        subtitulo:
          `${filas.length} persona(s) con ESTADO_FINAL = VENCIDO y activas · al ${aFormatoCorto(hoyIso())}` +
          (filtro ? ` · filtro "${filtro}"` : ""),
        tarjetas: [
          { numero: filas.length, rotulo: "personas vencidas" },
          { numero: filas.reduce((n, f) => n + f.vencidos.length, 0), rotulo: "RRCC vencidos", color: TINTA.rojo },
          { numero: filas.reduce((n, f) => n + f.porVencer.length, 0), rotulo: "RRCC por vencer", color: TINTA.ambar },
        ],
        columnas: COLUMNAS_IMAGEN,
        filas,
        pie: `AESA · U.M. Cerro Lindo · generado desde BD AESA el ${aFormatoCorto(hoyIso())}`,
      });
      descargarBlob(png, nombre);
      consola(`${filas.length} persona(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo generar la imagen: ${e.message}`, "err");
      notificar("No se pudo generar la imagen", e.message, "warn");
    } finally {
      el.imagen.disabled = filas.length === 0;
    }
  }

  async function cargar({ refrescar = false } = {}) {
    if (cargando) return;
    cargando = true;
    el.cargar.disabled = true;
    consola.limpiar();
    consola.cabecera(refrescar ? "RECARGANDO PERSONAL" : "CARGANDO PERSONAL");

    if (!refrescar) {
      const compartido = personalEnMemoria("vencidos_activos");
      if (compartido) {
        adoptar(compartido, hace(edadPersonal()));
        consola(`${compartido.length} persona(s) ya cargadas ${hace(edadPersonal())}; usa "recargar" para traerlas de nuevo`, "ok");
      }
    }

    try {
      const [ctx, lista] = await conReintento(
        () =>
          Promise.all([
            obtenerContexto({ refrescar }),
            obtenerPersonal({ filtro: "vencidos_activos", refrescar }),
          ]),
        consola
      );
      contexto = ctx;
      const deLaHoja = lista !== personas;
      adoptar(lista);
      if (deLaHoja) {
        consola(`${personas.length} persona(s) leída(s) (filtrado en el backend cuando esta disponible)`, "ok");
        notificar("Personal cargado", `${personas.length} persona(s) listas para el estado total.`);
      }
    } catch (e) {
      consola(`no se pudo cargar: ${e.message}`, "err");
      notificar("No se pudo cargar", e.message, "warn");
    } finally {
      cargando = false;
      el.cargar.disabled = false;
    }
  }

  /**
   * Lo que cargue o guarde otra pestana llega por aca y se pinta solo.
   *
   * Aqui se acepta cualquier listado, completo o filtrado: esta vista vuelve a
   * filtrar por vencido+activo al pintar, asi que un listado ya filtrado no le
   * hace dano.
   */
  alCambiar((ev) => {
    if (ev.tipo !== "personal" || ev.personas === personas || cargando) return;
    adoptar(ev.personas, ev.origen === "escritura" ? "actualizado" : hace(edadPersonal()));
    consola(
      ev.origen === "escritura"
        ? "una fila se guardó en otra pestaña: informe actualizado"
        : `${ev.personas.length} persona(s) ya disponibles: la base se cargó una vez para toda la app`,
      "info"
    );
  });

  el.cargar.addEventListener("click", () => cargar());
  el.recargar.addEventListener("click", () => cargar({ refrescar: true }));
  // el PDF pasa siempre por la vista previa: primero se ve, luego se baja
  el.pdf.addEventListener("click", abrirPrevia);
  el.previaCerrar.addEventListener("click", cerrarPrevia);
  el.previaModal.addEventListener("click", (ev) => {
    if (ev.target === el.previaModal) cerrarPrevia(); // clic fuera de la caja
  });
  el.previaImprimir.addEventListener("click", () => window.print());
  el.previaDescargar.addEventListener("click", async () => {
    await exportarPdf();
    cerrarPrevia();
  });
  el.excel.addEventListener("click", exportarExcel);
  el.imagen.addEventListener("click", exportarImagen);
  el.buscar.addEventListener("input", pintar);
  el.orden.addEventListener("click", () => {
    descendente = !descendente;
    ordenColumna = null; // el orden por urgencia vuelve a mandar
    actualizarBotonOrden();
    pintar();
  });
  el.resultados.addEventListener("click", alClicEnFila);
  el.resultados.addEventListener("keydown", alTecladoEnFila);

  // Al montarse ya puede haber datos de otra pestana: se pintan sin esperar a
  // que alguien pulse CARGAR PERSONAL.
  const yaHay = personalEnMemoria("vencidos_activos");
  if (yaHay) adoptar(yaHay, hace(edadPersonal()));

  pintarCuandoSeVea();

  return { recargar: () => cargar({ refrescar: true }), cargar };
}
