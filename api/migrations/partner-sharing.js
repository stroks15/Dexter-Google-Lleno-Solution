import crypto from "node:crypto";
import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const user=await requireUser(req);const {action="start",jobId}=req.body||{};
  if(action==="start"){
   const id=crypto.randomUUID();
   await sb("dexter_google_migration_jobs",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify([{id,user_id:user.id,mode:"photos_videos",status:"awaiting_partner_sharing",total_bytes:0,processed_bytes:0,verified_bytes:0,error_message:"Partner Sharing is user-configured; no binary data is processed by this app."}])});
   return json(res,201,{jobId:id,status:"awaiting_partner_sharing",safeToDelete:false,verification:"not_performed"});
  }
  if(action==="review"&&typeof jobId==="string"&&jobId.length<=64){
   const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,mode&id=eq."+encodeURIComponent(jobId));
   const job=jobs?.[0];if(!job||job.user_id!==user.id)return json(res,404,{error:"job_not_found"});
   if(job.mode!=="photos_videos")return json(res,409,{error:"not_a_photos_partner_sharing_job"});
   await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId)+"&user_id=eq."+encodeURIComponent(user.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"manual_verification_required",error_message:"Manual review requested. No API-level completeness or byte identity verification is available; deletion is not authorized.",updated_at:new Date().toISOString()})});
   return json(res,200,{jobId,status:"manual_verification_required",verified:false,safeToDelete:false});
  }
  return json(res,400,{error:"unsupported_action"});
 }catch(e){return apiError(res,e);}
}
