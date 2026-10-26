import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
import {getAccessToken,deleteDriveFile} from "../_lib/drive.js";
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const user=await requireUser(req);
  const {jobId,confirmationText}=req.body||{};
  const expected="ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1";
  if(confirmationText!==expected)return json(res,400,{error:"explicit_confirmation_text_required",requiredText:expected});
  if(!jobId)return json(res,400,{error:"jobId_required"});
  const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status,delete_confirmation_at&id=eq."+encodeURIComponent(jobId));
  const job=jobs?.[0];
  if(!job||job.user_id!==user.id)return json(res,404,{error:"job_not_found"});
  if(job.status!=="verified"&&!job.delete_confirmation_at)return json(res,409,{error:"job_must_be_fully_verified_first"});
  const files=await sb("dexter_google_migration_files?select=id,source_file_id,status,source_service&job_id=eq."+encodeURIComponent(jobId)+"&user_id=eq."+encodeURIComponent(user.id)+"&status=eq.verified");
  if(!files.length)return json(res,409,{error:"no_verified_source_files_to_delete"});
  await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({delete_confirmation_at:new Date().toISOString(),status:"delete_pending",updated_at:new Date().toISOString()})});
  const token=await getAccessToken("source",user.id);
  const results=[];
  for(const file of files){
    if(file.source_service!=="drive"){results.push({fileId:file.source_file_id,status:"unsupported"});continue;}
    try{
      await deleteDriveFile(file.source_file_id,token);
      const now=new Date().toISOString();
      await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(file.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"deleted",deleted_at:now,updated_at:now})});
      await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.drive&file_id=eq."+encodeURIComponent(file.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"deleted",delete_confirmed_at:now,deleted_at:now,updated_at:now})});
      results.push({fileId:file.source_file_id,status:"deleted"});
    }catch(e){results.push({fileId:file.source_file_id,status:"failed",error:String(e.message||"delete_failed")});}
  }
  const failed=results.some(x=>x.status!=="deleted");
  await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:failed?"failed":"deleted",updated_at:new Date().toISOString()})});
  return json(res,200,{jobId,status:failed?"partial":"deleted",results,warning:"Deleted Drive items may remain in Google Drive trash until permanently removed there."});
 }catch(e){return apiError(res,e);}
}
