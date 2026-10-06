# Riesgos Críticos — AESA / Cerro Lindo

App web con tres funciones:

1. **Certificados** — descarga todos los certificados de una persona (o de una
   lista) desde **JOMISER** (`aula.jomiser.com`), **EIN / WebNexa** y una
   **carpeta pública de Google Drive**. Acepta un DNI, una lista pegada o un
   Excel/CSV.
2. **Renovación** — actualiza la **Autorización de Riesgos Críticos**: jala los
   certificados, recalcula fechas, vencimientos y estados de los 18 RRCC, aplica
   la regla de las "A", escribe la fila en Google Sheets y deja en Drive una
   carpeta por persona con sus certificados vigentes, el fotocheck nuevo y el
   Word de autorización.
3. **Nuevo personal** — alta desde la app, con la matriz por puesto proponiendo
   qué riesgos van autorizados.

Vite + funciones serverless en Vercel. **Sin dependencias nuevas**: solo
`jszip`, que ya estaba.

---

## Estructura

```
├── index.html            interfaz (tres pestañas)
├── shared/               reglas puras — las usan el navegador Y las funciones
│   ├── rrcc.js           los 18 riesgos críticos y el layout de `BD AESA`
│   └── estados.js        fechas, ESTADO, mapeo curso→RRCC, regla de las "A"
├── src/
│   ├── main.js           extractor de certificados + montaje de pestañas
│   ├── style.css         estética terminal
│   ├── lib/
│   │   ├── dni.js        normalización + ceros a la izquierda
│   │   ├── excel.js      lector .xlsx / .csv en el navegador
│   │   ├── api.js        cliente de las funciones
│   │   ├── guardar.js    escritura en carpeta y ZIP
│   │   ├── renovacion.js motor de renovación (orquesta las llamadas)
│   │   ├── fotocheck.js  dibuja el fotocheck en <canvas> y lo exporta a PNG
│   │   └── docx.js       arma el Word con las dos imágenes
│   └── vistas/           renovación, nuevo personal, modal del fotocheck
├── api/                  funciones serverless (Node)
│   ├── _lib/nexa.js      extracción de JOMISER
│   ├── _lib/ein.js       extracción de EIN / WebNexa
│   ├── _lib/drive.js     lectura de la carpeta pública (API key)
│   ├── _lib/google.js    cuenta de servicio (JWT RS256, sin `googleapis`)
│   ├── _lib/sheets.js    cliente de Google Sheets
│   ├── _lib/drive-escritura.js  crear carpetas y subir archivos
│   ├── search.js         POST → certificados de un DNI
│   ├── download.js       POST → UN PDF
│   ├── sheets.js         POST → contexto | persona | guardar | alta | cargos | comprobar | setup
│   └── drive-output.js   POST → carpeta | carpetas | subir | foto | foto-de | bajar | listar
├── scripts/
│   ├── migrar-excel.js   coteja el .xlsx contra la hoja y sube las fotos que falten
│   └── _lib/xlsx.js      lector de .xlsx por entradas sueltas
├── tests/estados.test.js `npm test`
├── dev-server.js         emula Vercel en local
└── escritorio/           versión antigua en Python
```

> `shared/` existe porque las reglas de negocio tienen que correr **igual** en
> el navegador y en Node. Si vivieran dentro de `api/`, el proxy de `/api` del
> servidor de desarrollo de Vite las interceptaría y el navegador no podría
> importarlas.

---

## Conectar solo con Apps Script (sin cuenta de servicio)

Si no quieres crear ni guardar credenciales `GOOGLE_SA_*`, usa el backend
incluido en `apps-script/Code.gs`. Se ejecuta con tu propia cuenta de Google,
que ya tiene acceso al Sheet y a la carpeta RRCC.

1. Abre script.google.com, crea un proyecto y pega `apps-script/Code.gs`.
2. En **Project Settings → Script properties**, crea `RRCC_SHEET_ID` (ID del
   Spreadsheet `DATA`) y `RRCC_ROOT_FOLDER_ID` (ID de la carpeta `RRCC`).
3. En **Deploy → New deployment → Web app**, selecciona **Execute as: Me** y
   copia la URL que termina en `/exec`.
4. En `.env` define: `APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec`

Opcionalmente protege el endpoint con una propiedad `RRCC_TOKEN` y el mismo
valor en `APPS_SCRIPT_TOKEN`. Reinicia el servidor local tras editar `.env`.
Las rutas `/api` quedan como un puente hacia Apps Script para evitar CORS;
ya no requieren ni usan claves de Google.

## Por qué no hay un `Code.gs`

Apps Script es una forma de exponer un Sheet a una app externa, pero esta app
habla **directamente** con las APIs oficiales (`sheets.googleapis.com/v4` y
`drive/v3`), autenticada con una **cuenta de servicio**: `api/_lib/google.js`
firma un JWT con `node:crypto` y lo canjea por un token. Es lo que Apps Script
haría por debajo, sin el intermediario.

Un `Code.gs` en medio añadiría otro proyecto que desplegar, una URL `/exec`
que habría que dejar pública o proteger con OAuth desde el navegador, 2–5 s de
arranque en frío por llamada (y aquí se hacen unas seis por persona), y una
capa que no se puede probar en local. Haría falta solo si la organización
impidiera crear cuentas de servicio, o si se quisiera que la propia hoja
dispare algo al editarla (`onEdit`).

---

## La estructura en Drive

Todo vive en la carpeta **`RRCC`** de Drive:

```
RRCC/
├── DATA/            salidas: una subcarpeta por persona, "<DNI>_<APELLIDOS NOMBRES>"
├── FOTOS/           fotos del personal, "<DNI>.png"
├── REVALIDACIONES/  (la app no la toca)
└── DATA             Spreadsheet: la base de la app
```

El Spreadsheet `DATA` ya tiene sus hojas (`BD AESA`, `FOTOCHEK`, `TB_DINAMICS`).
**La app se engancha a `BD AESA`, no la reestructura**: la cabecera esta en la
fila 3, los datos empiezan en la 4, y el orden de columnas se respeta tal cual
porque la hoja `FOTOCHEK` resuelve por `BUSCARV` posicional. Lo unico que la
app puede agregarle son cuatro columnas **al final**
(`FOTOCHECK_ANTIGUO_DRIVE_ID`, `CARPETA_DRIVE_ID`, `RESTRICCIONES_EMO`,
`ACTUALIZADO`), que no afectan a esos `BUSCARV`.

Ademas crea tres hojas suyas: `CURSO_RRCC`, `MATRIZ_PUESTO` y `CONFIG`.

---

## Puesta en marcha

### 1. Google Cloud (una sola vez)

1. En [Google Cloud Console](https://console.cloud.google.com/), habilitar
   **Google Sheets API** y **Google Drive API**.
2. Crear una **cuenta de servicio** y descargar su clave JSON. De ahi salen
   `client_email` y `private_key`.
3. **Compartir la carpeta `RRCC` con el `client_email` como Editor.** Con eso
   alcanza: al compartir la carpeta, el Spreadsheet y las subcarpetas quedan
   compartidos tambien. Una cuenta de servicio no tiene unidad propia y solo
   puede escribir donde alguien la invito.
4. Cargar las variables de entorno (ver `.env.example`).

### 2. Variables de entorno

| Variable | Para que |
|---|---|
| `EIN_USUARIO`, `EIN_PASSWORD` | fuente EIN / WebNexa |
| `DRIVE_API_KEY` | clave de la API de Drive (lectura de carpetas publicas) |
| `DRIVE_INDUCCION_FOLDER` (antes `DRIVE_FOLDER_ID`) | carpeta de Drive con los certificados de induccion (`<DNI>_<APELLIDOS NOMBRES>.pdf`), con o sin subcarpetas por anio; alimenta el panel CERTIFICADOS INDUCCION |
| `DRIVE_CERT_FOLDERS` | respaldo cuando JOMISER no trae un certificado: ids o URLs de carpetas de Drive (separados por comas) con un PDF por certificado, nombrado `<DNI 8 digitos>_<CODIGO RRCC>_<AAAA-MM-DD>_<APELLIDOS NOMBRES>.pdf`. Deben ser publicas ("cualquiera con el enlace"). En Vercel tambien hay que definirla |
| `GOOGLE_SA_EMAIL`, `GOOGLE_SA_PRIVATE_KEY` | cuenta de servicio (o `GOOGLE_SA_JSON`) |
| `DRIVE_RRCC_FOLDER_ID` | la carpeta `RRCC`; dentro se buscan por nombre `DATA`, `FOTOS` y el Spreadsheet |
| `SHEET_ID` | opcional: el Spreadsheet `DATA`. Si falta, se busca en la carpeta |

Opcionales, por si algo se llama distinto: `DRIVE_OUTPUT_FOLDER_ID`,
`DRIVE_FOTOS_FOLDER_ID`, `SHEET_HOJA_PERSONAL`, `SHEET_FILA_CABECERA`,
`SHEET_FILA_DATOS`.

Dos tolerancias a propósito, porque las dos cosas son ambiguas a ojo:

- **El id del Spreadsheet** se puede omitir: la app busca el archivo de
  Google Sheets dentro de `RRCC`. En un id de Drive la `l` minúscula y la `I`
  mayúscula se dibujan igual, y copiarlo mal da un 404 que parece un problema
  de permisos.
- **El nombre de la pestaña** se compara sin distinguir espacios de guiones
  bajos ni mayúsculas: `BD AESA`, `BD_AESA` y `bd aesa` son la misma.

Vercel no admite saltos de linea en una variable: la clave privada va en una
sola linea con los `\n` escapados y entre comillas. El codigo los desescapa.

Cada fuente es **opcional**: sin las variables de Google, las pestanas de
renovacion y alta avisan que la base no esta configurada y el extractor de
certificados sigue funcionando igual.

### 3. Sembrar las hojas auxiliares

Con la app abierta, pestana **RENOVACION → CONFIGURAR BASE**. Crea, si faltan:

- `CURSO_RRCC` — el catalogo y ~70 alias conocidos.
- `MATRIZ_PUESTO` — solo la cabecera (**falta cargar la matriz real**).
- `CONFIG` — los parametros por defecto.

Y agrega al final de `BD AESA` las columnas que la app necesita. Es
idempotente y **nunca reescribe `BD AESA`**. Al terminar informa si la
cabecera real coincide con la que el codigo da por sentada, columna a
columna: si alguien inserto una columna, conviene saberlo antes de escribir
nada.

### 4. Comprobar que quedo bien

Una consulta de solo lectura sirve de prueba de humo: escribe un DNI en
**RENOVACION** y pulsa **CONSULTAR Y VERIFICAR**. Si trae el nombre, las
fechas y el resumen de autorizaciones, todo esta conectado.

---

## Desarrollo local

```bash
npm install
npm test                  # reglas de negocio, sin red ni credenciales
npm run build && node dev-server.js   # http://localhost:3000 (front + /api)
npm run dev                           # recarga en caliente, proxy de /api al 3000
```

---

## El modelo de datos

### `BD AESA`

Una fila por persona, con la cabecera en la **fila 3** y los datos desde la
**fila 4**. El orden de columnas se respeta tal cual, porque la hoja
`FOTOCHEK` resuelve todo con `BUSCARV` por posición sobre el rango `C:CO`:
mover una columna rompe el fotocheck.

La columna `D` (`FOTO`) guarda una **ruta**, `FOTOS/<DNI>.png`, no la imagen
ni un id. La app no depende de ella: busca la foto por documento dentro de la
carpeta `FOTOS`, porque ahí conviven las dos grafías del DNI (`4075286.png` y
`04065624.png`) según quién perdió el cero inicial al exportarlas.

La app agrega, **al final**, cuatro columnas: `FOTOCHECK_ANTIGUO_DRIVE_ID`,
`CARPETA_DRIVE_ID`, `RESTRICCIONES_EMO` y `ACTUALIZADO`.

Las fechas se guardan como texto ISO `YYYY-MM-DD` y se escriben con
`valueInputOption: RAW`. Si se dejara que Sheets las interpretara, un `02/09`
podría quedar guardado como 9 de febrero según la configuración regional.

Los 18 riesgos críticos, en el orden del Excel, con 4 columnas cada uno
(`Fecha de capacitacion`, `Fecha de vencimiento`, `TIPO`, `ESTADO`):

`AE` Bloqueo y Aislamiento de Energías · `IE` Instalaciones Eléctricas ·
`SQ` Sustancias Químicas Peligrosas · `PM` Protección de Máquinas ·
`TA` Trabajo en Altura · `CS` Cargas Suspendidas · `SP` Sistemas Presurizados ·
`ES` Excavaciones Subterráneas · `HM` Herramientas Manuales ·
`OC` Excavación en Obras Civiles · `EC` Espacios Confinados ·
`VEM` Vehículos y Equipos Móviles · `AP` Animales Ponzoñosos ·
`HP` Herramientas de Poder · `TC` Trabajos en Caliente · `OB` Oficial de Bloqueo ·
`MD` Montaje y Desmontaje · `RIG` Rigger.

### `CURSO_RRCC`

Diccionario `nombre_certificado → codigo_rrcc`, con una columna
`fuente_preferida` opcional. Se amplía **sin tocar código**: lo que se escriba
en la hoja manda sobre los alias de fábrica.

El matching normaliza (mayúsculas, sin tildes, sin signos, en singular) y
acepta coincidencia parcial por palabras completas, porque los archivos de
Drive suelen traer el nombre de la persona pegado al del curso
(`ROBLES GOMEZ JUAN MARCELINO - T_C` → `TC`).

Un `codigo_rrcc` vacío o `IGNORAR` marca cursos que **no** son riesgos críticos
(inducción, "RIESGOS CRITICOS", fotocheck…) para que no ensucien el informe.
Todo curso que no mapee se reporta en pantalla y se anota en la propia hoja con
la marca `sin mapear <fecha>`: **nunca se asume nada**.

### `MATRIZ_PUESTO`

Qué riesgos exige cada puesto: `Cargo`, `Area` y los 18 códigos con `A`, `C` o
vacío. Una fila sin `Cargo` vale como regla general de su `Area`. La
**renovación no la usa**; el alta de personal nuevo sí.

### `CONFIG`

| Clave | Por defecto | Qué hace |
|---|---|---|
| `UMBRAL_VENCIDO` | 365 | días desde la capacitación para dar por VENCIDO |
| `UMBRAL_ACTUALIZAR` | 330 | días para avisar que toca renovar |
| `A_SIN_CERT` | `MANTENER` | `MANTENER` o `DEGRADAR` (ver más abajo) |
| `PLANTILLA_CARPETA` | — | ya no se usa: la carpeta de cada persona se llama solo con su DNI (las viejas con apellidos se reutilizan y se renombran) |
| `FOTOCHECK_ANCHO_CM` / `FOTOCHECK_ALTO_CM` | — | ya no se usan: el fotocheck del Word va siempre a 10.9 × 8.6 cm (`MEDIDAS_WORD` en `src/lib/docx.js`); si siguen en la hoja, se ignoran |
| `ANTIGUO_ANCHO_CM` | 17 | ancho de la foto del fotocheck antiguo (anverso+reverso lado a lado); 17 cm es el ancho completo de la página entre márgenes |

---

## Las reglas (`shared/estados.js`)

Replican las fórmulas de `BD AESA`, con las pruebas de `npm test` fijándolas.

**ESTADO**, con `cap` = fecha de capacitación:

| | |
|---|---|
| `cap` vacía | NO APLICA |
| `HOY − cap > 365` | VENCIDO |
| `HOY − cap ≥ 330` | ACTUALIZAR |
| resto | VIGENTE |

**Vencimiento** = `cap + 365`. `ES` y `HM` las emite EIN, así que si el
certificado declara su propia vigencia se usa esa; hoy ninguna fuente la
devuelve, y por eso el resultado coincide con el `cap + 365` del Excel. Lo que
sí cambia para `ES` y `HM` es la **fuente preferida**: si el mismo curso llega
de JOMISER y de EIN, manda EIN aunque JOMISER traiga algo más nuevo.

**ESTADO_FINAL** = `VIGENTE` si el vencimiento más próximo todavía no pasó.

> El `MIN` del Excel se saltea una columna y referencia por error una de
> `ESTADO`. Aquí se toma el mínimo de los 18 vencimientos, que es lo que la
> fórmula quería decir. Por lo mismo, la migración **recalcula** estados y
> vencimientos en vez de copiar los valores cacheados del `.xlsx`, que son de
> la última vez que alguien lo abrió.

**La regla de las "A".** En una renovación, los cursos que la persona *debe*
tener son exactamente aquellos en los que **ya figura "A"**. No se consulta
ninguna matriz. El motor mantiene la "A" y actualiza su fecha con el
certificado nuevo.

- Un RRCC con "A" que se quedó sin certificado vigente **conserva la "A" y
  levanta una alerta** (`A_SIN_CERT=MANTENER`). Se eligió así para no borrar
  autorizaciones por un certificado atrasado. Con `DEGRADAR` baja a "C" cuando
  está vencido.
- Un certificado nuevo de un RRCC que la persona no tenía entra como **"C"**
  (capacitado, no autorizado).
- Un certificado **más viejo** que la fecha ya registrada no la pisa.

---

## Consultar y verificar (sin tocar nada)

En **RENOVACIÓN**, el botón **CONSULTAR Y VERIFICAR** (o `Ctrl+Enter` en el
cuadro de documentos) hace todo el recorrido —lee la fila de la persona,
inventaría sus certificados en JOMISER, EIN y Drive y recalcula— pero **no
escribe en la hoja ni crea nada en Drive**.

Cada ficha encabeza con lo que interesa: *"14/16 autorizaciones vigentes · 1
vencida · 1 por vencer"*. "Vigente" significa que hoy existe un certificado
que respalda esa `A`, no que la hoja lo afirme. Debajo, los 18 riesgos con su
fecha de vencimiento, su letra y el estado, resaltando los que acaban de
recibir un certificado nuevo.

En **NUEVO PERSONAL**, escribir un DNI consulta la base antes de dejar cargar
nada: si la persona ya existe, rellena el formulario con sus datos y avisa,
en vez de dejar que el alta duplique su fila.

---

## Qué produce una renovación

Por persona, en la carpeta raíz de salidas:

```
RRCC/DATA/
└── 40018082_CCENCHO TAYPE NICOLAS/
    ├── 2026-09-12_EXCAVACIONES SUBTERRÁNEAS.pdf     (solo los VIGENTES)
    ├── 2026-09-13_TRABAJOS EN ALTURA.pdf
    ├── ...
    ├── FOTOCHECK_CCENCHO TAYPE NICOLAS.png
    └── Autorizacion_RRCC_CCENCHO TAYPE NICOLAS.docx
```

El Word lleva arriba el fotocheck nuevo a **10.9 cm de ancho × 8.6 cm de alto**
(fijo, en `MEDIDAS_WORD` de `src/lib/docx.js`) y debajo la foto del fotocheck
antiguo, respetando su proporción (ancho máximo: `ANTIGUO_ANCHO_CM` de `CONFIG`).

La carpeta se **reutiliza** si ya existe, y los archivos con el mismo nombre se
actualizan en vez de duplicarse: se puede volver a correr una renovación sin
ensuciar nada.

### El fotocheck

Se dibuja en un `<canvas>` replicando la hoja `FOTOCHEK`: la tarjeta azul con
el logo, la foto, los datos y el EMO, y la grilla de los 18 riesgos con su
fecha de vencimiento y su letra (`A` sombreada, `C` sin sombrear), más
`AUTORIZADO` / `NO AUTORIZADO` según `ESTADO_FINAL`.

Se eligió canvas y no "HTML a imagen" porque en Vercel no hay Chromium para
renderizar del lado del servidor, y las librerías que lo hacen en el navegador
dependen de `<foreignObject>`, que **ensucia el canvas** en cuanto entra una
imagen de otro origen (la foto de Drive) y entonces ya no se puede exportar.

El Word también se arma a mano (`src/lib/docx.js`): un `.docx` es un ZIP con
cuatro XML, y de esos solo cambia el que lleva las dos imágenes. Evita sumar la
librería `docx`, de varios MB, para producir un documento de dos párrafos.

---

## El Excel original: cómo se encontraron las fotos

La migración de los datos ya está hecha. Queda escrito porque no es evidente
y porque `scripts/migrar-excel.js` sigue sirviendo para cotejar que no falte
nadie y para subir a `FOTOS` las fotos que no estén.

La columna `FOTO` del Excel **no guardaba la imagen en la celda**: guardaba la
fórmula `CONCATENATE("FOTOS/",DNI,".png")`, que es solo texto. Las 557 fotos
vivían en el almacén de *rich data* de Excel 365 (`xl/richData/`) como un
**array paralelo a las filas de `Tabla1`**: la entrada *i* de `rdarray.xml`
corresponde a la fila *i* de datos de la tabla (`A3:CP619` → filas 4 a 619).

Es decir, la foto de una persona se localiza **por su posición en la tabla**,
no por su celda. `scripts/_lib/xlsx.js` resuelve esa cadena
(`rdarray → rdrichvalue → richValueRel → rels → xl/media/imageN.png`) y además
lee el `.xlsx` **entrada por entrada** desde el directorio central del ZIP: de
los 286 MB del archivo, 284 son fotos, y abrirlo con JSZip significaría
meterlo entero en memoria para leer una hoja de 3 MB.

```bash
node scripts/migrar-excel.js "C:/ruta/....xlsx" --dry-run   # solo informa
node scripts/migrar-excel.js "C:/ruta/....xlsx"             # sube fotos y coteja
```

Este script **no escribe en la hoja**.

---

## Ceros a la izquierda

Excel guarda `07481337` como el **número** 7481337: el cero desaparece del
archivo. Como todos los documentos son de 8 dígitos, la app rellena a 8 y **te
muestra exactamente qué cambió**, valor por valor:

```
cero restaurado: 7481337 → 07481337
cero restaurado: 350889  → 00350889
```

El lector de Excel distingue si la celda venía como **texto** (ceros intactos) o
como **número** (ceros perdidos) y lo informa. Detecta la columna por la cabecera
(`DNI`, `DOCUMENTO`, `NDocumento`, `CÉDULA`…) y, si no hay, elige la que tenga
más valores con forma de documento. El `.xls` antiguo no se puede leer: guárdalo
como `.xlsx` o `.csv`.

---

## Detalles de JOMISER

- Es una consulta pública: `GET /certificados?dni=<DNI>` devuelve la tabla, y
  cada fila aprobada trae un enlace `/pdf/exportar-certificado/<id>`.
- **Busca por coincidencia exacta**, así que un DNI mal escrito no devuelve a
  otra persona. Aun así se comprueba que el `COD. IDENTIDAD` de la respuesta sea
  el DNI pedido.
- **Los desaprobados no tienen certificado**: se marcan `SIN CERTIFICADO`, no
  como error.

## Detalles de EIN

- Es un sitio ASP.NET con login (WebForms + SAP Crystal Reports), no una
  consulta pública: hace falta `EIN_USUARIO`/`EIN_PASSWORD`.
- **Busca por coincidencia parcial**: por ejemplo, `0350889` también devuelve
  los certificados de `10350889`. Se descarta toda fila cuyo NDocumento no
  sea idéntico al DNI pedido, y queda un aviso con cuántas se descartaron.
- A diferencia de JOMISER/Drive, **no se sabe si un curso tiene certificado
  emitido hasta intentar descargarlo**: por eso aparece como `PENDIENTE` y
  recién al descargar se resuelve a `DESCARGADO` o `SIN CERTIFICADO`.
- **El servidor devuelve el certificado de otra persona de forma
  intermitente** (bug de concurrencia del reporte Crystal, ~1 de cada 4
  descargas; pasa igual haciendo clic a mano). Cada PDF se abre, se extrae su
  texto y se verifica que el registro `<COD><DNI>` sea el esperado; si no,
  se reintenta.
- Por eso la **renovación en lote procesa una persona a la vez**: dos en
  paralelo se pisarían la misma sesión y el mismo visor de Crystal.
- La empresa del combo se toma **la que venga seleccionada por defecto en la
  página** (NEXA MINERIA) — la opción "TP" da error 500 en el servidor.

## Detalles de Drive

- Buscar usa la **Drive API oficial** (`files.list` + API key) en vez de
  raspar la página pública de la carpeta: esa página solo trae los primeros
  50 archivos.
- La búsqueda por nombre (`contains`) es por **subcadena, no por prefijo**, así
  que se descarta cualquier resultado cuyo nombre no arranque exacto con el DNI.
- Descargar de la carpeta pública no necesita la API key. **Escribir** sí
  necesita la cuenta de servicio.

---

## Por qué el navegador dirige y no una sola función

Las funciones de Vercel tienen dos límites que la tarea rompe de inmediato:

- **60 s de ejecución** en el plan Hobby.
- **4.5 MB por respuesta**. Un solo PDF de JOMISER pesa 421 KB.

Por eso cada función hace **una operación corta** y el navegador va encadenando:

```
navegador                          serverless              fuentes / Google
   │                                                              │
   ├── POST /api/sheets   (persona)  ── fila de PERSONAL ────────►│
   ├── POST /api/search              ── certificados ────────────►│
   │   … el cálculo ocurre aquí, en shared/estados.js             │
   ├── POST /api/sheets   (guardar)  ── fila actualizada ────────►│
   ├── POST /api/download            ── 1 PDF ───────────────────►│
   ├── POST /api/drive-output(subir) ── 1 archivo ───────────────►│
   │   … se repite por cada certificado vigente                   │
   └── dibuja el fotocheck, arma el Word y los sube
```

---

## Salida del extractor de certificados (pestaña 1)

ZIP con los certificados sueltos en la raíz, nombrado como el participante más
su documento:

```
MEZA SUAZO, LUIS ANGEL_71481337.zip
├── 2026-08-28_EXCAVACIONES SUBTERRÁNEAS.pdf
├── 2026-08-29_TRABAJOS EN ALTURA.pdf
└── 2026-08-30_SUSTANCIAS QUÍMICAS PELIGROSAS.pdf
```

Con **varios DNI** el ZIP se llama `certificados_<N>_dni_<fecha>.zip` y cada
persona va en su propia subcarpeta.

Como un lote puede tardar varios minutos y se suele dejar en segundo plano, al
acabar se avisa por tres vías: un aviso en la página, una notificación del
sistema (si se concede el permiso) y un pitido corto.

---

## Seguridad

La app queda **pública** al desplegarla, y con la renovación ahora escribe en la
base de personal. Activa
[Vercel Authentication](https://vercel.com/docs/security/deployment-protection)
en Settings → Deployment Protection antes de usarla con datos reales.

---

## Pendiente

- **Cargar `MATRIZ_PUESTO`**: la hoja se crea con su cabecera, pero la matriz
  real (qué riesgos exige cada cargo) todavía no existe en ningún archivo. Sin
  ella, el alta de personal nuevo funciona igual, pero hay que marcar las "A" a
  mano en el formulario.

---

## Versión de escritorio (`escritorio/`)

App en Python + tkinter, sin dependencias. Descarga de JOMISER y de
EIN/WebNexa, con la estructura antigua (`<DNI>/JOMISER/`, `<DNI>/EIN/` y
`resumen.txt`).

```
escritorio\EJECUTAR.bat                                          # ventana
python escritorio\descargar_certificados.py 71481337 "D:\Certif" # consola
```
