# Google Photos Picker migration

This flow uses Google's Picker API for user-selected source media and the Photos Library API only to append new media to the destination account.

## User flow
1. Connect the source account with `photospicker.mediaitems.readonly`.
2. Create a Picker session at `POST /api/migrations/scan?service=photos` and open the returned `pickerUri`.
3. Poll `GET /api/migrations/scan?service=photos&sessionId=...` until `ready=true`; this endpoint returns the selected media IDs.
4. Queue the selected IDs with `POST /api/migrations/enqueue`, mode `photos_videos`, and `photosSessionId`.
5. The shared protected `/api/workers/transfer` worker downloads selected media and creates destination items using `photoslibrary.appendonly`.

## Important constraints
- The durable worker handles one streamed 4 MiB range per invocation and persists the Google resumable-upload session and offset in Upstash Redis. The Google Photos API maximums are 200 MB per photo and 20 GB per video. A source Picker base URL must actually honor HTTP Range; if it returns a full response instead of 206 Partial Content, that item fails safely rather than buffering the full file.
- Picker base URLs expire after about 60 minutes, and this application's Picker session record also has a one-hour TTL. Very long jobs may need the user to select the media again if the session expires. The upload is re-queued between chunks through QStash, so no single Vercel invocation is intended to transfer an entire video.
- Google Photos APIs do not provide a supported general-purpose delete operation for arbitrary existing library items. This flow copies selected media and records successful item creation returned by Google Photos; the Picker API does not provide a source checksum for byte-for-byte verification in this implementation. It never deletes originals. To free Photos storage, review the destination manually first, then delete the originals manually in Google Photos.
- Picker media URLs expire after about 60 minutes. Start the queued transfer promptly after selection; the worker re-lists selected items for each chunk, but cannot extend Google's session lifetime.
- Google OAuth consent screen / verification and API access must be approved/configured for the Google accounts used. The API being enabled alone does not guarantee access.

- Streaming avoids buffering a full item and avoids temporary files, but it does not make Vercel bandwidth zero: media bytes still pass through the Vercel worker between Google accounts.
