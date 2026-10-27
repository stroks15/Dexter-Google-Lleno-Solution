import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
import {getAccessToken} from "../_lib/drive.js";
// Metadata only. Google Photos requires user-configured Partner Sharing.
export default async function handler(req,res){
 if(!method(req,res,["GET"]))return;
 try{
  const user=await requireUser(req);
  if(req.query?.service==="photos")return json(res,409,{error:"photos_partner_sharing_required",status:"MANUAL_VERIFICATION_REQUIRED",message:"The public Google Photos API cannot enumerate and compare both complete libraries. Configure Partner Sharing in Google Photos."});
  const connections=await sb("dexter_google_connections?select=role&user_id=eq."+encodeURIComponent(user.id)+"&revoked_at=is.null");
  if(!connections.some(x=>x.role==="source"))return json(res,409,{error:"connect_source_account_first"});
  const token=await getAccessToken("source",user.id);
  const pageToken=String(req.query?.pageToken||"");
  const params=new URLSearchParams({pageSize:"1000",orderBy:"quotaBytesUsed desc",q:"trashed = false",fields:"nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime,createdTime,webViewLink,quotaBytesUsed)"});
  if(pageToken)params.set("pageToken",pageToken);
  const response=await fetch("https://www.googleapis.com/drive/v3/files?"+params.toString(),{headers:{Authorization:"Bearer "+token}});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return json(res,response.status===429?429:502,{error:"google_drive_metadata_scan_failed",detail:data.error?.message||"Google Drive API error"});
  const files=(data.files||[]).map(f=>({fileId:f.id,name:f.name,mimeType:f.mimeType,sizeBytes:Number(f.size||f.quotaBytesUsed||0),md5Checksum:f.md5Checksum||null,createdTime:f.createdTime||null,modifiedTime:f.modifiedTime||null,webViewLink:f.webViewLink||null,service:"drive"}));
  return json(res,200,{files,nextPageToken:data.nextPageToken||null,accountRole:"source",count:files.length,mode:"metadata_only"});
 }catch(e){return apiError(res,e);}
}
