# Dexter Google Lleno Solution — backend integration

## Implemented endpoints

- `POST /api/auth/google`: accepts an authenticated Supabase Bearer token and `{ "role": "account_source" | "account_target" }`; returns a Google OAuth URL with one-time state in Upstash.
- `GET /api/auth/callback/google`: exchanges OAuth code, verifies Google identity, encrypts refresh token with AES-256-GCM, and stores it in the server-only Supabase secret table.
- `GET /api/auth/connections`: safe connection metadata only.
- `POST /api/migrations/enqueue`: creates a migration job, rows and idempotency logs, then publishes to QStash when configured.
- `POST /api/workers/transfer`: protected QStash worker for Drive; transfers files in resumable 8 MiB chunks and verifies destination size plus MD5 before marking verified.
- `POST /api/migrations/scan?service=photos` and `GET /api/migrations/scan?service=photos&sessionId=...`: create a Google Photos Picker session and poll/list the user selection.
- `POST /api/workers/transfer`: the same protected QStash worker dispatches Drive jobs or Google Photos Picker jobs; Photos copies selected media into the destination library using `photoslibrary.appendonly`, with a 50 MiB per-item cap.
- `GET /api/migrations/progress?jobId=...`: reads job and Redis progress for the signed-in owner.
- `POST /api/migrations/confirm-delete`: requires the exact explicit confirmation string and deletes only source Drive IDs whose records are verified.

## Correct OAuth scopes

The scope host must be `https://www.googleapis.com/auth/...`, not `https://googleapis.com`. Source Drive initially requests `drive.readonly`; destination Drive requests `drive.file`. Only after a job is fully verified and the user explicitly confirms deletion does the app ask Google for an additional `drive` scope, replacing the source token. Google Photos source media is selected explicitly through Picker API; the destination uses `photoslibrary.appendonly` to create new media items. This does not allow deleting arbitrary original Google Photos library items. After verifying the destination, the user must manage original deletion manually in Google Photos. See `docs/GOOGLE-PHOTOS.md` for limits.

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
