/**
 * RRCC – backend Google Apps Script.
 *
 * Los IDs y nombres de esta instalación están definidos abajo en CONFIG.
 * Opcional: Script Property RRCC_TOKEN, secreto compartido con
 * APPS_SCRIPT_TOKEN del servidor.
 *
 * Despliegue: Deploy > New deployment > Web app > Execute as: Me.
 * El acceso debe permitir a quien llegue al puente de la aplicación.
 */
const P = PropertiesService.getScriptProperties();
const CONFIG = {
  // Spreadsheet DATA
  sheetId: "1VbSgb_iVIEocPruDIw_OZj4wvy7OhPihyHkcO09-ssM",
  // Pestaña que contiene al personal (cabecera fila 3; datos desde fila 4)
  hojaPersonal: "BD_AESA",
  filaCabecera: 3,
  filaDatos: 4,
  // Carpeta raíz RRCC; dentro se ubican estas dos subcarpetas por nombre.
  carpetaRaizId: "15bkVX87Hny_V97ICR8uuVaGqIYp2d5ek",
  carpetaSalidasNombre: "DATA",
  carpetaFotosNombre: "FOTOS",
  // Si luego quieres fijar carpetas concretas, pega sus IDs aquí.
  carpetaSalidasId: "",
  carpetaFotosId: "",
};
const RIESGOS = ["AE","IE","SQ","PM","TA","CS","SP","ES","HM","OC","EC","VEM","AP","HP","TC","OB","MD","RIG"];
const DATOS = ["Columna1","Item","Codigo","FOTO","Apellidos","Nombres","DNI","EMPRESA","Guardia","Cargo Planilla","COMENTARIO","Area Planilla","F. Ex. Medico","F. Vencimiento","USO DE LENTES"];
const CIERRE = ["ANEXO 04","ANEXO 05","FECHA MINIMA","DIAS","ESTADO_FINAL","FullName","_EstaTE"];
const EXTRA = ["FOTOCHECK_ANTIGUO_DRIVE_ID","CARPETA_DRIVE_ID","RESTRICCIONES_EMO","ACTUALIZADO"];
const CABECERA = DATOS.concat(...RIESGOS.map(x => ["Fecha de capacitacion_"+x,"Fecha de vencimiento_"+x,"TIPO_"+x,"ESTADO_"+x]), CIERRE, EXTRA);
// Posicion (0-based, como CABECERA) de cada ESTADO_xx: 3 columnas despues de su capacitacion.
const COL_ESTADO = RIESGOS.map((_, i) => DATOS.length + i*4 + 3);
const H = { personal: "BD_AESA", cursos: "CURSO_RRCC", matriz: "MATRIZ_PUESTO", config: "CONFIG" };
const MATRIZ_ORIGEN = "MATRIZ";

function doGet() { return salida({ ok:true, servicio:"RRCC Apps Script", version:1 }); }
function doPost(e) {
  try {
    const b = JSON.parse(e.postData && e.postData.contents || "{}");
    const token = P.getProperty("RRCC_TOKEN") || "";
    if (token && b.token !== token) throw new Error("token de Apps Script invalido");
    const f = b.servicio === "sheets" ? hojas : b.servicio === "drive" ? drive : null;
    if (!f) throw new Error("servicio desconocido");
    return salida(f(b));
  } catch (err) { return salida({ ok:false, error:String(err.message || err) }); }
}
function salida(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function libro() { return SpreadsheetApp.openById(CONFIG.sheetId); }
function raiz() { return DriveApp.getFolderById(CONFIG.carpetaRaizId); }
function normal(t) { return String(t||"").normalize("NFD").replace(/[\u0300-\u036f]/g,"").toUpperCase().replace(/[^A-Z0-9]+/g," ").trim(); }
function personal() { const s=libro(); const wanted=normal(CONFIG.hojaPersonal); const sh=s.getSheets().find(x=>normal(x.getName())===wanted); if(!sh) throw new Error('no existe la hoja '+CONFIG.hojaPersonal); return sh; }
function dni(v) { let d=String(v==null?"":v).replace(/\D/g,""); return d ? (d.length<8 ? ("00000000"+d).slice(-8) : d) : ""; }
function completas(v) { const a=CABECERA.map(()=>""); (v||[]).slice(0,a.length).forEach((x,i)=>a[i]=x==null?"":x); return a; }
function folderNamed(parent, name) { const it=parent.getFoldersByName(name); return it.hasNext()?it.next():parent.createFolder(name); }
function folderByIdOrName(id, name) { return id ? DriveApp.getFolderById(id) : folderNamed(raiz(), name); }
function codigoMatriz(t) {
  const x=normal(t);
  if(x.includes("BLOQUEO")&&x.includes("ENERG"))return "AE";
  if(x.includes("INSTALACIONES")&&x.includes("ELECTRIC"))return "IE";
  if(x.includes("SUSTANCIAS")&&x.includes("QUIM"))return "SQ";
  if(x.includes("PROTECCION")&&x.includes("MAQUIN"))return "PM";
  if(x.includes("TRABAJO")&&x.includes("ALTURA"))return "TA";
  if(x.includes("CARGAS")&&x.includes("SUSPEND"))return "CS";
  if(x.includes("SISTEMAS")&&x.includes("PRESUR"))return "SP";
  if(x.includes("EXCAVACIONES")&&x.includes("SUBTERR"))return "ES";
  if(x.includes("HERRAMIENTAS")&&x.includes("MANUALES"))return "HM";
  if(x.includes("EXCAVACION")&&x.includes("OBRAS")&&x.includes("CIVIL"))return "OC";
  if(x.includes("ESPACIOS")&&x.includes("CONFIN"))return "EC";
  if(x.includes("VEHICULOS")&&x.includes("MOVIL"))return "VEM";
  if(x.includes("ANIMALES")&&x.includes("PONZ"))return "AP";
  if(x.includes("HERRAMIENTAS")&&x.includes("PODER"))return "HP";
  if(x.includes("TRABAJOS")&&x.includes("CALIENT"))return "TC";
  if(x.includes("OFICIAL")&&x.includes("BLOQUEO"))return "OB";
  if(x.includes("MONTAJE")&&(x.includes("DESMONTAJE")||x.includes("ANDAMIO")))return "MD";
  if(x.includes("RIGGER"))return "RIG";
  return "";
}
/** Convierte la pestaña corporativa MATRIZ al formato que entiende la app:
 *  ["Cargo", "Area", "AE", ...] y valores A cuando el curso dice Aplica. */
function leerMatrizOrigen() {
  const sh=libro().getSheetByName(MATRIZ_ORIGEN);
  if(!sh || sh.getLastRow()<2) return null;
  const filas=sh.getDataRange().getDisplayValues(), cab=filas[0], iCargo=cab.findIndex(x=>normal(x).includes("PUESTO DE TRABAJO")), iArea=cab.findIndex(x=>normal(x)==="AREA");
  if(iCargo<0) return null;
  const cols={}; cab.forEach((x,i)=>{const c=codigoMatriz(x);if(c)cols[c]=i});
  return [["Cargo","Area"].concat(RIESGOS)].concat(filas.slice(1).filter(r=>String(r[iCargo]||"").trim()).map(r=>[
    r[iCargo], iArea>=0?r[iArea]:"", ...RIESGOS.map(c=>normal(r[cols[c]]||"").startsWith("APLICA")?"A":"")
  ]));
}

function hojas(b) {
  const accion=String(b.accion||"");
  if (accion === "contexto") return contexto();
  if (accion === "persona") return persona(b.dni);
  if (accion === "listado") return listado(b.filtro);
  if (accion === "guardar") return guardar(b);
  if (accion === "alta") return alta(b);
  if (accion === "cargos") return cargos();
  if (accion === "comprobar") return comprobar();
  if (accion === "setup") return setup();
  throw new Error('accion desconocida: '+accion);
}
function contexto() {
  const ss=libro(), cursos=ss.getSheetByName(H.cursos), matriz=ss.getSheetByName(H.matriz), config=ss.getSheetByName(H.config);
  const cv=cursos && cursos.getLastRow()>1 ? cursos.getRange(2,1,cursos.getLastRow()-1,4).getValues() : [];
  const mv=leerMatrizOrigen() || (matriz ? matriz.getDataRange().getValues() : []);
  const o={}; if(config && config.getLastRow()>1) config.getRange(2,1,config.getLastRow()-1,2).getValues().forEach(r=>{if(r[0])o[r[0]]=r[1]});
  return {cabecera:CABECERA, riesgos:RIESGOS.map(codigo=>({codigo})), cursos:cv, matriz:mv, config:o};
}
function iso(x) { if(Object.prototype.toString.call(x)==="[object Date]"&&!isNaN(x))return Utilities.formatDate(x,Session.getScriptTimeZone(),"yyyy-MM-dd"); const s=String(x||"").trim(),m=/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s);return m?m[3]+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[1]).slice(-2):s; }
function datosFila(f) { const v=n=>String(f[CABECERA.indexOf(n)]==null?"":f[CABECERA.indexOf(n)]).trim(), base=DATOS.length; return {codigo:v("Codigo"),item:v("Item"),apellidos:v("Apellidos"),nombres:v("Nombres"),dni:dni(v("DNI")),empresa:v("EMPRESA"),guardia:v("Guardia"),cargo:v("Cargo Planilla"),area:v("Area Planilla"),comentario:v("COMENTARIO"),examenMedico:iso(v("F. Ex. Medico")),vencimientoEmo:iso(v("F. Vencimiento")),usoLentes:v("USO DE LENTES"),restricciones:v("RESTRICCIONES_EMO"),foto:v("FOTO"),fotocheckAntiguoDriveId:v("FOTOCHECK_ANTIGUO_DRIVE_ID"),carpetaDriveId:v("CARPETA_DRIVE_ID"),estadoFinal:v("ESTADO_FINAL"),fechaMinima:iso(v("FECHA MINIMA")),dias:v("DIAS"),estadoTrabajador:v("_EstaTE"),nombreCompleto:[v("Apellidos"),v("Nombres")].filter(Boolean).join(" "),riesgos:RIESGOS.map((codigo,i)=>({codigo,rotulo:codigo,nombre:codigo,cap:iso(f[base+i*4]),venc:iso(f[base+i*4+1]),tipo:String(f[base+i*4+2]||"").trim().toUpperCase(),estado:String(f[base+i*4+3]||"").trim().toUpperCase()}))}; }
function persona(valor) { const k=dni(valor); if(!k) throw new Error("DNI invalido"); const sh=personal(), col=DATOS.indexOf("DNI")+1, first=CONFIG.filaDatos, n=Math.max(sh.getLastRow()-first+1,0); const vals=n?sh.getRange(first,col,n,1).getValues():[]; for(let i=0;i<vals.length;i++) if(dni(vals[i][0])===k) { const row=first+i, v=completas(sh.getRange(row,1,1,Math.min(sh.getMaxColumns(),CABECERA.length)).getValues()[0]); return {encontrada:true,dni:k,fila:row,valores:v,datos:datosFila(v)}; } return {encontrada:false,dni:k}; }
/**
 * Todo el personal, o solo quienes coinciden con `filtro`, para el reporte de
 * vencimientos por RRCC (una sola lectura, no una por persona).
 *
 * `filtro:"vencidos_activos"` (ESTADO_FINAL=VENCIDO y _EstaTE=ACTIVO) filtra
 * ANTES de devolver: la vista "estado total" solo necesita a un puñado de las
 * 600+ personas de la hoja, y lo mas lento del pedido es serializar y mandar
 * por red el JSON de todo el mundo (1.5+ MB), no la lectura del rango.
 *
 * El filtro se aplica sobre la fila cruda, antes de `datosFila`, que es lo
 * caro: por cada persona arma 18 riesgos y resuelve ~20 nombres de columna con
 * CABECERA.indexOf (un recorrido de las 97 columnas cada vez). Hacerlo primero
 * para las 600+ y descartar despues gastaba casi todo ese trabajo en gente que
 * no iba a viajar, y es de lo que empujaba al pedido por encima del limite de
 * tiempo de la funcion.
 */
function listado(filtro) {
  const sh=personal(), first=CONFIG.filaDatos, last=sh.getLastRow();
  if (last < first) return { personas: [] };
  const width = Math.min(sh.getMaxColumns(), CABECERA.length);
  const filas = sh.getRange(first, 1, last-first+1, width).getValues();
  const iDni = DATOS.indexOf("DNI"), iEstado = CABECERA.indexOf("ESTADO_FINAL"), iEsta = CABECERA.indexOf("_EstaTE");
  let utiles = filas.filter(f => String(f[iDni]||"").trim());
  if (filtro === "vencidos_activos") {
    utiles = utiles.filter(f => normal(f[iEstado]) === "VENCIDO" && normal(f[iEsta]) === "ACTIVO");
  }
  return { personas: utiles.map(f => datosFila(completas(f))) };
}
function colLetra(n) { let s=""; for(;n>0;n=Math.floor((n-1)/26)) s=String.fromCharCode(65+(n-1)%26)+s; return s; }
/** Formula de ESTADO_xx de la hoja (NO APLICA sin fecha, VENCIDO >365 dias, ACTUALIZAR desde 330),
 *  contada desde la capacitacion. `e` es la posicion 0-based del ESTADO; su capacitacion es la columna e-2 (1-based). */
function formulaEstado(e, fila) { const d="TODAY()-"+colLetra(e-2)+fila; return '=IF('+d+'=TODAY(),"NO APLICA",IF('+d+'>365,"VENCIDO",IF('+d+'>=330,"ACTUALIZAR","VIGENTE")))'; }
/** Fila mas cercana por encima de `fila` (hasta 25) con formulas en el bloque de riesgos, o 0.
 *  Una alta fallida deja una fila a medias, que no sirve de modelo. */
function filaConFormulas(sh, fila, inicio, ancho) {
  const n=Math.min(25, fila-CONFIG.filaDatos);
  if(n<=0) return 0;
  const desde=fila-n, formulas=sh.getRange(desde,inicio+1,n,ancho).getFormulasR1C1();
  for(let i=n-1;i>=0;i--) if(formulas[i].some(f=>f)) return desde+i;
  return 0;
}
/**
 * Escribe P en adelante SIN pisar formulas: la hoja calcula el ESTADO de cada RRCC
 * (y lo demas que tenga formula) a partir de las fechas; la app solo aporta fechas y tipos.
 *  - una celda que ya trae formula se deja intacta;
 *  - ESTADO_xx es siempre formula: si la celda no la tiene, se le pone;
 *  - en una alta (`heredar`) se copian de la fila anterior el resto de formulas (FECHA MINIMA,
 *    DIAS, ESTADO_FINAL...) como si se arrastraran: en R1C1 son relativas y quedan ajustadas.
 *    No se usa copyTo: Google lo rechaza si la fila de origen esta oculta por un filtro
 *    ("No se admite esta operacion en un rango con una fila filtrada"); leer si se puede.
 */
function escribirBloque(sh, fila, valores, heredar) {
  const inicio=DATOS.length, ancho=Math.min(sh.getMaxColumns(),CABECERA.length)-inicio;
  if(ancho<=0) throw new Error("la hoja no tiene bloque de riesgos");
  const destino=sh.getRange(fila,inicio+1,1,ancho), v=completas(valores);
  const modelo=heredar?filaConFormulas(sh,fila,inicio,ancho):0;
  if(modelo) { destino.setFormulasR1C1(sh.getRange(modelo,inicio+1,1,ancho).getFormulasR1C1()); SpreadsheetApp.flush(); }
  const formulas=destino.getFormulas()[0];
  destino.setValues([formulas.map((f,i)=>f||(COL_ESTADO.indexOf(inicio+i)>=0?formulaEstado(inicio+i,fila):v[inicio+i]))]);
}
/** Columnas de A:O que la ficha puede corregir a mano (vencimiento del EMO, area, nombre, cargo y empresa). El resto de A:O no se toca. */
const EDITABLES = { "F. Vencimiento": "fecha", "Area Planilla": "texto", "Apellidos": "texto", "Nombres": "texto", "Cargo Planilla": "texto", "EMPRESA": "texto" };
/**
 * Escribe esas columnas para una fila. Los nombres se validan ANTES de escribir nada. Si la celda tenia una
 * formula se reemplaza por lo escrito (es una correccion explicita) y el nombre vuelve en la respuesta.
 */
function escribirDatos(sh, fila, datos) {
  const nombres=Object.keys(datos||{});
  nombres.forEach(n=>{ if(!EDITABLES[n]) throw new Error("columna no editable desde la app: "+n); });
  const reemplazadas=[];
  nombres.forEach(n=>{
    const celda=sh.getRange(fila,DATOS.indexOf(n)+1), v=datos[n];
    if(celda.getFormula()) reemplazadas.push(n);
    celda.setValue(EDITABLES[n]==="fecha" ? (v||"") : String(v==null?"":v).trim());
  });
  return reemplazadas;
}
/**
 * Una escritura vieja no pisa a una nueva. Cuando el script tarda, Google devuelve una pagina rota
 * AUNQUE la ejecucion siga corriendo, y el puente reintenta: esa ejecucion abandonada podia terminar
 * DESPUES de un guardado posterior (una fecha corregida a mano) y devolver la fila a lo anterior.
 * Cada guardado trae `marca` (ms, la pone el navegador una vez; los reintentos repiten la misma).
 * Con el candado, las escrituras de una fila van de a una y se descarta la que llegue con una marca
 * menor a la ultima aplicada. Devuelve true si hay que descartarla.
 */
function escrituraObsoleta(fila, marca) {
  if (!marca) return false; // clientes viejos sin marca: se escribe como siempre
  const c=CacheService.getScriptCache(), k="guardar:"+fila, previa=Number(c.get(k)||0);
  if (previa > Number(marca)) return true;
  c.put(k, String(marca), 21600); // 6 h: de sobra para cualquier reintento en vuelo
  return false;
}
/** Actualiza P en adelante (y, si se piden, las columnas editables de A:O); A:O conserva las validaciones de la base y las formulas de la hoja no se tocan. */
function guardar(b) { if(!b.fila||!Array.isArray(b.valores)) throw new Error("faltan fila o valores"); const candado=LockService.getScriptLock(); candado.waitLock(30000); try { return guardarConCandado(b); } finally { candado.releaseLock(); } }
function guardarConCandado(b) { const sh=personal(), fila=Number(b.fila); if(escrituraObsoleta(fila,b.marca)) return {ok:true,fila:fila,obsoleto:true,formulaReemplazada:[]}; const formulaReemplazada=escribirDatos(sh,fila,b.datos); escribirBloque(sh,fila,b.valores); SpreadsheetApp.flush(); if(b.noMapeados&&b.noMapeados.length) { const c=libro().getSheetByName(H.cursos); if(c)c.getRange(c.getLastRow()+1,1,b.noMapeados.length,4).setValues(b.noMapeados.map(x=>[x.curso||"","",x.origen||"","sin mapear "+new Date().toISOString()])); } return {ok:true,fila:fila,formulaReemplazada:formulaReemplazada}; }
function alta(b) { if(!Array.isArray(b.valores)) throw new Error("falta valores"); const v=completas(b.valores), k=dni(v[6]); if(!k) throw new Error("la persona nueva no trae DNI"); if(persona(k).encontrada) { const x=persona(k); return {ok:false,yaExiste:true,fila:x.fila,error:"el DNI ya existe"}; } const sh=personal(), first=CONFIG.filaDatos; if(!v[2]) { const codes=sh.getRange(first,3,Math.max(sh.getLastRow()-first+1,1),1).getValues().flat(); let max=0; codes.forEach(x=>{const m=/^AE(\d+)$/i.exec(x);if(m)max=Math.max(max,+m[1])});v[2]="AE"+("000"+(max+1)).slice(-3); } if(!v[1])v[1]=Math.max(sh.getLastRow()-first+2,1); const width=Math.min(sh.getMaxColumns(),CABECERA.length), inicio=DATOS.length, row=sh.getLastRow()+1; sh.getRange(row,1,1,Math.min(inicio,width)).setValues([v.slice(0,inicio)]); if(width>inicio) { try { escribirBloque(sh,row,v,true); } catch(err) { try { sh.getRange(row,1,1,width).clearContent(); } catch(_) {} throw err; } } return {ok:true,fila:row,codigo:v[2],valores:v}; }
function cargos() { const sh=personal(), first=CONFIG.filaDatos, n=Math.max(sh.getLastRow()-first+1,0), distinct=c=>[...new Set(n?sh.getRange(first,c,n,1).getValues().flat().map(String).map(x=>x.trim()).filter(Boolean):[])].sort(); return {cargos:distinct(10),areas:distinct(12)}; }
function comprobar() { const sh=personal(), row=CONFIG.filaCabecera, actual=sh.getRange(row,1,1,Math.min(sh.getMaxColumns(),CABECERA.length)).getValues()[0], dif=[]; CABECERA.forEach((x,i)=>{if(actual[i]!==undefined&&actual[i]!==""&&normal(actual[i])!==normal(x))dif.push({columna:i+1,esperada:x,real:String(actual[i])})}); return {ok:!dif.length,spreadsheet:libro().getId(),hojaPersonal:sh.getName(),hojas:libro().getSheets().map(x=>x.getName()),faltan:[H.cursos,H.matriz,H.config].filter(x=>!libro().getSheetByName(x)),revision:{diferencias:dif,grave:!!dif.length}}; }
function setup() { const ss=libro(), creadas=[]; [H.cursos,H.matriz,H.config].forEach(n=>{if(!ss.getSheetByName(n)){ss.insertSheet(n);creadas.push(n)}}); const c=ss.getSheetByName(H.cursos),m=ss.getSheetByName(H.matriz),f=ss.getSheetByName(H.config), hecho=[]; if(!c.getLastRow()){c.getRange(1,1,1,4).setValues([["nombre_certificado","codigo_rrcc","fuente_preferida","nota"]]);hecho.push(H.cursos+": cabecera creada");} if(!m.getLastRow()){m.getRange(1,1,1,2+RIESGOS.length).setValues([["Cargo","Area"].concat(RIESGOS)]);hecho.push(H.matriz+": cabecera creada");} if(!f.getLastRow()){f.getRange(1,1,9,2).setValues([["CLAVE","VALOR"],["UMBRAL_VENCIDO",365],["UMBRAL_ACTUALIZAR",330],["A_SIN_CERT","MANTENER"],["PLANTILLA_CARPETA","{DNI}_{APELLIDOS} {NOMBRES}"],["PREFIJO_CODIGO","AE"],["FOTOCHECK_ALTO_CM",8],["FOTOCHECK_ANCHO_CM",10],["ANTIGUO_ANCHO_CM",17]]);hecho.push(H.config+": parametros creados");} const sh=personal(); if(sh.getMaxColumns()<CABECERA.length){sh.insertColumnsAfter(sh.getMaxColumns(),CABECERA.length-sh.getMaxColumns());hecho.push("columnas extra agregadas");} return {ok:true,creadas,hecho,avisos:[],revision:comprobar().revision}; }

function drive(b) { const a=String(b.accion||""); if(a==="carpeta")return carpeta(b);if(a==="carpetas")return carpetas();if(a==="subir")return subir(b);if(a==="subir-lote")return subirLote(b);if(a==="foto")return subir(Object.assign({},b,{carpetaId:b.carpetaId||folderByIdOrName(CONFIG.carpetaFotosId,CONFIG.carpetaFotosNombre).getId()}));if(a==="foto-de")return fotoDe(b);if(a==="bajar")return bajar(b);if(a==="listar")return listar(b);if(a==="eliminar")return eliminar(b);throw new Error("accion desconocida: "+a); }
/**
 * Carpeta de una persona. Con `dni` se busca primero por el DNI del comienzo del nombre, con o sin el
 * cero inicial ("76018787", "76018787_TORRES ..." o "4220334_..."): asi las carpetas creadas cuando el
 * nombre llevaba apellidos se reutilizan y se renombran a `nombre` (el DNI), en vez de crear otra cada
 * vez que el nombre cambia una letra. Si hay varias, gana la que ya se llama como el DNI, y si no la
 * modificada mas recientemente.
 */
function carpeta(b){const p=b.padre?DriveApp.getFolderById(b.padre):folderByIdOrName(CONFIG.carpetaSalidasId,CONFIG.carpetaSalidasNombre);let f=null,creada=false,renombrada="";if(b.dni){f=carpetaDeDni(p,b.dni,b.nombre);if(f){const antes=f.getName();if(b.nombre&&antes!==b.nombre){f.setName(b.nombre);renombrada=antes;}}}if(!f){const it=p.getFoldersByName(b.nombre);creada=!it.hasNext();f=creada?p.createFolder(b.nombre):it.next();}const r={ok:true,carpetaId:f.getId(),nombre:f.getName(),creada:creada,renombrada:renombrada};if(b.vaciar){r.eliminados=creada?0:vaciarCarpeta(f);r.vaciada=true;}return r;}
/** Manda a la papelera (recuperable) todos los archivos de la carpeta; devuelve cuantos. */
function vaciarCarpeta(f){const it=f.getFiles();let n=0;while(it.hasNext()){it.next().setTrashed(true);n++;}return n;}
function carpetaDeDni(p,valor,nombre){const k=dni(valor);if(!k)return null;const corto=k.replace(/^0+/,"")||k,vistos={},c=[];[k,corto].forEach(x=>{const it=p.searchFolders("title contains '"+x+"' and trashed = false");while(it.hasNext()){const f=it.next(),id=f.getId();if(vistos[id])continue;vistos[id]=1;const m=/^(\d+)/.exec(f.getName());if(m&&dni(m[1])===k)c.push(f);}});if(!c.length)return null;c.sort((a,b)=>((b.getName()===nombre)-(a.getName()===nombre))||(b.getLastUpdated()-a.getLastUpdated()));return c[0];}
function carpetas(){const s=folderByIdOrName(CONFIG.carpetaSalidasId,CONFIG.carpetaSalidasNombre),f=folderByIdOrName(CONFIG.carpetaFotosId,CONFIG.carpetaFotosNombre);return {ok:true,raiz:raiz().getId(),salidas:s.getId(),fotos:f.getId(),faltan:[]};}
function subir(b){if(!b.carpetaId||!b.datos)throw new Error("faltan carpetaId o datos");const p=DriveApp.getFolderById(b.carpetaId), bytes=Utilities.base64Decode(String(b.datos).replace(/^data:[^;]+;base64,/,"")), name=String(b.nombre||"SIN_NOMBRE"),it=p.getFilesByName(name);let reemplazado=false;if(b.reemplazar!==false&&it.hasNext()){it.next().setTrashed(true);reemplazado=true;}const file=p.createFile(Utilities.newBlob(bytes,b.mime||"application/octet-stream",name));return {ok:true,id:file.getId(),nombre:file.getName(),enlace:file.getUrl(),reemplazado};}
/**
 * Busca la foto por nombre exacto.  Antes se recorria toda la carpeta FOTOS;
 * con cientos de imagenes eso supera facilmente el tiempo de respuesta del
 * Web App y Google devuelve una pagina HTML con HTTP 200. El cliente entonces
 * solo podia mostrar "respuesta ilegible" y la renovacion no creaba salidas.
 *
 * Se mantienen las extensiones habituales y las dos grafias del documento
 * (con y sin cero inicial) que existen en la migracion historica.
 */
function fotoDe(b){
  const p=folderByIdOrName(CONFIG.carpetaFotosId,CONFIG.carpetaFotosNombre),k=dni(b.dni);
  const sinCeros=k.replace(/^0+/,"")||k;
  const bases=[k]; if(sinCeros!==k)bases.push(sinCeros);
  const extensiones=[".png",".PNG",".jpg",".JPG",".jpeg",".JPEG"];
  for(let i=0;i<bases.length;i++)for(let j=0;j<extensiones.length;j++){
    const it=p.getFilesByName(bases[i]+extensiones[j]);
    if(it.hasNext()){
      const f=it.next();
      return {ok:true,encontrada:true,id:f.getId(),nombre:f.getName(),mime:f.getMimeType(),datos:Utilities.base64Encode(f.getBlob().getBytes())};
    }
  }
  return {ok:false,encontrada:false,dni:k};
}
/** Varios archivos en una sola ejecucion: cada llamada al Web App cuesta varios segundos fijos. */
function subirLote(b){if(!b.carpetaId||!Array.isArray(b.archivos)||!b.archivos.length)throw new Error("faltan carpetaId o archivos");return {ok:true,archivos:b.archivos.map(x=>subir(Object.assign({},x,{carpetaId:b.carpetaId})))};}
function bajar(b){const f=DriveApp.getFileById(b.id);return {ok:true,id:b.id,nombre:f.getName(),mime:f.getMimeType(),datos:Utilities.base64Encode(f.getBlob().getBytes())};}
/** Manda a la papelera (recuperable) los archivos de la carpeta con esos nombres: certificados quitados con la "x". */
function eliminar(b){if(!b.carpetaId||!Array.isArray(b.nombres)||!b.nombres.length)throw new Error("faltan carpetaId o nombres");const p=DriveApp.getFolderById(b.carpetaId),eliminados=[];b.nombres.forEach(n=>{const it=p.getFilesByName(String(n));let hubo=false;while(it.hasNext()){it.next().setTrashed(true);hubo=true;}if(hubo)eliminados.push(String(n));});return {ok:true,eliminados};}
function listar(b){const it=DriveApp.getFolderById(b.carpetaId).getFiles(),a=[];while(it.hasNext()){const f=it.next();a.push({id:f.getId(),name:f.getName(),mimeType:f.getMimeType(),size:f.getSize()})}return {ok:true,archivos:a};}
