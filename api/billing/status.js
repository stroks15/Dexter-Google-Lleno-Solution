import {apiError,json,method,requireUser,sb} from "../_lib/runtime.js";
export default async function handler(req,res){
 if(!method(req,res,["GET"]))return;
 try{
  const user=await requireUser(req),rows=await sb("dexter_user_entitlements?select=plan_type,bytes_transferred,discount_coupon_applied,subscription_status,current_period_end&user_id=eq."+encodeURIComponent(user.id));
  const e=rows?.[0]||{plan_type:"free",bytes_transferred:0,subscription_status:null};
  return json(res,200,{...e,free_limit_bytes:2147483648,unlimited:e.plan_type!=="free"});
 }catch(e){return apiError(res,e)}
}
