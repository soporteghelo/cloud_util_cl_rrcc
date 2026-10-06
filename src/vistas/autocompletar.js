/**
 * Desplegable de sugerencias que se filtra mientras se escribe.
 *
 * Sustituye al <datalist> nativo, que solo compara el texto tal cual: aqui no
 * importan las tildes ni las mayusculas y se puede escribir en cualquier orden
 * ("mina maestro" encuentra "MAESTRO DE OPERACIONES MINA"). Lo que mas se
 * parece a lo escrito sale primero.
 */

const sinTildes = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Mayusculas, sin tildes ni signos y con un solo espacio entre palabras. */
export const normalizarBusqueda = (t) =>
  sinTildes(t)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();

/**
 * Las opciones que encajan con `texto`, la mejor primero:
 *   0  empieza por lo escrito
 *   1  cada palabra escrita es el comienzo de alguna palabra de la opcion
 *   2  cada palabra escrita aparece dentro de la opcion
 * Sin texto devuelve todas, en su orden.
 */
export function filtrarOpciones(opciones, texto) {
  const q = normalizarBusqueda(texto);
  if (!q) return [...opciones];
  const palabras = q.split(" ");

  const encontradas = [];
  for (const opcion of opciones) {
    const n = normalizarBusqueda(opcion);
    let puntaje = -1;
    if (n.startsWith(q)) puntaje = 0;
    else if (palabras.every((p) => n.split(" ").some((w) => w.startsWith(p)))) puntaje = 1;
    else if (palabras.every((p) => n.includes(p))) puntaje = 2;
    if (puntaje >= 0) encontradas.push({ opcion, puntaje, largo: n.length });
  }
  // el orden es estable: a igual puntaje y largo se conserva el de la lista
  encontradas.sort((a, b) => a.puntaje - b.puntaje || a.largo - b.largo);
  return encontradas.map((e) => e.opcion);
}

const escaparHtml = (t) =>
  String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** La opcion en HTML con las palabras escritas resaltadas (`<mark>`). */
export function resaltar(opcion, texto) {
  const palabras = normalizarBusqueda(texto).split(" ").filter(Boolean);
  const letras = [...String(opcion)];
  const plano = letras.map((c) => sinTildes(c).toUpperCase());
  // si alguna letra cambia de largo al normalizar (ß -> SS...) las posiciones no cuadran: sin resaltado
  if (!palabras.length || plano.some((c) => c.length !== 1)) return escaparHtml(opcion);

  const base = plano.join("");
  const marcada = new Array(letras.length).fill(false);
  for (const p of palabras) {
    for (let i = base.indexOf(p); i >= 0; i = base.indexOf(p, i + p.length)) {
      for (let k = i; k < i + p.length; k++) marcada[k] = true;
    }
  }

  let salida = "";
  let dentro = false;
  letras.forEach((c, i) => {
    if (marcada[i] !== dentro) {
      salida += dentro ? "</mark>" : "<mark>";
      dentro = marcada[i];
    }
    salida += escaparHtml(c);
  });
  return salida + (dentro ? "</mark>" : "");
}

/**
 * Engancha el desplegable a un campo de texto.
 *  - `obtener()` devuelve las opciones vigentes (se consulta cada vez: el
 *    catalogo puede llegar despues de montar el campo).
 *  - Al elegir se escribe la opcion y se emiten `input` y `change`, como si se
 *    hubiera tecleado, para que el resto de la pantalla reaccione igual.
 *  - `detalle(opcion)` agrega un texto al costado de cada sugerencia (p. ej.
 *    cuantas personas tiene) sin que pase a formar parte de lo elegido.
 *  - `textos` reemplaza los avisos pensados para la matriz por puesto:
 *    `sinOpciones` (no hay ninguna) y `sinCoincidencias` (nada encaja).
 *  - `alElegir(opcion)` es para elegir varias: lo elegido se le pasa a esa
 *    funcion en vez de escribirse en el campo, la lista sigue abierta para
 *    elegir la siguiente, y Enter con una sola coincidencia la elige.
 */
export function autocompletar(
  campo,
  { obtener, nombre = "opciones", max = 60, detalle = null, textos = {}, alElegir = null } = {}
) {
  const contenedor = campo.closest(".inp-borrable") || campo.parentElement;
  const lista = document.createElement("ul");
  lista.className = "ac-lista";
  lista.id = `${campo.id}-sugerencias`;
  lista.setAttribute("role", "listbox");
  lista.hidden = true;
  contenedor.appendChild(lista);

  campo.setAttribute("role", "combobox");
  campo.setAttribute("aria-autocomplete", "list");
  campo.setAttribute("aria-controls", lista.id);
  campo.setAttribute("aria-expanded", "false");

  let mostradas = [];
  let activa = -1;
  let eligiendo = false;

  function cerrar() {
    lista.hidden = true;
    activa = -1;
    campo.setAttribute("aria-expanded", "false");
    campo.removeAttribute("aria-activedescendant");
  }

  function marcar(indice) {
    const items = lista.querySelectorAll(".ac-op");
    items.forEach((li, i) => li.classList.toggle("activa", i === indice));
    activa = indice;
    const li = items[indice];
    if (li) {
      campo.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    } else {
      campo.removeAttribute("aria-activedescendant");
    }
  }

  function elegir(valor) {
    if (alElegir) {
      alElegir(valor);
      if (document.activeElement === campo) abrir();
      else cerrar();
      return;
    }
    eligiendo = true;
    campo.value = valor;
    campo.dispatchEvent(new Event("input", { bubbles: true }));
    campo.dispatchEvent(new Event("change", { bubbles: true }));
    eligiendo = false;
    cerrar();
  }

  function abrir() {
    const todas = obtener() || [];
    const texto = campo.value;
    const encontradas = filtrarOpciones(todas, texto);
    mostradas = encontradas.slice(0, max);
    activa = -1;

    const resumen = texto.trim()
      ? todas.length
        ? `${encontradas.length} de ${todas.length} ${nombre}`
        : textos.sinOpciones || `sin coincidencias en la matriz · se usará lo que escribas`
      : todas.length
        ? `${todas.length} ${nombre} · escribe para filtrar`
        : textos.sinOpciones || `sin opciones en la matriz · escribe libremente`;
    const extra = (o) => {
      const d = detalle ? detalle(o) : "";
      return d === "" || d === null || d === undefined ? "" : `<span class="ac-n">${escaparHtml(d)}</span>`;
    };
    const resto = encontradas.length - mostradas.length;
    lista.innerHTML =
      `<li class="ac-info" role="presentation">${resumen}</li>` +
      (mostradas.length
        ? mostradas
            .map(
              (o, i) =>
                `<li class="ac-op" role="option" id="${lista.id}-${i}" data-valor="${escaparHtml(o)}">${resaltar(o, texto)}${extra(o)}</li>`
            )
            .join("")
        : `<li class="ac-vacio" role="presentation">${escaparHtml(textos.sinCoincidencias || "Sin coincidencias: se usará lo que escribas")}</li>`) +
      (resto > 0 ? `<li class="ac-info" role="presentation">…y ${resto} más: sigue escribiendo</li>` : "");
    lista.hidden = false;
    campo.setAttribute("aria-expanded", "true");
  }

  // mousedown y no click: asi el campo no pierde el foco antes de elegir
  lista.addEventListener("mousedown", (ev) => {
    const li = ev.target.closest(".ac-op");
    if (!li) return;
    ev.preventDefault();
    elegir(li.dataset.valor);
  });

  campo.addEventListener("input", () => {
    if (!eligiendo) abrir();
  });
  campo.addEventListener("focus", abrir);
  campo.addEventListener("click", () => {
    if (lista.hidden) abrir();
  });
  campo.addEventListener("blur", () => setTimeout(cerrar, 120));

  campo.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (lista.hidden) abrir();
      if (!mostradas.length) return;
      const paso = ev.key === "ArrowDown" ? 1 : -1;
      marcar((activa + paso + mostradas.length) % mostradas.length);
    } else if (ev.key === "Enter" && !lista.hidden && activa >= 0) {
      ev.preventDefault();
      elegir(mostradas[activa]);
    } else if (ev.key === "Enter" && alElegir && !lista.hidden && mostradas.length === 1 && campo.value.trim()) {
      ev.preventDefault();
      elegir(mostradas[0]);
    } else if (ev.key === "Escape" && !lista.hidden) {
      ev.preventDefault();
      cerrar();
    } else if (ev.key === "Tab") {
      cerrar();
    }
  });

  return { abrir, cerrar };
}
