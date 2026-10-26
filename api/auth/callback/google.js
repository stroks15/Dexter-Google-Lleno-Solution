import {apiError,baseUrl,env,json,redis,sb,encryptSecret} from "../../_lib/runtime.js";

export default async function handler(req,res) {
  if (req.method !== "GET") { res.setHeader("Allow","GET"); return json(res,405,{error:"method_not_allowed"}); }
  try {
    if (req.query?.error) return json(res,400,{error:"google_oauth_denied",detail:String(req.query.error)});
    const code=String(req.query?.code||"");
    const state=String(req.query?.state||"");
    if (!code || !state || state.length>256) return json(res,400,{error:"missing_code_or_state"});
    const raw=await redis(["GET","dexter:oauth:state:"+state]);
    if (!raw) return json(res,400,{error:"oauth_state_expired_or_invalid"});
    await redis(["DEL","dexter:oauth:state:"+state]);
    const stateData=typeof raw==="string"?JSON.parse(raw):raw;
    // The one-time, high-entropy state was created only after validating the Supabase session.
    // Google redirects the browser without the original Authorization header, so bind to the
    // user recorded in that expiring state instead of expecting a bearer token on this callback.
    const userId=stateData.userId;
    if (!userId) return json(res,400,{error:"invalid_oauth_state"});
    const role=stateData.role;
    if (!["account_source","account_target","account_source_delete"].includes(role)) return json(res,400,{error:"invalid_oauth_role"});
    const tokenResponse=await fetch("https://oauth2.googleapis.com/token",{
      method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({code,client_id:env("GOOGLE_CLIENT_ID"),client_secret:env("GOOGLE_CLIENT_SECRET"),redirect_uri:baseUrl(req)+"/api/auth/callback/google",grant_type:"authorization_code"})
    });
    const tokenData=await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) return json(res,400,{error:"google_token_exchange_failed",detail:tokenData.error||"invalid_response"});
    const infoResponse=await fetch("https://openidconnect.googleapis.com/v1/userinfo",{headers:{Authorization:"Bearer "+tokenData.access_token}});
    const info=await infoResponse.json();
    if (!infoResponse.ok || !info.sub || !info.email) return json(res,400,{error:"google_userinfo_failed"});
    const scopes=String(tokenData.scope||"").split(" ").filter(Boolean);
    if (!tokenData.refresh_token) return json(res,409,{error:"refresh_token_missing_reconnect_with_consent"});
    const ciphertext=encryptSecret(tokenData.refresh_token);
    const roleMap={account_source:"source",account_target:"destination",account_source_delete:"source"};
    const connectionRows=await sb("dexter_google_connections?on_conflict=user_id,role",{
      method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=representation"},
      body:JSON.stringify([{user_id:userId,role:roleMap[role],google_subject:info.sub,email:info.email,scopes,revoked_at:null}])
    });
    const connection=connectionRows?.[0];
    if (!connection?.id) throw new Error("connection_upsert_failed");
    await sb("dexter_google_credentials?on_conflict=user_id,account_role",{
      method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify([{user_id:userId,account_role:role==="account_source_delete"?"account_source":role,google_subject:info.sub,email:info.email,scopes,encrypted_refresh_token:ciphertext,encryption_version:"aes-256-gcm-v1",revoked_at:null,updated_at:new Date().toISOString()}])
    });
    res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Cuenta conectada</title><p>Cuenta Google conectada de forma segura. Puedes cerrar esta ventana.</p><script>if(window.opener){window.opener.postMessage({type:'google-oauth-complete',role:"+JSON.stringify(role)+"},location.origin)}setTimeout(()=>window.close(),900)</script>");
  } catch(e) { return apiError(res,e); }
}
