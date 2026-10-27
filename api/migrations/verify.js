import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
// Fail closed: metadata equality cannot establish complete or byte-identical Photos copies.
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const user=await requireUser(req);const jobId=String(req.body?.jobId||"");
  if(!jobId)return json(res,400,{error:"jobId_required"});
  const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,mode&id=eq."+encodeURIComponent(jobId));
  const job=jobs?.[0];if(!job||job.user_id!==user.id)return json(res,404,{error:"job_not_found"});
  if(job.mode!=="photos_videos")return json(res,409,{error:"unsupported_verification_mode"});
  await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId)+"&user_id=eq."+encodeURIComponent(user.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"manual_verification_required",verified_bytes:0,error_message:"Name, size and capture date cannot prove content identity; full cross-account Photos inventory is not available.",updated_at:new Date().toISOString()})});
  return json(res,200,{jobId,status:"MANUAL_VERIFICATION_REQUIRED",verified:false,safeToDelete:false,checks:{name:false,sizeBytes:false,captureDate:false},reason:"Google Photos does not expose a supported API for comparing complete Partner Sharing libraries account-to-account."});
 }catch(e){return apiError(res,e);}
}
