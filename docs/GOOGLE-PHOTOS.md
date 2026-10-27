# Google Photos Picker migration

This flow uses Google's Picker API for user-selected source media and the Photos Library API only to append new media to the destination account.

## User flow
1. Connect the source account with `photospicker.mediaitems.readonly`.
2. Create a Picker session at `POST /api/migrations/scan?service=photos` and open the returned `pickerUri`.
3. Poll `GET /api/migrations/scan?service=photos&sessionId=...` until `ready=true`; this endpoint returns the selected media IDs.
4. Queue the selected IDs with `POST /api/migrations/enqueue`, mode `photos_videos`, and `photosSessionId`.
5. The shared protected `/api/workers/transfer` worker downloads selected media and creates destination items using `photoslibrary.appendonly`.

## Important constraints
- This implementation intentionally caps each item at 50 MiB because the current Vercel function buffers one item in memory. Larger videos must not be queued through this path until a streaming/resumable worker is deployed.
- Google Photos APIs do not provide a supported general-purpose delete operation for arbitrary existing library items. This flow copies and verifies selected media but never deletes originals. To free Photos storage, review the destination manually first, then delete the originals manually in Google Photos.
- Picker media URLs expire. Start the queued transfer promptly after selection.
- Google OAuth consent screen / verification and API access must be approved/configured for the Google accounts used. The API being enabled alone does not guarantee access.
