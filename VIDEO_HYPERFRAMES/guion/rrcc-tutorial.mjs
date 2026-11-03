// Tutorial completo de RRCC (Riesgos Críticos): uso de cada pestaña.
export default {
  id: "rrcc-tutorial",
  title: "Riesgos Críticos — Tutorial",
  kind: "tutorial",
  formats: ["landscape"],
  voice: "es-PE-CamilaNeural",
  rate: "+0%",
  product: "Riesgos Críticos",
  url: "riesgos-criticos.app",
  shotsDir: "captures/rrcc/shots",
  shotSize: [1600, 900],
  scenes: [
    {
      type: "title", icon: "shield-check", kicker: "Tutorial completo", title: "Cómo usar *Riesgos Críticos*",
      sub: "Renovación, certificados, fotochecks y control del personal",
      vo: ["Bienvenido al tutorial de Riesgos Críticos.", "Verás cómo renovar autorizaciones, descargar certificados, generar fotochecks y controlar a todo tu personal."],
    },
    {
      type: "toc", kicker: "Lo que verás", title: "Contenido",
      items: [
        { icon: "refresh-cw", title: "Renovación" }, { icon: "id-card", title: "Fotocheck" },
        { icon: "download", title: "Certificados" }, { icon: "users", title: "Nuevo personal" },
        { icon: "chart-bar", title: "Estados y exportación" }, { icon: "layers", title: "Fotochecks del personal" },
      ],
      vo: ["La app tiene una pestaña para cada tarea. Vamos una por una."],
    },
    { type: "chapter", num: "01", title: "Renovación", vo: ["Empecemos por la pestaña Renovación."] },
    {
      type: "screen", step: "Paso 1", title: "Consulta sin modificar nada", shot: "01-renov",
      bullets: ["Un DNI por línea, o Excel / CSV", "Ctrl + Enter para consultar", "Solo lectura: no escribe nada"],
      vo: [
        { t: "Escribe los DNI del personal a renovar, uno por línea. También puedes cargar un Excel o CSV.", zoom: [20, 180, 360, 420], hl: "01-renov.dnis" },
        { t: "La app restaura los ceros a la izquierda que Excel suele borrar, y te muestra qué corrigió." },
        { t: "Presiona Control más Enter para consultar y verificar. Esta consulta es de solo lectura: no escribe en la hoja ni en Drive.", reset: true },
      ],
    },
    {
      type: "screen", step: "Paso 2", title: "Lee la ficha de cada persona", shot: "02-consulta",
      bullets: ["Resumen de autorizaciones vigentes", "Alertas: vencidos, por vencer, fechas distintas", "Tarjetas A · autorizados y C · capacitados"],
      vo: [
        { t: "Cada persona aparece con su ficha: foto, DNI, datos del examen médico y área.", zoom: [240, 110, 1040, 240], hl: [240, 118, 1040, 110] },
        { t: "El resumen indica cuántas autorizaciones están vigentes y cuántas tienen certificado nuevo.", hl: [245, 322, 722, 26] },
        { t: "Las alertas avisan de lo vencido, lo por vencer y las fechas de la hoja que no coinciden con el certificado.", zoom: "02-consulta.alertas", hl: [244, 220, 420, 32] },
        { t: "Abajo, cada riesgo crítico es una tarjeta: A, autorizado, o C, solo capacitado.", reset: true, hl: [244, 360, 1116, 328] },
        { t: "Si la fecha de la hoja difiere del certificado, el botón Usar aplica la fecha correcta con un clic.", zoom: [400, 370, 640, 340], hl: [552, 520, 182, 30] },
      ],
    },
    {
      type: "screen", step: "Paso 3", title: "Renueva las autorizaciones", shot: "02-consulta",
      bullets: ["Actualiza la fila en Google Sheets", "Crea la carpeta de la persona en Drive", "Sube certificados, fotocheck y Word"],
      vo: [
        { t: "Cuando todo esté revisado, pulsa Renovar autorizaciones.", click: [29, 778, 166, 46], hl: [29, 778, 166, 46] },
        { t: "La app escribe la fila en Google Sheets, aplicando la regla de las A: se mantiene lo que la persona ya tenía autorizado." },
        { t: "En Drive crea la carpeta de cada persona, con sus certificados vigentes, el fotocheck nuevo y el Word de autorización.", img: "05-renovando", hl: [240, 262, 1340, 118] },
        { t: "Si la carpeta ya existe, se reutiliza: puedes volver a correr la renovación sin duplicar archivos.", img: "06-renovado", hl: [221, 736, 1363, 150] },
      ],
    },
    { type: "chapter", num: "02", title: "Fotocheck", vo: ["Veamos el fotocheck."] },
    {
      type: "screen", step: "Paso 4", title: "Fotocheck automático", shot: "02-consulta",
      bullets: ["Se dibuja con los datos de la hoja", "Anverso y reverso", "Descarga como imagen o Word"],
      vo: [
        { t: "El botón Ver fotocheck abre la tarjeta de la persona.", click: "02-consulta.fotocheckBtn", hl: "02-consulta.fotocheckBtn" },
        { t: "Se dibuja sola: foto, datos, examen médico y la grilla de los dieciocho riesgos con su vencimiento.", img: "03-fotocheck", zoom: [950, 370, 620, 440], hl: [955, 383, 615, 420] },
        { t: "La A sombreada indica autorizado y la C, capacitado. Al pie, si la persona está autorizada o no." },
        { t: "Puedes descargarla como imagen o como Word, con el fotocheck nuevo y el antiguo.", reset: true, hl: [955, 820, 620, 60] },
      ],
    },
    { type: "chapter", num: "03", title: "Certificados", vo: ["Ahora, la pestaña Certificados."] },
    {
      type: "screen", step: "Paso 5", title: "Descarga certificados en lote", shot: "07-cert",
      bullets: ["Uno o varios DNI", "Busca en todas tus fuentes", "Un ZIP ordenado por persona"],
      vo: [
        { t: "Escribe uno o varios DNI y pulsa Iniciar extracción.", hl: [29, 148, 358, 580], click: [29, 827, 358, 45] },
        { t: "La app busca los certificados de cada persona en todas tus fuentes configuradas.", img: "08-cert-resultado", hl: [425, 120, 1150, 362] },
        { t: "Al terminar, Descargar ZIP te entrega los certificados ordenados, con una carpeta por persona.", hl: [425, 512, 1150, 44] },
        { t: "Y como un lote puede tardar, te avisa al finalizar con una notificación y un sonido.", reset: true },
      ],
    },
    { type: "chapter", num: "04", title: "Nuevo personal", vo: ["Para dar de alta a una persona, usa Nuevo personal."] },
    {
      type: "screen", step: "Paso 6", title: "Alta con matriz por puesto", shot: "09-nuevo",
      bullets: ["Datos de la persona", "La matriz propone las A del cargo", "Alta y renovación en un paso"],
      vo: [
        { t: "Escribe el DNI. Si la persona ya existe, la app rellena sus datos y te avisa, para no duplicarla.", zoom: [20, 70, 400, 380], hl: [25, 130, 375, 70] },
        { t: "Completa nombres, empresa, cargo y área.", hl: [25, 200, 375, 450] },
        { t: "Según el cargo, la matriz por puesto propone qué riesgos van autorizados.", reset: true, hl: [425, 160, 1150, 130] },
        { t: "Pulsa Dar de alta y renovar, y la persona queda registrada con su carpeta y su fotocheck.", click: [25, 832, 362, 34], hl: [25, 828, 362, 42] },
      ],
    },
    { type: "chapter", num: "05", title: "Estados y exportación", vo: ["Las siguientes pestañas te dan el control de todo el personal."] },
    {
      type: "screen", step: "Paso 7", title: "Estado por riesgo crítico", shot: "10-estado",
      bullets: ["Filtra por riesgo, estado o fecha", "Ordena de lo vencido a lo vigente", "Imprime o exporta a Excel"],
      vo: [
        { t: "En Estado RRCC, pulsa Cargar personal y verás, por cada riesgo, quién está vigente, por actualizar o vencido.", hl: [425, 103, 1163, 728] },
        { t: "Filtra por riesgo, por estado o por fecha de vencimiento.", zoom: [20, 70, 400, 500], hl: [25, 150, 375, 400] },
        { t: "Y lleva el resultado a impresión o a Excel.", reset: true, hl: [25, 826, 375, 52] },
      ],
    },
    {
      type: "screen", step: "Paso 8", title: "Estado total y exportación", shot: "11-total",
      bullets: ["Personas con algo vencido", "Lo más urgente primero", "PDF, Excel, imagen o ZIP"],
      vo: [
        { t: "Estado total resume a las personas con algún riesgo vencido o por vencer, empezando por lo más urgente.", hl: [425, 110, 1150, 290] },
        { t: "Puedes exportarlo a PDF, Excel o imagen.", hl: [25, 826, 375, 52] },
        { t: "Y en Exportación obtienes la lista de autorizados vigentes, con un ZIP de sus certificados.", img: "12-export", hl: [412, 110, 1163, 560] },
      ],
    },
    {
      type: "screen", step: "Paso 9", title: "Fotochecks de todo el personal", shot: "13-ver",
      bullets: ["Galería de fotochecks", "Filtros por estado, guardia y cargo", "ZIP de fotochecks y certificados"],
      vo: [
        { t: "Ver RRCC muestra el fotocheck de cada persona, tal como queda en la hoja.", zoom: [425, 110, 760, 560], hl: [425, 110, 375, 290] },
        { t: "Filtra por estado, guardia, cargo, área o riesgo.", reset: true, hl: [25, 150, 375, 420] },
        { t: "Y descarga todos los fotochecks o los certificados en un ZIP.", hl: [25, 776, 375, 100] },
      ],
    },
    {
      type: "features", kicker: "Consejos", title: "Buenas prácticas",
      items: [
        { icon: "search", title: "Consulta primero", text: "Revisa la ficha antes de renovar." },
        { icon: "triangle-alert", title: "Atiende las alertas", text: "Vencidos y fechas distintas al certificado." },
        { icon: "users", title: "Matriz al día", text: "Mantén actualizada la matriz por puesto." },
        { icon: "chart-bar", title: "Control semanal", text: "Revisa Estado total cada semana." },
      ],
      vo: ["Unos consejos finales.", "Consulta siempre antes de renovar.", "Atiende las alertas de vencidos y fechas distintas.", "Mantén al día la matriz por puesto.", "Y revisa el estado total cada semana."],
    },
    {
      type: "title", icon: "badge-check", title: "¡Listo! Ya dominas *Riesgos Críticos*", sub: "Autorizaciones siempre al día, sin Excel.",
      vo: ["¡Listo! Ya sabes usar Riesgos Críticos. Tus autorizaciones, siempre al día."],
      hold: 1.5,
    },
  ],
};
