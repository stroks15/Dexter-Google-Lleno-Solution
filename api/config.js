import {env,json,method} from "./_lib/runtime.js";
export default function handler(req,res){
 if(!method(req,res,["GET"]))return;
 try{return json(res,200,{supabaseUrl:env("SUPABASE_URL"),supabaseAnonKey:env("SUPABASE_ANON_KEY")});}
 catch{return json(res,503,{error:"public_configuration_unavailable"});}
}
