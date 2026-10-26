import {apiError,decryptSecret,env,googleApi,json,method,redisSet,sb} from "../_lib/runtime.js";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function retry(fn) {
  let last;
  for(let attempt=0;attempt<=5;attempt++) {
    try { return await fn(); } catch(e) {
      last=e;
      if(attempt===5 || !([429,500,502,503,504].includes(e.status)||e.name==="TypeError")) throw e;
      const delay=Math.min(30000,1000*(2**attempt))+Math.floor(Math.random()*300);
      await sleep(delay);
    }
  }
  throw last;
}
async function accessToken(role,userId) {
  const rows=await sb("dexter_google_connections?select=id&user_id=eq."+encodeURIComponent(userId)+"&role=eq."+role+"&revoked_at=is.null");
  if(!rows?.[0]) throw new Error("google_connection_missing:"+role);
  const secrets=await sb("dexter_google_oauth_secrets?select=encrypted_refresh_token&connection_id=eq."+rows[0].id);
  if(!secrets?.[0]) throw new Error("refresh_token_missing");
  const refreshToken=decryptSecret(secrets[0].encrypted_refresh_token);
  const tokenRes=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env("GOOGLE_CLIENT_ID"),client_secret:env("GOOGLE_CLIENT_SECRET"),refresh_token:refreshToken,grant_type:"refresh_token"})});
  const data=await tokenRes.json();
  if(!tokenRes.ok||!data.access_token) throw Object.assign(new Error("google_refresh_failed"),{status:tokenRes.status});
  return data.access_token;
}
export default async function handler(req,res) {
 if(!method(req,res,["POST"]))return;
 try{
  const secret=req.headers["x-worker-secret"]||req.headers.authorization?.replace(/^Bearer /,"");
  if(!secret||secret!==env("WORKER_SHARED_SECRET"))return json(res,401,{error:"unauthorized_worker"});
  const {jobId,userId}=req.body||{};
  if(!jobId||!userId)return json(res,400,{error:"jobId_and_userId_required"});
  const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status,total_bytes,processed_bytes& id=eq."+encodeURIComponent(jobId));
  const job=jobs?.[0];
  if(!job||job.user_id!==userId)return json(res,404,{error:"job_not_found"});
  const files=await sb("dexter_google_migration_files?select=id,source_file_id,destination_file_id,file_name,mime_type,size_bytes,source_md5,status&job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&status=in.(queued,failed,copying,verifying)");
  const sourceToken=await accessToken("source",userId);
  const targetToken=await accessToken("destination",userId);
  const start=Date.now();let processed=Number(job.processed_bytes)||0;const total=Math.max(1,Number(job.total_bytes)||files.reduce((n,f)=>n+Number(f.size_bytes||0),0));
  await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"copying",updated_at:new Date().toISOString()})});
  for(const f of files){
    const logs=await sb("dexter_google_transfer_logs?select=id,status&job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id));
    if(logs?.some(l=>["verified","copied"].includes(l.status)))continue;
    await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"copying",attempts:1,updated_at:new Date().toISOString()})});
    try{
      const metadata=await retry(()=>googleApi("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(f.source_file_id)+"?fields=id,name,mimeType,size,md5Checksum,sha256Checksum,webViewLink&supportsAllDrives=true",sourceToken));
      // Server-side copy is only supported within the same Drive. Cross-account copies
      // require downloading bytes and resumable upload; don't fake a cross-account copy.
      const download=await retry(()=>fetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(f.source_file_id)+"?alt=media", {headers:{Authorization:"Bearer "+sourceToken}}));
      if(!download.ok)throw Object.assign(new Error("source_download_failed"),{status:download.status});
      const bytes=Buffer.from(await download.arrayBuffer());
      if(metadata.size && bytes.length!==Number(metadata.size))throw new Error("source_size_mismatch");
      const created=await retry(async()=>{
        const boundary="dexter_"+cryptoRandom();
        const meta={name:metadata.name||f.file_name,mimeType:metadata.mimeType||f.mime_type||"application/octet-stream"};
        const body=Buffer.concat([Buffer.from("--"+boundary+"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n"+JSON.stringify(meta)+"\r\n--"+boundary+"\r\nContent-Type: "+meta.mimeType+"\r\n\r\n"),bytes,Buffer.from("\r\n--"+boundary+"--")]);
        const r=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,md5Checksum,sha256Checksum",{method:"POST",headers:{Authorization:"Bearer "+targetToken,"Content-Type":"multipart/related; boundary="+boundary},body});
        if(!r.ok)throw Object.assign(new Error("destination_upload_failed"),{status:r.status});
        return r.json();
      });
      await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({destination_file_id:created.id,status:"verifying",destination_md5:created.md5Checksum||null,updated_at:new Date().toISOString()})});
      const dest=await retry(()=>googleApi("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(created.id)+"?fields=id,name,mimeType,size,md5Checksum,sha256Checksum",targetToken));
      const sizeOk=Number(dest.size)===bytes.length;
      const checksumOk=metadata.md5Checksum ? metadata.md5Checksum===dest.md5Checksum : false;
      if(!sizeOk||!checksumOk)throw new Error("integrity_verification_failed");
      const now=new Date().toISOString();
      await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",verified_at:now,destination_file_id:dest.id,destination_md5:dest.md5Checksum,updated_at:now})});
      await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",destination_file_id:dest.id,source_size_bytes:bytes.length,destination_size_bytes:Number(dest.size),source_checksum:metadata.md5Checksum||null,destination_checksum:dest.md5Checksum||null,copied_at:now,verified_at:now,updated_at:now})});
      processed+=bytes.length;
      const elapsed=(Date.now()-start)/1000;const remaining=processed?Math.max(0,Math.ceil(elapsed*(total-processed)/processed)):null;
      await redisSet("migration:progress:"+jobId,{jobId,percent:Math.min(100,Math.floor(processed/total*100)),remainingSeconds:remaining,processedBytes:processed,totalBytes:total,status:"copying"},86400);
    }catch(e){
      await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_code:String(e.status||"transfer_error"),error_message:String(e.message||"").slice(0,300),updated_at:new Date().toISOString()})});
      await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_message:String(e.message||"").slice(0,300),updated_at:new Date().toISOString()})});
    }
  }
  const remaining=await sb("dexter_google_migration_files?select=status&job_id=eq."+encodeURIComponent(jobId)+"&status=not.in.(verified,deleted)");
  const complete=!remaining?.length;
  await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:complete?"verified":"failed",processed_bytes:processed,verified_bytes:processed,updated_at:new Date().toISOString()})});
  await redisSet("migration:progress:"+jobId,{jobId,percent:complete?100:Math.min(99,Math.floor(processed/total*100)),remainingSeconds:0,processedBytes:processed,totalBytes:total,status:complete?"verified":"failed",deleteRequiresConfirmation:true},86400);
  return json(res,200,{jobId,status:complete?"verified":"failed",processedBytes:processed,deleteRequiresConfirmation:true});
 }catch(e){return apiError(res,e);}
}
function cryptoRandom(){return Math.random().toString(16).slice(2)+Date.now().toString(16)}
