import {apiError,json,method,redis,requireUser,sb} from "../_lib/runtime.js";
export default async function handler(req,res){
 if(!method(req,res,["GET"]))return;
 try{
  const user=await requireUser(req);const jobId=String(req.query?.jobId||"");
  if(!jobId)return json(res,400,{error:"jobId_required"});
  const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status,total_bytes,processed_bytes,verified_bytes,updated_at&id=eq."+encodeURIComponent(jobId));
  if(!jobs?.[0]||jobs[0].user_id!==user.id)return json(res,404,{error:"job_not_found"});
  const raw=await redis(["GET","migration:progress:"+jobId]);
  let progress=raw;if(typeof raw==="string"){try{progress=JSON.parse(raw)}catch{progress=null}}
  const verifiedFiles=jobs[0].status==="verified"?await sb("dexter_google_migration_files?select=id,source_file_id,file_name,mime_type,size_bytes,source_service,status,verified_at&job_id=eq."+encodeURIComponent(jobId)+"&user_id=eq."+encodeURIComponent(user.id)+"&source_service=eq.photos&status=eq.verified&order=file_name.asc"):[];
  return json(res,200,{job:jobs[0],progress,verifiedFiles:verifiedFiles||[]});
 }catch(e){return apiError(res,e);}
}
