import {apiError,baseUrl,env,json,redis,requireUser,sb,encryptSecret} from "../../_lib/runtime.js";

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
    // Bind callback to the same signed-in Supabase user. The browser must send the same
    // Supabase access token as Authorization header; no user ID is trusted from query params.
    const user=await requireUser(req);
    if (user.id!==stateData.userId) return json(res,403,{error:"oauth_state_user_mismatch"});
    const role=stateData.role;
    if (!["account_source","account_target"].includes(role)) return json(res,400,{error:"invalid_oauth_role"});
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
    // Google may omit refresh_token on repeat consent. Require a fresh offline consent rather
    // than replacing a working stored refresh token with an empty value.
    if (!tokenData.refresh_token) return json(res,409,{error:"refresh_token_missing_reconnect_with_consent"});
    const ciphertext=encryptSecret(tokenData.refresh_token);
    const roleMap={account_source:"source",account_target:"destination"};
    const connectionRows=await sb("dexter_google_connections?on_conflict=user_id,role",{
      method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=representation"},
      body:JSON.stringify([{user_id:user.id,role:roleMap[role],google_subject:info.sub,email:info.email,scopes,revoked_at:null}])
    });
    const connection=connectionRows?.[0];
    if (!connection?.id) throw new Error("connection_upsert_failed");
    await sb("dexter_google_oauth_secrets?on_conflict=connection_id",{
      method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},
      body:JSON.stringify([{connection_id:connection.id,encrypted_refresh_token:ciphertext,key_version:"aes-256-gcm-v1",updated_at:new Date().toISOString()}])
    });
    // Keep OAuth tokens off the URL. Return a tiny success page; frontend can poll its
    // authenticated connection-status endpoint after the popup closes.
    res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    return res.status(200).send("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Cuenta conectada</title><p>Cuenta Google conectada de forma segura. Puedes cerrar esta ventana.</p><script>if(window.opener){window.opener.postMessage({type:'google-oauth-complete',role:"+JSON.stringify(role)+"},location.origin)}setTimeout(()=>window.close(),900)</script>");
  } catch(e) { return apiError(res,e); }
}
