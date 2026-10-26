const selected = new Map();
let files = [];
let nextPageToken = null;
let currentJobId = null;
let supabaseClient = null;
let session = null;
let pollHandle = null;
const list = document.querySelector("#fileList");
const fmt = n => (Number(n||0)/1e9).toFixed(2)+" GB";
const byId = id => document.getElementById(id);
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
  byId("recoverLabel").textContent=fmt(total);
  byId("afterLabel").textContent="se calcula tras verificar";
  byId("usedLabel").textContent="—";
  byId("toggleAll").textContent=selected.size===files.length&&files.length?"Quitar selección":"Seleccionar todos";
}
function renderFiles(){
  list.innerHTML="";
  if(!files.length){list.textContent="Inicia sesión y pulsa «Escanear archivos reales de Drive» para cargar tus archivos.";updateSummary();return}
  for(const f of files){
    const row=document.createElement("label");row.className="file";
    const cb=document.createElement("input");cb.type="checkbox";cb.checked=selected.has(f.fileId);cb.setAttribute("aria-label","Seleccionar "+f.name);
    cb.addEventListener("change",()=>{if(cb.checked)selected.set(f.fileId,f);else selected.delete(f.fileId);updateSummary()});
    const icon=document.createElement("span");icon.className="fileicon";icon.textContent=f.mimeType?.startsWith("video/")?"▷":f.mimeType?.startsWith("image/")?"▧":"▤";
    const meta=document.createElement("span");meta.className="filemeta";
    const name=document.createElement("strong");name.textContent=f.name;
    const type=document.createElement("small");type.textContent=(f.mimeType||"Archivo")+" · "+(f.modifiedTime?new Date(f.modifiedTime).toLocaleDateString():"fecha desconocida");
    meta.append(name,type);
    const size=document.createElement("span");size.className="filesize";size.textContent=fmt(f.sizeBytes);
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
  byId("authEmail").disabled=signed;byId("authPassword").disabled=signed;
  byId("signInButton").hidden=signed;byId("signUpButton").hidden=signed;byId("signOutButton").hidden=!signed;
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
});
byId("authForm").addEventListener("submit",async event=>{
  event.preventDefault();
  try{const email=byId("authEmail").value.trim(),password=byId("authPassword").value;
    const result=await supabaseClient.auth.signInWithPassword({email,password});
    if(result.error)throw result.error;
    await refreshAuth();
  }catch(e){setAuthHint("No se pudo iniciar sesión: "+e.message)}
});
byId("signUpButton").addEventListener("click",async()=>{
  try{const result=await supabaseClient.auth.signUp({email:byId("authEmail").value.trim(),password:byId("authPassword").value});
    if(result.error)throw result.error;
    setAuthHint(result.data.session?"Cuenta creada y sesión iniciada.":"Cuenta creada. Revisa tu correo para confirmar el registro.");
    await refreshAuth();
  }catch(e){setAuthHint("No se pudo crear la cuenta: "+e.message)}
});
byId("signOutButton").addEventListener("click",async()=>{await supabaseClient.auth.signOut();session=null;selected.clear();files=[];renderFiles();await refreshAuth()});
byId("scanButton").addEventListener("click",()=>scanFiles(false));
byId("loadMoreButton").addEventListener("click",()=>scanFiles(true));
async function scanFiles(loadMore){
  if(!session){byId("actionHint").textContent="Inicia sesión primero.";return}
  try{
    byId("scanButton").disabled=true;byId("loadMoreButton").disabled=true;byId("actionHint").textContent="Consultando archivos reales de Google Drive…";
    const path="/api/migrations/scan"+(loadMore&&nextPageToken?"?pageToken="+encodeURIComponent(nextPageToken):"");
    const result=await api(path);
    if(!loadMore){files=[];selected.clear()}
    files.push(...result.files);nextPageToken=result.nextPageToken;
    byId("loadMoreButton").hidden=!nextPageToken;
    byId("actionHint").textContent=files.length+" archivos de Drive cargados. Selecciona los que quieras copiar.";
    renderFiles();
  }catch(e){byId("actionHint").textContent="No se pudo escanear Drive: "+e.message}
  finally{byId("scanButton").disabled=false;byId("loadMoreButton").disabled=false}
}
byId("toggleAll").addEventListener("click",()=>{
  if(files.length&&selected.size===files.length)selected.clear();else files.forEach(f=>selected.set(f.fileId,f));
  renderFiles();
});
document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>{
  document.querySelectorAll("[data-mode]").forEach(b=>b.classList.toggle("selected",b===button));
  if(button.dataset.mode!=="drive"&&button.dataset.mode!=="all")byId("actionHint").textContent="La transferencia de Google Fotos todavía no está habilitada; por seguridad solo se encolan archivos de Drive.";
}));
byId("startButton").addEventListener("click",async()=>{
  if(!session){byId("actionHint").textContent="Inicia sesión primero.";return}
  if(!selected.size){byId("actionHint").textContent="Escanea Drive y selecciona al menos un archivo real.";return}
  try{
    byId("startButton").disabled=true;byId("actionHint").textContent="Creando tarea de migración…";
    const result=await api("/api/migrations/enqueue",{method:"POST",body:JSON.stringify({mode:"drive",files:[...selected.values()].map(f=>({fileId:f.fileId,name:f.name,mimeType:f.mimeType,sizeBytes:f.sizeBytes,service:"drive"}))})});
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
    if(data.job.status==="verified"){byId("confirmDeleteButton").disabled=false;byId("deleteHint").textContent="Copia verificada. Revisa la Cuenta 2 antes de confirmar el borrado."}
    if(["verified","deleted","failed","cancelled"].includes(data.job.status))return;
  }catch(e){byId("remainingText").textContent="No se pudo actualizar el progreso: "+e.message}
  pollHandle=setTimeout(pollProgress,3000);
}
byId("confirmDeleteButton").addEventListener("click",async()=>{
  if(!session||!currentJobId)return;
  const warning="Entra a tu cuenta de Google número 2 y revisa en Fotos y Drive que todos tus archivos estén completos para tu mayor seguridad. Una vez que verifiques que todo está completo y sin errores, presiona aquí para eliminar los archivos copiados de la cuenta 1";
  if(!window.confirm(warning))return;
  const typed=window.prompt('Para confirmar, escribe exactamente: ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1');
  if(typed!=="ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1")return;
  try{
    byId("confirmDeleteButton").disabled=true;
    const result=await api("/api/migrations/confirm-delete",{method:"POST",body:JSON.stringify({jobId:currentJobId,confirmationText:typed})});
    byId("deleteHint").textContent="Resultado del borrado: "+result.status+". Revisa los resultados individuales.";
  }catch(e){byId("deleteHint").textContent="El borrado no se completó: "+e.message;byId("confirmDeleteButton").disabled=false}
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
