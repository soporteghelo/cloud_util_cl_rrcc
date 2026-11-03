# Plan de Gestión Preventiva de Riesgos Críticos (RRCC) — v2
**AESA · SSOMA / Competencias y Aprendizaje · U.M. Cerro Lindo (Nexa)**
Versión 2.0, octubre de 2026. Ajustada al aplicativo `RRCC_ALL` (Vite + Apps Script + Sheets `BD AESA`).

> **Qué cambia respecto de la v1.** La v1 era un proceso genérico de "cupos y reportes". Después de revisar la app, el plan cambia de fondo: **la app ya puede saber, sin que el trabajador venga, quién ya pasó sus cursos y quién no.** Entonces el trabajador deja de ser el que dispara el trámite. El capacitador renueva en lote a quienes ya están listos, y al supervisor solo le llega la lista de quienes tienen algo pendiente: un curso, la revalidación o un dato.

---

## 1. Lo que la app ya resuelve (y que el plan aprovecha)

| Capacidad existente | Dónde está | Cómo la usa el plan |
|---|---|---|
| Reglas de vencimiento: `cap + 365` = VENCIDO, `≥ 330 días` = ACTUALIZAR (35 días de aviso) | `shared/estados.js` → `estadoDe`, `UMBRAL_*`, hoja `CONFIG` | Son la base del semáforo. No se inventan umbrales nuevos. |
| `FECHA MINIMA` / `ESTADO_FINAL`: la autorización cae cuando vence la **primera** "A" | `BD AESA` | Define cuándo hay que renovar a cada persona. |
| Inventario automático de certificados (JOMISER, EIN, Drive, Inducción) | `api/search.js`, `src/lib/renovacion.js` | **Barrido preventivo**: detectar quién ya aprobó sin esperar a que venga. |
| **CONSULTAR Y VERIFICAR** (solo lectura) y **renovación en lote** | pestaña RENOVACIÓN | Clasificar a la gente y renovar en bloque a los que están listos. |
| Columna `Guardia` (A, B, C, S/G) y `agruparPorGuardia` | `shared/estados.js` | Ordenar reportes y relacionarlos con la bajada de cada guardia. |
| Reportes ESTADO RRCC / ESTADO TOTAL en PDF, imagen y Excel por guardia | `src/vistas/estado*.js` | Base visual del reporte al supervisor. |
| Carpeta por DNI en Drive con certificados vigentes, fotocheck y Word | `RRCC/DATA/<DNI>` | Es el **expediente** que va a administración. No hace falta armar nada aparte. |
| Apps Script con tu cuenta (`apps-script/Code.gs`) | backend | Activadores programados para enviar correos sin servidor adicional. |

---

## 2. Diagnóstico afinado (lo que encontré en el código)

### Hallazgo 1: la Revalidación Anual de RRCC se descarta
En `shared/estados.js`, `CURSOS_IGNORADOS` incluye `"INDUCCION"`, `"RIESGOS CRITICOS"`, `"RRCC"`, `"RRCC 1"`, `"RRCC 2"`. La app **ve** ese certificado en JOMISER o en la carpeta de inducción, pero lo bota y **no guarda su fecha en ninguna columna**. Por eso nadie se entera cuando alguien la pasa en sus días libres, y por eso Nexa rechaza trámites que parecían listos.
**Acción:** dejar de ignorarlo y guardarlo como **requisito previo** en columnas nuevas al final de la hoja (ver §9).

### Hallazgo 2: cada "A" vence en su propia fecha, y eso multiplica los trámites
Cada uno de los 18 RRCC tiene su propia fecha de capacitación. Si una persona tiene 4 "A" capacitadas en meses distintos, **su autorización cae 4 veces al año** y cada caída es un trámite completo: ventanilla, administración, impresión y Nexa.
Ejemplo ilustrativo: 600 personas × 3–4 fechas distintas ≈ 1 800–2 400 trámites al año, es decir **35–45 por semana**. Ese es el volumen escondido que satura al capacitador.
**Acción:** **alinear fechas** (§8). Cuando alguien renueve, que lleve también los cursos que vencerían en los siguientes 60 días.

### Hallazgo 3: no existen ni el supervisor ni el calendario de bajada
`BD AESA` tiene `Guardia`, `Cargo` y `Área`, pero no dice **quién es el supervisor** ni **cuándo baja cada guardia**. Sin eso la app no puede avisar a nadie más que a ti.
**Acción:** dos hojas pequeñas nuevas, `MAPA_SUPERVISOR` y `CALENDARIO_GUARDIA` (§9). No se tocan las columnas existentes.

### Hallazgo 4: el trabajador no siempre necesita venir
La renovación arma el expediente con la foto (`FOTOS/<DNI>.png`), el fotocheck antiguo (`FOTOCHECK_ANTIGUO_DRIVE_ID`) y los certificados de las fuentes. **Si esos datos ya están en Drive y los cursos están aprobados, el capacitador puede renovar sin la persona delante.**
> ⚠️ **Por confirmar:** si Nexa o administración exige la firma del trabajador o la entrega física del fotocheck viejo, la presencia sigue siendo necesaria, pero solo en la **entrega** y ya no en la **gestión**. El plan funciona en ambos casos.

---

## 3. Principios del nuevo proceso

1. **La app detecta y el supervisor moviliza.** El capacitador no contacta trabajadores uno por uno.
2. **Se trabaja con 35 días de anticipación** (el umbral `ACTUALIZAR` que ya existe). Eso cubre al menos dos ciclos de guardia.
3. **Quien ya está listo se renueva en lote, sin esperar a que venga.**
4. **Ventanilla solo para lo que exige presencia** (foto, fotocheck antiguo, firma o entrega).
5. **Sin revalidación vigente no se inicia el trámite.** La app lo bloquea y no depende de la memoria de nadie.
6. **Todo se alinea con la ventana de Nexa (14:00–17:00)**, con corte a administración a las 12:00.

---

## 4. El barrido preventivo semanal (el corazón del plan)

### 4.1 Qué es
Una corrida en lote de **CONSULTAR Y VERIFICAR** (sin escribir nada) sobre **solo las personas activas en riesgo**: `_EstaTE = ACTIVO` y `FECHA MINIMA` en ≤ 35 días o ya vencida. De ~600 personas, normalmente serán unas 40–80, no las 600.

### 4.2 Cuándo
| Día | Hora | Qué |
|---|---|---|
| **Viernes** | 15:00 (corre en segundo plano; la app avisa con notificación y pitido al terminar) | Barrido semanal completo |
| **Lunes y miércoles** | 07:00 | Barrido corto, solo de la guardia que **baja al día siguiente** |

### 4.3 Resultado: cada persona cae en UNA bandeja

| Bandeja | Condición (calculada por la app) | Quién actúa | Qué pasa |
|---|---|---|---|
| ✅ **B1 · LISTO PARA RENOVAR** | Todas sus "A" por vencer ya tienen certificado nuevo, la revalidación está vigente y hay foto y fotocheck antiguo en Drive | **Capacitador** | Renovación en lote el mismo día. **El trabajador no viene.** |
| 📘 **B2 · FALTA CURSO** | Alguna "A" vence en ≤ 35 días y no hay certificado nuevo en ninguna fuente | **Supervisor** | Que el trabajador rinda el curso **antes de bajar**. El próximo barrido lo pasa solo a B1. |
| ⚫ **B3 · FALTA REVALIDACIÓN** | Revalidación anual vencida o por vencer en ≤ 35 días | **Supervisor** | Que la rinda. Bloquea todo lo demás. |
| 🪪 **B4 · FALTA DATO** | Sin foto, sin fotocheck antiguo, sin guardia, EMO vencido o curso "sin mapear" | **Capacitador + trabajador** | Cupo en ventanilla (§6). |
| 🔵 **B5 · EN TRÁMITE** | Renovado, en administración o en Nexa | **Capacitador / administración** | Seguimiento en la hoja `TRAMITES`. |
| 🔴 **B6 · VENCIDO** | `ESTADO_FINAL = VENCIDO` | **Supervisor → jefe de guardia** | No ingresa a mina. Escalamiento inmediato. |

> **Regla de bajada:** si la `FECHA MINIMA` cae entre la **bajada** y los **3 días posteriores a la subida** de su guardia (según `CALENDARIO_GUARDIA`), la persona sube de prioridad aunque le falten más de 15 días. Así se evita el caso de "volvió el martes y ya estaba vencido".

---

## 5. El supervisor: reporte, responsabilidad y escalamiento

### 5.1 Reporte automático
Lo envía Apps Script desde la hoja `SEGUIMIENTO` (que llena el barrido), **un día antes de cada bajada** (lunes para la del martes, miércoles para la del jueves), a las 08:00.

Cada supervisor recibe **solo a su gente**, y **solo las bandejas que le tocan** (B2, B3, B4 y B6). B1 y B5 aparecen como resumen, para que vea que SSOMA ya los está atendiendo.

```
RIESGOS CRÍTICOS · Supervisor: J. RAMOS · Guardia B · Baja: mar 13/10
Tu personal: 38 · ✅ 3 se renuevan sin acción tuya · 🔵 2 en trámite

🔴 VENCIDOS — NO INGRESAN (1)
  PÉREZ ROJAS, Juan · TA vencido 03/10

⚫ FALTA REVALIDACIÓN ANUAL (1)
  TORRES LEÓN, Raúl · vence 18/10 · debe rendirla ANTES de bajar

📘 FALTA CURSO (2)
  QUISPE MAMANI, Ana · TA vence 24/10 · CS vence 02/11
  ROJAS VERA, Luis · EC vence 21/10 (vence en sus días libres)

🪪 PASAR POR VENTANILLA (1)
  CHÁVEZ SOTO, Mario · falta foto del fotocheck antiguo · cupo lun 12/10 09:10

Confirma acciones aquí → [enlace al formulario] (hasta las 18:00)
```

### 5.2 Canal
- **Correo** (Apps Script `MailApp`, desde tu propia cuenta). Con Gmail gratuito el límite es de unos 100 destinatarios al día, suficiente para alrededor de 30 supervisores × 2 envíos.
- **WhatsApp del grupo de supervisores:** solo el **resumen numérico por guardia** (la imagen de ESTADO TOTAL que la app ya genera), sin datos personales.

### 5.3 Escalamiento automático
| Situación | Escala a | Cuándo |
|---|---|---|
| Supervisor no confirma un B2/B3/B6 | Jefe de guardia | 08:00 del día siguiente |
| Trabajador sigue en B2/B3 el día de su bajada | Jefe de guardia + ingeniero residente | Día de bajada, 08:00 |
| Persona pasa a B6 (vencido) | Residente + RR.HH. | Inmediato (barrido siguiente) |
| Supervisor con 2 o más vencidos en el mes | Gerencia del proyecto (KPI) | Consolidado mensual |

> **Cada correo queda registrado** en la hoja `AVISOS` (fecha, supervisor, DNI, bandeja). Esa es tu **evidencia** de que SSOMA avisó con 35 días de anticipación cuando alguien intente echarle la culpa al área.

---

## 6. Horario y ventanilla (ahora mucho más liviana)

Con el barrido, la ventanilla deja de ser la puerta de entrada de todos. Solo pasan **B4** y los casos que necesiten firma o entrega.

| Hora | Actividad |
|---|---|
| 07:30–08:00 | Revisar `SEGUIMIENTO` y confirmar cupos del día |
| **08:00–10:00** | **Ventanilla por cupos** (B4 y entregas). Cupos de 10 minutos, 12 como máximo |
| **10:00–11:30** | **Renovación en lote de B1** (sin trabajadores presentes) |
| 11:30–12:00 | Cerrar el lote del día: marcar `TRAMITES` como "ENVIADO ADMIN" |
| **12:00** | **Corte: lote único a administración** (lo que llegue después pasa al día siguiente) |
| 12:00–13:30 | Administración adjunta documentos e imprime |
| **14:00–17:00** | **Nexa** |
| Resto | Capacitaciones y otras funciones. **No se atiende RRCC fuera de ventanilla** |

**Días:**
- **Lunes y miércoles:** prioridad a quien baja al día siguiente. Si hace falta, se amplía la ventanilla.
- **Martes y jueves (cambio de guardia):** solo cupos y entregas. Nada de último minuto, salvo B6 autorizado por el jefe de guardia (máximo 2 al día, registrados como excepción).
- **Viernes:** barrido semanal y alineación de fechas (§8).

---

## 7. Del capacitador a Nexa: seguimiento del trámite

La carpeta `RRCC/DATA/<DNI>` **ya es el expediente**. Lo que falta es saber en qué paso está cada uno. La hoja nueva `TRAMITES` lleva una fila por renovación:

| DNI | F_RENOVACION | F_ENVIO_ADMIN | F_PRESENTADO_NEXA | F_APROBADO | ESTADO | OBS |
|---|---|---|---|---|---|---|
| 40018082 | 2026-10-12 | 2026-10-12 | 2026-10-12 | 2026-10-13 | APROBADO | — |

- La app crea la fila al terminar una renovación (estado `RENOVADO`).
- Al pulsar **"Cerrar lote del día"** se marcan todas como `ENVIADO_ADMIN` y se genera un **listado PDF/Excel** para administración con DNI, nombre, guardia y enlace a la carpeta.
- Administración (o tú) marca `PRESENTADO_NEXA` y `APROBADO` u `OBSERVADO`. Puede ser con un desplegable en la hoja; no necesita la app.
- `OBSERVADO` vuelve a la bandeja correspondiente en el siguiente barrido.

---

## 8. Alineación de fechas (para bajar el volumen de trámites)

Es el cambio que más carga quita a mediano plazo.

1. **Al renovar**, la app muestra las "A" que vencerían en los **próximos 60 días** (no solo las de 35): *"Si además lleva TA y CS ahora, su próxima renovación pasa de diciembre a octubre de 2027."*
2. En el reporte, el supervisor ve esos cursos como **"recomendado adelantar"** dentro de B2.
3. **Meta:** que cada persona tenga como máximo **2 fechas de vencimiento distintas** entre sus "A" (KPI §11).
4. Para **personal nuevo**, la matriz `MATRIZ_PUESTO` programa todos sus cursos "A" en el mismo bloque.

> El código ya protege contra lo contrario: un certificado **más viejo** no pisa una fecha más nueva, así que adelantar cursos no tiene riesgo.

---

## 9. Cambios en el aplicativo

Se respeta la regla del repositorio: **`BD AESA` no se reordena**. Lo nuevo va en **columnas al final** o en **hojas aparte**.

### 9.1 Columnas nuevas al final de `BD AESA` (agregarlas a `COLUMNAS_EXTRA` en `shared/rrcc.js`)
| Columna | Contenido |
|---|---|
| `F_REVALIDACION` | Fecha del último certificado de Revalidación Anual de RRCC |
| `VENC_REVALIDACION` | `F_REVALIDACION + 365` |
| `BANDEJA` | B1…B6, la escribe el barrido |
| `F_BARRIDO` | Fecha del último barrido de esa persona |

### 9.2 Hojas nuevas (las crea **CONFIGURAR BASE**, igual que `CURSO_RRCC` y `CONFIG`)

**`MAPA_SUPERVISOR`**: una fila por combinación de guardia y área, no por persona, así son unas 30 filas y no 600.
| Guardia | Area | Cargo (opcional) | Supervisor | Correo | Celular | Jefe_guardia | Correo_jefe |
|---|---|---|---|---|---|---|---|

Un `Cargo` vacío vale para toda el área, la misma lógica que ya usa `MATRIZ_PUESTO`. Si algún trabajador tiene un supervisor distinto al de su área, la excepción va en la columna extra `SUPERVISOR_DNI` (opcional).

**`CALENDARIO_GUARDIA`**: fechas de bajada y subida por guardia, cargadas por bloques de 3 meses.
| Guardia | F_BAJADA | F_SUBIDA |
|---|---|---|
| A | 2026-10-13 | 2026-10-20 |

**`SEGUIMIENTO`**: la reescribe cada barrido. Es lo que lee Apps Script para enviar correos.
| DNI | Nombre | Guardia | Area | Supervisor | Bandeja | Detalle | F_MINIMA | Prox_bajada | F_barrido |

**`TRAMITES`**: ver §7.

**`AVISOS`**: registro de cada correo enviado (fecha, destinatario, DNI, bandeja). Es la evidencia del §5.3.

### 9.3 Revalidación: dejar de ignorarla
En `shared/estados.js`, sacar de `CURSOS_IGNORADOS` el nombre exacto con que JOMISER o la carpeta de inducción traen la revalidación, y clasificarla aparte:

```javascript
// shared/estados.js
export const CURSOS_REVALIDACION = ["REVALIDACION ANUAL RIESGOS CRITICOS", "RIESGOS CRITICOS"]; // confirmar nombre real

export function esRevalidacion(item) {
  if (item?.origen === "INDUCCION") return true;              // carpeta de inducción: 1 PDF por persona y año
  const n = normalizarCurso(item?.curso);
  return CURSOS_REVALIDACION.some((c) => n.includes(normalizarCurso(c)));
}

/** Fecha más reciente de revalidación entre todo el inventario de la persona. */
export function ultimaRevalidacion(inventario) {
  return (inventario || [])
    .filter(esRevalidacion)
    .map((it) => aIso(it.fecha))
    .filter(Boolean)
    .sort()
    .pop() || "";
}
```
> ⚠️ Confirmar el nombre real del curso en JOMISER y qué son "RRCC 1" y "RRCC 2" antes de tocar la lista, para no confundir otro curso con la revalidación.

### 9.4 Clasificación en bandejas (función pura en `shared/estados.js`, con prueba en `tests/`)

```javascript
export const HORIZONTE_AVISO = 35;     // = 365 - UMBRAL_ACTUALIZAR
export const HORIZONTE_ALINEAR = 60;

/**
 * persona   = leerFila(fila)
 * inventario= resultado de CONSULTAR Y VERIFICAR (certificados nuevos por RRCC)
 * ctx       = { hoy, calendario, tramiteActivo, umbrales }
 */
export function bandejaDe(persona, inventario, ctx) {
  const hoy = ctx.hoy || hoyIso();
  if (ctx.tramiteActivo) return { bandeja: "B5", motivo: "en trámite" };
  if (persona.estadoFinal === "VENCIDO") return { bandeja: "B6", motivo: "autorización vencida" };

  // 1) Revalidación: requisito previo
  const reval = ultimaRevalidacion(inventario) || persona.fRevalidacion;
  const vReval = reval ? sumarDias(reval, 365) : "";
  if (!vReval || diasEntre(hoy, vReval) <= HORIZONTE_AVISO)
    return { bandeja: "B3", motivo: vReval ? `revalidación vence ${aFormatoCorto(vReval)}` : "sin revalidación registrada" };

  // 2) "A" que vencen dentro del horizonte (o antes de volver de la bajada)
  const limite = maxIso(sumarDias(hoy, HORIZONTE_AVISO), finVentanaBajada(persona, ctx.calendario));
  const porVencer = persona.riesgos.filter((r) => r.tipo === "A" && r.venc && r.venc <= limite);
  const sinCert = porVencer.filter((r) => !tieneCertificadoNuevo(inventario, r.codigo, r.cap));
  if (sinCert.length) return { bandeja: "B2", motivo: sinCert.map((r) => `${r.codigo} vence ${aFormatoCorto(r.venc)}`).join(" · ") };

  // 3) Datos para armar el expediente
  const faltan = [];
  if (!persona.foto) faltan.push("foto");
  if (!persona.fotocheckAntiguoDriveId) faltan.push("fotocheck antiguo");
  if (!guardiaDe(persona)) faltan.push("guardia");
  if (persona.vencimientoEmo && persona.vencimientoEmo < hoy) faltan.push("EMO vencido");
  if (faltan.length) return { bandeja: "B4", motivo: "falta " + faltan.join(", ") };

  if (porVencer.length) return { bandeja: "B1", motivo: "listo para renovar" };
  return { bandeja: "OK", motivo: "vigente" };
}
```

### 9.5 Nueva pestaña **SEGUIMIENTO** (en `src/vistas/seguimiento.js`)
- Botón **BARRIDO**: filtra activos en riesgo, corre CONSULTAR Y VERIFICAR en lote (reutiliza el motor de `renovacion.js`, una persona a la vez por la limitación de EIN), aplica `bandejaDe` y escribe `SEGUIMIENTO` + las columnas `BANDEJA`/`F_BARRIDO`.
- Tablero con contadores por bandeja y por guardia.
- Botón **RENOVAR B1 EN LOTE**: pasa los DNI de B1 directamente a la renovación en lote que ya existe.
- Botón **CERRAR LOTE DEL DÍA**: marca `TRAMITES` y genera el listado para administración.
- Filtro **"baja mañana"** usando `CALENDARIO_GUARDIA`.

### 9.6 Apps Script: activadores programados (en `apps-script/Code.gs`)

```javascript
// Lunes y miércoles 08:00: reporte a supervisores de la guardia que baja mañana
function enviarReportesSupervisores() {
  const manana = Utilities.formatDate(new Date(Date.now() + 864e5), Session.getScriptTimeZone(), "yyyy-MM-dd");
  const guardias = guardiasQueBajan(manana);          // de CALENDARIO_GUARDIA
  const filas = leerSeguimiento().filter((f) => guardias.includes(f.guardia));
  const porSupervisor = agrupar(filas, (f) => f.correoSupervisor);
  for (const [correo, gente] of porSupervisor) {
    MailApp.sendEmail({ to: correo, subject: `RRCC · tu personal que baja ${manana}`, htmlBody: htmlReporte(gente) });
    registrarAviso(correo, gente);                    // hoja AVISOS = evidencia
  }
}

// Diario 08:00: escalamiento de lo que no se confirmó
function escalarPendientes() { /* B2/B3/B6 sin confirmación de ayer → jefe de guardia */ }

// Una sola vez, para crear los activadores
function instalarActivadores() {
  ScriptApp.newTrigger("enviarReportesSupervisores").timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  ScriptApp.newTrigger("enviarReportesSupervisores").timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(8).create();
  ScriptApp.newTrigger("escalarPendientes").timeBased().everyDays(1).atHour(8).create();
}
```
> El **barrido** se queda en la app y no en Apps Script, porque EIN exige sesión ASP.NET y la app ya la maneja. Apps Script solo lee `SEGUIMIENTO` y envía los correos. Así no se duplica la lógica de extracción.

### 9.7 Confirmación del supervisor
Un **Google Form** con DNI del trabajador, acción (curso programado, revalidación programada, enviado a ventanilla) y fecha, que escribe en la hoja `CONFIRMACIONES`. `escalarPendientes()` lee de ahí. Si más adelante quieres, se reemplaza por un enlace firmado dentro de la app.

---

## 10. Matriz RACI

| Actividad | Capacitador | Supervisor | Trabajador | Administración | Jefe de guardia | Nexa |
|---|---|---|---|---|---|---|
| Barrido semanal y bandejas | **R/A** | I | — | — | I | — |
| Reporte automático y registro de avisos | **A** (Apps Script R) | I | — | — | I | — |
| B1: renovar en lote | **R/A** | I | — | I | — | — |
| B2/B3: que rinda curso o revalidación | C | **R/A** | R | — | I | — |
| B4: pasar por ventanilla | R | A | **R** | — | — | — |
| B6: vencido, no ingresa | I | R | — | — | **A** | — |
| Mantener `MAPA_SUPERVISOR` y `CALENDARIO_GUARDIA` | **R** | C | — | — | A | — |
| Expediente impreso | I | — | — | **R/A** | — | — |
| Aprobación | I | I | — | C | — | **R/A** |

---

## 11. Indicadores (salen solos de las hojas nuevas)

| KPI | Fuente | Meta |
|---|---|---|
| % activos con `ESTADO_FINAL = VIGENTE` | `BD AESA` | ≥ 98 % |
| Bloqueados el día de subida | `SEGUIMIENTO` (B6 con subida = hoy) | 0 |
| Renovaciones **sin presencia** (B1) / total | `TRAMITES` | ≥ 60 % |
| Anticipación media (días entre renovación y `FECHA MINIMA`) | `TRAMITES` + `BD AESA` | ≥ 10 días |
| Confirmación de supervisores a tiempo | `CONFIRMACIONES` / `AVISOS` | ≥ 95 % |
| Fechas distintas de vencimiento "A" por persona | `BD AESA` | ≤ 2 |
| Tiempo de ciclo (renovación → aprobado Nexa) | `TRAMITES` | ≤ 1 día |
| Excepciones fuera de ventanilla | registro de excepciones | ≤ 2 por semana |

El consolidado de los viernes incluye un **ranking por supervisor** (pendientes y vencidos). La visibilidad hace buena parte del trabajo.

---

## 12. Implementación por fases

| Fase | Qué | Esfuerzo | Resultado inmediato |
|---|---|---|---|
| **0 · Datos** | Llenar `MAPA_SUPERVISOR` (~30 filas) y `CALENDARIO_GUARDIA` (3 meses). Revisar guardias vacías o con `#N/A`. Confirmar el nombre de la revalidación en JOMISER. | 1 día | Base para avisar |
| **1 · Arranque semimanual** | Usar **ESTADO TOTAL** filtrado por guardia y mandar el PDF a cada supervisor el lunes y el miércoles. Comunicado oficial (§13). Reunión de 15 minutos con supervisores y jefes de guardia. | Semana 1 | Los supervisores empiezan a ver a su gente |
| **2 · Revalidación** | §9.1 + §9.3, con una prueba en `tests/estados.test.js`. | 1–2 días | Se acaban los rechazos de Nexa por revalidación |
| **3 · Barrido y bandejas** | `bandejaDe` + pestaña SEGUIMIENTO + hoja `SEGUIMIENTO`. | 3–5 días | Renovación de B1 sin el trabajador |
| **4 · Trámites** | Hoja `TRAMITES` + "Cerrar lote del día". | 1–2 días | Trazabilidad hasta Nexa |
| **5 · Automatización** | Activadores de Apps Script + Form de confirmación + `AVISOS`. | 2–3 días | Cero contacto manual con trabajadores |
| **6 · Alineación** | Sugerencia de adelantar cursos (§8). | 1–2 días | Menos trámites por persona al año |
| **Campaña de limpieza** | Barrido de todos los activos y renovación de todo lo que esté en B1 en una semana. | 1 semana | Arrancar el sistema "en verde" |

---

## 13. Comunicado a supervisores

> **Asunto: Nuevo control de Riesgos Críticos, a partir del __/__/2026**
>
> Estimados supervisores:
>
> Para que nadie de nuestro personal quede sin ingresar a mina por Riesgos Críticos vencidos, SSOMA pone en marcha un control preventivo:
>
> 1. **Un día antes de cada bajada** recibirán por correo la lista de **su** personal con algo pendiente: curso por rendir, revalidación anual, dato faltante o autorización vencida.
> 2. **El personal que ya aprobó sus cursos será renovado por SSOMA sin que tenga que acercarse.**
> 3. Quien tenga un curso o la **Revalidación Anual** pendiente debe rendirlo **antes de bajar**. Sin revalidación vigente no se puede iniciar el trámite ante Nexa.
> 4. La ventanilla de RRCC atiende **de 08:00 a 10:00, solo con cupo**. Fuera de ese horario solo se atienden casos vencidos autorizados por el jefe de guardia.
> 5. Les pedimos **confirmar las acciones** en el enlace del correo el mismo día. Lo no confirmado se escala automáticamente al jefe de guardia.
>
> SSOMA avisa con 35 días de anticipación. La línea de mando asegura que el personal cumpla.
>
> Atentamente,
> Facilitador de Seguridad · SSOMA AESA

---

## 14. Datos por confirmar antes de programar

1. **¿El trabajador tiene que estar presente** (firma, entrega del fotocheck físico) para que Nexa apruebe? Esto define si B1 es 100 % sin presencia o solo "sin gestión".
2. **Nombre exacto** de la Revalidación Anual en JOMISER y si la carpeta de inducción de Drive es la misma revalidación.
3. **Relación guardia ↔ día de bajada:** ¿qué guardias bajan martes y cuáles jueves? ¿Cuál es el régimen (14×7, 10×4…)?
4. **Quién es el supervisor** de cada área y guardia (para `MAPA_SUPERVISOR`).
5. ¿Administración puede trabajar con el **corte de las 12:00**?
6. ¿La cuenta que ejecuta Apps Script es Gmail personal o Workspace? Define el límite de correos diarios.

---

## 15. Resumen

| Antes | Después |
|---|---|
| El trabajador viene cuando quiere | La app detecta con 35 días de anticipación |
| El capacitador avisa uno por uno | Apps Script avisa al supervisor un día antes de la bajada |
| Todos pasan por ventanilla | Los que ya aprobaron (B1) se renuevan en lote, sin venir |
| La revalidación se ignora en la app | Se guarda, se controla y bloquea el trámite si falta |
| Cada "A" vence en su fecha y el trámite se repite | Se alinean fechas y hay menos trámites por persona |
| No se sabe en qué va el trámite | Hoja `TRAMITES` hasta la aprobación de Nexa |
| La culpa cae en SSOMA | La hoja `AVISOS` prueba que se avisó a tiempo |
