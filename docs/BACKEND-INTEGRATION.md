# Dexter Google Lleno Solution — backend integration

## Implemented endpoints

- `POST /api/auth/google`: accepts an authenticated Supabase Bearer token and `{ "role": "account_source" | "account_target" }`; returns a Google OAuth URL with one-time state in Upstash.
- `GET /api/auth/callback/google`: exchanges OAuth code, verifies Google identity, encrypts refresh token with AES-256-GCM, and stores it in the server-only Supabase secret table.
- `GET /api/auth/connections`: safe connection metadata only.
- `POST /api/migrations/enqueue`: creates a migration job, rows and idempotency logs, then publishes to QStash when configured.
- `POST /api/workers/transfer`: protected QStash worker; streams Drive files in resumable 8 MiB chunks, retries transient errors up to five times, updates Redis progress, and verifies destination size plus MD5 before marking verified.
- `GET /api/migrations/progress?jobId=...`: reads job and Redis progress for the signed-in owner.
- `POST /api/migrations/confirm-delete`: requires the exact explicit confirmation string and deletes only source Drive IDs whose records are verified.

## Correct OAuth scopes

The scope host must be `https://www.googleapis.com/auth/...`, not `https://googleapis.com`. Source Drive currently requests `drive` because the requested post-verification delete action needs delete capability; this is a powerful scope. Destination Drive requests `drive.file`. Photos scopes are requested separately, but the transfer enqueue endpoint intentionally rejects Photos jobs until the app's allowed Photos API methods and data-access policy have been validated. Do not imply that arbitrary Google Photos library items can be copied/deleted with the Drive API.

## Required Vercel environment variables

Set these only as server-side encrypted/sensitive variables, never in the browser bundle:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY` — required, not available from the current connector context; add via Vercel dashboard/secret manager.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` — create in Google Cloud Console; add redirect URI `https://dexter-google-lleno-solution.vercel.app/api/auth/callback/google`.
- `OAUTH_TOKEN_ENCRYPTION_KEY` — base64 encoding of exactly 32 cryptographically random bytes.
- `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `QSTASH_TOKEN`, `WORKER_SHARED_SECRET`, `APP_BASE_URL`.

Do not paste private keys in GitHub issues, source files or frontend variables. The Supabase service-role key bypasses RLS; it must never be exposed to browsers.

## Android / Capacitor

This repository's current UI is a static site in `src`; the manifest template is under `android-template` because Capacitor must generate the native `android/` project first.

1. Install Node.js 20+ and run `npm install`.
2. Run `npx cap add android` once to generate the native project.
3. Copy `android-template/app/src/main/AndroidManifest.xml` to `android/app/src/main/AndroidManifest.xml` (merge permissions if Capacitor changes its template).
4. Run `npm run android:prepare`, then `npx cap open android`.
5. Build the signed APK/AAB in Android Studio.

The `WAKE_LOCK` permission alone does not guarantee an always-awake device; use a foreground service or carefully scoped wake lock in native code if background transfers must continue with the screen off. Android background execution restrictions still apply.
