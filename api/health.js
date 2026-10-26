// Safe readiness endpoint: reports configuration presence only, never values.
// Vercel Node.js Serverless Function (GET /api/health).
export default function handler(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const checks = {
    supabaseUrl: Boolean(process.env.SUPABASE_URL),
    supabaseServiceRoleKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    googleClientId: Boolean(process.env.GOOGLE_CLIENT_ID),
    googleClientSecret: Boolean(process.env.GOOGLE_CLIENT_SECRET),
    oauthTokenEncryptionKey: Boolean(process.env.OAUTH_TOKEN_ENCRYPTION_KEY),
    upstashRestUrl: Boolean(process.env.UPSTASH_REDIS_REST_URL),
    upstashRestToken: Boolean(process.env.UPSTASH_REDIS_REST_TOKEN),
  };

  const required = Object.keys(checks);
  const configured = required.filter((key) => checks[key]).length;
  const ready = configured === required.length;

  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).json({
    service: "dexter-google-lleno-solution",
    status: ready ? "configured" : "configuration_required",
    configured,
    required: required.length,
    checks,
    note: "Presence-only diagnostics; this endpoint does not validate credentials or connect to Google APIs.",
  });
}
