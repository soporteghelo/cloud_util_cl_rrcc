/**
 * Piezas de interfaz que comparten las tres vistas: la consola, la barra de
 * progreso, el aviso de fin y el cambio de pestana.
 */

export const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Consola                                                             */
/* ------------------------------------------------------------------ */

/**
 * Devuelve una funcion `log(texto, clase)` atada a un panel de consola.
 * El cursor parpadeante se va moviendo al final, como en una terminal.
 */
export function crearConsola(idTerm, idLimpiar) {
  const term = $(idTerm);
  let cursor = null;

  function log(texto, clase = "info") {
    if (!term) return;
    cursor?.remove();
    const linea = document.createElement("div");
    linea.className = `ln ln-${clase}`;
    linea.textContent = texto;
    term.appendChild(linea);

    cursor = document.createElement("span");
    cursor.className = "cursor";
    term.appendChild(cursor);
    term.scrollTop = term.scrollHeight;
  }

  log.limpiar = () => {
    if (term) term.innerHTML = "";
    cursor = null;
  };
  log.cabecera = (t) => log(t, "head");

  $(idLimpiar)?.addEventListener("click", log.limpiar);
  return log;
}

/* ------------------------------------------------------------------ */
/* Barra de progreso                                                   */
/* ------------------------------------------------------------------ */

/** `prefijo` es el id sin sufijo: "rn" para #rn-bar-fill, #rn-bar-txt, ... */
export function crearProgreso(prefijo) {
  const p = prefijo ? `${prefijo}-` : "";
  const envoltorio = $(`${p}bar-wrap`);
  const relleno = $(`${p}bar-fill`);
  const texto = $(`${p}bar-txt`);
  const porcentaje = $(`${p}bar-pct`);

  return {
    mostrar(visible = true) {
      if (envoltorio) envoltorio.hidden = !visible;
    },
    set(hecho, total, mensaje) {
      const pct = total ? Math.round((hecho / total) * 100) : 0;
      if (relleno) relleno.style.width = `${pct}%`;
      if (porcentaje) porcentaje.textContent = `${pct}%`;
      if (texto) texto.textContent = mensaje;
    },
  };
}

/**
 * Cuanto falta, estimado con el ritmo que se lleva: si `hecho` de `total`
 * unidades tardaron lo que va desde `inicio`, lo que queda tarda en
 * proporcion. Devuelve milisegundos, o `null` mientras no hay con que medir.
 */
export function estimarRestante(inicio, hecho, total, ahora = Date.now()) {
  if (!total || hecho <= 0) return null;
  if (hecho >= total) return 0;
  return ((ahora - inicio) / hecho) * (total - hecho);
}

/** "~8 s", "~1 min 20 s"; `null` = todavia no se sabe. */
export function textoRestante(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "calculando…";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `~${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `~${m} min ${r} s` : `~${m} min`;
}

/* ------------------------------------------------------------------ */
/* Aviso de fin                                                        */
/* ------------------------------------------------------------------ */

let cerrarToast = null;

/**
 * Avisa por tres vias, porque un lote tarda y se suele dejar en segundo
 * plano: el aviso en la pagina, la notificacion del sistema y un pitido.
 */
export function notificar(titulo, detalle, tipo = "ok") {
  const toast = $("toast");
  if (toast) {
    clearTimeout(cerrarToast);
    toast.className = `toast ${tipo === "ok" ? "" : tipo}`.trim();
    $("toast-ic").textContent = tipo === "ok" ? "✓" : "!";
    $("toast-tit").textContent = titulo;
    $("toast-sub").textContent = detalle;
    toast.hidden = false;

    // reinicia la animacion de la barra al reutilizar el mismo nodo
    const barra = toast.querySelector(".toast-bar");
    if (barra) {
      barra.style.animation = "none";
      void barra.offsetWidth;
      barra.style.animation = "";
    }
    cerrarToast = setTimeout(() => (toast.hidden = true), 12000);
  }

  try {
    if ("Notification" in window && Notification.permission === "granted") {
      const n = new Notification(titulo, { body: detalle, icon: "/favicon.svg", tag: "aesa-rrcc" });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* algunos navegadores lanzan si la pagina no es segura */
  }

  if (tipo === "ok") pitido();
}

export function pitido() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t0 = ctx.currentTime;
    for (const [i, hz] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gan = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      gan.gain.setValueAtTime(0.0001, t0 + i * 0.11);
      gan.gain.exponentialRampToValueAtTime(0.08, t0 + i * 0.11 + 0.01);
      gan.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.11 + 0.1);
      osc.connect(gan).connect(ctx.destination);
      osc.start(t0 + i * 0.11);
      osc.stop(t0 + i * 0.11 + 0.11);
    }
    setTimeout(() => ctx.close(), 600);
  } catch {
    /* sin audio disponible */
  }
}

/** Pide permiso de notificacion sin bloquear: el dialogo pararia el lote. */
export function pedirPermisoAviso() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    /* sin soporte */
  }
}

/* ------------------------------------------------------------------ */
/* Pestanas                                                            */
/* ------------------------------------------------------------------ */

export function montarPestanas(pares, inicial = 0) {
  const botones = pares.map(([idTab]) => $(idTab));

  function activar(indice) {
    pares.forEach(([idTab, idVista], i) => {
      const activo = i === indice;
      const tab = $(idTab);
      const vista = $(idVista);
      if (tab) {
        tab.classList.toggle("activo", activo);
        tab.setAttribute("aria-selected", String(activo));
      }
      if (vista) vista.hidden = !activo;
    });
  }

  botones.forEach((boton, i) => boton?.addEventListener("click", () => activar(i)));
  activar(inicial);
  return activar;
}

/**
 * Llama a `fn` cada vez que la vista `idVista` pase de oculta a visible (y de
 * entrada, si ya se esta viendo).
 *
 * La precarga del arranque deja datos en vistas que el usuario todavia no ha
 * abierto. Pintar cientos de filas de una tabla escondida es trabajo tirado y
 * se nota como un tiron al cargar la pagina, asi que las vistas pesadas lo
 * posponen hasta que se las mira.
 */
export function alMostrarse(idVista, fn) {
  const vista = $(idVista);
  if (!vista) return () => {};
  if (!vista.hidden) fn();
  const observador = new MutationObserver(() => {
    if (!vista.hidden) fn();
  });
  observador.observe(vista, { attributes: true, attributeFilter: ["hidden"] });
  return () => observador.disconnect();
}

/* ------------------------------------------------------------------ */
/* Filtro de seleccion multiple                                        */
/* ------------------------------------------------------------------ */

/**
 * Convierte `#idBase` (un `.msel` con su boton `#idBase-btn` y su panel
 * `.msel-panel`, ya en el HTML) en un desplegable de casillas: se puede
 * marcar mas de una opcion a la vez, a diferencia de un `<select>` normal.
 * Sin nada marcado se entiende "todos" (sin filtro).
 *
 * `opciones` es `[{ valor, etiqueta }]`. `resumen(opcion)` decide que texto
 * mostrar en el boton cuando hay una sola opcion marcada (por defecto, su
 * etiqueta); con varias marcadas se muestra "N SELECCIONADOS".
 */
export function crearMultiSelect(idBase, opciones, { textoTodos = "TODOS", resumen = (op) => op.etiqueta } = {}) {
  const raiz = $(idBase);
  const boton = $(`${idBase}-btn`);
  const panel = raiz?.querySelector(".msel-panel");
  const texto = boton?.querySelector(".msel-txt");
  const seleccion = new Set();
  let alCambiar = () => {};

  if (!raiz || !boton || !panel || !texto) {
    return { obtener: () => seleccion, alCambiar: (fn) => (alCambiar = fn) };
  }

  function actualizarTexto() {
    const n = seleccion.size;
    texto.textContent =
      n === 0 ? textoTodos : n === 1 ? resumen(opciones.find((o) => seleccion.has(o.valor))) : `${n} seleccionados`.toUpperCase();
  }

  function render() {
    panel.textContent = "";

    const acciones = document.createElement("div");
    acciones.className = "msel-acciones";
    const limpiar = document.createElement("button");
    limpiar.type = "button";
    limpiar.className = "lnk";
    limpiar.textContent = "LIMPIAR";
    limpiar.addEventListener("click", () => {
      seleccion.clear();
      panel.querySelectorAll("input[type=checkbox]").forEach((c) => (c.checked = false));
      actualizarTexto();
      alCambiar();
    });
    acciones.appendChild(limpiar);
    panel.appendChild(acciones);

    for (const op of opciones) {
      const etiqueta = document.createElement("label");
      etiqueta.className = "msel-op";
      const caja = document.createElement("input");
      caja.type = "checkbox";
      caja.setAttribute("role", "option");
      caja.checked = seleccion.has(op.valor);
      caja.addEventListener("change", () => {
        if (caja.checked) seleccion.add(op.valor);
        else seleccion.delete(op.valor);
        actualizarTexto();
        alCambiar();
      });
      etiqueta.appendChild(caja);
      etiqueta.appendChild(document.createTextNode(op.etiqueta));
      panel.appendChild(etiqueta);
    }
  }

  function abierto() {
    return !panel.hidden;
  }
  function abrir() {
    panel.hidden = false;
    boton.setAttribute("aria-expanded", "true");
  }
  function cerrar() {
    panel.hidden = true;
    boton.setAttribute("aria-expanded", "false");
  }

  boton.addEventListener("click", () => (abierto() ? cerrar() : abrir()));
  raiz.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && abierto()) {
      cerrar();
      boton.focus();
    }
  });
  document.addEventListener("click", (ev) => {
    if (abierto() && !raiz.contains(ev.target)) cerrar();
  });

  render();
  actualizarTexto();

  return {
    obtener: () => seleccion,
    alCambiar: (fn) => (alCambiar = fn),
  };
}

/* ------------------------------------------------------------------ */
/* Portapapeles                                                        */
/* ------------------------------------------------------------------ */

/** Copia texto al portapapeles. Recurre a un textarea oculto si la API
    asincrona no esta disponible (contexto no seguro, navegador viejo). */
export async function copiarTexto(texto) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch {
    /* se intenta el metodo de respaldo */
  }
  try {
    const area = document.createElement("textarea");
    area.value = texto;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.focus();
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Texto seguro para volcar como HTML                                  */
/* ------------------------------------------------------------------ */

export const escaparHtml = (valor) =>
  String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** "faltan 5 día(s)" / "vence hoy" / "vencido hace 5 día(s)", para los reportes de vencimientos. */
export function textoDias(dias) {
  if (dias === null || dias === undefined || Number.isNaN(dias)) return "—";
  if (dias > 0) return `faltan ${dias} día(s)`;
  if (dias === 0) return "vence hoy";
  return `vencido hace ${Math.abs(dias)} día(s)`;
}

/* ------------------------------------------------------------------ */
/* Reintento ante un Apps Script que responde con una pagina rota      */
/* ------------------------------------------------------------------ */

/**
 * Estados en los que vale la pena volver a pedir lo mismo, porque no hay nada
 * malo en el pedido: el puente no logro hablar con Apps Script (502), la
 * funcion todavia no estaba lista (503) o tardo tanto que la corto la red de
 * Vercel (504). El 504 hay que contemplarlo aunque el puente ya se rinda antes
 * con su propio 502: el corte de la plataforma puede llegar igual (una accion
 * pesada, un arranque en frio), y ahi no llega JSON sino una pagina de error,
 * que en pantalla se lee como "respuesta ilegible (HTTP 504)".
 */
const REINTENTABLES = new Set([502, 503, 504]);

/**
 * Las cargas mas pesadas (todo el personal de una vez) son las que mas
 * tardan en Apps Script. Cuando dos personas las disparan casi a la vez,
 * Google satura y responde con una pagina rota en vez de JSON (ya
 * reintentado del lado servidor sin exito). Se reintenta una vez mas, desde
 * el navegador, antes de rendirse y avisarle al usuario.
 */
export async function conReintento(tarea, consola, intentos = 2) {
  for (let i = 1; ; i++) {
    try {
      return await tarea();
    } catch (e) {
      if (!REINTENTABLES.has(e.estado) || i > intentos) throw e;
      consola(`Apps Script no respondió, reintentando (${i}/${intentos})…`, "warn");
      await new Promise((r) => setTimeout(r, 1500 * i));
    }
  }
}

/* ------------------------------------------------------------------ */
/* Antiguedad de los datos                                             */
/* ------------------------------------------------------------------ */

/**
 * "hace un momento" / "hace 3 min" / "hace 2 h".
 *
 * Las vistas reutilizan lo que ya cargo otra pestana, asi que tienen que poder
 * decir de cuando es lo que se esta viendo: sin eso, datos compartidos serian
 * datos de procedencia desconocida.
 */
export function hace(ts) {
  if (!ts) return "";
  const seg = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (seg < 45) return "hace un momento";
  if (seg < 3600) return `hace ${Math.max(1, Math.round(seg / 60))} min`;
  return `hace ${Math.round(seg / 3600)} h`;
}

/* ------------------------------------------------------------------ */
/* Descargas                                                           */
/* ------------------------------------------------------------------ */

export function descargarBlob(blob, nombre) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = nombre;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
