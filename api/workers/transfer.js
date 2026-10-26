import crypto from "node:crypto";
import {apiError,env,json,method,redisSet,sb} from "../_lib/runtime.js";

const CHUNK = 8 * 1024 * 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));
async function retry(fn) {
  let last;
  for (let attempt=0; attempt<=5; attempt++) {
    try { return await fn(); }
    catch (e) {
      last=e;
      if (attempt===5 || !([429,500,502,503,504].includes(e.status) || e.name==="TypeError")) throw e;
      await sleep(Math.min(30000,1000*(2**attempt))+Math.floor(Math.random()*250));
    }
  }
  throw last;
}
async function tokenFor(role,userId) {
  const rows=await sb("dexter_google_connections?select=id&user_id=eq."+encodeURIComponent(userId)+"&role=eq."+role+"&revoked_at=is.null");
  if(!rows?.[0]) throw new Error("google_connection_missing:"+role);
  const secrets=await sb("dexter_google_oauth_secrets?select=encrypted_refresh_token&connection_id=eq."+rows[0].id);
  if(!secrets?.[0]) throw new Error("refresh_token_missing");
  const [version,iv,tag,ciphertext]=secrets[0].encrypted_refresh_token.split(".");
  if(version!=="v1") throw new Error("invalid_encrypted_token");
  const key=Buffer.from(env("OAUTH_TOKEN_ENCRYPTION_KEY"),"base64");
  if(key.length!==32) throw new Error("invalid_encryption_key");
  const decipher=crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  const refresh=Buffer.concat([decipher.update(Buffer.from(ciphertext,"base64url")),decipher.final()]).toString();
  const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env("GOOGLE_CLIENT_ID"),client_secret:env("GOOGLE_CLIENT_SECRET"),refresh_token:refresh,grant_type:"refresh_token"})});
  const data=await r.json();
  if(!r.ok||!data.access_token) throw Object.assign(new Error("google_refresh_failed"),{status:r.status});
  return data.access_token;
}
async function googleJson(url,token,init={}) {
  const r=await fetch(url,{...init,headers:{Authorization:"Bearer "+token,...(init.headers||{})}});
  if(!r.ok){const t=await r.text();throw Object.assign(new Error("google_api_error:"+t.slice(0,200)),{status:r.status});}
  if(r.status===204)return null;
  return r.json();
}
async function sourceChunk(fileId,token,start,end,total) {
  const headers={Authorization:"Bearer "+token};
  if(total>0)headers.Range="bytes="+start+"-"+end;
  const r=await fetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId)+"?alt=media",{headers});
  if(!r.ok){const t=await r.text();throw Object.assign(new Error("source_download_failed:"+t.slice(0,150)),{status:r.status});}
  const bytes=Buffer.from(await r.arrayBuffer());
  if(total>0 && bytes.length!==end-start+1)throw new Error("source_chunk_size_mismatch");
  return bytes;
}
async function findExistingCopy(sourceId,token) {
  const q="appProperties has { key='dexterSourceId' and value='"+sourceId+"' } and trashed = false";
  const params=new URLSearchParams({q,spaces:"drive",pageSize:"1",fields:"files(id,name,mimeType,size,md5Checksum,sha256Checksum,appProperties)"});
  return googleJson("https://www.googleapis.com/drive/v3/files?"+params.toString(),token);
}
async function startUpload(metadata,token,sourceId) {
  const r=await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,sha256Checksum",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json","X-Upload-Content-Type":metadata.mimeType||"application/octet-stream"},body:JSON.stringify({name:metadata.name,mimeType:metadata.mimeType||"application/octet-stream",appProperties:{dexterSourceId:sourceId}})});
  if(!r.ok){const t=await r.text();throw Object.assign(new Error("resumable_upload_init_failed:"+t.slice(0,150)),{status:r.status});}
  const location=r.headers.get("location");
  if(!location)throw new Error("google_resumable_upload_location_missing");
  return location;
}
async function putChunk(session,token,bytes,start,total) {
  const end=start+bytes.length-1;
  const contentRange=total===0?"bytes */0":"bytes "+start+"-"+end+"/"+total;
  const r=await fetch(session,{method:"PUT",headers:{Authorization:"Bearer "+token,"Content-Length":String(bytes.length),"Content-Range":contentRange},body:bytes});
  if(r.status===308)return {complete:false};
  if(!r.ok){const t=await r.text();throw Object.assign(new Error("destination_chunk_upload_failed:"+t.slice(0,150)),{status:r.status});}
  return {complete:true,data:await r.json()};
}
async function setProgress(jobId,processed,total,start,status) {
  const elapsed=Math.max(.1,(Date.now()-start)/1000);
  await redisSet("migration:progress:"+jobId,{jobId,percent:total?Math.min(100,Math.floor(processed/total*100)):100,remainingSeconds:processed?Math.max(0,Math.ceil(elapsed*Math.max(0,total-processed)/processed)):null,processedBytes:processed,totalBytes:total,status},86400);
}
export default async function handler(req,res) {
  if(!method(req,res,["POST"]))return;
  try {
    const supplied=req.headers["x-worker-secret"]||req.headers.authorization?.replace(/^Bearer /,"");
    if(!supplied||supplied!==env("WORKER_SHARED_SECRET"))return json(res,401,{error:"unauthorized_worker"});
    const {jobId,userId}=req.body||{};
    if(!jobId||!userId)return json(res,400,{error:"jobId_and_userId_required"});
    const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status,total_bytes,processed_bytes&id=eq."+encodeURIComponent(jobId));
    const job=jobs?.[0];
    if(!job||job.user_id!==userId)return json(res,404,{error:"job_not_found"});
    const files=await sb("dexter_google_migration_files?select=id,source_file_id,destination_file_id,file_name,mime_type,size_bytes,status&job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&status=in.(queued,failed,copying,verifying)");
    const sourceToken=await tokenFor("source",userId),targetToken=await tokenFor("destination",userId);
    const start=Date.now();
    let processed=Number(job.processed_bytes)||0;
    const total=Math.max(0,Number(job.total_bytes)||files.reduce((n,f)=>n+Number(f.size_bytes||0),0));
    await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"copying",updated_at:new Date().toISOString()})});
    for(const f of files) {
      const logs=await sb("dexter_google_transfer_logs?select=id,status&job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id));
      if(logs?.some(x=>["copied","verified"].includes(x.status)))continue;
      try {
        await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"copying",attempts:1,updated_at:new Date().toISOString()})});
        const meta=await retry(()=>googleJson("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(f.source_file_id)+"?fields=id,name,mimeType,size,md5Checksum,sha256Checksum",sourceToken));
        if(meta.size===undefined)throw new Error("native_google_workspace_export_not_supported_yet");
        const size=Number(meta.size);
        const existing=await retry(()=>findExistingCopy(f.source_file_id,targetToken));
        if(existing.files?.length){
          const dest=existing.files[0];
          const verified=Number(dest.size)===Number(meta.size)&&Boolean(meta.md5Checksum&&dest.md5Checksum&&meta.md5Checksum.toLowerCase()===dest.md5Checksum.toLowerCase());
          if(!verified)throw new Error("existing_destination_copy_failed_integrity_check");
          const now=new Date().toISOString();
          await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({destination_file_id:dest.id,status:"verified",destination_md5:dest.md5Checksum,verified_at:now,updated_at:now})});
          await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",destination_file_id:dest.id,source_size_bytes:Number(meta.size),destination_size_bytes:Number(dest.size),source_checksum:meta.md5Checksum,destination_checksum:dest.md5Checksum,verified_at:now,updated_at:now})});
          continue;
        }
        const session=await retry(()=>startUpload(meta,targetToken,f.source_file_id));
        const md5=crypto.createHash("md5");
        let offset=0;let finalData=null;
        if(size===0) {
          const empty=await retry(()=>putChunk(session,targetToken,Buffer.alloc(0),0,0));
          finalData=empty.data||null;
        }
        while(offset<size) {
          const end=Math.min(size-1,offset+CHUNK-1);
          const chunk=await retry(()=>sourceChunk(f.source_file_id,sourceToken,offset,end,size));
          md5.update(chunk);
          const uploaded=await retry(()=>putChunk(session,targetToken,chunk,offset,size));
          offset+=chunk.length;processed+=chunk.length;
          await setProgress(jobId,processed,total,start,"copying");
          if(uploaded.complete)finalData=uploaded.data;
        }
        const sourceMd5=md5.digest("hex");
        if(meta.md5Checksum && sourceMd5.toLowerCase()!==meta.md5Checksum.toLowerCase())throw new Error("source_md5_mismatch");
        const dest=await retry(()=>googleJson("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(finalData?.id||"") +"?fields=id,name,mimeType,size,md5Checksum,sha256Checksum",targetToken));
        const sizeOk=Number(dest.size)===size;
        const hashOk=Boolean(meta.md5Checksum && dest.md5Checksum && meta.md5Checksum.toLowerCase()===dest.md5Checksum.toLowerCase());
        if(!sizeOk||!hashOk)throw new Error("destination_integrity_verification_failed");
        const now=new Date().toISOString();
        await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({destination_file_id:dest.id,status:"verified",destination_md5:dest.md5Checksum,verified_at:now,updated_at:now})});
        await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",destination_file_id:dest.id,source_size_bytes:size,destination_size_bytes:Number(dest.size),source_checksum:meta.md5Checksum||sourceMd5,destination_checksum:dest.md5Checksum,copied_at:now,verified_at:now,updated_at:now})});
      } catch(e) {
        await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_code:String(e.status||"transfer_error"),error_message:String(e.message||"").slice(0,300),updated_at:new Date().toISOString()})});
        await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_message:String(e.message||"").slice(0,300),updated_at:new Date().toISOString()})});
      }
    }
    const pending=await sb("dexter_google_migration_files?select=status&job_id=eq."+encodeURIComponent(jobId)+"&status=not.in.(verified,deleted)");
    const complete=!pending?.length;
    const now=new Date().toISOString();
    await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:complete?"verified":"failed",processed_bytes:processed,verified_bytes:processed,updated_at:now})});
    await setProgress(jobId,processed,total,start,complete?"verified":"failed");
    return json(res,200,{jobId,status:complete?"verified":"failed",processedBytes:processed,deleteRequiresConfirmation:true});
  } catch(e) {return apiError(res,e);}
}
