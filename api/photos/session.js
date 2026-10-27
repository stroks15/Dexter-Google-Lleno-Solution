import {apiError,json,method,requireUser,redis,redisSet,sb} from "../_lib/runtime.js";
import {getAccessToken} from "../_lib/drive.js";

export default async function handler(req,res){
 if(!method(req,res,["POST","GET"]))return;
 try{
  const user=await requireUser(req);
  const connections=await sb("dexter_google_connections?select=role,scopes&user_id=eq."+encodeURIComponent(user.id)+"&revoked_at=is.null");
  const source=connections.find(c=>c.role==="source");
  if(!source)return json(res,409,{error:"connect_source_account_first"});
  if(!(source.scopes||[]).includes("https://www.googleapis.com/auth/photospicker.mediaitems.readonly"))
   return json(res,409,{error:"reconnect_source_with_photos_picker_scope"});
  const token=await getAccessToken("source",user.id);
  if(req.method==="POST"){
   const r=await fetch("https://photospicker.googleapis.com/v1/sessions",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:"{}"});
   const data=await r.json().catch(()=>({}));
   if(!r.ok)return json(res,r.status===429?429:502,{error:"photos_picker_session_create_failed",detail:data.error?.message||"Google Photos Picker API error"});
   if(!data.id||!data.pickerUri)return json(res,502,{error:"photos_picker_session_response_incomplete"});
   await redisSet("dexter:photos:session:"+data.id,{userId:user.id,createdAt:Date.now()},3600);
   return json(res,201,{sessionId:data.id,pickerUri:data.pickerUri,expireTime:data.expireTime||null});
  }
  const sessionId=String(req.query?.sessionId||"");
  if(!sessionId||sessionId.length>256)return json(res,400,{error:"sessionId_required"});
  const raw=await redis(["GET","dexter:photos:session:"+sessionId]);
  const record=typeof raw==="string"?JSON.parse(raw):raw;
  if(!record||record.userId!==user.id)return json(res,404,{error:"photos_picker_session_not_found"});
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
 }catch(e){return apiError(res,e);}
}
