/**
 * Vista "ESTADO RRCC": vencimientos de todo el personal agrupados por riesgo
 * critico, ordenados de vencido a por vencer (o al reves) y listos para
 * imprimir.
 *
 * A diferencia de RENOVACION (que consulta persona por persona contra
 * JOMISER/EIN/Drive), esta vista solo lee lo que ya esta en `BD AESA`: es un
 * reporte de lo guardado, no vuelve a verificar certificados.
 */

import {
  $,
  crearConsola,
  crearMultiSelect,
  notificar,
  escaparHtml,
  conReintento,
  descargarBlob,
  hace,
  alMostrarse,
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
import { personasPorRiesgo, agruparPorGuardia, guardiaDe, aFormatoCorto, aIso, hoyIso } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";

const CLASE_ESTADO = {
  VIGENTE: "et-vigente",
  ACTUALIZAR: "et-actualizar",
  VENCIDO: "et-vencido",
  "NO APLICA": "et-noaplica",
};

/** Orden de urgencia al ordenar por la columna Estado: igual criterio que VENCIDO -> POR VENCER. */
const RANGO_ESTADO = { VENCIDO: 0, ACTUALIZAR: 1, VIGENTE: 2, "NO APLICA": 3 };

const COLUMNAS = [
  { campo: "dni", texto: "DNI", valor: (it) => it.persona.dni || "" },
  { campo: "cargo", texto: "Cargo", valor: (it) => (it.persona.cargo || "").toUpperCase() },
  { campo: "area", texto: "Área", valor: (it) => (it.persona.area || "").toUpperCase() },
  { campo: "nombre", texto: "Apellidos y Nombres", valor: (it) => (it.persona.nombreCompleto || "").toUpperCase() },
  { campo: "estado", texto: "Estado", valor: (it) => RANGO_ESTADO[it.estado] ?? 99 },
  { campo: "fecha", texto: "F. Vencimiento", valor: (it) => it.riesgo.venc || "" },
];

/**
 * Columnas del Excel exportado: las cinco que se ven en pantalla mas el RRCC
 * y la guardia (impresos son el titulo de cada tabla y de cada sub-bloque,
 * pero en una hoja plana tienen que ir en cada fila para poder filtrar) y los
 * dias que faltan, que ya estan calculados y son lo primero por lo que se
 * suele ordenar.
 */
const COLUMNAS_EXCEL = [
  { titulo: "RRCC", ancho: 7, valor: (it, g) => g.codigo },
  { titulo: "RIESGO CRITICO", ancho: 32, valor: (it, g) => g.nombre },
  { titulo: "GUARDIA", ancho: 10, valor: (it) => guardiaDe(it.persona) },
  { titulo: "DNI", ancho: 12, valor: (it) => it.persona.dni || "" },
  { titulo: "CARGO", ancho: 30, valor: (it) => (it.persona.cargo || "").toUpperCase() },
  { titulo: "APELLIDOS Y NOMBRES", ancho: 34, valor: (it) => (it.persona.nombreCompleto || "").toUpperCase() },
  { titulo: "ESTADO", ancho: 13, valor: (it) => it.estado },
  { titulo: "F. VENCIMIENTO", ancho: 16, tipo: "fecha", valor: (it) => it.riesgo.venc || "" },
  { titulo: "DIAS", ancho: 8, tipo: "numero", valor: (it) => (it.dias === null ? "" : it.dias) },
  { titulo: "AREA", ancho: 26, valor: (it) => (it.persona.area || "").toUpperCase() },
];

export function montarEstado() {
  const consola = crearConsola("es-term", "es-log-clear");

  const el = {
    buscar: $("es-buscar"),
    hasta: $("es-hasta"),
    hastaBorrar: $("es-hasta-borrar"),
    orden: $("es-orden"),
    cargar: $("es-cargar"),
    imprimir: $("es-imprimir"),
    excel: $("es-excel"),
    count: $("es-count"),
    resCount: $("es-res-count"),
    resultados: $("es-resultados"),
    resumenRiesgo: $("es-resumen-riesgo"),
    recargar: $("es-recargar"),
  };

  let personas = [];
  let contexto = null;
  let configSnapshot = null; // config del ultimo snapshot, solo hasta que llegue el contexto real
  let descendente = false;
  let cargando = false;
  let visible = { grupos: [], vencHasta: "" }; // lo ultimo pintado, que es lo que se imprime y se exporta
  const ordenPorGrupo = new Map(); // codigo RRCC -> { campo, direccion }, al hacer clic en un encabezado

  const selRiesgo = crearMultiSelect(
    "es-riesgo",
    RRCC.map((r) => ({ valor: r.codigo, etiqueta: `${r.codigo} · ${r.rotulo}` })),
    { textoTodos: "TODOS LOS RRCC", resumen: (op) => op.valor }
  );
  const selEstado = crearMultiSelect(
    "es-estado",
    ["VENCIDO", "ACTUALIZAR", "VIGENTE", "NO APLICA"].map((e) => ({ valor: e, etiqueta: e })),
    { textoTodos: "TODOS LOS ESTADOS" }
  );

  function actualizarBotonOrden() {
    el.orden.textContent = descendente ? "VIGENTE → VENCIDO" : "VENCIDO → POR VENCER";
    el.orden.title = descendente
      ? "De lo que menos urge a lo mas vencido. Clic para invertir"
      : "De lo mas vencido a lo que menos urge. Clic para invertir";
    el.orden.setAttribute("aria-pressed", String(descendente));
  }
  actualizarBotonOrden();

  /** Orden manual de este grupo (clic en un encabezado), o el orden natural
      que ya trae (vencido -> por vencer / al reves) si no se toco ninguno. */
  function itemsDelGrupo(grupo) {
    const orden = ordenPorGrupo.get(grupo.codigo);
    if (!orden) return grupo.items;
    const clave = COLUMNAS.find((c) => c.campo === orden.campo)?.valor;
    if (!clave) return grupo.items;
    return [...grupo.items].sort((a, b) => {
      const va = clave(a);
      const vb = clave(b);
      const cmp = va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * orden.direccion;
    });
  }

  function htmlDeGrupo(grupo, vencHasta) {
    const orden = ordenPorGrupo.get(grupo.codigo);
    const filaHtml = ({ persona, riesgo, estado }) => {
      const clase = CLASE_ESTADO[estado] || "et-noaplica";
      return (
        `<tr class="${clase}">` +
        `<td>${escaparHtml(persona.dni)}</td>` +
        `<td>${escaparHtml(persona.cargo) || "—"}</td>` +
        `<td>${escaparHtml(persona.area) || "—"}</td>` +
        `<td>${escaparHtml(persona.nombreCompleto)}</td>` +
        `<td><span class="et-badge ${clase}">${estado}</span></td>` +
        `<td>${aFormatoCorto(riesgo.venc) || "—"}</td>` +
        `</tr>`
      );
    };
    // Dentro del curso, un sub-bloque por guardia (A, B, C, S/G y al final
    // quien no la tiene en la hoja), cada uno con su titulo y su cuenta. Es
    // un <tbody> por guardia: la tabla sigue siendo una sola, asi que las
    // columnas no cambian de ancho entre guardias y el <thead> con el titulo
    // del curso se sigue repitiendo en cada hoja impresa.
    const cuerpos = agruparPorGuardia(itemsDelGrupo(grupo))
      .map(
        (sub) =>
          `<tbody class="estado-guardia">` +
          `<tr class="estado-guardia-titulo"><th colspan="${COLUMNAS.length}">${escaparHtml(sub.rotulo)}<span>${sub.items.length}</span></th></tr>` +
          sub.items.map(filaHtml).join("") +
          `</tbody>`
      )
      .join("");

    // Los <th> del encabezado ordenan al hacer clic (delegado en el
    // contenedor, ver alClicEncabezado). La primera fila de <thead> repite
    // el titulo del grupo en cada hoja al imprimir/exportar a PDF (por eso
    // va DENTRO de <thead>, no como un div aparte: eso no se repite al
    // cortar una tabla larga entre paginas); en pantalla queda oculta,
    // porque para eso ya esta el titulo de arriba (.estado-grupo-head).
    const encabezado = COLUMNAS.map(({ campo, texto }) => {
      const activo = orden?.campo === campo;
      const flecha = activo ? (orden.direccion === 1 ? " ▲" : " ▼") : "";
      return (
        `<th data-campo="${campo}" tabindex="0" role="button" aria-label="Ordenar por ${texto}"` +
        `${activo ? ' class="es-th-activo"' : ""}>${texto}${flecha}</th>`
      );
    }).join("");

    // El ancho de columna se fija con <colgroup> (no con el width de cada
    // <th>): la fila de titulo de arriba tiene un solo <th colspan> y, sin
    // colgroup, un motor de tablas puede tomar ESA fila como referencia para
    // repartir columnas en table-layout:fixed y arruinar el ancho de las demas.
    // El corte por fecha va en el titulo que se imprime: en pantalla se ve en
    // el contador de arriba, pero la hoja impresa tiene que decir por si sola
    // hasta que fecha esta recortada la lista.
    const corte = vencHasta ? ` · VENCEN HASTA ${aFormatoCorto(vencHasta)}` : "";

    return (
      `<section class="estado-grupo">` +
      `<div class="estado-grupo-head"><b>${grupo.codigo} · ${escaparHtml(grupo.nombre)}</b><span>${grupo.items.length}</span></div>` +
      `<table class="estado-tabla" data-codigo="${grupo.codigo}">` +
      `<colgroup><col class="ec-dni" /><col class="ec-cargo" /><col class="ec-area" /><col class="ec-nombre" /><col class="ec-estado" /><col class="ec-fecha" /></colgroup>` +
      `<thead>` +
      `<tr class="estado-tabla-titulo"><th colspan="${COLUMNAS.length}">${grupo.codigo} · ${escaparHtml(grupo.nombre)} (${grupo.items.length})${corte}</th></tr>` +
      `<tr>${encabezado}</tr>` +
      `</thead>${cuerpos}</table>` +
      `</section>`
    );
  }

  function pintar() {
    const textoFiltro = el.buscar.value.trim().toUpperCase();
    const riesgosFiltro = selRiesgo.obtener();
    const estadosFiltro = selEstado.obtener();
    // Corte por fecha de vencimiento: deja solo lo que vence hasta ese dia
    // (incluido), es decir lo que hay que renovar de aqui a esa fecha.
    const vencHasta = aIso(el.hasta.value);
    const umbrales = {
      vencido: Number(contexto?.config?.UMBRAL_VENCIDO ?? configSnapshot?.UMBRAL_VENCIDO ?? 365),
      actualizar: Number(contexto?.config?.UMBRAL_ACTUALIZAR ?? configSnapshot?.UMBRAL_ACTUALIZAR ?? 330),
    };

    // Todos los RRCC con el filtro de estado/activo/texto ya aplicado, ANTES
    // de recortar por "riesgo critico": de aca sale tanto el resumen de la
    // izquierda (cuenta por RRCC, los 18) como las tablas de la derecha
    // (solo los RRCC elegidos, y sin las que quedan en 0).
    const gruposFiltrados = personasPorRiesgo(personas, { descendente, umbrales }).map((g) => ({
      ...g,
      items: g.items
        .filter((it) => (it.persona.estadoTrabajador || "").toUpperCase() === "ACTIVO")
        .filter((it) => estadosFiltro.size === 0 || estadosFiltro.has(it.estado))
        .filter((it) => !vencHasta || (it.riesgo.venc && it.riesgo.venc <= vencHasta))
        .filter(
          (it) =>
            !textoFiltro ||
            [it.persona.nombreCompleto, it.persona.dni, it.persona.area, it.persona.cargo].some((v) =>
              String(v || "").toUpperCase().includes(textoFiltro)
            )
        ),
    }));

    el.resumenRiesgo.innerHTML = personas.length
      ? [...gruposFiltrados]
          .sort((a, b) => b.items.length - a.items.length)
          .map((g) => `<div class="resumen-riesgo-fila"><b>${g.codigo}</b><span>${escaparHtml(g.rotulo)}</span><em>${g.items.length}</em></div>`)
          .join("")
      : "";

    const grupos = gruposFiltrados
      .filter((g) => riesgosFiltro.size === 0 || riesgosFiltro.has(g.codigo))
      .filter((g) => g.items.length);

    const vacio = !personas.length
      ? "carga el personal para ver sus vencimientos"
      : vencHasta
        ? `ningún RRCC vence hasta el ${aFormatoCorto(vencHasta)} con este filtro`
        : "nada coincide con el filtro";

    el.resultados.innerHTML = grupos.length
      ? grupos.map((g) => htmlDeGrupo(g, vencHasta)).join("")
      : `<div class="estado-vacio">${vacio}</div>`;

    visible = { grupos, vencHasta };

    const totalItems = grupos.reduce((n, g) => n + g.items.length, 0);
    el.resCount.textContent = personas.length
      ? `${totalItems} vencimiento(s) · ${grupos.length} RRCC` + (vencHasta ? ` · hasta ${aFormatoCorto(vencHasta)}` : "")
      : "";
    el.imprimir.disabled = totalItems === 0;
    el.excel.disabled = totalItems === 0;
  }

  /**
   * Exporta a .xlsx lo mismo que saldria por la impresora: los grupos que
   * estan a la vista, en su orden (por guardia dentro de cada RRCC), con los
   * filtros ya aplicados. Va todo a UNA hoja (con las columnas RRCC y
   * GUARDIA) en vez de una hoja por riesgo: asi se puede filtrar, ordenar y
   * hacer tablas dinamicas sobre el conjunto.
   */
  async function exportar() {
    const filas = visible.grupos.flatMap((g) =>
      agruparPorGuardia(itemsDelGrupo(g)).flatMap((sub) => sub.items.map((it) => COLUMNAS_EXCEL.map((c) => c.valor(it, g))))
    );
    if (!filas.length) return;

    const corte = visible.vencHasta ? ` hasta ${visible.vencHasta}` : "";
    const nombre = `ESTADO RRCC ${hoyIso()}${corte}.xlsx`;

    el.excel.disabled = true;
    try {
      descargarBlob(await armarXlsx([{ nombre: "ESTADO RRCC", columnas: COLUMNAS_EXCEL, filas }]), nombre);
      consola(`${filas.length} fila(s) exportadas a ${nombre}`, "ok");
    } catch (e) {
      consola(`no se pudo exportar: ${e.message}`, "err");
      notificar("No se pudo exportar", e.message, "warn");
    } finally {
      el.excel.disabled = false;
    }
  }

  /** Deja la vista mostrando `lista` sin pedirle nada a la hoja. Es el camino
      por el que entra todo lo que ya cargo otra pestana, lo guardado de la
      sesion anterior y los parches de cada guardado. */
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
    if ($("vista-estado").hidden) {
      pintadoPendiente = true;
      return;
    }
    pintadoPendiente = false;
    pintar();
  }
  alMostrarse("vista-estado", () => {
    if (!pintadoPendiente) return;
    pintadoPendiente = false;
    pintar();
  });

  /**
   * Trae el personal, reutilizando lo que ya haya.
   *
   * Orden de preferencia: lo que cargo otra pestana en esta sesion (instantaneo
   * y sin red), lo guardado de la ultima vez (instantaneo, mientras llega lo
   * real) y por ultimo la hoja. Con `refrescar` se salta todo eso y se le
   * pregunta a la hoja de nuevo, que es lo que hace el enlace "recargar".
   */
  async function cargar({ refrescar = false } = {}) {
    if (cargando) return;
    cargando = true;
    el.cargar.disabled = true;
    consola.limpiar();
    consola.cabecera(refrescar ? "RECARGANDO PERSONAL" : "CARGANDO PERSONAL");
    ordenPorGrupo.clear();

    if (!refrescar) {
      const compartido = personalEnMemoria();
      if (compartido) {
        adoptar(compartido, hace(edadPersonal()));
        consola(`${compartido.length} persona(s) ya cargadas ${hace(edadPersonal())}; usa "recargar" para traerlas de nuevo`, "ok");
      } else if (!personas.length) {
        // con 600+ personas la carga real tarda varios segundos: mientras
        // tanto se pinta lo de la ultima vez para no dejar la pantalla vacia
        const snap = personalGuardado();
        if (snap) {
          configSnapshot = snap.config;
          adoptar(snap.personas, "de la última carga, actualizando…");
          consola(`${snap.personas.length} persona(s) de la última carga guardada; trayendo datos actuales…`, "info");
        }
      }
    }

    try {
      const [ctx, lista] = await conReintento(
        () => Promise.all([obtenerContexto({ refrescar }), obtenerPersonal({ refrescar })]),
        consola
      );
      contexto = ctx;
      const deLaHoja = lista !== personas;
      adoptar(lista);
      if (deLaHoja) {
        consola(`${personas.length} persona(s) leída(s) de la hoja`, "ok");
        notificar("Personal cargado", `${personas.length} persona(s) listas para el reporte de vencimientos.`);
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
   * Lo que cargue o guarde cualquier otra pestana llega por aca y se pinta
   * solo: renovar a alguien en RENOVACION se ve al instante en este reporte.
   *
   * Solo se adoptan listados COMPLETOS: el que usa ESTADO TOTAL viene filtrado
   * a los vencidos activos y aqui haria creer que la empresa tiene 30 personas.
   */
  alCambiar((ev) => {
    if (ev.tipo !== "personal" || !ev.completo || ev.personas === personas || cargando) return;
    adoptar(ev.personas, ev.origen === "escritura" ? "actualizado" : hace(edadPersonal()));
    consola(
      ev.origen === "escritura"
        ? "una fila se guardó en otra pestaña: reporte actualizado"
        : `${ev.personas.length} persona(s) ya disponibles: la base se cargó una vez para toda la app`,
      "info"
    );
  });

  /** Clic (o Enter/Espacio) en un <th data-campo>: ordena ese grupo por esa
      columna, alternando ascendente/descendente; un clic en otra columna
      empieza de nuevo en ascendente. Delegado en el contenedor porque las
      tablas se reconstruyen enteras en cada pintar(). */
  function ordenarPorEncabezado(th) {
    const codigo = th.closest("table[data-codigo]")?.dataset.codigo;
    const campo = th.dataset.campo;
    if (!codigo || !campo) return;
    const actual = ordenPorGrupo.get(codigo);
    const direccion = actual?.campo === campo ? -actual.direccion : 1;
    ordenPorGrupo.set(codigo, { campo, direccion });
    pintar();
  }
  el.resultados.addEventListener("click", (ev) => {
    const th = ev.target.closest("th[data-campo]");
    if (th) ordenarPorEncabezado(th);
  });
  el.resultados.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    const th = ev.target.closest("th[data-campo]");
    if (!th) return;
    ev.preventDefault();
    ordenarPorEncabezado(th);
  });

  el.cargar.addEventListener("click", () => cargar());
  el.recargar.addEventListener("click", () => cargar({ refrescar: true }));
  el.buscar.addEventListener("input", pintar);
  el.hasta.addEventListener("input", pintar);
  el.hasta.addEventListener("change", pintar);
  el.hastaBorrar.addEventListener("click", () => {
    el.hasta.value = "";
    pintar();
    el.hasta.focus();
  });
  selRiesgo.alCambiar(pintar);
  selEstado.alCambiar(pintar);
  el.orden.addEventListener("click", () => {
    descendente = !descendente;
    ordenPorGrupo.clear(); // el orden global vuelve a mandar en todos los grupos
    actualizarBotonOrden();
    pintar();
  });
  el.imprimir.addEventListener("click", () => window.print());
  el.excel.addEventListener("click", exportar);

  // Al montarse ya puede haber datos: otra pestana que cargo antes, o la
  // sesion anterior guardada en este navegador. Se pintan sin esperar a que
  // alguien pulse CARGAR PERSONAL.
  const yaHay = personalEnMemoria();
  if (yaHay) adoptar(yaHay, hace(edadPersonal()));

  pintarCuandoSeVea();

  return { recargar: () => cargar({ refrescar: true }), cargar };
}
