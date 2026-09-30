/**
 * Pruebas de la renovacion en lote ante Apps Script saturado: el guardado se
 * reintenta con la misma marca, una renovacion que no se pudo guardar no se
 * pierde, y el carril de fondo espera mientras se pintan las fichas.
 * `fetch` se simula: no tocan la red.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { CABECERA, colCap, colTipo, INDICE } from "../shared/rrcc.js";
import { AJUSTES_COLA, retenerFondo, sheets, drive } from "../src/lib/api.js";
import { guardarFilaVerificada, renovarPersona } from "../src/lib/renovacion.js";

AJUSTES_COLA.enfriarMs = 0;

const filaVacia = () => CABECERA.map(() => "");
function persona() {
  const f = filaVacia();
  f[INDICE["DNI"]] = "04086358";
  return f;
}

/** Respuesta rota de Google tal como la devuelve el puente: 502 con `reintentable`. */
const ROTA = { rota: true };

/** `comportamiento(cuerpo, ruta)` devuelve lo que responde el servidor; ROTA = pagina 404 de Google. */
const apiSimulada = (comportamiento) => async (ruta, opciones) => {
  const salida = await comportamiento(JSON.parse(opciones.body), ruta);
  if (salida === ROTA) {
    const cuerpo = { error: 'Google respondió "No se encontró la página"', reintentable: true };
    return { ok: false, status: 502, headers: new Map(), json: async () => cuerpo };
  }
  return { ok: true, status: 200, headers: new Map(), json: async () => salida };
};

async function conFetch(simulado, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = simulado;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/* ---- guardado verificado con reintentos ---- */

test("guardado: si la respuesta llega rota y la hoja no lo tiene, se reintenta con la MISMA marca", async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  const guardados = [];
  let enHoja = persona();
  await conFetch(
    apiSimulada((b) => {
      if (b.accion === "guardar") {
        guardados.push(b);
        if (guardados.length === 1) return ROTA; // no se ejecuto
        enHoja = b.valores;
        return { ok: true, fila: 300 };
      }
      return { encontrada: true, fila: 300, valores: enHoja };
    }),
    async () => {
      const g = await guardarFilaVerificada({
        fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"],
        noMapeados: [{ curso: "X" }], esperaMs: 0,
      });
      assert.equal(g.confirmado, true);
      assert.equal(g.recuperado, true);
      assert.equal(g.intentos, 2);
    }
  );
  assert.equal(guardados.length, 2);
  assert.equal(guardados[0].marca, guardados[1].marca, "un reintento no es una escritura nueva");
  assert.deepEqual(guardados[0].noMapeados, [{ curso: "X" }]);
  assert.deepEqual(guardados[1].noMapeados, [], "los cursos sin mapear no se duplican");
});

test("guardado: si todos los intentos llegan rotos y la hoja no lo tiene, se rinde tras los reintentos", async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  let guardados = 0;
  await conFetch(
    apiSimulada((b) => (b.accion === "guardar" ? (guardados++, ROTA) : { encontrada: true, fila: 300, valores: persona() })),
    async () => {
      await assert.rejects(
        guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"], reintentos: 2, esperaMs: 0 }),
        /No se encontró la página/
      );
    }
  );
  assert.equal(guardados, 3);
});

test('guardado: con releer "si-falla" y la respuesta sana no se vuelve a leer la hoja', async () => {
  const acciones = [];
  await conFetch(
    apiSimulada((b) => (acciones.push(b.accion), { ok: true, fila: 300 })),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: persona(), dni: "04086358", codigos: ["TA"], releer: "si-falla" });
      assert.equal(g.confirmado, true);
      assert.equal(g.recuperado, false);
    }
  );
  assert.deepEqual(acciones, ["guardar"]);
});

test('guardado: con releer "si-falla" y la respuesta rota, se relee y la hoja confirma', async () => {
  const pedida = persona();
  pedida[colTipo("TA")] = "A";
  const acciones = [];
  await conFetch(
    apiSimulada((b) => {
      acciones.push(b.accion);
      return b.accion === "guardar" ? ROTA : { encontrada: true, fila: 300, valores: pedida }; // si se ejecuto
    }),
    async () => {
      const g = await guardarFilaVerificada({ fila: 300, valores: pedida, dni: "04086358", codigos: ["TA"], releer: "si-falla", esperaMs: 0 });
      assert.equal(g.recuperado, true);
    }
  );
  assert.deepEqual(acciones, ["guardar", "persona"]);
});

/* ---- renovacion que no se pudo guardar ---- */

test("renovacion: si el guardado no se pudo hacer, el error trae lo calculado para no perder la ficha", async () => {
  // una "A" con la capacitacion vencida: recalculada queda distinta de la hoja
  const fila = persona();
  fila[colTipo("TA")] = "A";
  fila[colCap("TA")] = "2020-01-10";
  await conFetch(
    apiSimulada((b, ruta) => {
      if (ruta === "/api/search") return { items: [], avisos: [] };
      if (b.accion === "persona") return { encontrada: true, fila: 300, valores: fila };
      return ROTA; // guardar
    }),
    async () => {
      await assert.rejects(
        renovarPersona("04086358", { config: { A_SIN_CERT: "DEGRADAR" } }, { reintentosGuardado: 0 }),
        (e) => {
          assert.match(e.message, /no se pudo guardar la fila en la hoja/);
          assert.equal(e.resultado.estado, "ok");
          assert.equal(e.resultado.sinGuardar, true);
          assert.equal(e.resultado.fila, 300);
          assert.ok(Array.isArray(e.resultado.valores), "la fila recalculada, para reintentar el guardado");
          assert.ok(Array.isArray(e.resultado.detalle));
          return true;
        }
      );
    }
  );
});

/* ---- carril de fondo retenido ---- */

test("cola: con el fondo retenido, lo urgente pasa y lo de fondo espera hasta soltarlo", async () => {
  const orden = [];
  await conFetch(
    apiSimulada((b) => (orden.push(b.accion), { ok: true, encontrada: false })),
    async () => {
      const soltar = retenerFondo();
      const fondo = drive({ accion: "subir-lote" }, undefined, { fondo: true });
      const urgente = sheets({ accion: "persona", dni: "1" });
      await urgente;
      await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(orden, ["persona"], "la subida no sale mientras se pintan las fichas");
      soltar();
      await fondo;
      assert.deepEqual(orden, ["persona", "subir-lote"]);
      soltar(); // soltar dos veces no descuenta de mas
    }
  );
});
