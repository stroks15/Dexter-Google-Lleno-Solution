# Dexter Google Lleno Solution

Mobile-first app foundation for user-approved Google Drive and Google Photos migration.

## Current status
This repository was empty at start. The initial foundation adds the migration schema and a responsive interactive prototype. OAuth callbacks, real Google API transfers, background workers, Android packaging, and deployment still require provider configuration and integration tests.

## Safety model
- Source account is read-only for scanning/copying; destination account is write-enabled.
- OAuth refresh tokens must be encrypted server-side using envelope encryption. The browser never receives tokens or service-role credentials.
- Files are never deleted automatically after copy. Deletion requires a separate authenticated confirmation and is limited to files with verified destination IDs, matching sizes, and matching available hashes.
- Google Photos API does not always provide original binary hashes or permit arbitrary upload/move semantics; implementation must follow the current API's supported operations and must not claim verification where unavailable.
- The projected storage meter is an estimate based on selected source sizes. Real space is freed only after successful deletion and Google account quota refresh.

## Layout
- `supabase/migrations/`: RLS-protected migration records; OAuth secrets are isolated in a backend-only table.
- `src/`: accessible responsive prototype.
- `api/`: server-side route placeholders / worker contracts.
- `vercel.json`: Vercel routing and function defaults.
- `.github/workflows/`: CI checks.

## Local UI preview
Open `src/index.html` in a browser. It is a prototype and does not connect to Google or delete files.

## Required environment variables (server only)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OAUTH_TOKEN_ENCRYPTION_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Configure only in the deployment provider's secret store. Never commit real values.

## Android
The responsive web app can later be packaged using Capacitor and Android Gradle tooling. APK signing keys must remain outside the repository and CI logs.