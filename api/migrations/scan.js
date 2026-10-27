import {apiError,json,method,requireUser,redis,redisSet,sb} from "../_lib/runtime.js";
import {getAccessToken} from "../_lib/drive.js";
export default async function handler(req,res){
 if(!method(req,res,["GET","POST"]))return;
 try{
  const user=await requireUser(req);
  if(req.method==="POST"&&req.body?.service==="photos"){
   const connections=await sb("dexter_google_connections?select=role,scopes&user_id=eq."+encodeURIComponent(user.id)+"&revoked_at=is.null");
   const source=connections.find(c=>c.role==="source");
   if(!source)return json(res,409,{error:"connect_source_account_first"});
   if(!(source.scopes||[]).includes("https://www.googleapis.com/auth/photospicker.mediaitems.readonly"))return json(res,409,{error:"reconnect_source_with_photos_picker_scope"});
   const token=await getAccessToken("source",user.id);
   const r=await fetch("https://photospicker.googleapis.com/v1/sessions",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:"{}"});
   const data=await r.json().catch(()=>({}));
   if(!r.ok)return json(res,r.status===429?429:502,{error:"photos_picker_session_create_failed",detail:data.error?.message||"Google Photos Picker API error"});
   if(!data.id||!data.pickerUri)return json(res,502,{error:"photos_picker_session_response_incomplete"});
   await redisSet("dexter:photos:session:"+data.id,{userId:user.id,createdAt:Date.now()},3600);
   return json(res,201,{sessionId:data.id,pickerUri:data.pickerUri,expireTime:data.expireTime||null});
  }
  if(req.method==="GET"&&req.query?.service==="photos"){
   const sessionId=String(req.query?.sessionId||"");
   if(!sessionId||sessionId.length>256)return json(res,400,{error:"sessionId_required"});
   const raw=await redis(["GET","dexter:photos:session:"+sessionId]);
   const record=typeof raw==="string"?JSON.parse(raw):raw;
   if(!record||record.userId!==user.id)return json(res,404,{error:"photos_picker_session_not_found"});
   const token=await getAccessToken("source",user.id);
   const r=await fetch("https://photospicker.googleapis.com/v1/sessions/"+encodeURIComponent(sessionId),{headers:{Authorization:"Bearer "+token}});
   const data=await r.json().catch(()=>({}));
   if(!r.ok)return json(res,r.status===429?429:502,{error:"photos_picker_session_status_failed",detail:data.error?.message||"Google Photos Picker API error"});
   if(!data.mediaItemsSet)return json(res,200,{ready:false,sessionId,expireTime:data.expireTime||null});
   const params=new URLSearchParams({sessionId,pageSize:"100"});
   if(req.query?.pageToken)params.set("pageToken",String(req.query.pageToken));
   const itemsResponse=await fetch("https://photospicker.googleapis.com/v1/mediaItems?"+params,{headers:{Authorization:"Bearer "+token}});
   const items=await itemsResponse.json().catch(()=>({}));
   if(!itemsResponse.ok)return json(res,itemsResponse.status===429?429:502,{error:"photos_picker_items_failed",detail:items.error?.message||"Could not list selected media"});
   return json(res,200,{ready:true,sessionId,items:(items.mediaItems||[]).map(x=>({fileId:x.id,name:x.mediaFile?.filename||"Google Photos media",mimeType:x.mediaFile?.mimeType||"application/octet-stream",sizeBytes:0,service:"photos"})),nextPageToken:items.nextPageToken||null});
  }
  if(req.method!=="GET")return json(res,400,{error:"unsupported_scan_action"});
  const connections=await sb("dexter_google_connections?select=role&user_id=eq."+encodeURIComponent(user.id)+"&revoked_at=is.null");
  if(!connections.some(x=>x.role==="source"))return json(res,409,{error:"connect_source_account_first"});
  const token=await getAccessToken("source",user.id);
  const pageToken=String(req.query?.pageToken||"");
  const params=new URLSearchParams({pageSize:"1000",orderBy:"quotaBytesUsed desc",q:"trashed = false",fields:"nextPageToken,files(id,name,mimeType,size,md5Checksum,sha256Checksum,modifiedTime,webViewLink,quotaBytesUsed)"});
  if(pageToken)params.set("pageToken",pageToken);
  const response=await fetch("https://www.googleapis.com/drive/v3/files?"+params.toString(),{headers:{Authorization:"Bearer "+token}});
  const data=await response.json();
  if(!response.ok)return json(res,response.status===429?429:502,{error:"google_drive_scan_failed",detail:data.error?.message||"API error"});
  const files=(data.files||[]).map(f=>({fileId:f.id,name:f.name,mimeType:f.mimeType,sizeBytes:Number(f.size||f.quotaBytesUsed||0),md5Checksum:f.md5Checksum||null,modifiedTime:f.modifiedTime||null,webViewLink:f.webViewLink||null,service:"drive"}));
  return json(res,200,{files,nextPageToken:data.nextPageToken||null,accountRole:"source",count:files.length});
 }catch(e){return apiError(res,e);}
}
