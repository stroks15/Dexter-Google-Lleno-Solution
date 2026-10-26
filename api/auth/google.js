import crypto from "node:crypto";
import {apiError,baseUrl,env,json,method,redisSet,requireUser} from "../_lib/runtime.js";

const DRIVE_SOURCE = ["https://www.googleapis.com/auth/drive.readonly","https://www.googleapis.com/auth/photospicker.mediaitems.readonly"];
const DRIVE_TARGET = ["https://www.googleapis.com/auth/drive.file","https://www.googleapis.com/auth/photoslibrary.appendonly"];
export default async function handler(req,res) {
  if (!method(req,res,["POST"])) return;
  try {
    const user = await requireUser(req);
    const role = req.body?.role;
    if (!["account_source","account_target"].includes(role)) return json(res,400,{error:"role_must_be_account_source_or_account_target"});
    const state = crypto.randomBytes(32).toString("base64url");
    const scopes = role === "account_source" ? DRIVE_SOURCE : DRIVE_TARGET;
    await redisSet("dexter:oauth:state:"+state,{userId:user.id,role,createdAt:Date.now()},600);
    const params = new URLSearchParams({
      client_id:env("GOOGLE_CLIENT_ID"),
      redirect_uri:baseUrl(req)+"/api/auth/callback/google",
      response_type:"code",
      scope:["openid","email","profile",...scopes].join(" "),
      access_type:"offline",
      prompt:role === "account_source" ? "consent" : "consent select_account",
      include_granted_scopes:"false",
      state
    });
    // Prefer the authenticated Google identity for the source account where Google can honor it.
    // Drive permissions are still separately consented to here; destination always allows account selection.
    if (role === "account_source" && user.email) params.set("login_hint",user.email);
    return res.status(200).json({url:"https://accounts.google.com/o/oauth2/v2/auth?"+params.toString(),expiresIn:600,role});
  } catch(e) { return apiError(res,e); }
}
