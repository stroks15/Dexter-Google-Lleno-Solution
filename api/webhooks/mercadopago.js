import crypto from "node:crypto";
import {MercadoPagoConfig,Payment,PreApproval} from "mercadopago";
import {apiError,env,json,method,redisSet,sb} from "../_lib/runtime.js";
const client=()=>new MercadoPagoConfig({accessToken:env("MP_ACCESS_TOKEN"),options:{timeout:12000,maxRetries:2}});
function signatureOK(req,id){
 const parts=Object.fromEntries((req.headers["x-signature"]||"").split(",").map(x=>x.trim().split("=").map(y=>y.trim())));
 const rid=req.headers["x-request-id"]||"";if(!parts.ts||!parts.v1||!rid||!id)return false;
 const manifest="id:"+String(id).toLowerCase()+";request-id:"+rid+";ts:"+parts.ts+";";
 const expected=crypto.createHmac("sha256",env("MP_WEBHOOK_SECRET")).update(manifest).digest("hex");
 const a=Buffer.from(expected,"hex"),b=Buffer.from(parts.v1,"hex");return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
async function grant(user,plan,coupon,preapproval=null){
 await sb("dexter_user_entitlements?on_conflict=user_id",{method:"POST",headers:{"Prefer":"resolution=merge-duplicates,return=minimal"},body:JSON.stringify([{user_id:user,plan_type:plan,discount_coupon_applied:coupon||null,mp_preapproval_id:preapproval,subscription_status:plan==="premium_monthly"?"authorized":null,lifetime_granted_at:plan==="premium_lifetime"?new Date().toISOString():null}])});
 await redisSet("dexter:entitlement:"+user,{plan_type:plan,updated_at:new Date().toISOString()});
}
export default async function handler(req,res){
 if(!method(req,res,["POST"]))return;
 try{
  const body=req.body||{},id=body.data?.id||req.query?.["data.id"]||req.query?.id;
  if(!signatureOK(req,id))return json(res,401,{error:"invalid_webhook_signature"});
  const type=body.type||body.topic;
  if(type==="payment"){
   const payment=await new Payment(client()).get({id:String(id)});
   if(payment.status!=="approved")return json(res,200,{received:true,processed:false,status:payment.status});
   const byReference=await sb("dexter_billing_orders?select=*&id=eq."+encodeURIComponent(payment.external_reference||""));
   let order=byReference?.[0];
   if(order?.plan_type==="premium_lifetime"){
    if(Number(payment.transaction_amount)!==Number(order.amount_mxn))return json(res,409,{error:"amount_mismatch"});
    await sb("dexter_billing_orders?id=eq."+order.id,{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"approved",mp_payment_id:String(payment.id)})});
    await grant(order.user_id,"premium_lifetime",order.discount_coupon_applied);
    if(order.discount_coupon_applied)await sb("dexter_coupon_redemptions",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify([{user_id:order.user_id,coupon_code:order.discount_coupon_applied}])});
    return json(res,200,{received:true,processed:true});
   }
   if(payment.preapproval_id){
    const subs=await sb("dexter_billing_orders?select=*&mp_preapproval_id=eq."+encodeURIComponent(String(payment.preapproval_id)));
    order=subs?.[0];
    if(order?.plan_type==="premium_monthly"){
     await grant(order.user_id,"premium_monthly",order.discount_coupon_applied,String(payment.preapproval_id));
     return json(res,200,{received:true,processed:true,subscription:true});
    }
   }
   return json(res,200,{received:true,processed:false,reason:"order_not_found"});
  }
  if(type==="subscription_preapproval"||type==="preapproval"){
   const sub=await new PreApproval(client()).get({id:String(id)});
   const rows=await sb("dexter_billing_orders?select=*&id=eq."+encodeURIComponent(sub.external_reference||""));
   const order=rows?.[0];if(!order||order.plan_type!=="premium_monthly")return json(res,200,{received:true,processed:false,reason:"order_not_found"});
   if(sub.status==="authorized"){
    await sb("dexter_billing_orders?id=eq."+order.id,{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({status:"authorized",mp_preapproval_id:String(sub.id)})});
    await grant(order.user_id,"premium_monthly",order.discount_coupon_applied,String(sub.id));
    if(order.discount_coupon_applied){
     await new PreApproval(client()).update({id:String(sub.id),body:{auto_recurring:{...sub.auto_recurring,transaction_amount:129}}});
     await sb("dexter_coupon_redemptions",{method:"POST",headers:{"Prefer":"resolution=ignore-duplicates,return=minimal"},body:JSON.stringify([{user_id:order.user_id,coupon_code:order.discount_coupon_applied}])});
    }
   }else if(["cancelled","paused"].includes(sub.status)){
    await sb("dexter_user_entitlements?user_id=eq."+encodeURIComponent(order.user_id),{method:"PATCH",headers:{"Prefer":"return=minimal"},body:JSON.stringify({plan_type:"free",subscription_status:sub.status,mp_preapproval_id:String(sub.id)})});
    await redisSet("dexter:entitlement:"+order.user_id,{plan_type:"free",updated_at:new Date().toISOString()});
   }
   return json(res,200,{received:true,processed:true,status:sub.status});
  }
  return json(res,200,{received:true,processed:false,ignored:true});
 }catch(e){return apiError(res,e)}
}
