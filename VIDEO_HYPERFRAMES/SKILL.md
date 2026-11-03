---
name: estilo-videos-hyperframes
description: Sistema de diseño y método completo para crear videos de VENTA (60–75 s, 16:9 y 9:16) y TUTORIALES (2–4 min, 16:9) de apps web/móviles con HyperFrames, en el estilo usado en los videos de IntelliExtract, Riesgos Críticos, LearnDrive, Reporte SSMA, Reporta Herramientas, Entrega Docs y Herramientas Scan. Úsala para producir un video nuevo de cualquier proyecto con el mismo look, ritmo, narración, capturas con datos ficticios y estructura persuasiva.
---

# Estilo de videos HyperFrames — guía de diseño y producción

Esta skill describe **exactamente** cómo se construyeron los videos: identidad visual, estructura narrativa, coreografía, audio y captura de pantallas. Si la sigues, cualquier video nuevo se verá como parte de la misma serie.

El generador vive en `ESTUDIO_VIDEOS_HYPERFRAMES/`:
- `tools/build.mjs`: convierte un guion en un proyecto HyperFrames.
- `tools/theme.css`: el sistema visual.
- `tools/music.py`: la música.
- `tools/queue.mjs`: la cola de render.
- `tools/cap-*.mjs`: las capturas.
- `brand.json`: la marca.

Cada proyecto guarda en su carpeta `VIDEO_HYPERFRAMES/` sus MP4, su código HyperFrames ya generado y su guion.

---

## 1. Principios

1. **Pantallas reales, datos ficticios.** Se muestra la app verdadera corriendo en local, pero todas sus APIs (Google Sheets, Apps Script, Drive, Gemini, etc.) se simulan con datos inventados:
   - nombres armados con apellidos comunes y DNI aleatorios;
   - la empresa "EMPRESA DEMO S.A.C.".

   Nunca se escribe en sistemas reales ni se muestran datos de personas reales. Los logos y nombres de clientes se reemplazan por genéricos ("DEMO").
2. **Marca neutra e insertable.** Todo color, logo y contacto sale de `brand.json`. Para cambiar de marca se edita ese archivo y se vuelve a renderizar.
3. **Persuasión honesta.** Solo se usan cifras que el dueño del producto ya publicó en sus pitch (por ejemplo 98 % de coincidencias o 20 participantes por hoja). Fuera de eso se habla de beneficios concretos y verificables en la pantalla.
4. **Una idea por escena, una frase por acción.** Cada frase de la voz coincide con un cambio visible: un zoom, un resaltado, un clic o una pantalla nueva.
5. **Ritmo ágil.** En las ventas se recortan los silencios del TTS. En los tutoriales hay pausas algo más largas para que se pueda seguir.

---

## 2. Identidad visual (tokens)

| Token | Valor por defecto | Uso |
|---|---|---|
| `--bg1` | `#070b16` | fondo base (azul noche casi negro) |
| `--bg2` | `#111a33` | degradado radial superior izquierdo |
| `--ac` | `#38bdf8` | acento principal (celeste): palabras clave `*así*`, bordes de resaltado, iconos |
| `--ac2` | `#a78bfa` | acento secundario (violeta): fin de degradados, segundo halo |
| `--tx` | `#eef2ff` | texto principal |
| `--mu` | `#a3adc8` | texto secundario (subtítulos de escena, descripciones) |
| `--card` | `rgba(255,255,255,0.06)` | tarjetas de vidrio |
| `--line` | `rgba(255,255,255,0.12)` | bordes finos |
| dolor | `#f97316 → #ef4444` | icono de las tarjetas "problema" |
| ok / mal | `#4ade80` / `#f87171` | columnas "Con X" / "Antes" del comparativo |

**Fondo:** degradado radial `--bg2 → --bg1`, más dos halos grandes (1300 px, `radial-gradient` del acento al 30 % de opacidad) que se desplazan muy lento durante todo el video, más una grilla técnica de 64 px con líneas blancas al 4.5 %. No uses `filter: blur` animado, porque es costoso en el render.

**Tipografía:**
- títulos: **Space Grotesk** 700, con `letter-spacing -0.02em`;
- cuerpo y subtítulos: **Inter** 400/600/700/800.

Siempre se cargan como `@font-face` locales (woff2 en `assets/fonts`).

| Elemento | Horizontal | Vertical |
|---|---|---|
| Título hero | 104 px | 92 px |
| Título de escena | 78 px | 76 px |
| Título sobre pantalla | 54 px | 64 px |
| Riel del tutorial | 46 px | — |
| Kicker | 24 px, mayúsculas, `letter-spacing .12em`, color acento, dentro de una píldora de vidrio con icono | — |
| Subtítulos (captions) | 36 px (venta), 34 px (tutorial) | 48–50 px |

Los subtítulos van en una píldora `rgba(4,8,20,.78)`, peso 600 y blanco, con las palabras clave en acento.

**Iconos:** Lucide (`lucide-static`), con trazo de 2 px. Van dentro de cuadros redondeados (radio de 18 px) con un degradado `--ac → --ac2`.

**Superficies:** tarjetas de vidrio con radio de 26 px, borde `--line` y sombra `0 18px 50px rgba(0,0,0,.25)`.

**Marcos de pantalla (`device`):**
- `browser`: barra de 44 px con los tres puntos de macOS y una URL ficticia, radio 18, sombra profunda. Para apps de escritorio, con capturas a 1600×900 @1.5x o 1920×1080 @1.25x.
- `phone`: bisel negro de 12 px y radio de 52 px. Para apps móviles, con capturas a 390×844 @3x.
- `doc`: hoja blanca con 12 px de margen. Para PDFs generados por la app (vales, certificados), renderizados a PNG.

---

## 3. Formatos y layout

| Formato | Lienzo | Pantalla de escritorio | Teléfono | Subtítulos |
|---|---|---|---|---|
| Venta horizontal | 1920×1080 | navegador de 1360 px de ancho, en x=280 / y=168; título encima | teléfono de 400 px a la derecha (x=1230); título y viñetas a la izquierda | y=975, ancho 1500 |
| Venta vertical | 1080×1920 | visor alto de 1000×1090: la cámara **panea** dentro de la captura según lo que se narra | teléfono de 560 px centrado (y=380) | y=1650, ancho 980 |
| Tutorial | 1920×1080 | riel izquierdo de 450 px (insignia "Paso N", título y viñetas con check) + navegador de 1300 px a la derecha | teléfono de 380 px en x=1020 | y=930, sobre el área de la pantalla |

**Zonas seguras:** el texto nunca a menos de 60 px del borde. En vertical, todo el contenido importante entre y=150 e y=1750.

---

## 4. Estructura narrativa

### Video de VENTA (60–75 s)

1. **Gancho** (`title`): una pregunta que duele, con kicker de audiencia ("Para áreas SSMA"). Ej.: "¿Todavía digitas tus *hojas de asistencia*?"
2. **Problema** (`pain`): tres tarjetas con icono naranja y frases cortas de 5 a 8 palabras.
3. **Revelación** (`title` con icono): "Conoce *Producto*", más una línea de valor y tres chips de beneficio.
4. **Demostración** (2 a 4 escenas `screen`): kicker "1 · Verbo", título de beneficio y una o dos frases por escena, con resaltado, zoom o clic sincronizados.
5. **Prueba** (`stats` o `compare`): cifras reales del pitch, o "Antes / Con Producto" con tres filas cada uno.
6. **Cierre** (`cta`): nombre del producto en degradado, promesa en una línea, botón "Solicita una demostración" que late, y contacto desde `brand.json`.

**Voz:** es-PE Alex a +10 %. Frases de 6 a 14 palabras.

### TUTORIAL (2–4 min)

1. Portada (`title`): "Cómo usar *Producto*" y para quién es.
2. Índice (`toc`): 4 a 6 temas numerados con icono.
3. Por cada sección: un `chapter` (número gigante en degradado + título) y luego escenas `screen` con "Paso N", título, 2 o 3 viñetas y 2 a 6 frases. Cada frase señala un elemento real de la pantalla.
4. Buenas prácticas (`features`): 4 tarjetas, con una frase por tarjeta.
5. Cierre (`title` con `badge-check`): "¡Listo! Ya dominas *Producto*".

**Voz:** es-PE Camila al 0 %. Tono instructivo, en segunda persona, verbos en imperativo amable ("Pulsa", "Elige", "Revisa").

**Escritura en pantalla:** los `*asteriscos*` marcan la palabra clave que se pinta en el color de acento. Usa `say:` cuando la pronunciación deba diferir del texto (por ejemplo "Intelli Extract").

---

## 5. Coreografía de animación (GSAP, línea de tiempo única y pausada)

| Elemento | Animación |
|---|---|
| Escena | contenedor `.inner` con fundido de entrada de 0.45 s y salida de 0.35 s |
| Kicker | `y 16→0` en 0.5 s, `power3.out` |
| Título | palabra por palabra: `y 34→0`, `opacity 0→1`, stagger de 0.06 s, `power3.out` |
| Subtítulo de escena | `y 20→0` en 0.6 s, 0.7 s después del título |
| Tarjetas, viñetas, chips | entran **sincronizadas con la frase que las nombra**: `y 40→0` y `scale .96→1` en 0.55 s |
| Pantalla (device) | entra con `y 60→0` y `rotationX 8→0` (perspectiva de 1600) en 0.9 s |
| Zoom | `scale` 1→1.6–2.3 y traslación para centrar el rectángulo de interés, 1.0 s `power2.inOut`; arranca 0.15 s antes de la frase |
| Resaltado | marco de 4 px en acento con halo + "spotlight" que oscurece el resto (`box-shadow 0 0 0 4000px rgba(5,10,25,.38)`); aparece 0.75 s después del inicio de la frase y se va 0.35 s antes de la siguiente |
| Cursor | flecha blanca con contorno oscuro; viaja al objetivo en 0.75 s, se encoge al hacer clic y deja una onda en acento; su escala compensa el zoom para mantener tamaño constante |
| Cambio de captura | fundido cruzado de 0.4 s dentro del mismo marco (así se ve "la app reaccionando") |
| Botón del CTA | late con `scale 1→1.05`, en yoyo ×3 |
| Fondo | los halos cruzan la pantalla durante toda la duración, con `sine.inOut` |

**Reglas HyperFrames:**
- una sola `gsap.timeline({ paused: true })` registrada en `window.__timelines["main"]`;
- nada de CSS `transform` en elementos que GSAP anima (inicializa con `fromTo`);
- cada `<audio>` lleva `id`;
- las fuentes se cargan locales;
- el check debe pasar con 0 errores.

---

## 6. Tiempos

- **Venta:** 0.35 s de entrada a la escena, 0.22 s entre frases y 0.55 s de cola.
- **Tutorial:** 0.55 s, 0.45 s y 1.0 s respectivamente.

La duración de cada escena sale de la voz real: la suma de las frases, más los huecos, más la cola. El TTS se recorta: se eliminan los silencios iniciales y finales y se dejan 60 ms de colchón.

**Subtítulos:** las frases largas se parten en fragmentos de 74 caracteres (venta), 80 (tutorial) o 56 (vertical), cortando en la puntuación. Cada fragmento dura lo proporcional a sus caracteres. Si el último fragmento tiene menos de 22 caracteres, se une al anterior.

---

## 7. Audio

- **Voz:** edge-tts con es-PE-AlexNeural (venta, +10 %) y es-PE-CamilaNeural (tutorial, 0 %). Si el servicio no responde, se usa el respaldo local Kokoro (`TTS_ENGINE=kokoro`), con em_alex y ef_dora. Las voces se guardan en caché por hash de voz, velocidad y texto.
- **Música** (`tools/music.py`, 100 % sintetizada, sin derechos):
  - venta: 112 BPM, progresión Am–F–C–G con pad de sierras filtradas, bajo en corcheas, arpegio pulsado, bombo, palmas y hi-hat;
  - tutorial: 92 BPM, Cmaj7–Am7–Fmaj7–G, pulso suave.

  Ambas con fade in de 1.2 s, fade out de 2.5 s y limitador tanh.
- **Mezcla:** voz a 1.0. Música a 0.20 en venta y a 0.09 en tutorial, con 2 s de fade final. El resultado queda en unos −17 LUFS integrados.

---

## 8. Captura de pantallas (método)

1. Levanta la app en local: `vite` o `python -m http.server`.
2. Con `playwright-core` y Chrome:
   - bloquea toda red externa;
   - atiende cada endpoint (`script.google.com`, `docs.google.com/.../gviz`, `/api/*`, `generativelanguage.googleapis.com`) con mocks que devuelven el formato exacto que el código espera;
   - el formato se lee del propio backend: `Code.gs` y `api/*.js`.
3. Recorre el flujo real de la app: clics, formularios, cargas de archivos y diálogos aceptados.
4. Guarda cada pantalla en PNG y las cajas de los elementos en `boxes.json`, que se usan para zoom y resaltado.
5. Simula los recursos que falten:
   - hojas manuscritas falsas (`make-sheet.mjs`);
   - foto o rostro ilustrado como cámara falsa (`--use-file-for-fake-video-capture=face.y4m`; la detección facial de MediaPipe lo acepta);
   - PDFs generados por la app, capturados al descargarse y renderizados con PyMuPDF.
6. Sustituye por genéricos los logos de clientes y los nombres reales: intercepta los archivos de imagen o reemplaza el texto del DOM en la captura.
7. Desactiva las guías interactivas (tours) o úsalas a propósito en una sola escena.

---

## 9. Guion (spec) — formato

```js
export default {
  id: "producto-venta", kind: "venta" /* o "tutorial" */, formats: ["landscape", "portrait"],
  voice: "es-PE-AlexNeural", rate: "+10%", product: "Producto", url: "producto.app",
  shotsDir: "captures/producto/shots", shotSize: [1600, 900],
  scenes: [
    { type: "title", kicker: "Para áreas SSMA", kickerIcon: "hard-hat", title: "¿Pregunta con *dolor*?", vo: ["Frase de gancho."] },
    { type: "pain", title: "...", items: [{ icon: "clock", title: "...", text: "..." }], vo: ["...", "...", "..."] },
    { type: "screen", device: "phone" /* browser por defecto | doc */, kicker: "1 · Sube", title: "...", shot: "01-inicio",
      bullets: ["..."], vo: [
        { t: "Frase.", hl: "01-inicio.boton" /* o [x,y,w,h] */, zoom: [x, y, w, h], click: "01-inicio.boton", img: "02-siguiente" },
        { t: "Otra frase.", reset: true } ] },
    { type: "stats", items: [{ value: "98%", label: "..." }], vo: [...] },
    { type: "compare", left: { title: "Antes", items: [...] }, right: { title: "Con X", items: [...] }, vo: [...] },
    { type: "cta", title: "Promesa en *una línea*.", sub: "...", vo: ["...", "Solicita hoy tu demostración."] },
    // tutorial: { type: "toc" }, { type: "chapter", num: "01" }, { type: "features" }
  ],
};
```

---

## 10. Producir un video nuevo

```bash
cd ESTUDIO_VIDEOS_HYPERFRAMES
node tools/cap-<app>.mjs                 # 1. capturas con datos ficticios
node tools/build.mjs specs/<video>.mjs   # 2. genera build/<id>-<formato>/ (voz, música, HTML)
cd build/<id>-landscape && npx hyperframes check && npx hyperframes snapshot --at 5,20,40
echo "<id>-landscape|Nombre 16x9.mp4" >> ../../render-queue.txt
node tools/queue.mjs 2                   # 3. render (2 a la vez, 8 workers, calidad alta, 30 fps)
```

---

## 11. Control de calidad (antes de entregar)

- [ ] `hyperframes check`: 0 errores. Las advertencias de "subcomposición" solo afectan al Studio.
- [ ] Hoja de contactos con 6 a 10 fotogramas: resaltados sobre el elemento correcto, sin texto cortado y con subtítulos de dos líneas como máximo.
- [ ] Ningún dato real, logo de cliente ni cifra inventada a la vista.
- [ ] MP4: H.264 + AAC, 1080p a 30 fps, duración igual a la del guion, alrededor de −17 LUFS.
- [ ] La versión vertical lee bien en un celular: subtítulos grandes y la cámara centrada en la acción.
