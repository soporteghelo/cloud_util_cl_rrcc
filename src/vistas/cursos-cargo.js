/**
 * RENOVACION · "cargo -> cursos A": al pie de la lista de DNIs se elige un
 * cargo de MATRIZ_PUESTO y se ve que RRCC le exige como autorizacion ("A").
 *
 * Es solo una consulta: no toca la hoja ni la ficha de nadie. La matriz sale
 * del contexto que la app ya precarga al abrir, asi que normalmente esta
 * lista sin pedir nada.
 */

import { $, escaparHtml } from "./comun.js";
import { obtenerContexto, contextoEnMemoria, alCambiar } from "../lib/datos.js";
import { cargosDeMatriz, exigenciasDeCargo, cargoMasParecido } from "../../shared/estados.js";
import { porCodigo } from "../../shared/rrcc.js";
import { autocompletar } from "./autocompletar.js";

export function montarCursosDeCargo({ campo = $("rn-cargo"), caja = $("rn-cargo-res") } = {}) {
  if (!campo || !caja) return;

  let matriz = null; // null = todavia no llego
  let cargos = [];
  let error = "";

  function usarMatriz(filas) {
    matriz = filas || [];
    cargos = cargosDeMatriz(matriz);
    error = "";
  }

  const enMemoria = contextoEnMemoria();
  if (enMemoria) usarMatriz(enMemoria.matriz);

  autocompletar(campo, { obtener: () => cargos, nombre: "cargos" });

  const nota = (texto) => `<div class="rn-cargo-nota">${texto}</div>`;

  function htmlGrupo(g, variosGrupos) {
    const areas = g.areas.length ? `<div class="rn-cargo-areas">${escaparHtml(g.areas.join(" · "))}</div>` : "";
    const cabeza =
      `<div class="rn-cargo-head"><b>${g.autorizados.length} curso(s) A</b>` +
      (variosGrupos && !g.areas.length ? `<span>sin área</span>` : "") +
      `</div>`;
    if (!g.autorizados.length) {
      return (
        `<div class="rn-cargo-grupo">${cabeza}${areas}` +
        nota(`no exige cursos A${g.capacitados.length ? ` · solo ${g.capacitados.length} C` : ""}`) +
        `</div>`
      );
    }
    const items = g.autorizados
      .map((codigo) => {
        const r = porCodigo(codigo);
        return `<li title="${escaparHtml(r?.nombre || codigo)}"><b>${codigo}</b><span>${escaparHtml(r?.rotulo || codigo)}</span></li>`;
      })
      .join("");
    return `<div class="rn-cargo-grupo">${cabeza}${areas}<ul class="rn-cargo-a">${items}</ul></div>`;
  }

  /**
   * Mientras se teclea casi nada coincide exacto: el aviso de "no esta en la
   * matriz" (con la sugerencia de un typo) espera al `change`.
   */
  function pintar(evento) {
    const cargo = campo.value.trim();
    if (!matriz) {
      caja.innerHTML = nota(error ? `no se pudo leer la matriz: ${escaparHtml(error)}` : "cargando la matriz…");
      return;
    }
    if (!matriz.length) {
      caja.innerHTML = nota("la hoja MATRIZ_PUESTO está vacía");
      return;
    }
    if (!cargo) {
      caja.innerHTML = nota(`elige un cargo para ver los cursos "A" que le exige la matriz`);
      return;
    }

    const grupos = exigenciasDeCargo(matriz, cargo);
    if (grupos.length) {
      caja.innerHTML = grupos.map((g) => htmlGrupo(g, grupos.length > 1)).join("");
      return;
    }
    if (evento?.type !== "change") {
      caja.innerHTML = nota("elige un cargo de la lista");
      return;
    }
    const sugerido = cargoMasParecido(matriz, cargo);
    caja.innerHTML =
      nota(`"${escaparHtml(cargo)}" no está en la matriz`) +
      (sugerido
        ? `<button type="button" class="rn-cargo-sug" data-cargo-sug="${escaparHtml(sugerido)}">¿${escaparHtml(sugerido)}?</button>`
        : "");
  }

  campo.addEventListener("input", pintar);
  campo.addEventListener("change", pintar);
  caja.addEventListener("click", (ev) => {
    const boton = ev.target.closest("[data-cargo-sug]");
    if (!boton) return;
    campo.value = boton.dataset.cargoSug;
    pintar({ type: "change" });
    campo.focus();
  });

  // la matriz puede refrescarse desde otra pestana (o llegar despues de montar)
  alCambiar((ev) => {
    if (ev.tipo !== "contexto") return;
    usarMatriz(ev.contexto?.matriz);
    pintar({ type: "change" });
  });

  pintar();
  if (!matriz) {
    obtenerContexto().then(
      (ctx) => {
        usarMatriz(ctx.matriz);
        pintar({ type: "change" });
      },
      (e) => {
        error = e.message;
        pintar();
      }
    );
  }
}
