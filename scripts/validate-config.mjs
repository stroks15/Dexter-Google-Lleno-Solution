const required = ["SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","GOOGLE_CLIENT_ID","GOOGLE_CLIENT_SECRET","OAUTH_TOKEN_ENCRYPTION_KEY","UPSTASH_REDIS_REST_URL","UPSTASH_REDIS_REST_TOKEN","QSTASH_TOKEN","WORKER_SHARED_SECRET","APP_BASE_URL"];
const missing = required.filter((key) => !process.env[key]);
console.log("Dexter Google Lleno source validation (does not contact third-party APIs)");
if (missing.length) {
  console.log("Environment not fully configured; missing:", missing.join(", "));
  console.log("Build is allowed so the public UI can deploy. OAuth and transfer endpoints will remain unavailable until server secrets are configured.");
} else {
  const key = Buffer.from(process.env.OAUTH_TOKEN_ENCRYPTION_KEY, "base64");
  if (key.length !== 32) {
    console.error("OAUTH_TOKEN_ENCRYPTION_KEY must be base64-encoded 32 bytes");
    process.exitCode = 1;
  } else console.log("Required environment variables are present.");
}
