// Video de venta de RRCC (Riesgos Críticos). Sin cifras inventadas: solo hechos del producto (18 RRCC, Sheets, Drive, Word).
export default {
  id: "rrcc-venta",
  title: "Riesgos Críticos — Venta",
  kind: "venta",
  formats: ["landscape", "portrait"],
  voice: "es-PE-AlexNeural",
  rate: "+10%",
  product: "Riesgos Críticos",
  url: "riesgos-criticos.app",
  shotsDir: "captures/rrcc/shots",
  shotSize: [1600, 900],
  scenes: [
    {
      type: "title", kicker: "Para áreas SSMA", kickerIcon: "hard-hat",
      title: "¿Renovar autorizaciones te quita *días*?",
      vo: ["¿Renovar las autorizaciones de riesgos críticos le quita días a tu equipo?"],
    },
    {
      type: "pain", kicker: "El problema", title: "Certificados, Excel y fotochecks a mano",
      items: [
        { icon: "search", title: "Certificados dispersos", text: "Buscar en cada plataforma, persona por persona." },
        { icon: "file-spreadsheet", title: "Un Excel frágil", text: "Fechas, vencimientos y estados calculados a mano." },
        { icon: "id-card", title: "Fotochecks uno por uno", text: "Diseñar, exportar y archivar cada tarjeta." },
      ],
      vo: [
        "Certificados repartidos en varias plataformas.",
        "Vencimientos y estados calculados a mano en un Excel.",
        "Y fotochecks armados uno por uno.",
      ],
    },
    {
      type: "title", icon: "shield-check", title: "Conoce *Riesgos Críticos*", sub: "Certificados, vigencias y fotochecks en un solo flujo.",
      chips: [{ icon: "layers", t: "18 riesgos críticos" }, { icon: "sheet", t: "Google Sheets y Drive" }, { icon: "id-card", t: "Fotocheck automático" }],
      vo: ["Conoce Riesgos Críticos: certificados, vigencias y fotochecks, en un solo flujo."],
      hold: 0.4,
    },
    {
      type: "screen", kicker: "1 · Consulta", title: "Escribe el DNI y verifica al instante", shot: "01-renov",
      vo: [
        { t: "Escribe uno o varios DNI y consulta.", hl: "01-renov.dnis" },
        { t: "La app reúne sus certificados y recalcula los dieciocho riesgos críticos.", img: "02-consulta", hl: [244, 360, 1116, 328] },
        { t: "Y te alerta de lo vencido, lo por vencer y los *certificados nuevos*.", zoom: [240, 200, 600, 160], hl: [244, 222, 400, 30] },
      ],
    },
    {
      type: "screen", kicker: "2 · Fotocheck", title: "El fotocheck se genera solo", shot: "03-fotocheck",
      vo: [
        { t: "El fotocheck se dibuja automáticamente: foto, datos y grilla de autorizaciones.", zoom: [950, 370, 620, 440], hl: [955, 383, 615, 420] },
      ],
    },
    {
      type: "screen", kicker: "3 · Renueva", title: "Un clic: Sheets, Drive y Word listos", shot: "02-consulta",
      vo: [
        { t: "Con un clic renuevas: tu base en Google Sheets queda actualizada…", click: [29, 778, 166, 46], hl: [29, 778, 166, 46] },
        { t: "…y en Drive quedan los certificados vigentes, el fotocheck y el Word de autorización.", img: "05-renovando", hl: [240, 262, 1340, 118] },
      ],
    },
    {
      type: "screen", kicker: "4 · Controla", title: "Todo tu personal, de un vistazo", shot: "10-estado",
      vo: [
        { t: "Controla el estado de cada riesgo, de lo vencido a lo vigente.", hl: [425, 103, 1163, 728] },
        { t: "Y los fotochecks de todo tu personal, listos para imprimir.", img: "13-ver", zoom: [425, 110, 760, 560] },
      ],
    },
    {
      type: "compare", kicker: "Antes y ahora", title: "La diferencia se nota",
      left: { title: "Antes", items: ["Certificados en varias plataformas", "Vigencias calculadas a mano", "Fotochecks uno por uno"] },
      right: { title: "Con Riesgos Críticos", items: ["Todo en una sola consulta", "Estados y vencimientos automáticos", "Fotocheck y Word en un clic"] },
      vo: ["Antes: horas buscando certificados y actualizando Excel.", "Ahora: una consulta, un clic, y todo queda al día."],
    },
    {
      type: "cta", title: "Autorizaciones al día, *sin Excel*.", sub: "Google Sheets · Google Drive · Fotocheck y Word automáticos",
      vo: ["Riesgos Críticos: tus autorizaciones, siempre al día.", "Solicita hoy tu demostración."],
      hold: 0.8,
    },
  ],
};
