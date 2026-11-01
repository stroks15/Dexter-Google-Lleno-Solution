import { MercadoPagoConfig, Preference, PreApproval, Payment } from "mercadopago";
import { env } from "./runtime.js";
const client=()=>new MercadoPagoConfig({accessToken:env("MP_ACCESS_TOKEN"),options:{timeout:12000,maxRetries:2}});
export const mpPreference=()=>new Preference(client());
export const mpPreApproval=()=>new PreApproval(client());
export const mpPayment=()=>new Payment(client());
export const MONTHLY_MXN=129;
export const LIFETIME_MXN=499;
export const FREE_LIMIT_BYTES=2000000000;
