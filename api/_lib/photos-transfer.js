import {env,redis,sb,redisSet} from "./runtime.js";
import {getAccessToken} from "./drive.js";

const MAX_BYTES=50*1024*1024;
async function googleError(r){return (await r.text()).slice(0,300)}
async function readLimited(response,max){
 const reader=response.body?.getReader();if(!reader)throw new Error("photos_download_body_missing");
 const chunks=[];let total=0;
 try{
  while(true){
   const {done,value}=await reader.read();if(done)break;
   total+=value.byteLength;
   if(total>max){await reader.cancel();throw new Error("photos_item_exceeds_50mb_function_limit");}
   chunks.push(Buffer.from(value));
  }
 }finally{try{reader.releaseLock()}catch{}}
 return Buffer.concat(chunks,total);
}
export async function transferPhotosJob({jobId,userId}){
 const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status,total_bytes,processed_bytes,mode&id=eq."+encodeURIComponent(jobId));
 const job=jobs?.[0];
 if(!job||job.user_id!==userId)return {statusCode:404,body:{error:"job_not_found"}};
 if(job.mode!=="photos_videos")return {statusCode:409,body:{error:"photos_worker_requires_photos_videos_mode"}};
 const sessionRaw=await redis(["GET","migration:photos-session:"+jobId]);
 if(!sessionRaw)return {statusCode:409,body:{error:"photos_picker_session_expired_reselect_media"}};
 const sessionRecord=typeof sessionRaw==="string"?JSON.parse(sessionRaw):sessionRaw;
 if(sessionRecord.userId!==userId)return {statusCode:403,body:{error:"photos_session_owner_mismatch"}};
 const sourceToken=await getAccessToken("source",userId),targetToken=await getAccessToken("destination",userId);
 const files=await sb("dexter_google_migration_files?select=id,source_file_id,destination_file_id,file_name,mime_type,size_bytes,status&job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.photos&status=in.(queued,failed)");
 const selected=new Map();let pageToken=null;
 do{
  const params=new URLSearchParams({sessionId:sessionRecord.sessionId,pageSize:"100"});
  if(pageToken)params.set("pageToken",pageToken);
  const r=await fetch("https://photospicker.googleapis.com/v1/mediaItems?"+params,{headers:{Authorization:"Bearer "+sourceToken}});
  const data=await r.json().catch(()=>({}));
  if(!r.ok)throw Object.assign(new Error("photos_picker_list_failed:"+(data.error?.message||r.status)),{status:r.status});
  for(const item of data.mediaItems||[])selected.set(item.id,item);
  pageToken=data.nextPageToken||null;
 }while(pageToken);
 await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"copying",updated_at:new Date().toISOString()})});
 let processed=Number(job.processed_bytes)||0,total=0,failed=0;
 for(const f of files){
  try{
   const item=selected.get(f.source_file_id),mf=item?.mediaFile;
   if(!mf?.baseUrl||!mf?.mimeType)throw new Error("selected_photo_not_found_or_url_expired");
   const download=await fetch(mf.baseUrl+(item.type==="VIDEO"?"=dv":"=d"),{headers:{Authorization:"Bearer "+sourceToken}});
   if(!download.ok)throw Object.assign(new Error("photos_media_download_failed:"+download.status),{status:download.status});
   const declared=Number(download.headers.get("content-length")||0);
   if(declared>MAX_BYTES)throw new Error("photos_item_exceeds_50mb_function_limit");
   const bytes=await readLimited(download,MAX_BYTES);
   if(!bytes.length)throw new Error("photos_media_empty");
   const upload=await fetch("https://photoslibrary.googleapis.com/v1/uploads",{method:"POST",headers:{Authorization:"Bearer "+targetToken,"Content-Type":"application/octet-stream","X-Goog-Upload-Content-Type":mf.mimeType,"X-Goog-Upload-Protocol":"raw","X-Goog-Upload-File-Name":String(mf.filename||f.file_name||"photo").replaceAll(String.fromCharCode(13),"_").replaceAll(String.fromCharCode(10),"_")},body:bytes});
   if(!upload.ok)throw Object.assign(new Error("photos_upload_bytes_failed:"+upload.status+":"+await googleError(upload)),{status:upload.status});
   const uploadToken=(await upload.text()).trim();
   if(!uploadToken)throw new Error("photos_upload_token_missing");
   const create=await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",{method:"POST",headers:{Authorization:"Bearer "+targetToken,"Content-Type":"application/json"},body:JSON.stringify({newMediaItems:[{simpleMediaItem:{uploadToken,fileName:String(mf.filename||f.file_name||"photo").slice(0,255)}}]})});
   const created=await create.json().catch(()=>({}));
   const result=created.newMediaItemResults?.[0];
   if(!create.ok||!result?.mediaItem?.id)throw Object.assign(new Error("photos_media_create_failed:"+(result?.status?.message||created.error?.message||create.status)),{status:create.status});
   const now=new Date().toISOString();
   await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({destination_file_id:result.mediaItem.id,size_bytes:bytes.length,status:"verified",verified_at:now,updated_at:now})});
   await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.photos&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",destination_file_id:result.mediaItem.id,source_size_bytes:bytes.length,destination_size_bytes:bytes.length,verified_at:now,updated_at:now})});
   processed+=bytes.length;total+=bytes.length;
  }catch(e){
   failed++;
   await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_message:String(e.message||"photos_transfer_failed").slice(0,300),updated_at:new Date().toISOString()})});
   await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.photos&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"failed",error_message:String(e.message||"photos_transfer_failed").slice(0,300),updated_at:new Date().toISOString()})});
  }
 }
 const pending=await sb("dexter_google_migration_files?select=status&job_id=eq."+encodeURIComponent(jobId)+"&status=not.in.(verified,deleted)");
 const complete=!pending?.length&&!failed;
 const now=new Date().toISOString();
 await sb("dexter_google_migration_jobs?id=eq."+encodeURIComponent(jobId),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:complete?"verified":"failed",processed_bytes:processed,verified_bytes:processed,total_bytes:total,updated_at:now})});
 await redisSet("migration:progress:"+jobId,{jobId,percent:complete?100:0,remainingSeconds:0,processedBytes:processed,totalBytes:total,status:complete?"verified":"failed"},86400);
 return {statusCode:200,body:{jobId,status:complete?"verified":"failed",processedBytes:processed,deleteRequiresConfirmation:false,photosOriginalsRemain:true}};
}
