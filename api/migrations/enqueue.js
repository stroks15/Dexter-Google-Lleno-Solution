import crypto from "node:crypto";
import {apiError,json,method,requireUser,redisSet,sb,env} from "../_lib/runtime.js";
export default async function handler(req,res) {
  if (!method(req,res,["POST"])) return;
  try {
    const user=await requireUser(req);
    const {mode="drive",files=[]}=req.body||{};
    if (!["drive","all","photos_videos","videos_only","largest"].includes(mode)) return json(res,400,{error:"invalid_mode"});
    if (!Array.isArray(files)||files.length<1||files.length>1000) return json(res,400,{error:"files_must_contain_1_to_1000_items"});
    const roles=await sb("dexter_google_connections?select=role&user_id=eq."+encodeURIComponent(user.id)+"&revoked_at=is.null");
    if (!roles.some(x=>x.role==="source")||!roles.some(x=>x.role==="destination")) return json(res,409,{error:"connect_both_google_accounts_first"});
    const jobId=crypto.randomUUID();
    const normalized=files.map(f=>{
      if (!f || typeof f.fileId!=="string" || !f.fileId || f.fileId.length>1024) throw Object.assign(new Error("invalid_file_id"),{status:400});
      if (f.service!=="drive") throw Object.assign(new Error("photos_transfer_not_enabled_until_photos_api_capabilities_are_verified"),{status:422});
      return {fileId:f.fileId,name:String(f.name||f.fileId).slice(0,500),mimeType:String(f.mimeType||"application/octet-stream").slice(0,200),sizeBytes:Math.max(0,Number(f.sizeBytes)||0)};
    });
    const job=await sb("dexter_google_migration_jobs",{
      method:"POST",headers:{"Prefer":"return=representation"},
      body:JSON.stringify([{id:jobId,user_id:user.id,mode,status:"queued",total_bytes:normalized.reduce((n,f)=>n+f.sizeBytes,0)}])
    });
    const rows=normalized.map(f=>({job_id:jobId,user_id:user.id,source_service:"drive",source_file_id:f.fileId,file_name:f.name,mime_type:f.mimeType,size_bytes:f.sizeBytes,status:"queued",selected_for_migration:true}));
    await sb("dexter_google_migration_files",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify(rows)});
    const logs=normalized.map(f=>({user_id:user.id,job_id:jobId,file_id:f.fileId,source_service:"drive",status:"queued",source_size_bytes:f.sizeBytes}));
    await sb("dexter_google_transfer_logs",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify(logs)});
    await redisSet("migration:progress:"+jobId,{jobId,percent:0,remainingSeconds:null,status:"queued",processedBytes:0,totalBytes:normalized.reduce((n,f)=>n+f.sizeBytes,0)},86400);
    const qstashToken=process.env.QSTASH_TOKEN;
    if (!qstashToken) return json(res,202,{jobId,status:"queued_database_only",note:"QSTASH_TOKEN is not configured; queue delivery is not active yet."});
    const base=env("APP_BASE_URL").replace(/\/$/,"");
    const publish=await fetch("https://qstash.upstash.io/v2/publish/"+encodeURIComponent(base+"/api/workers/transfer"),{
      method:"POST",headers:{Authorization:"Bearer "+qstashToken,"Content-Type":"application/json","Upstash-Forward-Authorization":"Bearer "+env("WORKER_SHARED_SECRET")},
      body:JSON.stringify({jobId,userId:user.id})
    });
    if(!publish.ok) throw new Error("qstash_publish_failed:"+publish.status);
    return json(res,202,{jobId,status:"queued"});
  } catch(e) { return apiError(res,e); }
}
