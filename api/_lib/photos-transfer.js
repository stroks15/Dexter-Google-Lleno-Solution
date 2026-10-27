import {env,redis,sb,redisSet} from "./runtime.js";
import {getAccessToken} from "./drive.js";

const CHUNK_BYTES=8*1024*1024;
const MAX_PHOTOS_VIDEO_BYTES=20*1024*1024*1024;
async function googleError(r){return (await r.text()).slice(0,300)}
async function readChunk(response,maxBytes){
 const reader=response.body?.getReader();if(!reader)throw new Error("photos_download_body_missing");
 const chunks=[];let total=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>maxBytes){await reader.cancel();throw new Error("photos_source_range_exceeded_chunk_limit");}chunks.push(Buffer.from(value));}}
 finally{try{reader.releaseLock()}catch{}}
 return Buffer.concat(chunks,total);
}
async function sourceRange(baseUrl,sourceToken,start,end){
 const url=baseUrl+(baseUrl.endsWith("=dv")||baseUrl.endsWith("=d")?"":"=d");
 const r=await fetch(url,{headers:{Authorization:"Bearer "+sourceToken,Range:`bytes=${start}-${end}`}});
 if(r.status!==206){const body=(await r.text().catch(()=>"")).slice(0,180);throw Object.assign(new Error("photos_source_range_not_supported_or_expired:"+r.status+":"+body),{status:r.status});}
 const contentRange=r.headers.get("content-range")||"";
 const match=contentRange.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
 if(!match||Number(match[1])!==start)throw new Error("photos_source_content_range_invalid");
 const bytes=await readChunk(r,CHUNK_BYTES);
 if(bytes.length!==Number(match[2])-start+1)throw new Error("photos_source_chunk_size_mismatch");
 return {bytes,total:Number(match[3]),end:Number(match[2])};
}
async function beginPhotosUpload(token,mimeType,total){
 const r=await fetch("https://photoslibrary.googleapis.com/v1/uploads",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Length":"0","X-Goog-Upload-Command":"start","X-Goog-Upload-Content-Type":mimeType||"application/octet-stream","X-Goog-Upload-Protocol":"resumable","X-Goog-Upload-Raw-Size":String(total)}});
 if(!r.ok)throw Object.assign(new Error("photos_resumable_upload_start_failed:"+r.status+":"+await googleError(r)),{status:r.status});
 const url=r.headers.get("x-goog-upload-url");if(!url)throw new Error("photos_resumable_upload_url_missing");
 const granularity=Number(r.headers.get("x-goog-upload-chunk-granularity")||262144);
 return {url,granularity};
}
async function sendPhotosChunk(session,bytes,offset,last){
 const r=await fetch(session.url,{method:"POST",headers:{"Content-Length":String(bytes.length),"X-Goog-Upload-Command":last?"upload, finalize":"upload","X-Goog-Upload-Offset":String(offset)},body:bytes});
 if(!r.ok)throw Object.assign(new Error("photos_resumable_chunk_failed:"+r.status+":"+await googleError(r)),{status:r.status});
 const text=await r.text();
 if(last&&!text.trim())throw new Error("photos_resumable_upload_token_missing");
 return last?text.trim():null;
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
   const first=await sourceRange(mf.baseUrl+(item.type==="VIDEO"?"=dv":"=d"),sourceToken,0,0);
   const totalSize=first.total;
   if(!totalSize||totalSize>MAX_PHOTOS_VIDEO_BYTES)throw new Error("photos_item_size_outside_supported_range_max_20gb");
   const uploadSession=await beginPhotosUpload(targetToken,mf.mimeType,totalSize);
   let uploadToken=null,offset=0;
   while(offset<totalSize){
    const end=Math.min(totalSize-1,offset+CHUNK_BYTES-1);
    const part=await sourceRange(mf.baseUrl+(item.type==="VIDEO"?"=dv":"=d"),sourceToken,offset,end);
    if(part.total!==totalSize)throw new Error("photos_source_size_changed_during_transfer");
    const last=part.end===totalSize-1;
    if(!last&&part.bytes.length%uploadSession.granularity!==0)throw new Error("photos_chunk_not_aligned_to_google_granularity");
    uploadToken=await sendPhotosChunk(uploadSession,part.bytes,offset,last)||uploadToken;
    offset+=part.bytes.length;
    processed+=part.bytes.length;total+=part.bytes.length;
    await redisSet("migration:progress:"+jobId,{jobId,percent:Math.min(99,Math.floor(processed/Math.max(Number(job.total_bytes)||totalSize,1)*100)),remainingSeconds:null,processedBytes:processed,totalBytes:Math.max(Number(job.total_bytes)||totalSize,total),status:"copying"},86400);
   }
   if(!uploadToken)throw new Error("photos_upload_token_missing");
   const create=await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate",{method:"POST",headers:{Authorization:"Bearer "+targetToken,"Content-Type":"application/json"},body:JSON.stringify({newMediaItems:[{simpleMediaItem:{uploadToken,fileName:String(mf.filename||f.file_name||"photo").slice(0,255)}}]})});
   const created=await create.json().catch(()=>({}));
   const result=created.newMediaItemResults?.[0];
   if(!create.ok||!result?.mediaItem?.id)throw Object.assign(new Error("photos_media_create_failed:"+(result?.status?.message||created.error?.message||create.status)),{status:create.status});
   const now=new Date().toISOString();
   await sb("dexter_google_migration_files?id=eq."+encodeURIComponent(f.id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({destination_file_id:result.mediaItem.id,size_bytes:totalSize,status:"verified",verified_at:now,updated_at:now})});
   await sb("dexter_google_transfer_logs?job_id=eq."+encodeURIComponent(jobId)+"&source_service=eq.photos&file_id=eq."+encodeURIComponent(f.source_file_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"verified",destination_file_id:result.mediaItem.id,source_size_bytes:totalSize,destination_size_bytes:totalSize,verified_at:now,updated_at:now})});
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
