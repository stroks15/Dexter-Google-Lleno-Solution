import crypto from "node:crypto";
import {apiError,baseUrl,json,method,requireUser,sb} from "../_lib/runtime.js";
import {mpPreference,mpPreApproval,MONTHLY_MXN,LIFETIME_MXN} from "../_lib/mercadopago.js";
const couponCode=v=>typeof v==="string"?v.trim().toUpperCase().slice(0,80):"";
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const user=await requireUser(req),{plan_selected,coupon_code}=req.body||{};
  if(!["premium_monthly","premium_lifetime"].includes(plan_selected))return json(res,400,{error:"invalid_plan"});
  const existing=await sb("dexter_user_entitlements?select=plan_type&user_id=eq."+encodeURIComponent(user.id));
  if(existing?.[0]?.plan_type&&existing[0].plan_type!=="free")return json(res,409,{error:"premium_already_active"});
  const pending=await sb("dexter_billing_orders?select=id&user_id=eq."+encodeURIComponent(user.id)+"&status=in.(pending,authorized)&created_at=gte."+encodeURIComponent(new Date(Date.now()-30*60*1000).toISOString()));
  if(pending?.length)return json(res,409,{error:"checkout_already_pending"});
  const code=couponCode(coupon_code);let coupon=null;
  if(code){
   const found=await sb("dexter_coupons?select=code,discount_mxn,grants_lifetime,active&code=eq."+encodeURIComponent(code));
   coupon=found?.[0];if(!coupon||!coupon.active)return json(res,400,{error:"invalid_coupon"});
   const used=await sb("dexter_coupon_redemptions?select=id&coupon_code=eq."+encodeURIComponent(code)+"&user_id=eq."+encodeURIComponent(user.id));
   if(used?.length)return json(res,409,{error:"coupon_already_redeemed"});
  }
  if(coupon?.grants_lifetime){
   await sb("dexter_coupon_redemptions",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify([{user_id:user.id,coupon_code:code}])});
   await sb("dexter_user_entitlements?on_conflict=user_id",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{user_id:user.id,plan_type:"premium_lifetime",discount_coupon_applied:code,lifetime_granted_at:new Date().toISOString(),subscription_status:null,mp_preapproval_id:null}])});
   await (await import("../_lib/runtime.js")).redisSet("dexter:entitlement:"+user.id,{plan_type:"premium_lifetime",updated_at:new Date().toISOString()});
   return json(res,200,{bypass:true,plan_type:"premium_lifetime",message:"Premium de por vida activado."});
  }
  const base=plan_selected==="premium_monthly"?MONTHLY_MXN:LIFETIME_MXN;
  const amount=Math.max(0,Number((base-(coupon?Number(coupon.discount_mxn):0)).toFixed(2)));
  const id=crypto.randomUUID();
  await sb("dexter_billing_orders",{method:"POST",headers:{"Prefer":"return=minimal"},body:JSON.stringify([{id,user_id:user.id,plan_type:plan_selected,amount_mxn:amount,discount_coupon_applied:code||null,status:"pending"}])});
  const root=baseUrl(req);
  if(plan_selected==="premium_monthly"){
   const p=await mpPreApproval().create({body:{reason:"Dexter Premium mensual",external_reference:id,payer_email:user.email,back_url:root+"/?billing=return",status:"pending",auto_recurring:{frequency:1,frequency_type:"months",transaction_amount:amount,currency_id:"MXN"}},requestOptions:{idempotencyKey:id}});
   await sb("dexter_billing_orders?id=eq."+id,{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({mp_preapproval_id:String(p.id)})});
   return json(res,200,{checkout_url:p.init_point,amount_mxn:amount,plan_type:plan_selected,discount_first_cycle:!!coupon});
  }
  const p=await mpPreference().create({body:{items:[{id:"dexter-premium-lifetime",title:"Dexter Premium de por Vida",description:"Acceso Premium ilimitado de por vida",quantity:1,currency_id:"MXN",unit_price:amount}],payer:{email:user.email},external_reference:id,notification_url:root+"/api/webhooks/mercadopago",back_urls:{success:root+"/?billing=success",failure:root+"/?billing=failure",pending:root+"/?billing=pending"},auto_return:"approved",statement_descriptor:"DEXTER PREMIUM"},requestOptions:{idempotencyKey:id}});
  await sb("dexter_billing_orders?id=eq."+id,{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({mp_preference_id:String(p.id)})});
  return json(res,200,{checkout_url:p.init_point,amount_mxn:amount,plan_type:plan_selected});
 }catch(e){return apiError(res,e)}
}
