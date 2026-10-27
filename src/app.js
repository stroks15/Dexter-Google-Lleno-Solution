const selected = new Map();
let files = [];
let nextPageToken = null;
let photosSessionId = null;
let currentSourceService = "drive";
let currentJobService = "drive";
let currentJobId = null;
let supabaseClient = null;
let session = null;
let pollHandle = null;
let pendingDeleteConfirmation = null;
const list = document.querySelector("#fileList");
const fmt = n => (Number(n||0)/1e9).toFixed(2)+" GB";
const byId = id => document.getElementById(id);
const keyFor = f => f.service+":"+f.fileId;
async function api(path, options={}) {
  const headers = {"Content-Type":"application/json",...(options.headers||{})};
  if(session?.access_token) headers.Authorization="Bearer "+session.access_token;
  const response=await fetch(path,{...options,headers});
  const data=await response.json().catch(()=>({error:"invalid_response"}));
  if(!response.ok) throw new Error(data.detail||data.error||("HTTP "+response.status));
  return data;
}
function setAuthHint(message){byId("authHint").textContent=message}
function updateSummary(){
  const total=[...selected.values()].reduce((sum,f)=>sum+Number(f.sizeBytes||0),0);
  byId("selectedCount").textContent=selected.size+" seleccionados";
  byId("recoverLabel").textContent=[...selected.values()].some(f=>f.service==="photos"&&!Number(f.sizeBytes))?"Se calcula al copiar":fmt(total);
  byId("afterLabel").textContent="se calcula tras verificar";
  byId("usedLabel").textContent="—";
  byId("toggleAll").textContent=selected.size===files.length&&files.length?"Quitar selección":"Seleccionar todos";
}
function renderFiles(){
  list.innerHTML="";
  if(!files.length){list.textContent="Inicia sesión y pulsa «Escanear archivos reales de Drive» para cargar tus archivos.";updateSummary();return}
  for(const f of files){
    const row=document.createElement("label");row.className="file";
    const cb=document.createElement("input");cb.type="checkbox";cb.checked=selected.has(keyFor(f));cb.setAttribute("aria-label","Seleccionar "+f.name);
    cb.addEventListener("change",()=>{if(cb.checked)selected.set(keyFor(f),f);else selected.delete(keyFor(f));updateSummary()});
    const icon=document.createElement("span");icon.className="fileicon";icon.textContent=f.mimeType?.startsWith("video/")?"▷":f.mimeType?.startsWith("image/")?"▧":"▤";
    const meta=document.createElement("span");meta.className="filemeta";
    const name=document.createElement("strong");name.textContent=f.name;
    const type=document.createElement("small");type.textContent=(f.mimeType||"Archivo")+" · "+(f.modifiedTime?new Date(f.modifiedTime).toLocaleDateString():"fecha desconocida");
    meta.append(name,type);
    const size=document.createElement("span");size.className="filesize";size.textContent=f.service==="photos"?"Se calcula al copiar":fmt(f.sizeBytes);
    row.append(cb,icon,meta,size);list.append(row);
  }
  updateSummary();
}
async function refreshConnections(){
  if(!session)return;
  const data=await api("/api/auth/connections");
  const labels={source:"Cuenta 1 · Origen",destination:"Cuenta 2 · Destino"};
  for(const [role,apiRole] of [["source","source"],["destination","destination"]]){
    const conn=data.connections.find(c=>c.role===apiRole&&c.connected);
    const button=document.querySelector('[data-connect="'+role+'"]');
    if(button){button.textContent=conn?"Conectada ✓":"Conectar";button.disabled=false}
  }
  const source=data.connections.find(c=>c.role==="source"&&c.connected);
  const destination=data.connections.find(c=>c.role==="destination"&&c.connected);
  document.querySelector("#connectionHint").textContent=(source?"Origen conectado: "+source.email+". ":"Origen pendiente. ")+(destination?"Destino conectado: "+destination.email+".":"Destino pendiente.");
}
async function refreshAuth(){
  const result=await supabaseClient.auth.getSession();
  session=result.data.session;
  const signed=!!session;
  byId("googleSignInButton").hidden=signed;byId("signOutButton").hidden=!signed;
  byId("authPanel").querySelector("h2").textContent=signed?"Sesión iniciada":"Inicia sesión para continuar";
  if(signed){setAuthHint("Sesión segura activa: "+(session.user.email||"usuario")+".");await refreshConnections().catch(e=>setAuthHint("Sesión activa; no se pudo consultar conexiones: "+e.message));}
  else{setAuthHint("Autenticación mediante Supabase. No introduzcas tu contraseña de Google aquí.");byId("connectionHint").textContent="Inicia sesión para conectar las cuentas Google."}
}
async function connect(role,button){
  if(!session){setAuthHint("Primero inicia sesión con tu cuenta de la aplicación.");return}
  const popup=window.open("about:blank","googleOAuth","popup,width=520,height=720");
  try{
    if(button)button.disabled=true;
    const result=await api("/api/auth/google",{method:"POST",body:JSON.stringify({role:role==="source"?"account_source":"account_target"})});
    if(popup)popup.location=result.url;else window.location.href=result.url;
  }catch(e){if(popup)popup.close();byId("connectionHint").textContent="No se pudo iniciar OAuth: "+e.message}
  finally{if(button)button.disabled=false}
}
document.querySelectorAll("[data-connect]").forEach(button=>button.addEventListener("click",()=>connect(button.dataset.connect,button)));
window.addEventListener("message",async event=>{
  if(event.origin!==window.location.origin||event.data?.type!=="google-oauth-complete")return;
  await refreshConnections().catch(e=>byId("connectionHint").textContent=e.message);
  if(event.data.role==="account_source_delete"&&pendingDeleteConfirmation&&currentJobId){
    try{
      const result=await api("/api/migrations/confirm-delete",{method:"POST",body:JSON.stringify({jobId:currentJobId,confirmationText:pendingDeleteConfirmation})});
      byId("deleteHint").textContent="Resultado del borrado: "+result.status+". Revisa los resultados individuales.";
    }catch(e){byId("deleteHint").textContent="No se completó el borrado: "+e.message;byId("confirmDeleteButton").disabled=false}
    finally{pendingDeleteConfirmation=null}
  }
});
byId("googleSignInButton").addEventListener("click",async()=>{
  try{
    byId("googleSignInButton").disabled=true;
    setAuthHint("Abriendo el acceso seguro de Google…");
    const result=await supabaseClient.auth.signInWithOAuth({
      provider:"google",
      options:{redirectTo:window.location.origin+"/",queryParams:{access_type:"offline",prompt:"select_account"}}
    });
    if(result.error)throw result.error;
  }catch(e){
    setAuthHint("No se pudo iniciar sesión con Google: "+e.message);
    byId("googleSignInButton").disabled=false;
  }
});
byId("signOutButton").addEventListener("click",async()=>{await supabaseClient.auth.signOut();session=null;selected.clear();files=[];renderFiles();await refreshAuth()});
byId("scanButton").addEventListener("click",()=>{currentSourceService="drive";scanFiles(false)});
byId("loadMoreButton").addEventListener("click",()=>scanFiles(true));
byId("selectPhotosButton").addEventListener("click",()=>startPhotosPicker());
async function startPhotosPicker(){
 if(!session){byId("photosHint").textContent="Inicia sesión primero.";return}
 const popup=window.open("about:blank","googlePhotosPicker","popup,width=1000,height=760");
 try{
  byId("selectPhotosButton").disabled=true;
  byId("photosHint").textContent="Creando sesión segura de Google Fotos…";
  const result=await api("/api/migrations/scan?service=photos",{method:"POST",body:JSON.stringify({service:"photos"})});
  photosSessionId=result.sessionId;
  if(popup)popup.location=result.pickerUri;else window.open(result.pickerUri,"_blank","noopener");
  byId("photosHint").textContent="Selecciona fotos y videos en Google Fotos. Esta página esperará a que termines…";
  const deadline=Date.now()+15*60*1000;
  let readyResult=null;
  while(Date.now()<deadline){
   await new Promise(resolve=>setTimeout(resolve,3000));
   const status=await api("/api/migrations/scan?service=photos&sessionId="+encodeURIComponent(photosSessionId));
   if(status.ready){readyResult=status;break}
  }
  if(!readyResult)throw new Error("No se detectó la selección. Vuelve a abrir el selector e inténtalo de nuevo.");
  const selectedPhotos=readyResult.items||[];
  if(!selectedPhotos.length)throw new Error("No seleccionaste elementos en Google Fotos.");
  files=selectedPhotos;selected.clear();currentSourceService="photos";nextPageToken=readyResult.nextPageToken||null;
  document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("selected",b.dataset.mode==="photos_videos"));
  byId("loadMoreButton").hidden=!nextPageToken;
  byId("actionHint").textContent=selectedPhotos.length+" elementos seleccionados desde Google Fotos. Marca los que quieras copiar.";
  byId("photosHint").textContent="Selección lista. La transferencia usa carga reanudable por fragmentos para fotos y videos grandes (hasta 20 GB por video según los límites de Google Photos). Los originales no se borrarán automáticamente.";
  renderFiles();
 }catch(e){if(popup&&popup.closed===false){}byId("photosHint").textContent="No se pudo seleccionar Google Fotos: "+e.message}
 finally{byId("selectPhotosButton").disabled=false}
}

async function scanFiles(loadMore){
  if(!session){byId("actionHint").textContent="Inicia sesión primero.";return}
  try{
    byId("scanButton").disabled=true;byId("loadMoreButton").disabled=true;
    if(currentSourceService==="photos"&&photosSessionId){
      byId("actionHint").textContent="Cargando más elementos seleccionados de Google Fotos…";
      const path="/api/migrations/scan?service=photos&sessionId="+encodeURIComponent(photosSessionId)+(loadMore&&nextPageToken?"&pageToken="+encodeURIComponent(nextPageToken):"");
      const result=await api(path);
      if(!result.ready)throw new Error("La selección de Google Fotos todavía no está lista.");
      files.push(...(result.items||[]));nextPageToken=result.nextPageToken||null;
      byId("loadMoreButton").hidden=!nextPageToken;
      byId("actionHint").textContent=files.length+" elementos seleccionados desde Google Fotos.";
    }else{
      byId("actionHint").textContent="Consultando archivos reales de Google Drive…";
      const path="/api/migrations/scan"+(loadMore&&nextPageToken?"?pageToken="+encodeURIComponent(nextPageToken):"");
      const result=await api(path);
      if(!loadMore){files=[];selected.clear()}
      files.push(...result.files);nextPageToken=result.nextPageToken;currentSourceService="drive";
      byId("loadMoreButton").hidden=!nextPageToken;
      byId("actionHint").textContent=files.length+" archivos de Drive cargados. Selecciona los que quieras copiar.";
    }
    renderFiles();
  }catch(e){byId("actionHint").textContent="No se pudieron cargar los archivos: "+e.message}
  finally{byId("scanButton").disabled=false;byId("loadMoreButton").disabled=false}
}
byId("toggleAll").addEventListener("click",()=>{
  if(files.length&&selected.size===files.length)selected.clear();else files.forEach(f=>selected.set(keyFor(f),f));
  renderFiles();
});
document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>{
  document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("selected",b===button));
  if(button.dataset.mode==="photos_videos"){byId("actionHint").textContent="Pulsa «Elegir fotos y videos de Google Fotos» para abrir el selector oficial.";}
  else if(button.dataset.mode==="drive"){byId("actionHint").textContent="Escanea Google Drive para elegir archivos.";}
  else if(button.dataset.mode==="all"){byId("actionHint").textContent="Drive y Fotos se procesan en tareas separadas; elige una fuente cada vez.";}
  else byId("actionHint").textContent="Elige los elementos con el selector oficial de Google Fotos y luego selecciona fotos o videos.";
}));
byId("startButton").addEventListener("click",async()=>{
  if(!session){byId("actionHint").textContent="Inicia sesión primero.";return}
  if(!selected.size){byId("actionHint").textContent="Escanea Drive y selecciona al menos un archivo real.";return}
  try{
    byId("startButton").disabled=true;byId("actionHint").textContent="Creando tarea de migración…";
    const service=[...selected.values()][0]?.service||currentSourceService;
    if([...selected.values()].some(f=>f.service!==service))throw new Error("Selecciona archivos de Drive o Google Fotos, no mezcles fuentes en una tarea.");
    currentJobService=service;
    const result=await api("/api/migrations/enqueue",{method:"POST",body:JSON.stringify({mode:service==="photos"?"photos_videos":"drive",photosSessionId:service==="photos"?photosSessionId:undefined,files:[...selected.values()].map(f=>({fileId:f.fileId,name:f.name,mimeType:f.mimeType,sizeBytes:f.sizeBytes,service}))})});
    currentJobId=result.jobId;byId("progressPanel").hidden=false;byId("progressText").textContent="Migración: "+result.status;byId("deleteHint").textContent="La verificación se realizará antes de habilitar el borrado.";
    pollProgress();
  }catch(e){byId("actionHint").textContent="No se pudo iniciar: "+e.message}
  finally{byId("startButton").disabled=false}
});
async function pollProgress(){
  if(!currentJobId||!session)return;
  try{
    const data=await api("/api/migrations/progress?jobId="+encodeURIComponent(currentJobId));
    const p=data.progress||{};const percent=Number(p.percent||0);
    byId("jobProgress").style.width=percent+"%";byId("progressText").textContent="Progreso verificado: "+percent+"% · Estado: "+(data.job.status||p.status||"en cola");
    byId("remainingText").textContent=p.remainingSeconds==null?"Calculando tiempo restante…":"Tiempo restante estimado: "+Math.ceil(p.remainingSeconds/60)+" min";
    if(data.job.status==="verified"){
      byId("confirmDeleteButton").disabled=currentJobService==="photos";
      byId("deleteHint").textContent=currentJobService==="photos"?"La API confirmó la creación de los elementos en destino. Comprueba que los videos terminen de procesarse y abre la lista inferior para localizar los originales; después podrás borrarlos manualmente en Google Fotos.":"Copia verificada. Revisa la Cuenta 2 antes de confirmar el borrado.";
      if(currentJobService==="photos"){
        byId("photosManualReview").hidden=false;
        const container=byId("photosVerifiedList");container.innerHTML="";
        for(const f of (data.verifiedFiles||[])){
          const label=document.createElement("label");label.className="file";
          const cb=document.createElement("input");cb.type="checkbox";cb.setAttribute("aria-label","Marcar como borrado manualmente: "+f.file_name);
          const name=document.createElement("strong");name.textContent=f.file_name||f.source_file_id;
          const detail=document.createElement("small");detail.textContent=(f.mime_type||"archivo")+" · "+(Number(f.size_bytes||0)?fmt(f.size_bytes):"tamaño desconocido")+" · copia aceptada por la API";
          const meta=document.createElement("span");meta.className="filemeta";meta.append(name,detail);label.append(cb,meta);container.append(label);
        }
        if(!(data.verifiedFiles||[]).length)container.textContent="No hay elementos de Google Fotos con estado verificado para este trabajo.";
      }
    }
    if(["verified","deleted","failed","cancelled"].includes(data.job.status))return;
  }catch(e){byId("remainingText").textContent="No se pudo actualizar el progreso: "+e.message}
  pollHandle=setTimeout(pollProgress,3000);
}
byId("confirmDeleteButton").addEventListener("click",async()=>{
  if(!session||!currentJobId)return;
  if(currentJobService==="photos"){byId("deleteHint").textContent="Google Photos no permite borrar ni seleccionar automáticamente estos originales mediante esta API. Usa la lista de control inferior, abre Google Fotos y selecciona allí los elementos que hayas comprobado en destino.";byId("photosManualReview").hidden=false;return;}
  const warning="Entra a tu cuenta de Google número 2 y revisa en Drive que todos los archivos seleccionados estén completos para tu mayor seguridad. Una vez que verifiques que todo está completo y sin errores, presiona aquí para eliminar los archivos copiados de la cuenta 1";
  if(!window.confirm(warning))return;
  const typed=window.prompt('Para confirmar, escribe exactamente: ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1');
  if(typed!=="ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1")return;
  const popup=window.open("about:blank","googleDeleteConsent","popup,width=520,height=720");
  try{
    byId("confirmDeleteButton").disabled=true;
    const result=await api("/api/migrations/confirm-delete",{method:"POST",body:JSON.stringify({jobId:currentJobId,confirmationText:typed})});
    if(popup)popup.close();
    byId("deleteHint").textContent="Resultado del borrado: "+result.status+". Revisa los resultados individuales.";
  }catch(e){
    if(e.message.includes("reauthorize_source_for_deletion")){
      try{
        const consent=await api("/api/auth/google-delete-consent",{method:"POST",body:JSON.stringify({jobId:currentJobId,confirmationText:typed})});
        if(!popup){byId("deleteHint").textContent="Permite la ventana emergente para autorizar el permiso de borrado.";byId("confirmDeleteButton").disabled=false;return}
        pendingDeleteConfirmation=typed;
        popup.location=consent.url;
        byId("deleteHint").textContent="Autoriza el permiso de borrado en Google. Solo se solicitará después de verificar la copia.";
      }catch(consentError){if(popup)popup.close();byId("deleteHint").textContent="No se pudo solicitar autorización: "+consentError.message;byId("confirmDeleteButton").disabled=false}
    }else{
      if(popup)popup.close();
      byId("deleteHint").textContent="El borrado no se completó: "+e.message;
      byId("confirmDeleteButton").disabled=false;
    }
  }
});
async function init(){
  try{
    const configResponse=await fetch("/api/config");const config=await configResponse.json();
    if(!configResponse.ok||!window.supabase?.createClient||!config.supabaseUrl||!config.supabaseAnonKey)throw new Error("Configuración de autenticación no disponible");
    supabaseClient=window.supabase.createClient(config.supabaseUrl,config.supabaseAnonKey);
    supabaseClient.auth.onAuthStateChange(()=>{setTimeout(()=>refreshAuth().catch(e=>setAuthHint(e.message)),0)});
    await refreshAuth();
  }catch(e){setAuthHint("La autenticación aún requiere configuración de servidor: "+e.message)}
  renderFiles();
}
init();
