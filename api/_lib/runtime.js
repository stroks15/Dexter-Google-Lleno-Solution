import crypto from "node:crypto";

export function json(res, status, body) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(body);
}
export function method(req, res, allowed) {
  if (!allowed.includes(req.method)) { res.setHeader("Allow", allowed.join(", ")); json(res,405,{error:"method_not_allowed"}); return false; }
  return true;
}
export function env(name) {
  const value = process.env[name];
  if (!value) throw new Error("missing_env:" + name);
  return value;
}
export function baseUrl(req) {
  const configured = process.env.APP_BASE_URL;
  if (configured) return configured.replace(/\/$/, "");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = req.headers["x-forwarded-proto"] || "https";
  if (!host) throw new Error("missing_host");
  return proto + "://" + host;
}
export async function requireUser(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) throw Object.assign(new Error("authentication_required"),{status:401});
  const token = auth.slice(7);
  const response = await fetch(env("SUPABASE_URL") + "/auth/v1/user", {
    headers: { apikey: env("SUPABASE_SERVICE_ROLE_KEY"), Authorization: "Bearer " + token }
  });
  if (!response.ok) throw Object.assign(new Error("invalid_session"),{status:401});
  const user = await response.json();
  if (!user?.id) throw Object.assign(new Error("invalid_session"),{status:401});
  return user;
}
export async function sb(path, options = {}) {
  const response = await fetch(env("SUPABASE_URL") + "/rest/v1/" + path, {
    ...options,
    headers: {
      apikey: env("SUPABASE_SERVICE_ROLE_KEY"),
      Authorization: "Bearer " + env("SUPABASE_SERVICE_ROLE_KEY"),
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw Object.assign(new Error("supabase_error:" + response.status + ":" + text.slice(0,400)),{status:502});
  return text ? JSON.parse(text) : null;
}
export async function redis(command) {
  const response = await fetch(env("UPSTASH_REDIS_REST_URL"), {
    method:"POST", headers:{Authorization:"Bearer "+env("UPSTASH_REDIS_REST_TOKEN"),"Content-Type":"application/json"},
    body:JSON.stringify(command)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error("redis_command_failed");
  return data.result;
}
export async function redisSet(key, value, ttlSeconds) {
  const args = ["SET",key,typeof value === "string" ? value : JSON.stringify(value)];
  if (ttlSeconds) args.push("EX",String(ttlSeconds));
  return redis(args);
}
export function encryptSecret(value) {
  const key = Buffer.from(env("OAUTH_TOKEN_ENCRYPTION_KEY"), "base64");
  if (key.length !== 32) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY_must_be_base64_32_bytes");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm",key,iv);
  const ciphertext = Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);
  return ["v1",iv.toString("base64url"),cipher.getAuthTag().toString("base64url"),ciphertext.toString("base64url")].join(".");
}
export function decryptSecret(value) {
  const [version,iv,tag,ciphertext] = value.split(".");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("invalid_ciphertext");
  const key = Buffer.from(env("OAUTH_TOKEN_ENCRYPTION_KEY"),"base64");
  if (key.length !== 32) throw new Error("OAUTH_TOKEN_ENCRYPTION_KEY_must_be_base64_32_bytes");
  const decipher = crypto.createDecipheriv("aes-256-gcm",key,Buffer.from(iv,"base64url"));
  decipher.setAuthTag(Buffer.from(tag,"base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext,"base64url")),decipher.final()]).toString("utf8");
}
export function apiError(res,error) {
  const status = error.status || 500;
  const safe = status === 500 ? "internal_error" : error.message;
  return json(res,status,{error:safe});
}
export async function googleApi(url, token, init = {}) {
  const response = await fetch(url,{...init,headers:{Authorization:"Bearer "+token,...(init.headers||{})}});
  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(new Error("google_api_error"),{status:response.status,googleBody:text.slice(0,500)});
  }
  if (response.status === 204) return null;
  return response.json();
}
