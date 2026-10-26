import crypto from "node:crypto";
import {apiError,baseUrl,env,json,method,redisSet,requireUser,sb} from "../_lib/runtime.js";
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const user=await requireUser(req);
  const {jobId,confirmationText}=req.body||{};
  if(confirmationText!=="ELIMINAR ARCHIVOS VERIFICADOS DE LA CUENTA 1")return json(res,400,{error:"explicit_confirmation_text_required"});
  const jobs=await sb("dexter_google_migration_jobs?select=id,user_id,status&id=eq."+encodeURIComponent(jobId||""));
  if(!jobs?.[0]||jobs[0].user_id!==user.id)return json(res,404,{error:"job_not_found"});
  if(jobs[0].status!=="verified")return json(res,409,{error:"job_must_be_fully_verified_first"});
  const state=crypto.randomBytes(32).toString("base64url");
  await redisSet("dexter:oauth:state:"+state,{userId:user.id,role:"account_source_delete",jobId,createdAt:Date.now()},600);
  const params=new URLSearchParams({client_id:env("GOOGLE_CLIENT_ID"),redirect_uri:baseUrl(req)+"/api/auth/callback/google",response_type:"code",scope:["openid","email","profile","https://www.googleapis.com/auth/drive"].join(" "),access_type:"offline",prompt:"consent select_account",include_granted_scopes:"false",state});
  return json(res,200,{url:"https://accounts.google.com/o/oauth2/v2/auth?"+params.toString(),expiresIn:600,role:"account_source_delete"});
 }catch(e){return apiError(res,e)}
}
