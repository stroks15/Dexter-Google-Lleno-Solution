# Durable transfer worker architecture

## Execution model

POST /api/migrations/enqueue validates the signed-in user and both account connections, persists the job/files, publishes one message to Upstash QStash and returns 202 Accepted. It refuses to claim a job was queued if QStash, the worker secret, or the base URL is missing.

POST /api/workers/transfer authenticates the forwarded shared secret, takes a short Redis lock per job, and performs at most one bounded chunk of work. The resumable upload URL and the next offset are persisted in Redis. Once the step finishes and the lock is released, the worker publishes the next message. Temporary network and rate-limit failures are delayed and retried; permanent file failures are recorded and the remaining files continue.

Redis keys:
- migration:worker-state:<jobId>: current file, resumable session URL, byte offset, total size and service-specific metadata (TTL 7 days).
- migration:worker-lock:<jobId>: short-lived mutual exclusion lock.
- migration:progress:<jobId>: UI progress (TTL 24 hours).
- migration:photos-session:<jobId>: owner and Google Photos Picker session ID (existing TTL remains 1 hour).

## Streaming and bandwidth

Binary content is fetched with an HTTP byte range and the response ReadableStream is passed directly to the Google resumable-upload request body. The implementation does not buffer an entire media item, write temporary files, or route media through the browser; each invocation handles at most a 4 MiB chunk. Drive and Photos uploads use their respective resumable-upload protocols.

This is not zero bandwidth through Vercel: the bytes still travel from Google through the Vercel function to Google, so platform transfer/egress accounting may apply. The design bounds memory and invocation duration and avoids temporary storage, but it cannot eliminate the bytes required to copy between independent Google accounts. Cross-account Google Drive files.copy is not a server-to-server transfer between separate users, and Google Photos has no equivalent arbitrary-library copy operation.

## Important API constraint

The Google Photos Picker mediaFile.baseUrl is temporary. This worker re-lists Picker items for each chunk and requires the download endpoint to honor HTTP Range with a valid 206 Partial Content and Content-Range. If the endpoint does not support ranges or the Picker session expires, the affected item fails safely and the original remains untouched. Do not silently fall back to buffering the entire video in memory. Re-select the media after an expired Picker session.

Google Photos resumable upload sessions are persisted as URLs; the byte offset is queried from Google's upload endpoint before every chunk. A rare interruption after finalizing the upload but before the upload token is durably recorded may require manual review rather than automatic replay. The worker avoids automatic deletion of Google Photos originals.

## Integrity and limitations

- Drive files are marked verified only after destination size and MD5 match the source. Native Google Workspace documents that require export are not supported by this binary-transfer path.
- Photos batchCreate success is recorded as API-accepted, not a cryptographic checksum comparison. Users must inspect important media in the destination before manually deleting originals.
- No end-to-end Google account transfer was run by static build validation. Test with authorized source/destination accounts and representative files, including a large video, before production use.
- No additional cloud resources or paid plans are created by this code change.
