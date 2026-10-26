import {decryptSecret,env,sb} from "./runtime.js";
export async function getAccessToken(role,userId){
 const rows=await sb("dexter_google_connections?select=id&user_id=eq."+encodeURIComponent(userId)+"&role=eq."+role+"&revoked_at=is.null");
 if(!rows?.[0])throw new Error("google_connection_missing");
 const secrets=await sb("dexter_google_oauth_secrets?select=encrypted_refresh_token&connection_id=eq."+rows[0].id);
 if(!secrets?.[0])throw new Error("refresh_token_missing");
 const refresh=decryptSecret(secrets[0].encrypted_refresh_token);
 const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env("GOOGLE_CLIENT_ID"),client_secret:env("GOOGLE_CLIENT_SECRET"),refresh_token:refresh,grant_type:"refresh_token"})});
 const data=await r.json();if(!r.ok||!data.access_token)throw new Error("google_refresh_failed");return data.access_token;
}
export async function deleteDriveFile(fileId,token){
 const r=await fetch("https://www.googleapis.com/drive/v3/files/"+encodeURIComponent(fileId),{method:"DELETE",headers:{Authorization:"Bearer "+token}});
 if(!r.ok && r.status!==404){const text=await r.text();throw new Error("google_drive_delete_failed:"+r.status+":"+text.slice(0,160));}
}
