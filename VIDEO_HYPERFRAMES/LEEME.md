# Videos de este proyecto (HyperFrames)

## Contenido
- `videos/`: los MP4 finales (venta horizontal, venta vertical y tutorial).
- `codigo_hyperframes/`: el **código HyperFrames** que generó cada video. Cada carpeta es un proyecto independiente: `index.html` (composición y animación GSAP) y `assets/` (voz, música, capturas, fuentes).
- `guion/`: el guion de cada video (`.mjs`), con las escenas, la narración, los resaltados y los zooms.
- `SKILL.md`: la **guía de diseño** detallada (colores, tipografía, layout, coreografía, audio, captura y control de calidad) para crear más videos con el mismo estilo.

- `videos/Riesgos Criticos - Venta 16x9.mp4`
- `videos/Riesgos Criticos - Venta 9x16.mp4`
- `videos/Riesgos Criticos - Tutorial.mp4`

## Volver a renderizar un video sin cambios
```
- `codigo_hyperframes/rrcc-venta-landscape/` → Riesgos Criticos - Venta 16x9.mp4
- `codigo_hyperframes/rrcc-venta-portrait/` → Riesgos Criticos - Venta 9x16.mp4
- `codigo_hyperframes/rrcc-tutorial-landscape/` → Riesgos Criticos - Tutorial.mp4
cd codigo_hyperframes/<carpeta>
npx hyperframes render -o ../../videos/<nombre>.mp4 -q high -f 30
```
Para previsualizarlo y editarlo en el navegador (HyperFrames Studio), en la misma carpeta: `npx hyperframes preview`.

## Cambiar textos, voz o marca
El generador está en `04_PLANTILLAS_Y_HERRAMIENTAS/ESTUDIO_VIDEOS_HYPERFRAMES`.
1. Edita el guion en `specs/` (es el mismo archivo que hay en `guion/`) o la marca en `brand.json`.
2. Desde esa carpeta, ejecuta `node tools/build.mjs specs/<guion>.mjs`.
3. Renderiza el resultado con `node tools/queue.mjs 2`. Antes, agrega la línea del video a `render-queue.txt`.
