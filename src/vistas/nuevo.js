/**
 * Vista "NUEVO PERSONAL": alta de una persona que todavia no esta en la
 * hoja `BD AESA`.
 *
 * La diferencia con la renovacion es de donde salen las "A": aqui no hay
 * fila previa de la que heredarlas, asi que las propone MATRIZ_PUESTO segun
 * el cargo y el area, y el usuario las confirma antes de guardar. Una vez
 * creada la fila, corre el mismo motor de renovacion para llenar fechas y
 * estados desde los certificados.
 */

import { $, crearConsola, crearProgreso, notificar } from "./comun.js";
import { normalizarDni } from "../lib/dni.js";
import { aFormatoCorto } from "../../shared/estados.js";
import { obtenerContexto, obtenerPersona } from "../lib/datos.js";
import { altaPersona, generarSalidas, subirFoto } from "../lib/renovacion.js";
import { tiposDeMatriz, cargoMasParecido, cargosDeMatriz } from "../../shared/estados.js";
import { RRCC } from "../../shared/rrcc.js";
import { autocompletar } from "./autocompletar.js";

export function montarNuevo() {
  const consola = crearConsola("nv-term", "nv-log-clear");
  const barra = crearProgreso("nv");

  const el = {
    dni: $("nv-dni"),
    apellidos: $("nv-apellidos"),
    nombres: $("nv-nombres"),
    empresa: $("nv-empresa"),
    guardia: $("nv-guardia"),
    cargo: $("nv-cargo"),
    area: $("nv-area"),
    emo: $("nv-emo"),
    emoVenc: $("nv-emo-venc"),
    lentes: $("nv-lentes"),
    restricciones: $("nv-restricciones"),
    comentario: $("nv-comentario"),
    foto: $("nv-foto"),
    matriz: $("nv-matriz"),
    matrizCount: $("nv-matriz-count"),
    run: $("nv-run"),
    existe: $("nv-existe"),
  };

  let contexto = null;
  let corriendo = false;

  /* ---------------- grilla de tipos ---------------- */

  /* La matriz se agrupa por tipo: A, C y los que no llevan nada. Al elegir el
     cargo llega ya repartida, y si se cambia un valor a mano la tarjeta pasa
     sola al grupo que le corresponde. */
  const GRUPOS_MATRIZ = [
    { tipo: "A", clase: "a", titulo: "A · AUTORIZADOS" },
    { tipo: "C", clase: "c", titulo: "C · CAPACITADOS" },
    { tipo: "", clase: "sin", titulo: "SIN TIPO" },
  ];
  const grupoDeTipo = (v) => (v === "A" || v === "C" ? v : "");

  function pintarMatriz(tipos = {}) {
    const tarjetas = RRCC.map((r, orden) => {
      const v = grupoDeTipo(tipos[r.codigo] || "");
      return {
        grupo: v,
        html:
          `<label class="mz${v ? " puesta" : ""}" data-codigo="${r.codigo}" data-orden="${orden}">` +
          `<span class="mz-nom" title="${r.nombre}">${r.rotulo}</span>` +
          `<select data-tipo="${r.codigo}">` +
          `<option value=""${v === "" ? " selected" : ""}>—</option>` +
          `<option value="A"${v === "A" ? " selected" : ""}>A</option>` +
          `<option value="C"${v === "C" ? " selected" : ""}>C</option>` +
          `</select></label>`,
      };
    });

    el.matriz.innerHTML = GRUPOS_MATRIZ.map((g) => {
      const propias = tarjetas.filter((t) => t.grupo === g.tipo);
      return (
        `<section class="rrcc-grupo rrcc-grupo-${g.clase}" data-grupo="${g.tipo}"${propias.length ? "" : " hidden"}>` +
        `<div class="rrcc-grupo-head"><b>${g.titulo}</b><span data-grupo-n>${propias.length}</span></div>` +
        `<div class="matriz">${propias.map((t) => t.html).join("")}</div></section>`
      );
    }).join("");

    for (const select of el.matriz.querySelectorAll("select")) {
      select.addEventListener("change", () => {
        const tarjeta = select.closest(".mz");
        tarjeta.classList.toggle("puesta", Boolean(select.value));
        moverAGrupoMatriz(tarjeta, select.value);
        actualizarConteo();
      });
    }
    actualizarConteo();
  }

  /** Lleva la tarjeta al grupo de su tipo (en el orden del catalogo) y actualiza los contadores. */
  function moverAGrupoMatriz(tarjeta, tipo) {
    const destino = el.matriz.querySelector(`.rrcc-grupo[data-grupo="${grupoDeTipo(tipo)}"]`);
    if (destino !== tarjeta.closest(".rrcc-grupo")) {
      const activo = document.activeElement;
      const rejilla = destino.querySelector(".matriz");
      const orden = Number(tarjeta.dataset.orden);
      const siguiente = [...rejilla.children].find((c) => Number(c.dataset.orden) > orden);
      rejilla.insertBefore(tarjeta, siguiente || null);
      if (activo && tarjeta.contains(activo)) activo.focus(); // seguir con el teclado
    }
    for (const seccion of el.matriz.querySelectorAll(".rrcc-grupo")) {
      const n = seccion.querySelectorAll(".mz").length;
      seccion.hidden = n === 0;
      seccion.querySelector("[data-grupo-n]").textContent = n;
    }
  }

  function tiposElegidos() {
    const tipos = {};
    for (const select of el.matriz.querySelectorAll("select")) {
      if (select.value) tipos[select.dataset.tipo] = select.value;
    }
    return tipos;
  }

  function actualizarConteo() {
    const tipos = tiposElegidos();
    const autorizados = Object.values(tipos).filter((v) => v === "A").length;
    const capacitados = Object.values(tipos).filter((v) => v === "C").length;
    el.matrizCount.textContent = `${autorizados} A · ${capacitados} C`;
  }

  /**
   * Cargo y marcas de la ultima propuesta pintada. Se repinta solo si cambia:
   * asi el `change` que llega tras el `input` (o teclear el area) no pisa las
   * marcas que el usuario ajusto a mano.
   */
  let propuesta = "";

  /**
   * Repropone lo que dice la matriz para el cargo/area actuales. Si el cargo no
   * tiene fila la grilla se limpia: dejar la del cargo anterior es enganoso.
   */
  function proponerDesdeMatriz(evento) {
    if (!contexto?.matriz?.length) return;
    const cargo = el.cargo.value.trim();
    const tipos = tiposDeMatriz(contexto.matriz, cargo, el.area.value);
    const n = Object.keys(tipos).length;
    const clave = `${cargo.toUpperCase()}|${JSON.stringify(tipos)}`;
    if (clave !== propuesta) {
      propuesta = clave;
      pintarMatriz(tipos);
      if (n) consola(`matriz: ${n} riesgo(s) para "${cargo}"`, "ok");
    }
    // Solo al confirmar (change): mientras se teclea, casi todo es "sin fila".
    if (!n && cargo && evento.type === "change") {
      const sugerido = cargoMasParecido(contexto.matriz, cargo);
      const pista = sugerido ? ` — ¿es un typo de "${sugerido}"?` : "";
      consola(`la matriz no tiene fila para "${cargo}" / "${el.area.value}": marca las A a mano${pista}`, "warn");
    }
  }

  // `input` cubre teclear y elegir de la lista sin esperar a que el campo pierda el foco.
  el.cargo.addEventListener("input", proponerDesdeMatriz);
  el.cargo.addEventListener("change", proponerDesdeMatriz);
  el.area.addEventListener("change", proponerDesdeMatriz);

  /** Borrador: vacia el campo y avisa como si se hubiera borrado a mano. */
  for (const boton of document.querySelectorAll("[data-borra]")) {
    const campo = $(boton.dataset.borra);
    boton.addEventListener("click", () => {
      campo.value = "";
      campo.dispatchEvent(new Event("input", { bubbles: true }));
      campo.dispatchEvent(new Event("change", { bubbles: true }));
      campo.focus();
    });
  }

  /* ---------------- consulta por DNI ---------------- */

  /**
   * Al escribir un documento se consulta la hoja antes de dejar cargar nada.
   *
   * Si la persona ya existe, el alta duplicaria su fila: en vez de dejar que
   * eso pase al final, se avisa aqui y se rellena el formulario con lo que ya
   * hay, para que se vea de quien se trata y se pueda ir a RENOVACION.
   */
  let ultimoConsultado = "";

  async function consultarDni() {
    const norm = normalizarDni(el.dni.value);
    if (!norm || norm.dni === ultimoConsultado) return;
    ultimoConsultado = norm.dni;

    if (norm.relleno) {
      consola(`documento rellenado a 8 dígitos: ${el.dni.value.trim()} → ${norm.dni}`, "warn");
      el.dni.value = norm.dni;
    }

    try {
      const r = await obtenerPersona(norm.dni);
      if (!r.encontrada) {
        el.existe.hidden = true;
        consola(`${norm.dni} no está en la base: se puede dar de alta`, "ok");
        return;
      }

      const p = r.datos;
      rellenarCon(p);
      const autorizados = p.riesgos.filter((x) => x.tipo === "A").length;
      el.existe.hidden = false;
      el.existe.innerHTML =
        `<b>${p.nombreCompleto}</b> ya está en la base (${p.codigo || "sin código"}, fila ${r.fila}).<br>` +
        `${autorizados} autorización(es) · estado <b>${p.estadoFinal || "—"}</b>` +
        (p.fechaMinima ? ` hasta ${aFormatoCorto(p.fechaMinima)}` : "") +
        `.<br>Para verificar la vigencia de sus "A" contra JOMISER, EIN y Drive usa la pestaña ` +
        `<b>RENOVACIÓN</b> → CONSULTAR Y VERIFICAR.`;
      consola(`${norm.dni} ya existe: ${p.nombreCompleto} (fila ${r.fila})`, "warn");
    } catch (e) {
      consola(`no se pudo consultar ${norm.dni}: ${e.message}`, "warn");
    }
  }

  /** Vuelca en el formulario los datos que ya tiene la hoja. */
  function rellenarCon(p) {
    const poner = (campo, valor) => {
      if (valor && !campo.value.trim()) campo.value = valor;
    };
    poner(el.apellidos, p.apellidos);
    poner(el.nombres, p.nombres);
    poner(el.empresa, p.empresa);
    poner(el.guardia, p.guardia);
    poner(el.cargo, p.cargo);
    poner(el.area, p.area);
    poner(el.emo, p.examenMedico);
    poner(el.emoVenc, p.vencimientoEmo);
    poner(el.comentario, p.comentario);
    poner(el.restricciones, p.restricciones);
    if (p.usoLentes) el.lentes.value = p.usoLentes.toUpperCase() === "SI" ? "SI" : "NO";

    const tipos = {};
    for (const r of p.riesgos) if (r.tipo) tipos[r.codigo] = r.tipo;
    if (Object.keys(tipos).length) {
      pintarMatriz(tipos);
      propuesta = ""; // no viene de la matriz: el proximo cargo debe repintar
    }
  }

  el.dni.addEventListener("change", consultarDni);
  el.dni.addEventListener("blur", consultarDni);

  /* ---------------- catalogos ---------------- */

  // Google Sheets tarda varios segundos en contestar y hasta entonces el
  // desplegable estaba vacio. La ultima lista se guarda en el navegador para
  // que salga al instante y se refresque por detras.
  // Clave propia: estos cargos/areas salen de MATRIZ_PUESTO (los puestos que
  // la matriz reconoce), no de los que ya existen en `BD AESA`. Compartir la
  // clave con esos ultimos hacia que cada pestana pisara la lista de la otra.
  const CATALOGO_GUARDADO = "rrcc.catalogo.matriz";

  function catalogoGuardado() {
    try {
      const c = JSON.parse(localStorage.getItem(CATALOGO_GUARDADO));
      return Array.isArray(c?.cargos) && Array.isArray(c?.areas) ? c : null;
    } catch {
      return null;
    }
  }

  function guardarCatalogo(catalogo) {
    try {
      localStorage.setItem(CATALOGO_GUARDADO, JSON.stringify(catalogo));
    } catch {
      /* sin almacenamiento solo se pierde el atajo */
    }
  }

  /** Cargos y areas conocidos; los desplegables de los campos los leen en cada uso. */
  let catalogo = { cargos: [], areas: [] };

  function pintarCatalogo({ cargos, areas }) {
    catalogo = { cargos, areas };
  }

  function areasDeMatriz(matriz = []) {
    return [...new Set(matriz.map((fila) => String(fila?.[1] ?? "").trim()).filter(Boolean))].sort();
  }

  autocompletar(el.cargo, { obtener: () => catalogo.cargos, nombre: "cargos" });
  autocompletar(el.area, { obtener: () => catalogo.areas, nombre: "areas" });

  async function cargarCatalogos() {
    const guardado = catalogoGuardado();
    if (guardado) {
      pintarCatalogo(guardado);
    } else {
      el.cargo.placeholder = el.area.placeholder = "cargando…";
      consola("cargando cargos y matriz…");
    }

    const matriz = (async () => {
      contexto = await obtenerContexto();
      const cargos = cargosDeMatriz(contexto?.matriz || []);
      const areas = areasDeMatriz(contexto?.matriz || []);
      const siguiente = { cargos, areas };

      if (JSON.stringify(siguiente) !== JSON.stringify(guardado)) pintarCatalogo(siguiente);
      guardarCatalogo(siguiente);
      consola(`${cargos.length} cargo(s) y ${areas.length} area(s) de la matriz`, "ok");

      if (!contexto.matriz?.length) {
        consola("la hoja MATRIZ_PUESTO está vacía: marca las A a mano", "warn");
      } else if (el.cargo.value.trim()) {
        proponerDesdeMatriz({ type: "input" }); // el cargo se eligio antes de que llegara la matriz
      }
    })().catch((e) => consola(`no se pudo cargar la matriz: ${e.message}`, "warn"));

    await matriz;
    el.cargo.placeholder = el.area.placeholder = "";
  }

  /* ---------------- alta ---------------- */

  function leerFormulario() {
    const norm = normalizarDni(el.dni.value);
    if (!norm) throw new Error("falta el DNI");
    if (!el.apellidos.value.trim()) throw new Error("faltan los apellidos");
    if (!el.nombres.value.trim()) throw new Error("faltan los nombres");
    const foto = el.foto.files?.[0];
    if (!foto) throw new Error("falta la foto de la persona: es obligatoria");
    if (!foto.type.startsWith("image/")) throw new Error("la foto de la persona debe ser una imagen");

    return {
      dni: norm.dni,
      relleno: norm.relleno,
      apellidos: el.apellidos.value,
      nombres: el.nombres.value,
      empresa: el.empresa.value.trim() || "AESA",
      guardia: el.guardia.value.trim(),
      cargo: el.cargo.value.trim(),
      area: el.area.value.trim(),
      examenMedico: el.emo.value,
      vencimientoEmo: el.emoVenc.value,
      usoLentes: el.lentes.value,
      restricciones: el.restricciones.value.trim(),
      comentario: el.comentario.value.trim(),
    };
  }

  async function ejecutar() {
    consola.limpiar();
    barra.mostrar(true);
    barra.set(0, 5, "validando");

    let datos;
    try {
      datos = leerFormulario();
    } catch (e) {
      consola(e.message, "err");
      notificar("Faltan datos", e.message, "warn");
      barra.mostrar(false);
      return;
    }

    corriendo = true;
    el.run.disabled = true;
    consola.cabecera(`ALTA · ${datos.apellidos.toUpperCase()} ${datos.nombres.toUpperCase()} (${datos.dni})`);
    if (datos.relleno) consola(`documento rellenado a 8 dígitos: ${el.dni.value} → ${datos.dni}`, "warn");

    try {
      if (!contexto) contexto = await obtenerContexto();

      /* la foto es obligatoria y se sube antes de crear la fila: si falla no
         queda un registro sin foto */
      barra.set(1, 5, "subiendo foto");
      // se sube como "<DNI>.png" a la carpeta FOTOS, que es donde la app la
      // busca despues; en la hoja solo queda la ruta
      await subirFoto(el.foto.files[0], { nombre: `${datos.dni}.png` });
      datos.foto = `FOTOS/${datos.dni}.png`;
      consola(`foto subida a FOTOS/${datos.dni}.png`, "ok");

      barra.set(2, 5, "creando la fila");
      const r = await altaPersona(datos, contexto, { log: consola, tipos: tiposElegidos() });

      if (r.estado === "existe") {
        consola("la persona ya estaba: usa la pestaña RENOVACIÓN", "warn");
        notificar("Ya existe", r.error || `El DNI ${datos.dni} ya está en la base.`, "warn");
        return;
      }
      if (r.estado !== "ok") {
        consola(`el alta no se completó (${r.estado})`, "err");
        return;
      }

      barra.set(4, 5, "generando salidas");
      const salida = await generarSalidas(r, contexto, { log: consola });

      barra.set(5, 5, "completado");
      consola.cabecera(`ALTA COMPLETA · ${r.despues.codigo || ""} ${r.despues.nombreCompleto}`);
      notificar(
        "Personal dado de alta",
        `${r.despues.nombreCompleto} · carpeta "${salida.nombre}" con ${salida.certificados.length} certificado(s).`
      );
    } catch (e) {
      consola(`no se pudo completar el alta: ${e.message}`, "err");
      notificar("El alta falló", e.message, "warn");
    } finally {
      corriendo = false;
      el.run.disabled = false;
    }
  }

  el.run.addEventListener("click", () => {
    if (corriendo) return;
    ejecutar();
  });

  pintarMatriz({});
  cargarCatalogos();
}
