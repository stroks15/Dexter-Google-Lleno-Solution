import {decryptSecret,env,sb} from "./runtime.js";
export async function getAccessToken(role,userId){
 const accountRole=role==="source"?"account_source":"account_target";
 const secrets=await sb("dexter_google_credentials?select=encrypted_refresh_token&user_id=eq."+encodeURIComponent(userId)+"&account_role=eq."+accountRole+"&revoked_at=is.null");
 if(!secrets?.[0])throw new Error("refresh_token_missing");
 const refresh=decryptSecret(secrets[0].encrypted_refresh_token);
 const r=await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:new URLSearchParams({client_id:env("GOOGLE_CLIENT_ID"),client_secret:env("GOOGLE_CLIENT_SECRET"),refresh_token:refresh,grant_type:"refresh_token"})});
 const data=await r.json();if(!r.ok||!data.access_token)throw new Error("google_refresh_failed");return data.access_token;
}
