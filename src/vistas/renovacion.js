/**
 * Vista "RENOVACION": de una lista de DNI a la fila de `BD AESA` actualizada
 * y, si se pide, la carpeta de la persona en Drive.
 *
 * La cola es secuencial por persona a proposito: EIN reutiliza una sola
 * sesion y dos personas a la vez se pisarian el visor de Crystal Reports
 * (es el mismo problema de "certificado de otra persona" que ya documenta
 * el README). Dentro de una persona, cada operacion sigue siendo corta.
 */

import JSZip from "jszip";
import { $, crearConsola, crearProgreso, notificar, pedirPermisoAviso, copiarTexto, estimarRestante, textoRestante, descargarBlob } from "./comun.js";
import { montarPdf } from "./visor-pdf.js";
import { desdeTexto, normalizarLista } from "../lib/dni.js";
import { extraerDocumentos } from "../lib/excel.js";
import { drive, desdeBase64, blobABase64, retenerFondo } from "../lib/api.js";
import { obtenerCatalogo, catalogoGuardado } from "../lib/datos.js";
import { cargarContexto, renovarPersona, consultarPersona, adelantarInventarios, generarSalidas, vaciarCarpeta, resumenAutorizaciones, fotoDeDni, fotoAntigua, subirFoto, guardarFilaVerificada, subirArchivos, descargarCertificado, claveCertificado, nombresEnCarpeta, nombreEnCarpeta, certificadosDeRrcc, MIME_DOCX } from "../lib/renovacion.js";
import {
  aFormatoCorto,
  aIso,
  sumarDias,
  sumarAnios,
  hoyIso,
  estadoDe,
  vencimientoDe,
  renovarFila,
  aplicarCapacitacionC,
  aplicarEdicionesManuales,
  admiteAplicarC,
  leerFila,
  normalizarLentes,
} from "../../shared/estados.js";
import { colTipo, INDICE, CODIGOS_RRCC } from "../../shared/rrcc.js";
import { autocompletar } from "./autocompletar.js";
import { montarCursosDeCargo } from "./cursos-cargo.js";
import { armarAutorizacion, medidasWord } from "../lib/docx.js";
import { fotocheckImagen, nombreFotocheck, esImagenFotocheck, combinarFotocheckAntiguo } from "../lib/fotocheck.js";
import { abrirFotocheck, actualizarFotocheck, cerrarFotocheck, fotocheckAbiertoDe } from "./fotocheck-modal.js";

export function normalizarCambiosPendientes(ficha, contextoExtra = {}) {
  if (!ficha) return { cambios: 0, ediciones: {}, datosEdit: {} };

  const baseRiesgoLocal = contextoExtra.baseRiesgo || (() => ({ tipo: "", venc: "" }));
  const baseDatosLocal = contextoExtra.baseDatos || (() => ({}));
  const normalizarTipo = (valor) => String(valor ?? "").trim().toUpperCase();
  const normalizarFecha = (valor) => aIso(String(valor ?? "").trim() || "");
  const normalizarTexto = (valor) => String(valor ?? "").trim();

  const ediciones = { ...(ficha.ediciones || {}) };
  for (const codigo of Object.keys(ediciones)) {
    const edit = ediciones[codigo];
    const base = baseRiesgoLocal(ficha, codigo) || { tipo: "", venc: "" };
    const tipoIgual = edit.tipo === undefined || normalizarTipo(edit.tipo) === normalizarTipo(base.tipo);
    const vencIgual = edit.venc === undefined || normalizarFecha(edit.venc) === normalizarFecha(base.venc);
    if (tipoIgual && vencIgual) delete ediciones[codigo];
  }

  const datos = { ...(ficha.datosEdit || {}) };
  const baseDatos = baseDatosLocal(ficha) || {};
  for (const clave of Object.keys(datos)) {
    const valor = datos[clave];
    const base = baseDatos[clave];
    const igual = clave === "emoVenc"
      ? normalizarFecha(valor) === normalizarFecha(base)
      : normalizarTexto(valor) === normalizarTexto(base);
    if (igual) delete datos[clave];
  }

  ficha.ediciones = ediciones;
  ficha.datosEdit = datos;
  return { cambios: Object.keys(ediciones).length + Object.keys(datos).length, ediciones, datosEdit: datos };
}

export function montarRenovacion() {
  const consola = crearConsola("rn-term", "rn-log-clear");
  const barra = crearProgreso("rn");
  // al pie de la lista de DNIs: cargo -> sus cursos "A" segun MATRIZ_PUESTO
  montarCursosDeCargo();

  const el = {
    dnis: $("rn-dnis"),
    count: $("rn-count"),
    archivo: $("rn-archivo"),
    limpiar: $("rn-limpiar"),
    aviso: $("rn-aviso"),
    run: $("rn-run"),
    stop: $("rn-stop"),
    salidas: $("rn-salidas"),
    escribir: $("rn-escribir"),
    panel: $("rn-panel-res"),
    resultados: $("rn-resultados"),
    resCount: $("rn-res-count"),
    estadoDrive: $("rn-estado-drive"),
    estadoBase: $("estado-base"),
  };

  let corriendo = false;
  let abortador = null;
  let contexto = null;
  const fichas = new Map(); // dni -> { persona, foto, antiguo }

  // resubida del fotocheck/Word en segundo plano (ver sincronizarSalidaEnDrive):
  // temporizador pendiente por DNI (edicion agrupada) y promesa en curso por DNI
  // (para no mandar dos subidas a la vez a la misma carpeta).
  const temporizadoresSalida = new Map();
  const sincronizacionesEnCurso = new Map();

  /* ---------------- entrada ---------------- */

  const objetivos = () => normalizarLista(desdeTexto(el.dnis.value)).items;

  function refrescar() {
    el.count.textContent = `${objetivos().length} DNI`;
  }
  el.dnis.addEventListener("input", refrescar);

  el.limpiar.addEventListener("click", () => {
    el.dnis.value = "";
    el.aviso.hidden = true;
    refrescar();
    el.dnis.focus();
  });

  el.archivo.addEventListener("change", async (ev) => {
    const archivo = ev.target.files?.[0];
    if (!archivo) return;
    try {
      const { valores, detalle } = await extraerDocumentos(archivo);
      if (!valores.length) throw new Error("no se encontró ninguna columna con documentos");
      const union = normalizarLista([...desdeTexto(el.dnis.value), ...valores]);
      el.dnis.value = union.items.map((i) => i.dni).join("\n");
      refrescar();
      el.aviso.hidden = false;
      el.aviso.innerHTML = `<b>${archivo.name}</b> → ${valores.length} documento(s) de ${detalle}.`;
      consola(`${valores.length} documento(s) desde ${detalle}`, "ok");
    } catch (e) {
      el.aviso.hidden = false;
      el.aviso.innerHTML = `<b>No se pudo leer el archivo:</b> ${e.message}`;
      consola(`error leyendo archivo: ${e.message}`, "err");
    } finally {
      ev.target.value = "";
    }
  });

  /* ---------------- estado de la base ---------------- */

  async function comprobarBase() {
    try {
      contexto = await cargarContexto();
      const personas = Object.keys(contexto.config).length;
      el.estadoBase.textContent = "BASE OK";
      el.estadoBase.className = "tag ok";
      el.estadoBase.title = `${contexto.cursos.length} alias de curso · ${personas} parámetros de CONFIG`;
      return true;
    } catch (e) {
      el.estadoBase.textContent = "BASE ✕";
      el.estadoBase.className = "tag mal";
      el.estadoBase.title = e.message;
      return false;
    }
  }

  /* ---------------- pintado ---------------- */

  const CLASE_ESTADO = {
    VIGENTE: "rc-vigente",
    ACTUALIZAR: "rc-actualizar",
    VENCIDO: "rc-vencido",
    "NO APLICA": "rc-noaplica",
  };

  const escaparHtml = (valor) =>
    String(valor ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  /* ---------------- edicion manual ---------------- */

  const umbrales = () => {
    const c = contexto?.config || {};
    return { vencido: Number(c.UMBRAL_VENCIDO ?? 365), actualizar: Number(c.UMBRAL_ACTUALIZAR ?? 330) };
  };

  /** La fila de la hoja tal como esta ahora; se lee una vez por cada version de `valores`. */
  function filaDeHoja(ficha) {
    if (ficha.hojaLeida?.origen !== ficha.valores) ficha.hojaLeida = { origen: ficha.valores, fila: leerFila(ficha.valores) };
    return ficha.hojaLeida.fila;
  }

  /** Tipo, vigencia y capacitacion con los que arranca un riesgo, antes de
      cualquier edicion. Salen de la hoja y de nada mas: un certificado no
      rellena lo que se dejo vacio a proposito. */
  function baseRiesgo(ficha, codigo) {
    const h = filaDeHoja(ficha).riesgos.find((x) => x.codigo === codigo);
    return { tipo: h?.tipo || "", venc: h?.venc || "", cap: h?.cap || "" };
  }

  /** Lo que muestra un riesgo con una edicion dada (o sin ella): tipo, vigencia
      y el estado que resulta de esa vigencia. */
  function visibleCon(ficha, codigo, edit = {}) {
    const base = baseRiesgo(ficha, codigo);
    const u = umbrales();
    const venc = edit.venc !== undefined ? edit.venc : base.venc;
    let cap = base.cap;
    if (edit.venc !== undefined) cap = edit.venc ? sumarDias(edit.venc, -u.vencido) : "";
    else if (!cap && base.venc) cap = sumarDias(base.venc, -u.vencido);
    return {
      edit,
      tipo: edit.tipo !== undefined ? edit.tipo : base.tipo,
      venc,
      estado: cap ? estadoDe(cap, hoyIso(), u) : "NO APLICA",
    };
  }

  const visibleDe = (ficha, riesgo) => visibleCon(ficha, riesgo.codigo, ficha.ediciones?.[riesgo.codigo]);

  /** El detalle de la renovacion con el tipo (A/C) que muestra cada tarjeta:
      es el que decide que certificados van a la carpeta y al ZIP. */
  const detalleVisible = (ficha, detalle = ficha.detalle || []) =>
    detalle.map((d) => ({ ...d, tipo: visibleDe(ficha, d).tipo }));

  /** La persona tal como la muestran las tarjetas (tipo y vigencia de cada
      riesgo, editados o no). Es la que se imprime en el fotocheck y la que
      manda en la cabecera: la hoja mas lo editado, sin pasar por los certificados. */
  /** Vencimiento del EMO y area con los que arranca la ficha, segun la hoja. Si
      la hoja no trae el vencimiento se toma el examen + 365 dias, como el fotocheck. */
  function datosBase(ficha) {
    const h = filaDeHoja(ficha);
    return {
      emoVenc: h.vencimientoEmo || (h.examenMedico ? sumarDias(h.examenMedico, 365) : ""),
      area: h.area,
      apellidos: h.apellidos,
      nombres: h.nombres,
      cargo: h.cargo,
      empresa: h.empresa,
      // "SI" / "NO" (o vacio si la hoja trae otra cosa)
      usoLentes: normalizarLentes(h.usoLentes),
    };
  }

  /** Lo que muestran los campos de EMO y area: la hoja, o lo editado encima. */
  const datosVisibles = (ficha) => ({ ...datosBase(ficha), ...(ficha.datosEdit || {}) });

  function personaVisible(ficha) {
    const visibles = {};
    for (const r of filaDeHoja(ficha).riesgos) {
      const { tipo, venc } = visibleDe(ficha, r);
      visibles[r.codigo] = { tipo, venc };
    }
    const fila = aplicarEdicionesManuales(ficha.valores, visibles, { config: contexto?.config });
    const d = datosVisibles(ficha);
    fila[INDICE["F. Vencimiento"]] = d.emoVenc;
    // con el vencimiento del EMO corregido, el examen va un anio antes
    const examen = ficha.datosEdit?.emoVenc ? sumarAnios(d.emoVenc, -1) : "";
    if (examen) fila[INDICE["F. Ex. Medico"]] = examen;
    fila[INDICE["Area Planilla"]] = d.area;
    fila[INDICE["Apellidos"]] = d.apellidos;
    fila[INDICE["Nombres"]] = d.nombres;
    fila[INDICE["Cargo Planilla"]] = d.cargo;
    fila[INDICE["EMPRESA"]] = d.empresa;
    // sin editar, el fotocheck imprime lo que diga la hoja, tal cual
    if (ficha.datosEdit?.usoLentes !== undefined) fila[INDICE["USO DE LENTES"]] = d.usoLentes;
    return leerFila(fila);
  }

  /**
   * USO DE LENTES (columna O): SI o NO. La opcion vacia solo aparece si la
   * hoja no trae ninguno de los dos, para no obligar a elegir; una vez puesto
   * no se puede volver a dejar en blanco.
   */
  function htmlCampoLentes(ficha) {
    const valor = datosVisibles(ficha).usoLentes;
    const opciones = datosBase(ficha).usoLentes ? ["SI", "NO"] : ["", "SI", "NO"];
    return (
      `<label class="campo-ficha campo-lentes${ficha.datosEdit?.usoLentes !== undefined ? " editado" : ""}" title="Uso de lentes (columna USO DE LENTES de la hoja). Se imprime en el fotocheck y se puede corregir aquí"><span>USO DE LENTES</span>` +
      `<select data-lentes aria-label="Uso de lentes">` +
      opciones.map((o) => `<option value="${o}"${o === valor ? " selected" : ""}>${o || "—"}</option>`).join("") +
      `</select></label>`
    );
  }

  const htmlEstadoFinal = (p) =>
    `<b class="${p.estadoFinal === "VIGENTE" ? "st-ok" : "st-err"}">${p.estadoFinal || "—"}</b>` +
    `${p.fechaMinima ? ` hasta ${aFormatoCorto(p.fechaMinima)}` : ""}`;

  const claseTipo = (tipo) => `rc-tipo${tipo ? ` rc-${tipo.toLowerCase()}` : ""}`;

  /* Las tarjetas se agrupan por tipo. Cualquier tipo que no sea A o C
     (vacio incluido) cae en el ultimo grupo. */
  const GRUPOS = [
    { tipo: "A", clase: "a", titulo: "A · AUTORIZADOS" },
    { tipo: "C", clase: "c", titulo: "C · CAPACITADOS" },
    { tipo: "", clase: "sin", titulo: "SIN TIPO" },
  ];
  const grupoDe = (tipo) => (tipo === "A" || tipo === "C" ? tipo : "");

  /* Texto fijo de la cabecera de la ficha. Cada elemento va seguido de " |"
     salvo el ultimo, y no se parte en dos lineas por dentro. */
  const RRCC_CABECERA = [
    "TRABAJOS EN ALTURA",
    "CARGAS SUSPENDIDAS",
    "BLOQUEO Y AISLAMIENTO DE ENERGÍA",
    "ESPACIOS CONFINADOS",
    "SISTEMAS PRESURIZADOS",
    "HERRAMIENTAS MANUALES",
    "VEHÍCULOS Y EQUIPOS MÓVILES",
    "SUSTANCIAS QUÍMICAS PELIGROSAS",
  ];

  /* ---------------- fotocheck en vivo ---------------- */

  const opcionesFotocheck = (ficha, clave) => ({ clave, foto: ficha.foto, antiguo: ficha.antiguoManual || ficha.antiguo, config: contexto?.config || {} });

  const textoBotonFotocheck = (abierto) => (abierto ? "OCULTAR FOTOCHECK" : "VER FOTOCHECK");
  const ICONO_FOTOCHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2.5"/><path d="M5.5 17c.6-2 2-3 3.5-3s2.9 1 3.5 3"/><path d="M15 9h4M15 12h4M15 15h3"/></svg>';

  /** Los botones de la cabecera reflejan si el fotocheck de su persona esta abierto. */
  function marcarBotonesFotocheck() {
    for (const boton of el.resultados.querySelectorAll("[data-fotocheck]")) {
      const abierto = fotocheckAbiertoDe(boton.dataset.fotocheck);
      boton.setAttribute("aria-pressed", String(abierto));
      boton.querySelector("[data-texto]").textContent = textoBotonFotocheck(abierto);
    }
  }
  document.addEventListener("fotocheck:cerrado", marcarBotonesFotocheck);

  let temporizadorFotocheck = null;
  /** Redibuja el fotocheck abierto de esa persona con lo que muestran las
      tarjetas en este momento. Se junta lo que llegue en un instante. */
  function refrescarFotocheck(dni) {
    if (!fotocheckAbiertoDe(dni)) return;
    clearTimeout(temporizadorFotocheck);
    temporizadorFotocheck = setTimeout(() => {
      const ficha = fichas.get(dni);
      if (!ficha?.persona || !fotocheckAbiertoDe(dni)) return;
      actualizarFotocheck(personaVisible(ficha), opcionesFotocheck(ficha, dni)).catch(() => {});
    }, 120);
  }

  function alternarFotocheck(dni) {
    if (fotocheckAbiertoDe(dni)) {
      cerrarFotocheck();
      return;
    }
    const ficha = fichas.get(dni);
    if (!ficha?.persona) return;
    abrirFotocheck(personaVisible(ficha), opcionesFotocheck(ficha, dni)).catch(() => {});
    marcarBotonesFotocheck();
  }

  /** Abre el selector nativo de archivos y devuelve lo elegido (sin tocar el DOM). */
  function elegirImagenes({ multiple = false } = {}) {
    return new Promise((resolver) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = multiple;
      input.addEventListener("change", () => resolver(Array.from(input.files || [])), { once: true });
      input.click();
    });
  }

  /**
   * Fotocheck antiguo adjuntado a mano: hay un boton por lado (ANVERSO y
   * REVERSO) para que se pueda empezar por cualquiera de los dos. Si es la
   * primera vez que se adjunta algo para esta persona, apenas se elige un
   * lado se pide el otro al toque (se puede cancelar si no hay reverso que
   * fotografiar); si ya estaba completo y solo se quiere corregir un lado,
   * se reemplaza ese solo, sin volver a preguntar por el otro. Los dos
   * lados se combinan en una sola imagen que reemplaza, para esta persona,
   * lo que se hubiera bajado de Drive por FOTOCHECK_ANTIGUO_DRIVE_ID.
   *
   * Si la persona ya tiene carpeta en Drive, el Word se resube al toque: no
   * se espera a que despues se abra/comparta/descargue la carpeta, que es
   * cuando antes se sincronizaba (y es facil no llegar a hacerlo nunca).
   */
  async function elegirLadoAntiguo(dni, lado) {
    const ficha = fichas.get(dni);
    if (!ficha) return;

    const eraNuevo = !ficha.antiguoAnversoFile && !ficha.antiguoReversoFile;

    const [archivo] = await elegirImagenes();
    if (!archivo) return;
    if (lado === "anverso") ficha.antiguoAnversoFile = archivo;
    else ficha.antiguoReversoFile = archivo;

    let etiqueta = lado;
    const otro = lado === "anverso" ? "reverso" : "anverso";
    if (eraNuevo) {
      notificar("Fotocheck antiguo", `${lado === "anverso" ? "Anverso" : "Reverso"} cargado. Ahora elige el ${otro.toUpperCase()} (cancela si no lo tienes).`);
      const [archivoOtro] = await elegirImagenes();
      if (archivoOtro) {
        if (otro === "anverso") ficha.antiguoAnversoFile = archivoOtro;
        else ficha.antiguoReversoFile = archivoOtro;
        etiqueta = "ambos";
      }
    }

    const partes = [ficha.antiguoAnversoFile, ficha.antiguoReversoFile].filter(Boolean);
    try {
      const combinado = await combinarFotocheckAntiguo(partes);
      ficha.antiguoManual = combinado;
      ficha.antiguo = combinado;
      pintarFicha(dni, ficha);
      refrescarFotocheck(dni);
      const detalle = etiqueta === "ambos" ? "Anverso y reverso combinados en una sola imagen." : `Se guardó el ${etiqueta}.`;
      await sincronizarSiHayCarpeta(dni, detalle);
    } catch (e) {
      notificar("No se pudo cargar el fotocheck antiguo", e.message, "warn");
    }
  }

  async function quitarFotocheckAntiguo(dni) {
    const ficha = fichas.get(dni);
    if (!ficha) return;
    ficha.antiguoAnversoFile = null;
    ficha.antiguoReversoFile = null;
    ficha.antiguoManual = null;
    ficha.antiguo = null;
    pintarFicha(dni, ficha);
    refrescarFotocheck(dni);
    await sincronizarSiHayCarpeta(dni, "Se quitó el fotocheck antiguo.");
  }

  /**
   * Si la carpeta FOTOS de Drive no tiene la foto de la persona, la tarjeta
   * ofrece un boton para conseguirla: abre el mismo selector nativo que el
   * fotocheck antiguo (sin "capture", asi que en el celular pregunta camara
   * o galeria). La foto elegida se usa al toque en el fotocheck en pantalla
   * y se sube a FOTOS/<dni>.png para que la proxima renovacion ya la
   * encuentre sola. Si la persona ya tiene carpeta en Drive, el fotocheck y
   * el Word se resuben de una vez.
   */
  async function agregarFotoPersona(dni) {
    const ficha = fichas.get(dni);
    if (!ficha) return;

    const [archivo] = await elegirImagenes();
    if (!archivo) return;

    ficha.foto = archivo;
    ficha.fotoManual = archivo;
    pintarFicha(dni, ficha);
    refrescarFotocheck(dni);

    try {
      await subirFoto(archivo, { nombre: `${dni}.png` });
      consola(`  foto de ${dni} guardada en FOTOS/${dni}.png`, "ok");
      await sincronizarSiHayCarpeta(dni, "Foto agregada.", {
        listo: "Foto lista",
        guardado: "Foto guardada",
        error: "Foto lista, pero no se pudo actualizar la carpeta",
      });
    } catch (e) {
      notificar("La foto se usa en esta ficha, pero no se pudo guardar en FOTOS", e.message, "warn");
      consola(`  no se pudo subir la foto de ${dni} a FOTOS: ${e.message}`, "err");
    }
  }

  /** Tras cambiar el fotocheck antiguo (o la foto de la persona), resube el
      Word si la persona ya tiene carpeta en Drive; si no la tiene todavia,
      no hay nada que actualizar. `titulos` deja reusar esto para la foto
      nueva sin heredar el texto de "fotocheck antiguo". */
  async function sincronizarSiHayCarpeta(dni, detalle, titulos = {}) {
    const {
      listo = "Fotocheck antiguo listo",
      guardado = "Fotocheck antiguo guardado",
      error = "Fotocheck antiguo listo, pero no se pudo actualizar la carpeta",
    } = titulos;
    const ficha = fichas.get(dni);
    const folderId = ficha?.salida?.carpetaId || ficha?.carpetaId;
    if (!folderId) {
      notificar(listo, detalle);
      return;
    }
    ficha.salidaDesactualizada = true; // cambio en la carpeta: forzar la resubida aunque nada mas haya cambiado
    const ok = await sincronizarSalidaEnDrive(dni);
    notificar(
      ok ? guardado : error,
      ok
        ? `${detalle} El Word de la carpeta ya lo tiene.`
        : "Se actualizará al abrir, compartir o descargar la carpeta.",
      ok ? "ok" : "warn"
    );
  }

  /* ---------------- seleccion para aplicar C ---------------- */

  const tipoEnHoja = (ficha, codigo) => String(ficha.valores?.[colTipo(codigo)] ?? "").trim().toUpperCase();

  /** Una tarjeta se puede seleccionar si ni la hoja ni lo que se ve la marcan
      como A, y si su riesgo no esta excluido de la carga de C. */
  const elegibleParaC = (ficha, codigo, tipoVisible) =>
    admiteAplicarC(codigo, tipoVisible) && admiteAplicarC(codigo, tipoEnHoja(ficha, codigo));

  /** Deja la pantalla de acuerdo con la seleccion: casillas, resaltado, casilla
      de cada grupo y el boton, que solo se habilita con algo seleccionado. */
  function actualizarSeleccion(card, ficha) {
    const seleccion = ficha.seleccion || (ficha.seleccion = new Set());
    for (const celda of card.querySelectorAll(".rc")) {
      const codigo = celda.dataset.codigo;
      const elegible = elegibleParaC(ficha, codigo, celda.querySelector("[data-tipo]").value);
      if (!elegible) seleccion.delete(codigo);
      const marca = celda.querySelector(".rc-sel");
      marca.hidden = !elegible;
      marca.querySelector("input").checked = seleccion.has(codigo);
      celda.classList.toggle("rc-sel-on", seleccion.has(codigo));
    }
    for (const seccion of card.querySelectorAll(".rrcc-grupo")) {
      const todas = seccion.querySelector(".rrcc-grupo-todas");
      if (!todas) continue;
      const elegibles = [...seccion.querySelectorAll(".rc-sel:not([hidden]) input")];
      const marcadas = elegibles.filter((c) => c.checked).length;
      todas.hidden = elegibles.length === 0;
      const caja = todas.querySelector("input");
      caja.checked = elegibles.length > 0 && marcadas === elegibles.length;
      caja.indeterminate = marcadas > 0 && marcadas < elegibles.length;
    }
    const boton = card.querySelector("[data-aplicar-c]");
    boton.disabled = seleccion.size === 0;
    boton.textContent = seleccion.size ? `APLICAR C (${seleccion.size})` : "APLICAR C";
    boton.title = seleccion.size
      ? `Aplica C con la fecha indicada a las ${seleccion.size} tarjeta(s) seleccionada(s)`
      : "Selecciona al menos una tarjeta con su casilla. Las A y los riesgos excluidos no se pueden seleccionar";
  }

  /** Lleva la tarjeta a la seccion de su tipo, en el orden del catalogo, y
      actualiza los contadores. Conserva el foco para poder seguir con el teclado. */
  function moverAGrupo(card, celda, tipo) {
    const destino = card.querySelector(`.rrcc-grupo[data-grupo="${grupoDe(tipo)}"]`);
    const cambiaDeGrupo = destino !== celda.closest(".rrcc-grupo");
    if (cambiaDeGrupo) {
      const activo = document.activeElement;
      const rejilla = destino.querySelector(".rrcc");
      const orden = Number(celda.dataset.orden);
      const siguiente = [...rejilla.children].find((c) => Number(c.dataset.orden) > orden);
      rejilla.insertBefore(celda, siguiente || null);
      if (activo && celda.contains(activo)) activo.focus();
    }
    for (const seccion of card.querySelectorAll(".rrcc-grupo")) {
      const n = seccion.querySelectorAll(".rc").length;
      seccion.hidden = n === 0;
      seccion.querySelector("[data-grupo-n]").textContent = n;
    }
    if (cambiaDeGrupo) celda.scrollIntoView({ block: "nearest" });
  }

  /**
   * La vigencia que da el certificado elegido para un riesgo y si la fecha
   * editable (la de la hoja, o lo tecleado encima) no coincide con ella. Una
   * tarjeta A o C sin fecha en la hoja pero con certificado tambien cuenta:
   * es justo una de las que hay que completar.
   */
  function discrepancia(ficha, codigo, venc, tipo) {
    const cert = (ficha?.detalle || []).find((d) => d.codigo === codigo)?.certificado;
    const venceCert = cert?.fecha ? vencimientoDe(codigo, cert.fecha, cert, umbrales().vencido) || "" : "";
    const conTipo = tipo === "A" || tipo === "C";
    const diferente = Boolean(venceCert) && (venc ? String(venc).trim() !== String(venceCert).trim() : conTipo);
    return { diferente, venceCert };
  }

  /**
   * Lo que hay que mirar en la ficha, contado: fechas que no coinciden con su
   * certificado, vencidos y por vencer (solo A y C: sin tipo no se imprime).
   * Cada contador lleva a la primera tarjeta de su clase.
   */
  function pintarPendientes(card, ficha) {
    const caja = card.querySelector("[data-pendientes]");
    if (!caja) return;
    if (ficha.cargando) {
      caja.innerHTML = `<span class="pend-chip pend-cargando">buscando certificados…</span>`;
      return;
    }
    const cuenta = { dif: 0, venc: 0, act: 0 };
    for (const celda of card.querySelectorAll(".rc")) {
      const tipo = celda.querySelector("[data-tipo]")?.value || "";
      if (celda.classList.contains("rc-fecha-diferente")) cuenta.dif++;
      if (tipo !== "A" && tipo !== "C") continue;
      if (celda.classList.contains("rc-vencido")) cuenta.venc++;
      else if (celda.classList.contains("rc-actualizar")) cuenta.act++;
    }
    const chips = [];
    if (cuenta.dif) chips.push(`<button type="button" class="pend-chip pend-dif" data-ir=".rc-fecha-diferente" title="Ir a la primera tarjeta cuya fecha no coincide con su certificado">${cuenta.dif} fecha(s) ≠ certificado</button>`);
    if (cuenta.venc) chips.push(`<button type="button" class="pend-chip pend-venc" data-ir=".rc-vencido" title="Ir al primer riesgo vencido">${cuenta.venc} vencido(s)</button>`);
    if (cuenta.act) chips.push(`<button type="button" class="pend-chip pend-act" data-ir=".rc-actualizar" title="Ir al primer riesgo por vencer">${cuenta.act} por vencer</button>`);
    caja.innerHTML = chips.length ? chips.join("") : `<span class="pend-chip pend-ok">✓ fechas al día con los certificados</span>`;
    for (const chip of caja.querySelectorAll("[data-ir]")) {
      chip.addEventListener("click", () => {
        const destino = card.querySelector(chip.dataset.ir);
        if (!destino) return;
        destino.scrollIntoView({ behavior: "smooth", block: "center" });
        destino.classList.remove("rc-senalado");
        void destino.offsetWidth; // reinicia la animacion si ya estaba senalada
        destino.classList.add("rc-senalado");
        destino.querySelector("input[data-venc]")?.focus({ preventScroll: true });
      });
    }
  }

  /** Marca (o desmarca) la tarjeta cuya fecha no coincide con su certificado
      y muestra el atajo para copiar la del certificado. */
  function pintarDiscrepancia(card, celda, ficha, codigo, { venc, tipo }) {
    const { diferente } = discrepancia(ficha, codigo, venc, tipo);
    celda.classList.toggle("rc-fecha-diferente", diferente);
    const atajo = celda.querySelector("[data-usar-cert]");
    if (atajo) atajo.hidden = !diferente;
    pintarPendientes(card, ficha);
  }

  /** Anota (o retira) una edicion y refresca solo esa celda: repintar la
      ficha entera le quitaria el foco al campo de fecha mientras se escribe. */
  function editar(dni, card, codigo, cambio) {
    const ficha = fichas.get(dni);
    ficha.salidaDesactualizada = true;
    const base = baseRiesgo(ficha, codigo);
    const actual = { ...(ficha.ediciones?.[codigo] || {}), ...cambio };
    if (actual.tipo === base.tipo) delete actual.tipo;
    if (actual.venc === base.venc) delete actual.venc;

    ficha.ediciones = { ...ficha.ediciones };
    if (Object.keys(actual).length) ficha.ediciones[codigo] = actual;
    else delete ficha.ediciones[codigo];

    const celda = card.querySelector(`.rc[data-codigo="${codigo}"]`);
    const visible = visibleCon(ficha, codigo, actual);
    const { tipo, estado } = visible;
    for (const clase of Object.values(CLASE_ESTADO)) celda.classList.remove(clase);
    celda.classList.add(CLASE_ESTADO[estado] || "rc-noaplica");
    celda.classList.toggle("rc-editado", Object.keys(actual).length > 0);
    celda.querySelector("[data-estado]").textContent = estado.toLowerCase();
    celda.querySelector("[data-tipo]").className = claseTipo(tipo);
    // solo un "A" lleva su certificado a la carpeta: la "x" sobra en los demas
    const x = celda.querySelector("[data-cert-x-rrcc]");
    if (x) x.hidden = tipo !== "A";
    pintarDiscrepancia(card, celda, ficha, codigo, visible);
    moverAGrupo(card, celda, tipo);
    actualizarSeleccion(card, ficha);
    pintarBarraEdicion(card, ficha);
    card.querySelector("[data-estado-final]").innerHTML = htmlEstadoFinal(personaVisible(ficha));
    refrescarFotocheck(dni);
    programarSincronizacion(dni);
  }

  const cambiosPendientes = (ficha) => {
    const n = normalizarCambiosPendientes(ficha, { baseRiesgo, baseDatos: datosBase });
    return n.cambios;
  };

  function pintarBarraEdicion(card, ficha) {
    const n = cambiosPendientes(ficha);
    card.querySelector("[data-edicion]").hidden = n === 0;
    card.querySelector("[data-edicion-n]").textContent = `${n} cambio(s) sin guardar`;
  }

  /** Deshabilita (o repone) un boton/enlace de accion mientras espera algo
      async, para que el clic se sienta reconocido al instante aunque la
      operacion en si tarde (red, Drive). */
  function marcarOcupado(el, ocupado) {
    if (!el) return;
    el.classList.toggle("en-espera", ocupado);
    if (el.tagName === "BUTTON") el.disabled = ocupado;
    else el.setAttribute("aria-disabled", String(ocupado));
  }

  /** Cancela la resubida en segundo plano agendada para `dni`, si habia una. */
  function cancelarSincronizacionProgramada(dni) {
    const t = temporizadoresSalida.get(dni);
    if (t !== undefined) {
      clearTimeout(t);
      temporizadoresSalida.delete(dni);
    }
  }

  /**
   * Agenda, para dentro de `retrasoMs`, una resubida en segundo plano del
   * fotocheck/Word (ver `sincronizarSalidaEnDrive`). Cada llamada reemplaza
   * la anterior para el mismo DNI: escribir una fecha o el area dispara esto
   * en cada tecla, y asi solo se sube una vez al dejar de teclear en vez de
   * una por tecla. La idea es que para cuando se haga clic en ABRIR CARPETA /
   * DESCARGAR / WHATSAPP la carpeta ya este al dia y esos botones respondan
   * al toque, sin esperar la subida a Drive en ese momento.
   */
  function programarSincronizacion(dni, retrasoMs = 1200) {
    cancelarSincronizacionProgramada(dni);
    const t = setTimeout(() => {
      temporizadoresSalida.delete(dni);
      sincronizarSalidaEnDrive(dni).catch(() => {});
    }, retrasoMs);
    temporizadoresSalida.set(dni, t);
  }

  /* ---------------- estado de la carpeta en Drive (arriba de la consola) ---------------- */

  /**
   * DNIs de esta corrida que van a tener carpeta en Drive pero todavia no la
   * terminaron de armar (se estan leyendo, o esperan turno). Sin esto, entre
   * que se pinta la ficha y que arranca la subida el aviso no sabria que
   * mostrar.
   */
  const salidasPendientes = new Set();

  /**
   * Estado de la carpeta de una persona, deducido de lo que la vista ya lleva
   * registrado: la barra de progreso de la carpeta, las resubidas en curso o
   * agendadas tras una edicion, y si quedo algo sin subir.
   *   guardando -> hay algo subiendose (o por subirse en un instante)
   *   pendiente -> hay cambios que todavia no estan en Drive
   *   listo     -> Drive tiene la version que se ve en la ficha
   *   error     -> la carpeta no se pudo armar
   * null si la ficha no tiene nada que ver con Drive (consulta, sin salidas).
   */
  function estadoDrive(dni, ficha) {
    if (!ficha?.persona || ficha.consulta) return null;
    const barra = ficha.progreso?.salida;
    if (barra) {
      const pct = barra.total ? Math.min(100, Math.round((barra.hecho / barra.total) * 100)) : 0;
      return { tipo: "guardando", texto: barra.texto || "armando la carpeta…", pct, eta: etaDe(barra), zip: estadoZip(ficha) };
    }
    if (sincronizacionesEnCurso.has(dni) || temporizadoresSalida.has(dni)) {
      return { tipo: "guardando", texto: "guardando los cambios de la ficha…", zip: estadoZip(ficha) };
    }
    if (ficha.salida?.carpetaId) {
      if (ficha.salidaDesactualizada) return { tipo: "pendiente", texto: "hay cambios que aún no están en Drive", zip: estadoZip(ficha) };
      return { tipo: "listo", zip: estadoZip(ficha) || { listo: true, desdeDrive: true } };
    }
    if (ficha.errorSalida) return { tipo: "error", texto: ficha.errorSalida, zip: estadoZip(ficha) };
    if (salidasPendientes.has(dni)) return { tipo: "guardando", texto: "leyendo certificados…", zip: null };
    return null;
  }

  /**
   * El ZIP (certificados + Word con el fotocheck) va por su cuenta y termina antes
   * que Drive: se arma con lo que ya esta en memoria, sin esperar las subidas.
   */
  function estadoZip(ficha) {
    const armado = ficha.progreso?.armado;
    if (armado) {
      const pct = armado.total ? Math.min(100, Math.round((armado.hecho / armado.total) * 100)) : 0;
      return { listo: false, texto: armado.texto || "bajando certificados…", pct, eta: etaDe(armado) };
    }
    return ficha.salida?.archivos?.length ? { listo: true } : null;
  }

  /** Una mitad del aviso (ZIP o DRIVE), con su propio estado, avance y tiempo restante. */
  function htmlMitad({ tipo, destino, estado, pct, eta, detalle = "", accion = "" }) {
    const icono = tipo === "guardando" ? `<i class="ed-spin" aria-hidden="true"></i>` : `<i class="ed-icono" aria-hidden="true"></i>`;
    const avance =
      pct !== undefined
        ? `<div class="ed-barra" aria-hidden="true"><i style="width:${Math.max(pct, 3)}%"></i></div>` +
          `<div class="ed-cifras"><b>${pct}%</b>${eta ? `<span data-ed-eta>${escaparHtml(eta)}</span>` : ""}</div>`
        : "";
    return (
      `<div class="ed ed-mitad ed-${tipo}">` +
      `<div class="ed-cabeza">${icono}<div class="ed-txt"><div class="ed-destino">${destino}</div>` +
      `<div class="ed-titulo">${estado}</div></div></div>` +
      avance +
      (detalle ? `<div class="ed-detalle">${detalle}</div>` : "") +
      accion +
      (tipo === "guardando" ? `<div class="ed-onda" aria-hidden="true"></div>` : "") +
      `</div>`
    );
  }

  /** Mitad ZIP: armandose (bajando certificados, fotocheck, Word) o lista para descargar. */
  function htmlMitadZip(dni, e) {
    const boton = `<button type="button" class="btn btn-sm ed-zip" data-ed-zip="${escaparHtml(dni)}">DESCARGAR ZIP</button>`;
    const z = e.zip;
    if (z && !z.listo) {
      return htmlMitad({ tipo: "guardando", destino: "ZIP", estado: "ARMANDO", pct: z.pct, eta: z.eta, detalle: escaparHtml(z.texto) });
    }
    if (z?.listo) {
      return htmlMitad({
        tipo: "listo",
        destino: "ZIP",
        estado: "LISTO",
        detalle: z.desdeDrive ? "se arma desde la carpeta de Drive" : "certificados + Word",
        accion: boton,
      });
    }
    // si la carpeta fallo antes de armar el ZIP, no se queda "en espera" para siempre
    if (e.tipo === "error") {
      return htmlMitad({ tipo: "error", destino: "ZIP", estado: "NO SE PUDO ARMAR", detalle: "vuelve a renovar a esta persona" });
    }
    return htmlMitad({ tipo: "espera", destino: "ZIP", estado: "EN ESPERA", detalle: "esperando los certificados…" });
  }

  /** Mitad DRIVE: subiendo, guardado, con cambios pendientes o con error. */
  function htmlMitadDrive(e) {
    if (e.tipo === "guardando") {
      return htmlMitad({ tipo: "guardando", destino: "DRIVE", estado: "SUBIENDO", pct: e.pct, eta: e.eta, detalle: escaparHtml(e.texto) });
    }
    if (e.tipo === "pendiente") {
      return htmlMitad({
        tipo: "pendiente",
        destino: "DRIVE",
        estado: "CAMBIOS SIN GUARDAR",
        detalle: `${escaparHtml(e.texto)} · se guardan al abrir, compartir o descargar la carpeta`,
      });
    }
    if (e.tipo === "error") return htmlMitad({ tipo: "error", destino: "DRIVE", estado: "NO SE PUDO GUARDAR", detalle: escaparHtml(e.texto) });
    return htmlMitad({ tipo: "listo", destino: "DRIVE", estado: "GUARDADO", detalle: "la carpeta tiene todo lo de esta renovación" });
  }

  function htmlEstadoDrive() {
    const filas = [];
    for (const [dni, ficha] of fichas) {
      const e = estadoDrive(dni, ficha);
      if (!e) continue;
      // por persona: quien es arriba y debajo dos mitades independientes,
      // ZIP a la izquierda y DRIVE a la derecha, cada una con su tiempo restante
      filas.push(
        `<div class="ed-par" role="status">` +
          `<div class="ed-quien"><span class="ed-dni">${escaparHtml(dni)}</span>` +
          `<span class="ed-nombre">${escaparHtml(ficha.persona.nombreCompleto || "")}</span></div>` +
          `<div class="ed-mitades">${htmlMitadZip(dni, e)}${htmlMitadDrive(e)}</div>` +
          `</div>`
      );
    }
    return filas.join("");
  }

  let ultimoEstadoDrive = "";
  const ETA_ED = /<span data-ed-eta>([^<]*)<\/span>/g;
  /**
   * Repinta el aviso solo si cambio algo: asi la animacion no se reinicia a
   * cada vuelta. El tiempo restante cambia cada segundo: si es lo UNICO que
   * cambio, se actualiza ese texto en su lugar (repintar todo reiniciaba las
   * animaciones y podia comerse un clic en DESCARGAR ZIP).
   */
  function pintarEstadoDrive() {
    if (!el.estadoDrive) return;
    const html = htmlEstadoDrive();
    if (html === ultimoEstadoDrive) return;
    const sinEta = (h) => h.replace(ETA_ED, "<span data-ed-eta></span>");
    if (sinEta(html) === sinEta(ultimoEstadoDrive)) {
      const textos = [...html.matchAll(ETA_ED)].map((m) => m[1]);
      el.estadoDrive.querySelectorAll("[data-ed-eta]").forEach((s, i) => {
        s.innerHTML = textos[i] ?? "";
      });
      ultimoEstadoDrive = html;
      return;
    }
    ultimoEstadoDrive = html;
    el.estadoDrive.innerHTML = html;
    el.estadoDrive.hidden = !html;
  }
  // El estado sale de varios lugares (renovacion, ediciones, "x", ZIP...):
  // en vez de avisar desde cada uno, se revisa seguido. Es barato: son unas
  // pocas fichas y solo toca el DOM si algo cambio.
  setInterval(pintarEstadoDrive, 400);

  el.estadoDrive?.addEventListener("click", async (ev) => {
    const boton = ev.target.closest("[data-ed-zip]");
    if (!boton) return;
    marcarOcupado(boton, true);
    try {
      await descargarCarpetaUsuario(boton.dataset.edZip);
    } catch (e) {
      notificar("No se pudo descargar la carpeta", e.message, "warn");
    } finally {
      marcarOcupado(boton, false);
    }
  });

  /* ---------------- progreso con tiempo restante ---------------- */

  const TITULO_PROGRESO = { armado: "ZIP · ARMANDO", salida: "DRIVE · SUBIENDO", zip: "DESCARGA ZIP" };

  /**
   * Barra de avance de una tarea larga de la ficha (`salida` = armar la
   * carpeta en Drive, `zip` = descargarla), con cuanto falta. Vive en
   * `ficha.progreso` para sobrevivir a los repintados de la ficha.
   * `estado` = { hecho, total, texto } o `null` para quitarla.
   */
  function mostrarProgreso(dni, clave, estado) {
    const ficha = fichas.get(dni);
    if (!ficha) return;
    const progreso = (ficha.progreso ||= {});
    if (!estado) delete progreso[clave];
    else {
      const previo = progreso[clave];
      const inicio = previo?.inicio || Date.now();
      progreso[clave] = {
        ...estado,
        inicio,
        restante: estimarRestante(inicio, estado.hecho, estado.total),
        medido: Date.now(),
      };
    }
    pintarProgresos(el.resultados.querySelector(`[data-dni="${dni}"]`), ficha);
    vigilarProgresos();
  }

  function htmlProgresos(ficha) {
    return Object.entries(ficha.progreso || {})
      .map(([clave, p]) => {
        const pct = p.total ? Math.min(100, Math.round((p.hecho / p.total) * 100)) : 0;
        return (
          `<div class="tarea-prog${p.hecho ? "" : " tarea-prog-espera"}" data-prog="${clave}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">` +
          `<div class="tarea-prog-top"><b>${TITULO_PROGRESO[clave] || clave}</b>` +
          `<span class="tarea-prog-pct">${pct}%</span>` +
          `<span class="tarea-prog-eta" data-eta>${etaDe(p)}</span></div>` +
          `<div class="tarea-prog-barra"><i style="width:${Math.max(pct, 3)}%"></i></div>` +
          `<small>${escaparHtml(p.texto || "")}</small></div>`
        );
      })
      .join("");
  }

  /** Lo que falta, descontando lo que paso desde la ultima medicion: asi el
      reloj sigue bajando aunque la siguiente unidad tarde en terminar. */
  function etaDe(p) {
    if (p.restante === null || p.restante === undefined) return "calculando…";
    const ms = Math.max(0, p.restante - (Date.now() - p.medido));
    return ms < 1000 ? "terminando…" : `quedan ${textoRestante(ms)}`;
  }

  function pintarProgresos(card, ficha) {
    const caja = card?.querySelector("[data-progresos]");
    if (caja) caja.innerHTML = htmlProgresos(ficha);
  }

  /** Un solo reloj para todas las barras abiertas: se apaga solo cuando no queda ninguna. */
  let relojProgreso = null;
  function vigilarProgresos() {
    if (relojProgreso) return;
    relojProgreso = setInterval(() => {
      let activas = 0;
      for (const [dni, ficha] of fichas) {
        for (const [clave, p] of Object.entries(ficha.progreso || {})) {
          activas++;
          const eta = el.resultados.querySelector(`[data-dni="${dni}"] [data-prog="${clave}"] [data-eta]`);
          if (eta) eta.textContent = etaDe(p);
        }
      }
      if (!activas) {
        clearInterval(relojProgreso);
        relojProgreso = null;
      }
    }, 1000);
  }

  /**
   * El fotocheck (JPG) y el Word tal como se ven AHORA en la ficha, con
   * ediciones incluidas. Se arman en el navegador: lo usan la resubida a
   * Drive y el ZIP, que asi no tiene que bajarlos de Drive.
   */
  async function documentosActuales(ficha) {
    const persona = personaVisible(ficha);
    const foto = ficha.foto || (await fotoDeDni(persona.dni).catch(() => null));
    const img = await fotocheckImagen(persona, { foto, conWord: true });
    const pngBlob = img.blob; // (el nombre quedo de cuando era PNG: es la imagen del fotocheck)
    const docx = await armarAutorizacion({
      fotocheck: img.word,
      antiguo: ficha.antiguoManual || ficha.antiguo || null,
      medidas: medidasWord(contexto?.config),
    });
    const nombreBase = persona.nombreCompleto || persona.dni;
    return {
      persona,
      pngBlob,
      mimeFotocheck: img.mime,
      docx,
      nombreFotocheck: nombreFotocheck(persona),
      nombreWord: `Autorizacion_RRCC_${nombreBase}.docx`,
    };
  }

  /**
   * La carpeta lleva solo los certificados de los RRCC con "A". Si despues de
   * armarla se cambio el tipo de alguno en la ficha, lo que ya esta
   * (`presentes`, por nombre) deja de coincidir: devuelve los nombres que
   * sobran y los certificados que faltan. Lo quitado con la "x" no falta.
   */
  function certificadosPorConciliar(dni, ficha, presentes) {
    const fuera = excluidosDe(dni);
    const sobran = [];
    const faltan = [];
    for (const c of certificadosDeRrcc(detalleVisible(ficha))) {
      const esta = presentes.has(c.archivo);
      if (!c.entra && esta) sobran.push(c.archivo);
      else if (c.entra && !esta && !fuera.has(claveCertificado(c.cert))) faltan.push(c);
    }
    return { sobran, faltan };
  }

  /** Baja los certificados que faltan; uno que no se pudo bajar se avisa y se sigue sin el. */
  async function bajarFaltantes(dni, faltan) {
    const bajados = [];
    for (const c of faltan) {
      try {
        const r = await descargarCertificado(c.cert);
        if (!r.sinCertificado) bajados.push({ nombre: c.archivo, datos: r.pdf });
      } catch (e) {
        consola(`  ${dni} · ${c.codigo}: no se pudo bajar el certificado (${e.message})`, "warn");
      }
    }
    return bajados;
  }

  /** El ZIP en memoria (`salida.archivos`) con los certificados del tipo A/C que muestra hoy la ficha. */
  async function archivosAlDia(dni, ficha) {
    const archivos = ficha.salida?.archivos;
    if (!Array.isArray(archivos)) return;
    const { sobran, faltan } = certificadosPorConciliar(dni, ficha, new Set(archivos.map((a) => a.nombre)));
    if (!sobran.length && !faltan.length) return;
    let nuevos = [];
    if (faltan.length) {
      mostrarProgreso(dni, "zip", { hecho: 0, total: 1, texto: "bajando los certificados de los RRCC que pasaron a A…" });
      try {
        nuevos = await bajarFaltantes(dni, faltan);
      } finally {
        mostrarProgreso(dni, "zip", null);
      }
    }
    ficha.salida.archivos = [...archivos.filter((a) => !sobran.includes(a.nombre)), ...nuevos];
  }

  /**
   * Antes de abrir la carpeta, compartirla o descargarla en ZIP, la carpeta
   * de Drive tiene que mostrar lo mismo que la ficha en pantalla: si se
   * corrigio el EMO, el area, una fecha o el tipo (A/C) despues de la
   * renovacion, o se adjunto el fotocheck antiguo a mano, ni el PNG ni el
   * Word ya subidos lo reflejan. Se rehacen los dos con lo que se ve ahora y
   * se resuben con el mismo nombre (se reemplazan en la carpeta).
   *
   * `ficha.salidaDesactualizada` evita resubir cuando no hace falta: sin eso,
   * cada clic en ABRIR CARPETA / WHATSAPP / DESCARGAR volvia a dibujar el
   * fotocheck, armar el Word y hacer dos subidas a Apps Script (lento) aunque
   * nada hubiera cambiado desde la ultima vez. Ademas, cada edicion agenda
   * esta misma resubida en segundo plano (`programarSincronizacion`): lo
   * normal es que para cuando se haga clic en esos botones ya este al dia y
   * esto vuelva al toque sin subir nada de nuevo.
   *
   * Si ya hay una subida en curso para este DNI, no se manda una segunda en
   * paralelo (podrian cruzarse y la carpeta quedar con la version vieja): se
   * espera esa y se reintenta, por si mientras tanto llego otra edicion.
   */
  async function sincronizarSalidaEnDrive(dni) {
    const ficha = fichas.get(dni);
    const folderId = ficha?.salida?.carpetaId || ficha?.carpetaId;
    if (!folderId || !ficha?.persona) return false;

    const enCurso = sincronizacionesEnCurso.get(dni);
    if (enCurso) {
      await enCurso;
      return sincronizarSalidaEnDrive(dni);
    }

    if (!ficha.salidaDesactualizada) return true;
    cancelarSincronizacionProgramada(dni);

    const tarea = (async () => {
      try {
        const docs = await documentosActuales(ficha);

        // si se cambio el tipo A/C de algun RRCC despues de armar la carpeta,
        // sus certificados se ponen al dia: el que dejo de ser "A" sale y el
        // que paso a "A" se sube. Solo con la carpeta ya armada por esta
        // sesion (`certificados` = lo que subio): sin eso no se sabe que hay.
        const enDrive = ficha.salida?.certificados;
        const conciliar = Array.isArray(enDrive)
          ? certificadosPorConciliar(dni, ficha, new Set(enDrive.map((c) => c.nombre)))
          : { sobran: [], faltan: [] };
        const nuevos = await bajarFaltantes(dni, conciliar.faltan);

        // todo en una sola llamada a Apps Script (subir-lote)
        const [fotocheckSubido, wordSubido, ...certsSubidos] = await subirArchivos(folderId, [
          { nombre: docs.nombreFotocheck, mime: docs.mimeFotocheck, datos: await blobABase64(docs.pngBlob) },
          { nombre: docs.nombreWord, mime: MIME_DOCX, datos: await blobABase64(docs.docx) },
          ...(await Promise.all(
            nuevos.map(async (a) => ({
              nombre: a.nombre,
              mime: "application/pdf",
              datos: await blobABase64(new Blob([a.datos], { type: "application/pdf" })),
            }))
          )),
        ]);
        if (certsSubidos.length) consola(`${dni}: ${certsSubidos.map((c) => c.nombre).join(", ")} agregado(s) a la carpeta (RRCC con "A")`, "ok");

        // si se corrigio el nombre, el fotocheck y el Word del nombre anterior
        // quedarian duplicados en la carpeta; y los certificados de lo que ya
        // no es "A" no van: todo eso a la papelera
        const anteriores = [ficha.salida?.fotocheck?.nombre, ficha.salida?.word?.nombre].filter(
          (n) => n && n !== fotocheckSubido.nombre && n !== wordSubido.nombre
        );
        const aQuitar = [...anteriores, ...conciliar.sobran];
        if (aQuitar.length) {
          drive({ accion: "eliminar", carpetaId: folderId, nombres: aQuitar }).then(
            () => conciliar.sobran.length && consola(`${dni}: ${conciliar.sobran.join(", ")} quitado(s) de la carpeta (RRCC sin "A")`, "ok"),
            (e) => consola(`  no se pudo quitar ${aQuitar.join(", ")} de la carpeta: ${e.message}`, "warn")
          );
        }

        ficha.salida = { ...(ficha.salida || {}), carpetaId: folderId, fotocheck: fotocheckSubido, word: wordSubido };
        if (Array.isArray(enDrive)) {
          ficha.salida.certificados = [...enDrive.filter((c) => !conciliar.sobran.includes(c.nombre)), ...certsSubidos];
        }
        ficha.salidaDesactualizada = false;
        return true;
      } catch (e) {
        consola(`  no se pudo actualizar el fotocheck/Word de ${dni} en Drive: ${e.message}`, "err");
        return false; // sigue desactualizada: se reintenta en el proximo abrir/compartir/descargar
      } finally {
        sincronizacionesEnCurso.delete(dni);
      }
    })();
    sincronizacionesEnCurso.set(dni, tarea);
    return tarea;
  }

  /* ---------------- certificados quitados con la "x" ---------------- */

  /**
   * Certificados de EIN / Drive que se quitaron de la carpeta de la persona,
   * por DNI -> Map(clave del certificado -> nombres de archivo). Vive en la
   * sesion: no se suben al armar la carpeta ni entran al ZIP.
   */
  const excluidos = new Map();
  const excluidosDe = (dni) => new Set(excluidos.get(dni)?.keys() || []);
  const nombresExcluidos = (dni) => new Set([...(excluidos.get(dni)?.values() || [])].flat());

  /**
   * La "x": marca el certificado como quitado, lo saca de lo que ya esta en
   * memoria para el ZIP y, si la persona ya tiene carpeta en Drive, manda a
   * la papelera la copia que haya ahi. Otro toque lo devuelve a la lista.
   */
  async function alternarExcluido(dni, cert, boton) {
    if (!cert) return;
    const clave = claveCertificado(cert);
    const propios = excluidos.get(dni) || new Map();
    excluidos.set(dni, propios);
    if (propios.has(clave)) {
      propios.delete(clave);
      pintarExcluido(dni, clave, false);
      await reincluir(dni, cert, boton);
      return;
    }
    const nombres = nombresEnCarpeta(cert);
    propios.set(clave, nombres);
    pintarExcluido(dni, clave, true);

    const ficha = fichas.get(dni);
    if (ficha?.salida?.archivos) ficha.salida.archivos = ficha.salida.archivos.filter((a) => !nombres.includes(a.nombre));
    const folderId = ficha?.salida?.carpetaId || ficha?.carpetaId;
    if (!folderId) return;
    marcarOcupado(boton, true);
    try {
      const r = await drive({ accion: "eliminar", carpetaId: folderId, nombres });
      if (r.eliminados?.length) consola(`${dni}: ${r.eliminados.join(", ")} enviado(s) a la papelera de Drive`, "ok");
    } catch (e) {
      const viejo = /accion desconocida/i.test(e.message);
      notificar(
        "No se pudo quitar de la carpeta",
        viejo
          ? "El Apps Script publicado no tiene la acción \"eliminar\": hay que volver a desplegar Code.gs. Igual queda fuera del ZIP."
          : `${e.message}. Igual queda fuera del ZIP.`,
        "warn"
      );
    } finally {
      marcarOcupado(boton, false);
    }
  }

  /**
   * Deshacer la "x" cuando la carpeta ya estaba armada: el certificado vuelve
   * al ZIP en memoria y se sube otra vez a Drive, sin regenerar todo.
   */
  async function reincluir(dni, cert, boton) {
    const ficha = fichas.get(dni);
    const folderId = ficha?.salida?.carpetaId || ficha?.carpetaId;
    if (!ficha?.salida || !cert.descargable) return;
    const clave = claveCertificado(cert);
    const deRrcc = certificadosDeRrcc(detalleVisible(ficha)).find((c) => claveCertificado(c.cert) === clave);
    // el de un RRCC "C" o sin tipo no vuelve: solo la "A" va a la carpeta
    if (deRrcc && !deRrcc.entra) return;
    // con el mismo nombre con que lo subio la renovacion, o quedaria dos veces
    const nombre = deRrcc?.archivo || nombreEnCarpeta(cert);
    marcarOcupado(boton, true);
    try {
      const r = await descargarCertificado(cert);
      if (r.sinCertificado) return;
      if (Array.isArray(ficha.salida.archivos) && !ficha.salida.archivos.some((a) => a.nombre === nombre)) {
        ficha.salida.archivos.push({ nombre, datos: r.pdf });
      }
      if (folderId) {
        await drive({ accion: "subir", carpetaId: folderId, nombre, mime: "application/pdf", datos: await blobABase64(new Blob([r.pdf], { type: "application/pdf" })) });
        consola(`${dni}: ${nombre} vuelve a la carpeta de Drive`, "ok");
      }
    } catch (e) {
      notificar("No se pudo volver a agregar el certificado", e.message, "warn");
    } finally {
      marcarOcupado(boton, false);
    }
  }

  function pintarExcluido(dni, clave, fuera) {
    const card = el.resultados.querySelector(`[data-dni="${dni}"]`) || el.resultados;
    card.querySelectorAll(`[data-cert-clave="${CSS.escape(clave)}"]`).forEach((fila) => {
      fila.classList.toggle("excluido", fuera);
      const x = fila.querySelector("[data-cert-x], [data-cert-x-rrcc]");
      if (!x) return;
      x.textContent = fuera ? "↺" : "×";
      x.title = fuera ? "Volver a incluir este certificado" : "Quitar este certificado de la carpeta y del ZIP";
      x.setAttribute("aria-label", x.title);
    });
  }

  /**
   * ZIP de la carpeta de la persona.
   *
   * Camino rapido: los certificados ya se bajaron al armar la carpeta y siguen
   * en memoria (`salida.archivos`), y el fotocheck y el Word se arman aca con
   * lo que muestra la ficha. No se toca Drive: sale en uno o dos segundos. La
   * resubida a Drive de lo editado sigue en segundo plano, sin esperarla.
   *
   * Sin eso en memoria (la ficha viene de antes, o se recargo la pagina) se
   * cae al camino de siempre: listar la carpeta y bajar archivo por archivo
   * por Apps Script. Es lento, por eso muestra cuanto falta.
   */
  async function descargarCarpetaUsuario(dni) {
    const ficha = fichas.get(dni);
    const folderId = ficha?.salida?.carpetaId || ficha?.carpetaId;
    // un tipo A/C cambiado despues de armar la carpeta: el ZIP sale con lo de ahora
    if (ficha) await archivosAlDia(dni, ficha);
    const locales = ficha?.salida?.archivos || [];
    if (!folderId && !locales.length) return;

    const nombre = (ficha?.persona?.nombreCompleto || dni).replace(/[\\/:*?"<>|]+/g, " ").trim() || dni;
    const zip = new JSZip();
    const root = zip.folder(nombre) || zip;
    // la ultima fase (juntar el ZIP) se reparte en `FASE_ZIP` unidades
    const FASE_ZIP = 10;
    let total = 0;
    let hecho = 0;
    const avanzar = (texto, n = 1) => {
      hecho += n;
      mostrarProgreso(dni, "zip", { hecho: Math.min(hecho, total), total, texto });
    };

    try {
      // el fotocheck va solo dentro del Word, no como imagen suelta
      if (locales.length) {
        total = 1 + FASE_ZIP;
        mostrarProgreso(dni, "zip", { hecho: 0, total, texto: "armando el Word…" });
        const docs = await documentosActuales(ficha);
        root.file(docs.nombreWord, docs.docx);
        avanzar("Word listo");
        const fuera = nombresExcluidos(dni);
        for (const a of locales) if (!fuera.has(a.nombre)) root.file(a.nombre, a.datos);
        if (ficha.salidaDesactualizada) sincronizarSalidaEnDrive(dni).catch(() => {});
      } else {
        mostrarProgreso(dni, "zip", { hecho: 0, total: 1, texto: "actualizando la carpeta en Drive…" });
        await sincronizarSalidaEnDrive(dni);
        const lista = await drive({ accion: "listar", carpetaId: folderId });
        const fuera = nombresExcluidos(dni);
        const archivos = (lista.archivos || []).filter((a) => !fuera.has(a.name) && !esImagenFotocheck(a.name));
        total = archivos.length + FASE_ZIP;
        for (const archivo of archivos) {
          const r = await drive({ accion: "bajar", id: archivo.id });
          root.file(archivo.name, desdeBase64(r.datos));
          avanzar(`${archivo.name}`);
        }
      }

      // PDF, PNG y .docx ya vienen comprimidos por dentro: DEFLATE aca solo
      // gasta CPU sin bajar el tamano, y eso pesa mas en un celular que en una PC.
      const base = hecho;
      const blob = await zip.generateAsync({ type: "blob", compression: "STORE" }, (meta) => {
        const n = Math.round((meta.percent / 100) * FASE_ZIP);
        if (base + n > hecho) avanzar("juntando el ZIP…", base + n - hecho);
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${nombre}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      mostrarProgreso(dni, "zip", null);
    }
  }

  /** Anota (o retira) una correccion de un dato de la ficha (EMO, area, nombre,
      cargo, empresa) y refresca lo que depende de ella. */
  function editarDatos(dni, card, cambio) {
    const ficha = fichas.get(dni);
    ficha.salidaDesactualizada = true;
    const base = datosBase(ficha);
    const actual = { ...(ficha.datosEdit || {}), ...cambio };
    for (const k of Object.keys(actual)) if (actual[k] === base[k]) delete actual[k];
    ficha.datosEdit = actual;

    card.querySelector(".campo-emo").classList.toggle("editado", actual.emoVenc !== undefined);
    card.querySelector(".campo-area").classList.toggle("editado", actual.area !== undefined);
    card.querySelector(".campo-lentes")?.classList.toggle("editado", actual.usoLentes !== undefined);
    for (const clave of ["apellidos", "nombres", "cargo", "empresa"]) {
      card.querySelector(`[data-${clave}]`)?.classList.toggle("editado", actual[clave] !== undefined);
    }
    pintarBarraEdicion(card, ficha);
    refrescarFotocheck(dni);
    programarSincronizacion(dni);
  }

  /**
   * Lleva al estado lo que muestra un campo de fecha. `actual()` es el valor
   * que ya tiene el estado y `aplicar(valor)` lo cambia.
   *
   * Un campo de fecha a medio escribir llega vacio (`badInput`): no es "borrar".
   * Al teclear el anio pasa por 0002, 0020, 0202...: esos pasos no se toman
   * (`provisional`); al confirmar se toma lo que haya. Chrome tampoco avisa
   * (ni input ni change) cuando se termina de borrar con el teclado un campo que
   * ya estaba incompleto: solo llegan keyup y blur.
   */
  function enlazarFecha(campo, actual, aplicar) {
    const sincronizar = (provisional) => {
      if (campo.validity.badInput) return;
      if (provisional && campo.value && Number(campo.value.slice(0, 4)) < 2000) return;
      if (campo.value === actual()) return; // ya esta al dia
      aplicar(campo.value);
    };
    campo.addEventListener("input", () => sincronizar(true));
    campo.addEventListener("change", () => sincronizar(false));
    campo.addEventListener("keyup", () => sincronizar(true));
    campo.addEventListener("blur", () => sincronizar(false));
  }

  /** Areas conocidas (para el desplegable del campo AREA). Salen del almacen
      compartido: del listado de personal si alguna pestana ya lo cargo, del
      ultimo catalogo guardado si no, y solo en ultimo caso de la hoja. */
  let areasConocidas = [];
  async function cargarAreas() {
    const guardado = catalogoGuardado();
    if (Array.isArray(guardado?.areas)) areasConocidas = guardado.areas;
    try {
      const catalogo = await obtenerCatalogo();
      areasConocidas = catalogo.areas || areasConocidas;
    } catch {
      /* el campo sigue funcionando a mano */
    }
  }

  /** Tabla de revision: la fila original de Sheets contra el certificado que
      el motor eligio como mas reciente para cada autorizacion A. */
  function tablaComparacion(personaHoja, detalle) {
    const porCodigo = new Map(detalle.map((d) => [d.codigo, d]));
    const filas = (personaHoja?.riesgos || [])
      .filter((r) => r.tipo === "A")
      .map((r) => {
        const d = porCodigo.get(r.codigo);
        const cert = d?.certificado;
        const fechaCert = cert?.fecha || "";
        let contraste = "sin certificado encontrado";
        let clase = "cmp-falta";
        if (fechaCert && r.cap) {
          if (fechaCert > r.cap) {
            contraste = "certificado mÃ¡s reciente";
            clase = "cmp-nuevo";
          } else if (fechaCert === r.cap) {
            contraste = "misma fecha";
            clase = "cmp-igual";
          } else {
            contraste = "certificado anterior";
            clase = "cmp-anterior";
          }
        } else if (fechaCert) {
          contraste = "sin fecha registrada en hoja";
          clase = "cmp-nuevo";
        }
        return `<tr>` +
          `<td><b>${escaparHtml(r.codigo)}</b> · ${escaparHtml(r.rotulo)}</td>` +
          `<td>${aFormatoCorto(r.cap) || "â€”"}<small>vence ${aFormatoCorto(r.venc) || "â€”"}</small></td>` +
          `<td>${fechaCert ? `${aFormatoCorto(fechaCert)}<small>${escaparHtml(cert.curso)} · ${escaparHtml(cert.origen)}</small>` : "â€”"}</td>` +
          `<td class="${clase}">${contraste}</td>` +
          `</tr>`;
      })
      .join("");
    if (!filas) return "";
    return `<section class="comparacion-a"><div class="comparacion-titulo">AUTORIZACIONES A · HOJA VS CERTIFICADO</div>` +
      `<table><thead><tr><th>Riesgo</th><th>Hoja</th><th>Certificado encontrado</th><th>ComparaciÃ³n</th></tr></thead>` +
      `<tbody>${filas}</tbody></table></section>`;
  }

  const textoEstadoFicha = (datos) =>
    datos.cargando
      ? "cargando…"
      : datos.guardando
        ? "guardando…"
        : datos.consulta
          ? "consulta"
          : datos.sinGuardar
            ? "sin guardar en la hoja"
            : "renovado";

  /** La foto de la persona en la cabecera de la ficha. Puede ser un data URL
      (Drive) o el archivo elegido a mano; del archivo se crea una URL una sola
      vez por foto. */
  function pintarFoto(card, datos) {
    const caja = card?.querySelector("[data-foto-persona]");
    if (!caja) return;
    let src = "";
    if (typeof datos.foto === "string") src = datos.foto;
    else if (datos.foto instanceof Blob) {
      if (datos.fotoUrl?.de !== datos.foto) {
        if (datos.fotoUrl) URL.revokeObjectURL(datos.fotoUrl.url);
        datos.fotoUrl = { de: datos.foto, url: URL.createObjectURL(datos.foto) };
      }
      src = datos.fotoUrl.url;
    }
    caja.classList.toggle("card-foto-cargando", !src && !datos.fotoResuelta);
    caja.classList.toggle("card-foto-vacia", !src && Boolean(datos.fotoResuelta));
    caja.innerHTML = src ? `<img src="${src}" alt="Foto" />` : "";
  }

  function pintarFicha(dni, datos) {
    if (!datos.seleccion) datos.seleccion = new Set();
    fichas.set(dni, datos);
    el.panel.hidden = false;

    let card = el.resultados.querySelector(`[data-dni="${dni}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "card card-ficha";
      card.dataset.dni = dni;
      el.resultados.appendChild(card);
    }

    const { detalle = [], alertas = [], salida = null, error = null, inventario = [] } = datos;
    if (error) {
      card.innerHTML =
        `<div class="card-head"><span class="card-dni">${dni}</span>` +
        `<span class="card-nom">${error}</span></div>`;
      return;
    }

    const persona = personaVisible(datos);
    const porCodigo = new Map(detalle.map((d) => [d.codigo, d]));
    const res = datos.resumen || resumenAutorizaciones(detalle);
    const pendientes = datos.ediciones || {};
    const datosEdit = datos.datosEdit || {};

    const tarjetas = persona.riesgos
      .map((r, orden) => {
        const d = porCodigo.get(r.codigo);
        const cert = d?.certificado;
        const nuevo = d && (d.cambio === "NUEVO" || d.cambio === "ACTUALIZADO");
        const { edit, tipo, venc, estado } = visibleDe(datos, r);

        // la vigencia del certificado, no la fecha en que se dio el curso
        const { diferente: fechaDiferente, venceCert } = discrepancia(datos, r.codigo, venc, tipo);
        const contenidoCert =
          `<small>CERTIFICADO · VIGENCIA</small><b>${aFormatoCorto(venceCert) || "sin fecha"}</b>` +
          `<em>curso ${aFormatoCorto(cert?.fecha) || "sin fecha"} · ${escaparHtml(cert?.origen)}</em>`;
        const bloqueCert = datos.cargando
          ? `<span class="rc-cert cargando">BUSCANDO CERTIFICADO…</span>`
          : !cert
          ? `<span class="rc-cert falta">SIN CERTIFICADO</span>`
          : cert.descargable
            ? `<button type="button" class="rc-fecha cert-fecha" data-abrir-cert="${r.codigo}" title="Abrir el certificado (PDF) · ${escaparHtml(cert.curso)} · ${escaparHtml(cert.origen)}">${contenidoCert}</button>`
            : `<span class="rc-fecha cert-fecha" title="${escaparHtml(cert.curso)} · ${escaparHtml(cert.origen)}">${contenidoCert}</span>`;
        // La "x" de la tarjeta: saca este PDF de la carpeta de Drive y del ZIP,
        // igual que la del panel lateral. Comparten la clave del certificado,
        // asi que quitarlo en un lado lo muestra quitado en el otro. Solo
        // cambia lo que se sube: la fecha y la "A" de la hoja no se tocan.
        // En un "C" o sin tipo no aparece: ese certificado no va a la carpeta.
        let certificado = bloqueCert;
        if (!datos.cargando && cert?.descargable) {
          const clave = claveCertificado(cert);
          const fuera = excluidos.get(dni)?.has(clave);
          const tituloX = fuera ? "Volver a incluir este certificado" : "Quitar este certificado de la carpeta y del ZIP";
          certificado =
            `<div class="cert-fila rc-cert-fila${fuera ? " excluido" : ""}" data-cert-clave="${escaparHtml(clave)}">${bloqueCert}` +
            `<button type="button" class="cert-x" data-cert-x-rrcc="${r.codigo}" title="${tituloX}" aria-label="${tituloX}"${tipo === "A" ? "" : " hidden"}>${fuera ? "↺" : "×"}</button></div>`;
        }

        const opciones = ["", "A", "C"];
        if (tipo && !opciones.includes(tipo)) opciones.push(tipo);
        const selector =
          `<select class="${claseTipo(tipo)}" data-tipo="${r.codigo}" aria-label="Tipo de ${escaparHtml(r.rotulo)}" title="A autorizado · C capacitado">` +
          opciones.map((t) => `<option value="${escaparHtml(t)}"${t === tipo ? " selected" : ""}>${escaparHtml(t) || "—"}</option>`).join("") +
          `</select>`;

        return {
          grupo: grupoDe(tipo),
          html:
            `<div class="rc ${CLASE_ESTADO[estado] || "rc-noaplica"}${nuevo ? " rc-nuevo" : ""}${!cert && !datos.cargando ? " rc-sin-cert" : ""}${Object.keys(edit).length ? " rc-editado" : ""}${fechaDiferente ? " rc-fecha-diferente" : ""}" data-codigo="${r.codigo}" data-orden="${orden}">` +
            `<div class="rc-top">` +
            `<label class="rc-sel" title="Seleccionar para aplicar C"${elegibleParaC(datos, r.codigo, tipo) ? "" : " hidden"}>` +
            `<input type="checkbox" data-sel="${r.codigo}" aria-label="Seleccionar ${escaparHtml(r.rotulo)} para aplicar C"${datos.seleccion?.has(r.codigo) ? " checked" : ""} /></label>` +
            `<b>${r.rotulo}</b>${selector}</div>` +
            `<span class="rc-fecha rrcc-fecha"><small>RRCC EN HOJA</small>` +
            `<input type="date" data-venc="${r.codigo}" value="${venc || ""}" aria-label="Vigencia de ${escaparHtml(r.rotulo)}" title="Vigencia en la hoja (editable)" />` +
            `<em data-estado>${estado.toLowerCase()}</em></span>` +
            `${certificado}` +
            (venceCert
              ? `<button type="button" class="rc-usar-cert" data-usar-cert="${r.codigo}"${fechaDiferente ? "" : " hidden"} title="Copia en la hoja la vigencia del certificado (queda como cambio sin guardar)">↻ USAR ${aFormatoCorto(venceCert)}</button>`
              : "") +
            `</div>`,
        };
      });

    // A y C van en sus propias secciones; lo que no tiene tipo queda al final
    const celdas = GRUPOS.map((g) => {
      const propias = tarjetas.filter((t) => t.grupo === g.tipo);
      return (
        `<section class="rrcc-grupo rrcc-grupo-${g.clase}" data-grupo="${g.tipo}"${propias.length ? "" : " hidden"}>` +
        `<div class="rrcc-grupo-head"><b>${g.titulo}</b><span data-grupo-n>${propias.length}</span>` +
        (g.tipo === "A"
          ? ""
          : `<label class="rrcc-grupo-todas" title="Seleccionar todas las tarjetas de este grupo"><input type="checkbox" data-sel-grupo="${g.tipo}" /> SELECCIONAR TODAS</label>`) +
        `</div>` +
        `<div class="rrcc">${propias.map((t) => t.html).join("")}</div></section>`
      );
    }).join("");

    const avisos = alertas
      .map((a) => `<div class="al ${a.nivel === "error" ? "err" : ""}">${a.codigo ? `<b>${a.codigo}</b> · ` : ""}${a.motivo}</div>`)
      .join("");

    const panelFuente = (origen, titulo, vacio = origen) => {
      const items = inventario.filter((i) => i.origen === origen);
      const lista = datos.cargando
        ? `<div class="cert-vacio cert-buscando">buscando…</div>`
        : items.length
        ? items.map((it, i) => {
            const indice = inventario.indexOf(it);
            const estado = it.descargable ? "ABRIR PDF" : "SIN CERTIFICADO";
            const fecha = aFormatoCorto(it.fecha) || (origen === "INDUCCION" ? "" : "sin fecha");
            const clave = claveCertificado(it);
            const fuera = excluidos.get(dni)?.has(clave);
            const tituloX = fuera ? "Volver a incluir este certificado" : "Quitar este certificado de la carpeta y del ZIP";
            // la "x" va aparte del boton que abre el PDF: un <button> no puede ir dentro de otro
            return `<div class="cert-fila${fuera ? " excluido" : ""}" data-cert-clave="${escaparHtml(clave)}">` +
              `<button class="cert-item${it.descargable ? "" : " disabled"}" data-cert="${indice}" ${it.descargable ? "" : "disabled"} title="${escaparHtml(it.archivo || it.curso || "")}">` +
              `<b>${escaparHtml(it.curso || "Certificado")}</b><span>${fecha ? `<time class="cert-dia">${fecha}</time> · ` : ""}${estado}</span></button>` +
              `<button type="button" class="cert-x" data-cert-x="${indice}" title="${tituloX}" aria-label="${tituloX}">${fuera ? "↺" : "×"}</button></div>`;
          }).join("")
        : `<div class="cert-vacio">No se encontraron certificados de ${vacio}.</div>`;
      return `<section class="cert-panel cert-${origen.toLowerCase()}"><div class="cert-head">${titulo}<span>${items.length}</span></div>${lista}</section>`;
    };

    const folderId = datos?.salida?.carpetaId || datos?.carpetaId || salida?.carpetaId;
    const textoWhatsapp = folderId
      ? `Autorización RRCC\n${persona.nombreCompleto || "—"}\nDNI ${persona.dni}\n` +
        `https://drive.google.com/drive/folders/${folderId}`
      : "";
    const mensajeWhatsapp = encodeURIComponent(textoWhatsapp);
    const enlace = folderId
      ? `<a class="btn btn-ghost btn-sm" href="https://drive.google.com/drive/folders/${folderId}" target="_blank" rel="noopener" data-carpeta-abrir="${dni}">ABRIR CARPETA</a>` +
        `<button type="button" class="btn btn-ghost btn-sm" data-carpeta-zip="${dni}">DESCARGAR CARPETA</button>` +
        `<a class="btn btn-ghost btn-sm" href="https://wa.me/?text=${mensajeWhatsapp}" target="_blank" rel="noopener" data-carpeta-whatsapp="${dni}" title="Antes de abrir WhatsApp, actualiza el fotocheck y el Word de la carpeta con lo que se ve ahora en la ficha. El mensaje lleva el link de la carpeta, el DNI y el nombre: solo falta elegir el contacto y enviar">ENVIAR POR WHATSAPP</a>`
      : "";

    /* Lo que importa de un vistazo: de las "A" que la persona tiene, cuantas
       siguen respaldadas por un certificado vigente en las tres fuentes. */
    const trozos = datos.cargando
      ? [`<b class="st-wait">buscando certificados en JOMISER · EIN · Drive…</b>`]
      : [
          `<b class="${res.vigentes.length === res.total ? "st-ok" : "st-err"}">` +
            `${res.vigentes.length}/${res.total}</b> autorizaciones vigentes`,
        ];
    if (res.porVencer.length) trozos.push(`<b class="st-wait">${res.porVencer.length}</b> por vencer`);
    if (res.vencidos.length) trozos.push(`<b class="st-err">${res.vencidos.length}</b> vencidas`);
    if (res.sinCertificado.length) trozos.push(`<b class="st-err">${res.sinCertificado.length}</b> sin certificado`);
    if (res.conCertificadoNuevo) trozos.push(`${res.conCertificadoNuevo} con certificado nuevo`);

    // arriba, fija al desplazarse: identificacion, fotocheck, aplicar C y guardar
    // cambios, para no perderlos de vista mientras se editan tarjetas de abajo
    card.innerHTML =
      `<div class="card-barra">` +
      `<div class="card-id"><span class="card-foto${datos.fotoResuelta || datos.foto ? "" : " card-foto-cargando"}" data-foto-persona title="Foto de la persona (carpeta FOTOS)"></span>` +
      `<span class="card-dni">${persona.dni}</span>` +
      `<span class="item-meta">${persona.codigo || ""}</span>` +
      `<span class="card-n${datos.sinGuardar ? " card-n-error" : ""}" data-card-n>${textoEstadoFicha(datos)}</span>` +
      (datos.sinGuardar && !datos.consulta
        ? `<button type="button" class="btn btn-warn btn-sm" data-reintentar-guardado="${dni}" title="La hoja no recibió esta renovación (${escaparHtml(datos.sinGuardar.error)}). Lo calculado sigue en pantalla: toca para volver a guardarlo">SIN GUARDAR · REINTENTAR</button>`
        : "") +
      `<label class="campo-ficha campo-emo${datosEdit.emoVenc !== undefined ? " editado" : ""}" title="Vencimiento del examen médico (EMO). Se imprime en el fotocheck y se puede corregir aquí; al cambiarlo, la F. Ex. Médico pasa a ser un año antes"><span>EMO VENCE</span>` +
      `<input type="date" data-emo-venc value="${persona.vencimientoEmo || ""}" aria-label="Vencimiento del EMO" /></label>` +
      `<label class="campo-ficha campo-area${datosEdit.area !== undefined ? " editado" : ""}" title="Área de la planilla. Se imprime en el fotocheck y se puede corregir aquí"><span>ÁREA</span>` +
      `<input type="text" id="area-${dni}" data-area value="${escaparHtml(persona.area)}" placeholder="sin área" autocomplete="off" aria-label="Área" /></label>` +
      htmlCampoLentes(datos) +
      (datos.fotoResuelta && !datos.foto
        ? `<button type="button" class="btn btn-warn btn-sm" data-agregar-foto="${dni}" title="No se encontró la foto de esta persona en la carpeta FOTOS de Drive. Toca para tomarla con la cámara o elegirla de la galería">SIN FOTO · AGREGAR</button>`
        : "") +
      `<button type="button" class="btn btn-fotocheck" data-fotocheck="${dni}" aria-pressed="${fotocheckAbiertoDe(dni)}" title="Muestra el fotocheck y lo mantiene al día con las fechas y los tipos que edites">${ICONO_FOTOCHECK}<span data-texto>${textoBotonFotocheck(fotocheckAbiertoDe(dni))}</span></button>` +
      `<button type="button" class="btn btn-ghost btn-sm btn-antiguo" data-antiguo-anverso="${dni}" title="Foto del ANVERSO del carnet físico antiguo. Si es la primera vez, después te pide el reverso; se combinan en una sola imagen debajo del fotocheck nuevo en el Word">${datos.antiguoAnversoFile ? "ANVERSO ✓" : "ANVERSO"}</button>` +
      `<button type="button" class="btn btn-ghost btn-sm btn-antiguo" data-antiguo-reverso="${dni}" title="Foto del REVERSO del carnet físico antiguo. Si es la primera vez, después te pide el anverso; se combinan en una sola imagen debajo del fotocheck nuevo en el Word">${datos.antiguoReversoFile ? "REVERSO ✓" : "REVERSO"}</button>` +
      (datos.antiguoManual ? `<button type="button" class="btn btn-ghost btn-sm" data-antiguo-quitar="${dni}" title="Quitar el fotocheck antiguo adjuntado">QUITAR</button>` : "") +
      `</div>` +
      `<label class="aplicar-c"><span>FECHA C</span><input type="date" data-fecha-c title="Fecha de capacitación que se aplica como C a las tarjetas seleccionadas" /><button class="btn btn-warn btn-sm" data-aplicar-c disabled>APLICAR C</button></label>` +
      `<div class="edicion-barra" data-edicion${cambiosPendientes(datos) ? "" : " hidden"}>` +
      `<span data-edicion-n>${cambiosPendientes(datos)} cambio(s) sin guardar</span>` +
      `<button class="btn btn-warn btn-sm" data-guardar-edicion>GUARDAR CAMBIOS</button>` +
      `<button class="btn btn-ghost btn-sm" data-descartar-edicion>DESCARTAR</button></div>` +
      `<div class="pendientes" data-pendientes></div>` +
      `<div class="card-progresos" data-progresos>${htmlProgresos(datos)}</div>` +
      `</div>` +
      `<div class="card-head card-head-ren">` +
      `<span class="card-nom card-nom-editable">` +
      `<input type="text" data-apellidos class="campo-nom${datosEdit.apellidos !== undefined ? " editado" : ""}" value="${escaparHtml(persona.apellidos)}" placeholder="apellidos" autocomplete="off" aria-label="Apellidos" title="Apellidos. Se imprime en el fotocheck y se puede corregir aquí" />` +
      `<input type="text" data-nombres class="campo-nom${datosEdit.nombres !== undefined ? " editado" : ""}" value="${escaparHtml(persona.nombres)}" placeholder="nombres" autocomplete="off" aria-label="Nombres" title="Nombres. Se imprime en el fotocheck y se puede corregir aquí" />` +
      `<span class="card-nom-sep">·</span>` +
      `<input type="text" data-cargo class="campo-nom campo-nom-cargo${datosEdit.cargo !== undefined ? " editado" : ""}" value="${escaparHtml(persona.cargo)}" placeholder="sin cargo" autocomplete="off" aria-label="Cargo" title="Cargo de planilla. Se imprime en el fotocheck y se puede corregir aquí" />` +
      `<span class="card-nom-sep">·</span>` +
      `<input type="text" data-empresa class="campo-nom campo-nom-cargo${datosEdit.empresa !== undefined ? " editado" : ""}" value="${escaparHtml(persona.empresa)}" placeholder="sin empresa" autocomplete="off" aria-label="Empresa" title="Empresa. Se puede corregir aquí" />` +
      `<span class="card-nom-sep">·</span>` +
      `<span data-estado-final>${htmlEstadoFinal(persona)}</span></span>` +
      `<div class="card-c-lista">${RRCC_CABECERA.map((t, i, a) => `<span>${t}${i < a.length - 1 ? " |" : ""}</span>`).join(" ")}</div>` +
      `<span class="card-res">${trozos.join(" · ")}</span>` +
      `</div>` +
      `<div class="ficha-cuerpo"><section class="rrcc-principal">${celdas}</section>` +
      `<aside class="certificados-lateral">${panelFuente("EIN", "CERTIFICADOS EIN")}${panelFuente("INDUCCION", "CERTIFICADOS INDUCCION", "inducción")}</aside></div>` +
      (avisos ? `<div class="card-alertas">${avisos}</div>` : "") +
      (enlace ? `<div class="card-acciones">${enlace}</div>` : "");
    pintarFoto(card, datos);

    card.querySelector("[data-fotocheck]")?.addEventListener("click", () => alternarFotocheck(dni));
    card.querySelector("[data-reintentar-guardado]")?.addEventListener("click", async () => {
      if (await reintentarGuardado(dni)) {
        notificar("Guardado en la hoja", `${dni} · fila ${fichas.get(dni)?.fila}`, "ok");
      } else {
        notificar("No se pudo guardar", fichas.get(dni)?.sinGuardar?.error || "vuelve a intentarlo en unos segundos", "warn");
      }
    });
    card.querySelector("[data-agregar-foto]")?.addEventListener("click", () => agregarFotoPersona(dni));
    card.querySelector("[data-antiguo-anverso]")?.addEventListener("click", () => elegirLadoAntiguo(dni, "anverso"));
    card.querySelector("[data-antiguo-reverso]")?.addEventListener("click", () => elegirLadoAntiguo(dni, "reverso"));
    card.querySelector("[data-antiguo-quitar]")?.addEventListener("click", () => quitarFotocheckAntiguo(dni));
    card.querySelector("[data-carpeta-abrir]")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const folderId = fichas.get(dni)?.salida?.carpetaId || fichas.get(dni)?.carpetaId;
      if (!folderId) return;
      const boton = ev.currentTarget;
      marcarOcupado(boton, true); // respuesta al toque: lo normal es que ya este sincronizado y esto dure un instante
      try {
        if (!(await sincronizarSalidaEnDrive(dni))) {
          notificar("No se pudo actualizar la carpeta", "Se abre igual, pero podría no traer los últimos cambios de la ficha.", "warn");
        }
        window.open(`https://drive.google.com/drive/folders/${folderId}`, "_blank", "noopener,noreferrer");
      } finally {
        marcarOcupado(boton, false);
      }
    });
    card.querySelector("[data-carpeta-whatsapp]")?.addEventListener("click", async (ev) => {
      ev.preventDefault();
      const href = ev.currentTarget.href;
      const boton = ev.currentTarget;
      marcarOcupado(boton, true);
      try {
        if (!(await sincronizarSalidaEnDrive(dni))) {
          notificar("No se pudo actualizar la carpeta", "Se comparte igual, pero podría no traer los últimos cambios de la ficha.", "warn");
        }
        // El navegador suele bloquear window.open() aca porque ya pasamos por un
        // await (sincronizarSalidaEnDrive): para cuando se llama, el clic que lo
        // habilitaba ya no cuenta como gesto del usuario. Si lo bloquea, se copia
        // el mensaje para que se pueda pegar y compartir a mano.
        let ventana = null;
        try {
          ventana = window.open(href, "_blank", "noopener,noreferrer");
        } catch {
          ventana = null;
        }
        if (!ventana) {
          const copiado = await copiarTexto(textoWhatsapp);
          notificar(
            copiado ? "WhatsApp no se pudo abrir" : "No se pudo abrir WhatsApp ni copiar el mensaje",
            copiado ? "Se copió el mensaje: pégalo donde quieras compartirlo." : "Copia a mano el enlace de la carpeta.",
            "warn"
          );
        }
      } finally {
        marcarOcupado(boton, false);
      }
    });
    card.querySelector("[data-carpeta-zip]")?.addEventListener("click", async (ev) => {
      const boton = ev.currentTarget;
      marcarOcupado(boton, true);
      try {
        await descargarCarpetaUsuario(dni);
      } catch (e) {
        notificar("No se pudo descargar la carpeta", e.message, "warn");
      } finally {
        // el boton pudo cambiar si la ficha se repinto mientras tanto
        marcarOcupado(boton, false);
        marcarOcupado(el.resultados.querySelector(`[data-carpeta-zip="${dni}"]`), false);
      }
    });

    const campoEmo = card.querySelector("[data-emo-venc]");
    enlazarFecha(campoEmo, () => datosVisibles(fichas.get(dni)).emoVenc, (valor) => editarDatos(dni, card, { emoVenc: valor }));
    const campoArea = card.querySelector("[data-area]");
    const sincronizarArea = () => {
      const valor = campoArea.value.trim();
      if (valor !== datosVisibles(fichas.get(dni)).area) editarDatos(dni, card, { area: valor });
    };
    for (const evento of ["input", "change", "blur"]) campoArea.addEventListener(evento, sincronizarArea);
    autocompletar(campoArea, { obtener: () => areasConocidas, nombre: "áreas" });
    const campoLentes = card.querySelector("[data-lentes]");
    campoLentes?.addEventListener("change", () => editarDatos(dni, card, { usoLentes: campoLentes.value }));

    // apellidos, nombres, cargo y empresa: mismo patron de sincronizacion que area
    for (const [selector, clave] of [
      ["[data-apellidos]", "apellidos"],
      ["[data-nombres]", "nombres"],
      ["[data-cargo]", "cargo"],
      ["[data-empresa]", "empresa"],
    ]) {
      const campo = card.querySelector(selector);
      const sincronizar = () => {
        const valor = campo.value.trim();
        if (valor !== datosVisibles(fichas.get(dni))[clave]) editarDatos(dni, card, { [clave]: valor });
      };
      for (const evento of ["input", "change", "blur"]) campo.addEventListener(evento, sincronizar);
    }
    card.querySelectorAll("[data-cert]").forEach((boton) => {
      boton.addEventListener("click", () => abrirCertificado(fichas.get(dni)?.inventario?.[Number(boton.dataset.cert)]));
    });
    card.querySelectorAll("[data-cert-x]").forEach((boton) => {
      boton.addEventListener("click", () =>
        alternarExcluido(dni, fichas.get(dni)?.inventario?.[Number(boton.dataset.certX)], boton)
      );
    });
    card.querySelectorAll("[data-cert-x-rrcc]").forEach((boton) => {
      boton.addEventListener("click", () =>
        alternarExcluido(dni, fichas.get(dni)?.detalle?.find((d) => d.codigo === boton.dataset.certXRrcc)?.certificado, boton)
      );
    });
    card.querySelectorAll("[data-abrir-cert]").forEach((boton) => {
      boton.addEventListener("click", () => {
        abrirCertificado(fichas.get(dni)?.detalle?.find((d) => d.codigo === boton.dataset.abrirCert)?.certificado);
      });
    });
    card.querySelector("[data-aplicar-c]")?.addEventListener("click", () => aplicarC(dni, card));

    card.querySelectorAll("input[data-sel]").forEach((caja) => {
      caja.addEventListener("change", () => {
        const f = fichas.get(dni);
        if (caja.checked) f.seleccion.add(caja.dataset.sel);
        else f.seleccion.delete(caja.dataset.sel);
        actualizarSeleccion(card, f);
      });
    });
    card.querySelectorAll("input[data-sel-grupo]").forEach((caja) => {
      caja.addEventListener("change", () => {
        const f = fichas.get(dni);
        for (const c of caja.closest(".rrcc-grupo").querySelectorAll(".rc-sel:not([hidden]) input")) {
          if (caja.checked) f.seleccion.add(c.dataset.sel);
          else f.seleccion.delete(c.dataset.sel);
        }
        actualizarSeleccion(card, f);
      });
    });
    actualizarSeleccion(card, datos);
    refrescarFotocheck(dni);

    card.querySelectorAll("select[data-tipo]").forEach((sel) => {
      sel.addEventListener("change", () => {
        const codigo = sel.dataset.tipo;
        if (sel.value !== "") {
          editar(dni, card, codigo, { tipo: sel.value });
          return;
        }
        // sin A ni C no hay vigencia: el campo de fecha tambien queda en blanco
        card.querySelector(`input[data-venc="${codigo}"]`).value = "";
        editar(dni, card, codigo, { tipo: "", venc: "" });
      });
    });
    card.querySelectorAll("input[data-venc]").forEach((campo) => {
      const codigo = campo.dataset.venc;
      enlazarFecha(
        campo,
        () => {
          const ficha = fichas.get(dni);
          return visibleDe(ficha, filaDeHoja(ficha).riesgos.find((x) => x.codigo === codigo)).venc;
        },
        (valor) => editar(dni, card, codigo, { venc: valor })
      );
    });
    card.querySelectorAll("[data-usar-cert]").forEach((boton) => {
      boton.addEventListener("click", () => {
        const codigo = boton.dataset.usarCert;
        const ficha = fichas.get(dni);
        const { venceCert } = discrepancia(ficha, codigo, "", "A");
        if (!venceCert) return;
        const campo = card.querySelector(`input[data-venc="${codigo}"]`);
        if (campo) campo.value = venceCert;
        editar(dni, card, codigo, { venc: venceCert });
        const celda = card.querySelector(`.rc[data-codigo="${codigo}"]`);
        celda?.classList.remove("rc-corregido");
        void celda?.offsetWidth;
        celda?.classList.add("rc-corregido");
      });
    });
    pintarPendientes(card, datos);

    // mientras llegan los certificados la ficha solo se mira: lo que se
    // editara ahora se perderia al pintarla completa
    card.classList.toggle("ficha-cargando", Boolean(datos.cargando));
    if (datos.cargando) {
      for (const control of card.querySelectorAll("input, select, button:not([data-fotocheck])")) control.disabled = true;
    }

    card.querySelector("[data-guardar-edicion]").addEventListener("click", () => guardarEdiciones(dni, card));
    card.querySelector("[data-descartar-edicion]").addEventListener("click", () => {
      fichas.get(dni).ediciones = {};
      fichas.get(dni).datosEdit = {};
      pintarFicha(dni, fichas.get(dni));
    });
  }

  /**
   * Mensaje de confirmacion de un guardado. Sale de lo que la hoja tiene AHORA
   * (la fila releida despues de guardar), no de lo que se envio: si algo no
   * quedo igual, se avisa en vez de dar el guardado por bueno.
   */
  function confirmarGuardado(guardado, codigos, titulo, columnas = []) {
    const hoja = leerFila(guardado.valores);
    const lineas = codigos.map((codigo) => {
      const r = hoja.riesgos.find((x) => x.codigo === codigo);
      return `${r.rotulo}: ${r.tipo || "sin tipo"}${r.venc ? ` · vigencia ${aFormatoCorto(r.venc)}` : " · sin vigencia"}`;
    });
    if (columnas.includes("F. Vencimiento")) lineas.push(`EMO vence ${aFormatoCorto(hoja.vencimientoEmo) || "sin fecha"}`);
    if (columnas.includes("F. Ex. Medico")) lineas.push(`Examen médico ${aFormatoCorto(hoja.examenMedico) || "sin fecha"}`);
    if (columnas.includes("Area Planilla")) lineas.push(`Área: ${hoja.area || "vacía"}`);
    if (columnas.includes("Apellidos") || columnas.includes("Nombres")) lineas.push(`Nombre: ${hoja.nombreCompleto || "vacío"}`);
    if (columnas.includes("Cargo Planilla")) lineas.push(`Cargo: ${hoja.cargo || "vacío"}`);
    if (columnas.includes("EMPRESA")) lineas.push(`Empresa: ${hoja.empresa || "vacía"}`);
    if (columnas.includes("USO DE LENTES")) lineas.push(`Uso de lentes: ${hoja.usoLentes || "vacío"}`);
    const dif = guardado.diferencias.map(
      (d) => `${d.codigo} ${d.campo}: se pidió ${aFormatoCorto(d.esperado) || d.esperado || "vacío"}, la hoja tiene ${aFormatoCorto(d.real) || d.real || "vacío"}`
    );

    consola(`${titulo} · fila ${guardado.fila} de la hoja`, guardado.confirmado ? "ok" : "warn");
    for (const l of lineas) consola(`   ${l}`, "ok");
    if (guardado.recuperado) consola("Google devolvió una respuesta dañada, pero al releer la hoja el cambio ya estaba guardado", "warn");
    for (const c of guardado.formulaReemplazada) consola(`   la celda "${c}" tenía una fórmula en la hoja: quedó reemplazada por el valor escrito`, "warn");
    for (const d of dif) consola(`   ✕ ${d}`, "err");

    const resumen = lineas.slice(0, 3).join(" · ") + (lineas.length > 3 ? ` · +${lineas.length - 3} más` : "");
    if (guardado.confirmado) {
      notificar(
        "Guardado y confirmado en la hoja",
        `Fila ${guardado.fila} · ${resumen}${guardado.recuperado ? " (la respuesta de Google llegó dañada, pero la hoja ya lo tiene)" : ""}`,
        "ok"
      );
    } else {
      notificar("Guardado, pero la hoja no coincide", `Fila ${guardado.fila} · ${dif[0]}${dif.length > 1 ? ` (+${dif.length - 1} más)` : ""}`, "warn");
    }
  }

  /**
   * Vuelve a guardar una renovacion cuya fila no llego a la hoja (Apps Script
   * saturado). Se escribe `ficha.valores`, que es lo calculado: las
   * correcciones a mano que aun no se guardaron siguen como cambios pendientes.
   * Devuelve true si la hoja ya lo tiene.
   */
  async function reintentarGuardado(dni, { senal } = {}) {
    const ficha = fichas.get(dni);
    if (!ficha?.sinGuardar) return true;
    if (!ficha.fila || !Array.isArray(ficha.valores) || !ficha.persona?.dni) return false;
    const card = el.resultados.querySelector(`[data-dni="${dni}"]`);
    const boton = card?.querySelector("[data-reintentar-guardado]");
    if (boton) boton.disabled = true;
    ficha.guardando = true;
    const n = card?.querySelector("[data-card-n]");
    if (n) n.textContent = textoEstadoFicha(ficha);
    try {
      await guardarFilaVerificada({
        fila: ficha.fila,
        valores: ficha.valores,
        dni: ficha.persona.dni,
        codigos: CODIGOS_RRCC,
        senal,
        releer: "si-falla",
      });
      ficha.sinGuardar = null;
      consola(`[${dni}] fila guardada en la hoja`, "ok");
      return true;
    } catch (e) {
      if (senal?.aborted) return false; // abortado: sigue sin guardar
      ficha.sinGuardar = { error: e.message };
      consola(`[${dni}] la fila sigue sin guardarse en la hoja: ${e.message}`, "err");
      return false;
    } finally {
      ficha.guardando = false;
      if (fichas.get(dni) === ficha) pintarFicha(dni, ficha);
    }
  }

  /** Escribe en la hoja lo corregido a mano y deja la ficha con la fila nueva. */
  async function guardarEdiciones(dni, card) {
    const ficha = fichas.get(dni);
    const ediciones = ficha?.ediciones || {};
    const datosEdit = ficha?.datosEdit || {};
    if (!ficha?.fila || !Array.isArray(ficha.valores) || !cambiosPendientes(ficha)) return;

    // el navegador acepta anios como 0002 mientras se teclea; no se guardan
    const mala = Object.entries(ediciones).find(([, e]) => e.venc && !/^20\d\d-/.test(e.venc));
    if (mala) {
      notificar("Vigencia no válida", `${mala[0]}: revisa el año de la fecha`, "warn");
      return;
    }
    if (datosEdit.emoVenc && !/^20\d\d-/.test(datosEdit.emoVenc)) {
      notificar("Vigencia no válida", "EMO: revisa el año de la fecha", "warn");
      return;
    }

    const botones = card.querySelectorAll("[data-guardar-edicion], [data-descartar-edicion]");
    botones.forEach((b) => (b.disabled = true));
    try {
      const valores = aplicarEdicionesManuales(ficha.valores, ediciones, { config: contexto?.config });
      const codigos = Object.keys(ediciones);
      // vencimiento del EMO, area, nombre, cargo y empresa: columnas de A:O que se envian aparte
      const datos = {};
      if (datosEdit.emoVenc !== undefined) datos["F. Vencimiento"] = datosEdit.emoVenc;
      // el examen un anio antes del vencimiento, igual que en el fotocheck
      if (datosEdit.emoVenc) datos["F. Ex. Medico"] = sumarAnios(datosEdit.emoVenc, -1);
      if (datosEdit.area !== undefined) datos["Area Planilla"] = datosEdit.area;
      if (datosEdit.apellidos !== undefined) datos["Apellidos"] = datosEdit.apellidos.toUpperCase();
      if (datosEdit.nombres !== undefined) datos["Nombres"] = datosEdit.nombres.toUpperCase();
      if (datosEdit.cargo !== undefined) datos["Cargo Planilla"] = datosEdit.cargo;
      if (datosEdit.empresa !== undefined) datos["EMPRESA"] = datosEdit.empresa;
      if (datosEdit.usoLentes !== undefined) datos["USO DE LENTES"] = datosEdit.usoLentes;
      for (const [columna, valor] of Object.entries(datos)) valores[INDICE[columna]] = valor;
      // Un Code.gs sin redesplegar todavia no deja escribir las columnas que
      // se sumaron despues (el examen, el uso de lentes): rechaza el guardado
      // entero. Se quita la que rechazo, se avisa y se guarda lo demas.
      // El uso de lentes que no entro queda como cambio sin guardar (el examen
      // no: sale del EMO, que si se guarda).
      const RECIENTES = { "F. Ex. Medico": "el examen médico", "USO DE LENTES": "el uso de lentes" };
      const quedanPendientes = {};
      let guardado;
      for (;;) {
        try {
          guardado = await guardarFilaVerificada({ fila: ficha.fila, valores, dni: ficha.persona.dni, codigos, datos });
          break;
        } catch (e) {
          const columna = Object.keys(RECIENTES).find(
            (c) => datos[c] !== undefined && e.message.includes(`no editable desde la app: ${c}`)
          );
          if (!columna) throw e;
          delete datos[columna];
          valores[INDICE[columna]] = ficha.valores[INDICE[columna]];
          if (columna === "USO DE LENTES") quedanPendientes.usoLentes = datosEdit.usoLentes;
          const aviso = `${RECIENTES[columna]} no se escribió en la hoja: falta redesplegar Apps Script (Code.gs)`;
          if (!codigos.length && !Object.keys(datos).length) throw new Error(aviso);
          consola(aviso, "warn");
        }
      }

      // se vuelve a calcular contra los certificados, sin red, para que los
      // estados y el resumen salgan con la fila tal como quedo en la hoja
      const r = renovarFila({
        fila: guardado.valores,
        items: ficha.inventario,
        diccionario: contexto.diccionario,
        config: contexto.config,
      });
      ficha.valores = guardado.valores;
      ficha.persona = leerFila(guardado.valores);
      ficha.sinGuardar = null; // se escribio la fila entera: la renovacion tambien quedo
      ficha.detalle = r.detalle;
      ficha.alertas = r.alertas;
      ficha.resumen = resumenAutorizaciones(r.detalle);
      ficha.ediciones = {};
      ficha.datosEdit = { ...quedanPendientes };
      normalizarCambiosPendientes(ficha, { baseRiesgo, baseDatos: datosBase });
      pintarFicha(dni, ficha);
      const partes = [];
      if (codigos.length) partes.push(`${codigos.length} riesgo(s)`);
      if (datos["F. Vencimiento"] !== undefined) partes.push("EMO");
      if (datos["Area Planilla"] !== undefined) partes.push("área");
      if (datos["Apellidos"] !== undefined || datos["Nombres"] !== undefined) partes.push("nombre");
      if (datos["Cargo Planilla"] !== undefined) partes.push("cargo");
      if (datos["EMPRESA"] !== undefined) partes.push("empresa");
      if (datos["USO DE LENTES"] !== undefined) partes.push("uso de lentes");
      confirmarGuardado(guardado, codigos, `${partes.join(" + ")} corregido(s) a mano`, Object.keys(datos));
    } catch (e) {
      botones.forEach((b) => (b.disabled = false));
      notificar("No se pudo guardar", e.message, "warn");
      consola(`no se pudo guardar la edición: ${e.message}`, "err");
    }
  }

  async function aplicarC(dni, card) {
    const ficha = fichas.get(dni);
    const fecha = card.querySelector("[data-fecha-c]")?.value || "";
    const boton = card.querySelector("[data-aplicar-c]");
    if (!ficha?.fila || !Array.isArray(ficha.valores)) return;

    // solo las tarjetas seleccionadas; sin seleccion no se hace nada
    const elegidas = ficha.persona.riesgos
      .filter((r) => ficha.seleccion?.has(r.codigo) && elegibleParaC(ficha, r.codigo, visibleDe(ficha, r).tipo))
      .map((r) => r.codigo);
    if (!elegidas.length) {
      notificar("Selecciona tarjetas", "APLICAR C solo actúa sobre las tarjetas seleccionadas", "warn");
      return;
    }

    boton.disabled = true;
    try {
      const valores = aplicarCapacitacionC(ficha.valores, fecha, { solo: elegidas });
      const guardado = await guardarFilaVerificada({ fila: ficha.fila, valores, dni: ficha.persona.dni, codigos: elegidas });
      ficha.valores = guardado.valores;
      ficha.persona = leerFila(guardado.valores);
      ficha.sinGuardar = null; // se escribio la fila entera: la renovacion tambien quedo
      ficha.seleccion = new Set();
      ficha.salidaDesactualizada = true;
      fichas.set(dni, ficha);
      pintarFicha(dni, ficha);
      programarSincronizacion(dni, 0);
      confirmarGuardado(guardado, elegidas, `C aplicada a ${elegidas.length} tarjeta(s)${fecha ? ` con fecha ${aFormatoCorto(fecha)}` : " (campos limpiados)"}`);
    } catch (e) {
      actualizarSeleccion(card, ficha);
      notificar("No se pudo aplicar C", e.message, "warn");
      consola(`no se pudo aplicar C: ${e.message}`, "err");
    }
  }

  /**
   * El certificado se abre en una capa a pantalla completa por encima de todo
   * y se cierra con VOLVER o Escape. La ficha de atras no se toca, asi las
   * ediciones sin guardar siguen ahi al regresar.
   *
   * Al cerrar, la capa NO se destruye: se oculta y queda guardada por
   * certificado. Aunque el PDF ya este en memoria (`descargarCertificado`),
   * un <iframe> nuevo obliga al navegador a volver a abrir y dibujar el PDF
   * desde cero, y eso es lo que se veia como "carga de nuevo". Reabrir
   * muestra la misma capa, con el PDF ya dibujado y en la pagina donde se
   * dejo. Todo vive en memoria: al recargar la pagina se pierde.
   */
  const visores = new Map(); // clave del certificado -> { visor, url, listo }
  const MAX_VISORES = 15;
  let visorAbierto = null;

  function cerrarVisor() {
    if (!visorAbierto) return;
    const { entrada, previo } = visorAbierto;
    visorAbierto = null;
    document.removeEventListener("keydown", alTeclearVisor);
    if (entrada.listo) {
      entrada.visor.hidden = true;
    } else {
      // un error o una carga a medias no se guarda: la proxima vez se reintenta
      if (entrada.url) URL.revokeObjectURL(entrada.url);
      entrada.visor.remove();
      visores.delete(entrada.clave);
    }
    previo?.focus?.();
  }

  function alTeclearVisor(ev) {
    if (ev.key === "Escape") cerrarVisor();
  }

  async function abrirCertificado(cert) {
    if (!cert?.descargable) return;
    cerrarVisor();
    const previo = document.activeElement;
    const clave = claveCertificado(cert);

    let entrada = visores.get(clave);
    if (entrada) {
      // al final del Map = el usado mas recientemente
      visores.delete(clave);
      visores.set(clave, entrada);
    } else {
      const visor = document.createElement("div");
      visor.className = "visor-modal";
      visor.setAttribute("role", "dialog");
      visor.setAttribute("aria-modal", "true");
      visor.setAttribute("aria-label", "Certificado");
      visor.innerHTML =
        `<div class="visor-head"><button class="btn btn-ghost btn-sm" data-volver>← VOLVER</button>` +
        `<span class="visor-titulo">${escaparHtml(cert.curso)} · ${escaparHtml(cert.origen)}</span>` +
        `<button class="btn btn-ghost btn-sm" data-descargar hidden>DESCARGAR</button></div>` +
        `<div class="visor-carga">Cargando certificado...</div>`;
      visor.querySelector("[data-volver]").addEventListener("click", cerrarVisor);
      document.body.appendChild(visor);
      entrada = { clave, visor, url: "", listo: false };
      visores.set(clave, entrada);

      // los mas viejos se sueltan para no acumular PDFs dibujados sin limite
      while (visores.size > MAX_VISORES) {
        const [claveVieja, vieja] = visores.entries().next().value;
        visores.delete(claveVieja);
        if (vieja.url) URL.revokeObjectURL(vieja.url);
        vieja.visor.remove();
      }
    }

    entrada.visor.hidden = false;
    visorAbierto = { entrada, previo };
    document.addEventListener("keydown", alTeclearVisor);
    entrada.visor.querySelector("[data-volver]").focus();
    if (entrada.listo) return;

    try {
      const r = await descargarCertificado(cert);
      if (visores.get(clave) !== entrada) return; // se cerro y se descarto
      if (r.sinCertificado) throw new Error(r.motivo || "sin certificado emitido");
      // en el celular el PDF se dibuja con pdf.js: un <iframe> ahi no se ve
      const { url } = await montarPdf(entrada.visor.querySelector(".visor-carga"), r.pdf, { titulo: cert.curso || "Certificado" });
      if (visores.get(clave) !== entrada) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      entrada.url = url;
      const descargar = entrada.visor.querySelector("[data-descargar]");
      descargar.hidden = false;
      descargar.addEventListener("click", () =>
        descargarBlob(
          new Blob([r.pdf], { type: "application/pdf" }),
          `${(cert.archivo || cert.curso || "certificado").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, " ")}.pdf`
        )
      );
      entrada.listo = true;
    } catch (e) {
      if (visores.get(clave) !== entrada) return;
      entrada.visor.querySelector(".visor-carga").outerHTML =
        `<div class="visor-error">No se pudo abrir el certificado: ${escaparHtml(e.message)}</div>`;
    }
  }

  /* ---------------- corrida ---------------- */

  /**
   * `soloConsulta` recorre las mismas fuentes pero no escribe en la hoja ni
   * crea nada en Drive: sirve para mirar a una persona y ver de un vistazo
   * si sus "A" siguen respaldadas por un certificado vigente.
   */
  async function ejecutar({ soloConsulta = false } = {}) {
    const lista = objetivos();
    if (!lista.length) {
      consola(soloConsulta ? "escribe al menos un documento" : "no hay documentos que renovar", "warn");
      el.dnis.focus();
      return;
    }

    corriendo = true;
    abortador = new AbortController();
    const senal = abortador.signal;

    el.run.disabled = true;
    el.stop.hidden = false;
    barra.mostrar(true);
    consola.limpiar();
    el.resultados.innerHTML = "";
    fichas.clear();
    cerrarFotocheck();

    consola.cabecera(`${soloConsulta ? "CONSULTA" : "RENOVACION"} · ${lista.length} persona(s)`);
    if (soloConsulta) consola("modo consulta: no se escribe en la hoja ni en Drive", "info");

    let hechas = 0;
    let conSalida = 0;
    let fallos = 0;
    const nuevos = [];

    /* Con varios DNI la corrida va en dos etapas:
         1. FICHAS: por cada persona se lee su fila, se cruzan sus certificados,
            se pintan las fechas y se guarda. Es lo que se espera ver primero.
         2. CARPETAS: recien con todas las fichas en pantalla se arma la
            carpeta de Drive de cada una (vaciar, foto, subidas).
       Mientras dura la etapa 1 el carril de fondo de la cola de Apps Script
       queda retenido: una subida de varios MB en el aire dejaba el guardado de
       la persona siguiente esperando hasta agotar el tiempo, y esa persona se
       perdia. Con un solo DNI no hay a quien darle prioridad: su carpeta se
       prepara mientras se buscan sus certificados, como siempre. */
    const varias = lista.length > 1;
    const conSalidas = !soloConsulta && el.salidas.checked;
    const soltarFondo = varias ? retenerFondo() : () => {};
    const porArmar = []; // etapa 2, en orden
    const conError = []; // DNIs que fallaron en la etapa 1: se reintentan una vez al final de ella
    const sinGuardar = []; // fichas calculadas cuya fila no se pudo guardar: se reintenta al final
    const sinFoto = []; // la lectura publica no tenia su foto: se le pide a Apps Script en la etapa 2

    const contar = () => {
      el.resCount.textContent =
        `${hechas}/${lista.length}` + (soloConsulta ? " consultada(s)" : ` · ${conSalida} con salidas`);
    };

    /** Etapa 1 de una persona. Devuelve "ok" | "nuevo" | "error" | "abortado". */
    async function procesar(obj, { inventario = null, reintento = false } = {}) {
      barra.set(hechas, lista.length, `${obj.dni} · leyendo`);
      if (conSalidas) salidasPendientes.add(obj.dni);

      try {
        // el fotocheck antiguo adjuntado a mano (botones de la ficha) no viene
        // de esta corrida: se rescata de la ficha anterior para no perderlo,
        // anverso y reverso por separado (por si luego se reemplaza uno solo).
        const anterior = fichas.get(obj.dni);
        const antiguoManual = anterior?.antiguoManual || null;
        const antiguoAnversoFile = anterior?.antiguoAnversoFile || null;
        const antiguoReversoFile = anterior?.antiguoReversoFile || null;
        // igual que el antiguo: si la foto se agrego a mano y la subida a
        // FOTOS fallo (o Drive todavia no la indexa), no se pierde al
        // volver a correr la lista.
        const fotoManual = anterior?.fotoManual || null;

        // La foto solo necesita el DNI: se pide YA, en paralelo con la hoja y
        // el inventario de certificados, para que el fotocheck se vea con su
        // foto apenas se pinta la ficha y no al final de las subidas. En un
        // lote solo la lectura publica (no hace fila detras de Apps Script);
        // la consulta a Apps Script, que es lenta, queda para la etapa 2.
        const fotoP = fotoDeDni(obj.dni, senal, { soloPublica: varias }).catch(() => null);
        // la foto se pinta en cuanto llega, en la ficha que haya en ese
        // momento (la preliminar o la completa)
        fotoP.then((foto) => {
          const actual = fichas.get(obj.dni);
          if (!foto || !actual?.persona || actual.foto) return;
          actual.foto = foto;
          pintarFoto(el.resultados.querySelector(`[data-dni="${obj.dni}"]`), actual);
          refrescarFotocheck(obj.dni);
        });
        let antiguoP = null;
        const comunes = () => ({
          ediciones: {},
          datosEdit: {},
          seleccion: new Set(),
          consulta: soloConsulta,
          antiguoManual,
          antiguoAnversoFile,
          antiguoReversoFile,
          antiguo: antiguoManual,
          fotoManual,
          foto: fichas.get(obj.dni)?.foto || null,
        });
        // Etapa 1: la fila de la hoja ya se leyo. Se pinta la ficha con sus
        // datos y fechas (solo para mirar) mientras llegan los certificados.
        let carpeta = null;
        const alLeer = (p, registro) => {
          // Un solo DNI: su carpeta de Drive se vacia ya, para que al terminar
          // tenga solo lo que suba esta renovacion. En un lote eso lo hace la
          // etapa 2, para no quitarle el turno a las fichas.
          if (conSalidas && !varias) carpeta = vaciarCarpeta(p, contexto, { log: consola, senal });
          // el fotocheck antiguo depende de la fila: la lectura publica sale
          // ya; si hay que pedirselo a Apps Script, en un lote espera a la etapa 2
          if (!antiguoManual && p.fotocheckAntiguoDriveId) {
            antiguoP = fotoAntigua(p.fotocheckAntiguoDriveId, senal, { fondo: varias }).catch(() => null);
          }
          if (!registro?.valores) return;
          pintarFicha(obj.dni, {
            ...comunes(),
            persona: p,
            detalle: [],
            alertas: [],
            inventario: [],
            fila: registro.fila,
            valores: registro.valores,
            cargando: true,
          });
        };
        // Etapa 2: certificados cruzados con la hoja. Se pinta la ficha
        // completa sin esperar a que la escritura termine de hacer fila en
        // Apps Script; la cabecera dice "guardando…" hasta que confirme.
        let ficha = null;
        const alCalcular = (parcial) => {
          ficha = {
            ...comunes(),
            persona: parcial.despues,
            detalle: parcial.detalle,
            alertas: parcial.alertas,
            resumen: soloConsulta ? resumenAutorizaciones(parcial.detalle) : undefined,
            inventario: parcial.inventario?.items || [],
            fila: parcial.fila,
            valores: parcial.enHoja,
            guardando: !soloConsulta && el.escribir.checked,
          };
          pintarFicha(obj.dni, ficha);
        };

        let r;
        let errorGuardado = null;
        try {
          r = soloConsulta
            ? await consultarPersona(obj.dni, contexto, { log: consola, senal, alLeer, alCalcular, inventario })
            : await renovarPersona(obj.dni, contexto, {
                log: consola,
                senal,
                escribir: el.escribir.checked,
                alLeer,
                alCalcular,
                inventario,
                // en un lote la lista no se frena reintentando: si falla, la
                // ficha queda "sin guardar" y se vuelve a guardar al final
                reintentosGuardado: varias ? 0 : undefined,
              });
        } catch (e) {
          // La fila no se pudo guardar, pero la renovacion esta calculada: la
          // ficha se queda en pantalla con lo calculado (antes se perdia y se
          // saltaba al DNI siguiente) y el guardado se reintenta al final.
          if (!e.resultado || senal.aborted) throw e;
          r = e.resultado;
          errorGuardado = e;
        }

        if (r.estado === "nuevo") {
          nuevos.push(obj.dni);
          salidasPendientes.delete(obj.dni);
          pintarFicha(obj.dni, { error: "no está en la base — usa la pestaña NUEVO PERSONAL" });
          return "nuevo";
        }

        if (!ficha) alCalcular(r);
        ficha.resumen = r.resumen;
        if (errorGuardado) {
          // lo calculado es lo que le falta a la hoja: es lo que se reintenta
          // guardar, y la base de cualquier correccion a mano
          ficha.valores = r.valores;
          ficha.sinGuardar = { error: errorGuardado.causa?.message || errorGuardado.message };
          sinGuardar.push(obj.dni);
          consola(`  ${errorGuardado.message}`, "err");
          consola("  la ficha queda en pantalla con lo calculado; el guardado se reintenta al terminar la lista", "warn");
        }
        if (ficha.guardando) {
          ficha.guardando = false;
          const n = el.resultados.querySelector(`[data-dni="${obj.dni}"] [data-card-n]`);
          if (n) n.textContent = textoEstadoFicha(ficha);
        }
        if (r.resumen) {
          consola(
            `${r.resumen.vigentes.length}/${r.resumen.total} autorizaciones vigentes` +
              (r.resumen.vencidos.length ? ` · ${r.resumen.vencidos.length} vencida(s)` : "") +
              (r.resumen.porVencer.length ? ` · ${r.resumen.porVencer.length} por vencer` : ""),
            r.resumen.vigentes.length === r.resumen.total ? "ok" : "warn"
          );
        }

        // Drive no tenia la foto (o no se pudo bajar): si se habia agregado
        // a mano en una corrida anterior, se usa esa en vez de dejar la
        // ficha sin foto. `fotoResuelta` recien queda en true cuando se sabe
        // si hay foto o no: la tarjeta no debe ofrecer "agregar foto"
        // mientras se sigue buscando. En un lote, si la lectura publica no la
        // tenia, falta preguntarle a Apps Script (etapa 2).
        ficha.foto = ficha.foto || (await fotoP) || fotoManual;
        ficha.fotoResuelta = Boolean(ficha.foto) || !varias;
        if (!ficha.fotoResuelta && !sinFoto.includes(obj.dni)) sinFoto.push(obj.dni);
        pintarFicha(obj.dni, ficha);
        refrescarFotocheck(obj.dni);

        // el antiguo llega cuando llegue: solo lo usan el modal y el Word
        if (antiguoP) {
          antiguoP.then((a) => {
            if (a && !ficha.antiguoManual) ficha.antiguo = a;
          });
        }

        if (conSalidas) {
          mostrarProgreso(obj.dni, "salida", {
            hecho: 0,
            total: 1,
            texto: varias ? "en espera: primero las fichas de toda la lista…" : "en espera de la carpeta anterior…",
          });
          porArmar.push({ dni: obj.dni, r, antiguoManual, antiguoP, carpeta });
        }
        return "ok";
      } catch (e) {
        salidasPendientes.delete(obj.dni);
        if (senal.aborted) return "abortado";
        consola(`  ${e.message}`, "err");
        pintarFicha(obj.dni, {
          error: reintento || !varias ? escaparHtml(e.message) : `${escaparHtml(e.message)} — se reintenta al terminar la lista`,
        });
        return "error";
      }
    }

    /** Foto que la lectura publica no tenia: se le pide a Apps Script (una vez por DNI). */
    const fotosTardias = new Map();
    function fotoTardia(dni) {
      if (!fotosTardias.has(dni)) {
        const p = fotoDeDni(dni, senal, { fondo: true })
          .catch(() => null)
          .then((foto) => {
            const f = fichas.get(dni);
            if (f?.persona && !f.fotoResuelta) {
              if (foto && !f.foto) f.foto = foto;
              f.fotoResuelta = true;
              pintarFicha(dni, f); // sin foto aparece "SIN FOTO · AGREGAR"
              refrescarFotocheck(dni);
            }
            return fichas.get(dni)?.foto || foto;
          });
        fotosTardias.set(dni, p);
      }
      return fotosTardias.get(dni);
    }

    /** Etapa 2 de una persona: su carpeta de Drive. `alBajar` avisa cuando ya bajo todo (el ZIP esta listo). */
    async function armarSalida({ dni, r, antiguoManual, antiguoP, carpeta }, { alBajar = () => {} } = {}) {
      const ficha = fichas.get(dni);
      if (!ficha?.persona || senal.aborted) {
        mostrarProgreso(dni, "salida", null);
        salidasPendientes.delete(dni);
        alBajar();
        return;
      }
      const logSalida = varias ? (m, t) => consola(`[${dni}] ${m}`, t) : consola;
      barra.set(hechas, lista.length, `${dni} · generando salidas`);
      // el reloj del tiempo restante arranca aca, no mientras se esperaba turno
      if (ficha.progreso) delete ficha.progreso.salida;
      mostrarProgreso(dni, "salida", { hecho: 0, total: 1, texto: "creando la carpeta…" });
      mostrarProgreso(dni, "armado", { hecho: 0, total: 1, texto: "bajando certificados…" });
      try {
        // Se arma con la ficha como esta AHORA: en un lote pudo corregirse a
        // mano mientras se leian las demas personas (tambien el tipo A/C, que
        // decide que certificados van).
        const detalle = detalleVisible(ficha, ficha.detalle || r.detalle);
        const salida = await generarSalidas({ ...r, despues: ficha.persona, detalle }, contexto, {
          log: logSalida,
          excluidos: excluidosDe(dni),
          senal,
          fondo: varias,
          avance: (hecho, total, que) => {
            barra.set(hechas, lista.length, `${dni} · ${que}`);
            mostrarProgreso(dni, "salida", { hecho, total, texto: que });
          },
          avanceZip: (hecho, total, que) => {
            if (fichas.get(dni)?.progreso?.armado) mostrarProgreso(dni, "armado", { hecho, total, texto: que });
          },
          // el ZIP se puede bajar ya, con Drive todavia subiendo
          alZipListo: (parcial) => {
            ficha.salida = { ...(ficha.salida || {}), archivos: parcial.archivos, blobs: parcial.blobs, nombre: parcial.nombre };
            mostrarProgreso(dni, "armado", null);
            pintarFicha(dni, ficha);
            alBajar();
          },
          antiguoManual,
          material: { foto: ficha.foto || (varias ? fotoTardia(dni) : null), antiguo: antiguoP },
          // en un lote la carpeta se prepara recien ahora; con uno solo ya se
          // vacio al leer la fila
          carpeta: carpeta || (varias ? vaciarCarpeta(ficha.persona, contexto, { log: logSalida, senal, fondo: true }) : null),
        });
        salidasPendientes.delete(dni);
        delete ficha.errorSalida;
        ficha.salida = salida;
        if (!ficha.antiguoManual && salida.antiguo) ficha.antiguo = salida.antiguo;
        conSalida++;
        mostrarProgreso(dni, "armado", null);
        mostrarProgreso(dni, "salida", null);
        pintarFicha(dni, ficha);
        contar();
        // se corrigio algo en la ficha mientras se armaba la carpeta
        if (ficha.salidaDesactualizada) programarSincronizacion(dni, 0);
      } catch (e) {
        salidasPendientes.delete(dni);
        mostrarProgreso(dni, "armado", null);
        mostrarProgreso(dni, "salida", null);
        if (senal.aborted) return;
        ficha.errorSalida = e.message;
        fallos++;
        logSalida(`no se pudo generar la carpeta: ${e.message}`, "err");
        pintarFicha(dni, ficha);
      } finally {
        alBajar();
      }
    }

    try {
      if (!contexto) {
        consola("cargando CONFIG y diccionario de cursos...");
        // sin `senal`: el contexto lo comparten todas las pestanas, asi que
        // cancelar esta corrida no puede tumbarle el pedido a las demas
        contexto = await cargarContexto();
        consola(`${contexto.cursos.length} alias de curso, ${contexto.matriz.length} fila(s) de matriz`, "ok");
      }

      // mientras se procesa a una persona ya se buscan los certificados de las
      // siguientes: no pasan por Apps Script, asi que no le quitan turno a nada
      const inventarioDe = adelantarInventarios(lista.map((o) => o.dni), senal);

      /* ---------------- etapa 1: fichas ---------------- */
      for (const [i, obj] of lista.entries()) {
        if (senal.aborted) break;
        consola.cabecera(`[${i + 1}/${lista.length}] DNI ${obj.dni}`);
        const estado = await procesar(obj, { inventario: inventarioDe(i) });
        if (estado === "abortado") break;
        if (estado === "error" && varias) conError.push(obj);
        else {
          if (estado === "error") fallos++;
          hechas++;
        }
        barra.set(hechas, lista.length, `${hechas}/${lista.length}`);
        contar();
      }

      // una saturacion de Apps Script no se lleva a nadie: los que fallaron
      // se vuelven a procesar una vez, con el script ya mas tranquilo
      if (conError.length && !senal.aborted) {
        consola.cabecera(`REINTENTO · ${conError.length} DNI que fallaron`);
        for (const obj of conError) {
          if (senal.aborted) break;
          consola.cabecera(`DNI ${obj.dni} · reintento`);
          const estado = await procesar(obj, { reintento: true });
          if (estado === "abortado") break;
          if (estado === "error") fallos++;
          hechas++;
          barra.set(hechas, lista.length, `${hechas}/${lista.length}`);
          contar();
        }
      }

      if (sinGuardar.length && !senal.aborted) {
        consola.cabecera(`GUARDANDO DE NUEVO · ${sinGuardar.length} ficha(s) sin guardar en la hoja`);
        for (const dni of sinGuardar) {
          if (senal.aborted) break;
          await reintentarGuardado(dni, { senal });
        }
      }

      /* ---------------- etapa 2: carpetas de Drive ---------------- */
      soltarFondo();
      if (varias && !senal.aborted) sinFoto.forEach(fotoTardia);
      if (porArmar.length && !senal.aborted) {
        if (varias) consola.cabecera(`CARPETAS DE DRIVE · ${porArmar.length} persona(s)`);
        // Una carpeta a la vez, pero la persona siguiente empieza a bajar sus
        // certificados (no pasan por Apps Script) apenas la anterior termino
        // de bajar los suyos, mientras esa sube a Drive.
        for (const { dni } of porArmar) {
          if (fichas.get(dni)?.progreso?.salida) {
            mostrarProgreso(dni, "salida", { hecho: 0, total: 1, texto: "en espera de la carpeta anterior…" });
          }
        }
        const enVuelo = [];
        for (const item of porArmar) {
          if (senal.aborted) break;
          let bajo = () => {};
          const bajado = new Promise((listo) => (bajo = listo));
          enVuelo.push(armarSalida(item, { alBajar: bajo }));
          await bajado;
        }
        await Promise.all(enVuelo);
      }
      await Promise.all(fotosTardias.values());

      /* ---------------- cierre ---------------- */
      barra.set(1, 1, senal.aborted ? "abortado" : "completado");

      if (senal.aborted) {
        consola.cabecera(`ABORTADO · ${hechas} persona(s) procesada(s)`);
        notificar("Renovación abortada", `${hechas} persona(s) alcanzaron a procesarse.`, "warn");
        return;
      }

      consola.cabecera(`${soloConsulta ? "CONSULTA COMPLETA" : "COMPLETADO"} · ${hechas} persona(s)`);
      if (nuevos.length) consola(`${nuevos.length} no estaban en la base: ${nuevos.join(", ")}`, "warn");
      const pendientesHoja = sinGuardar.filter((dni) => fichas.get(dni)?.sinGuardar);
      if (pendientesHoja.length) {
        consola(
          `${pendientesHoja.length} ficha(s) siguen sin guardarse en la hoja: ${pendientesHoja.join(", ")} · usa SIN GUARDAR · REINTENTAR en su ficha`,
          "err"
        );
      }

      const detalleAviso =
        `${hechas - fallos - nuevos.length} ${soloConsulta ? "consultada(s)" : "renovada(s)"}` +
        (conSalida ? `, ${conSalida} con carpeta en Drive` : "") +
        (nuevos.length ? `, ${nuevos.length} sin ficha` : "") +
        (fallos ? `, ${fallos} con error` : "") +
        (pendientesHoja.length ? `, ${pendientesHoja.length} sin guardar en la hoja` : "");
      notificar(
        soloConsulta ? "Consulta completa" : "Renovación completa",
        detalleAviso,
        fallos || nuevos.length || pendientesHoja.length ? "warn" : "ok"
      );
    } catch (e) {
      consola(`la corrida se detuvo: ${e.message}`, "err");
      notificar("Renovación interrumpida", e.message, "warn");
    } finally {
      soltarFondo();
      salidasPendientes.clear();
      corriendo = false;
      el.run.disabled = false;
      el.stop.hidden = true;
    }
  }

  el.run.addEventListener("click", () => {
    if (corriendo) return;
    pedirPermisoAviso();
    ejecutar({ soloConsulta: false });
  });

  // Enter en el cuadro de documentos = consultar: es lo que se hace mas
  // veces y no toca nada, asi que no hay riesgo de dispararlo sin querer.
  el.dnis.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && !corriendo) {
      ev.preventDefault();
      ejecutar({ soloConsulta: true });
    }
  });

  el.stop.addEventListener("click", () => {
    abortador?.abort();
    consola("abortando...", "warn");
  });

  refrescar();
  comprobarBase();
  cargarAreas();

  return { comprobarBase, contexto: () => contexto };
}
