# Worker contract (implementation pending)

Use Upstash QStash to dispatch durable HTTP tasks to a protected worker endpoint. Every message must carry a migration job ID and an idempotency key; verify QStash signatures before processing. Do not pass OAuth tokens in queue payloads.

Suggested stages:
1. scan source metadata and persist file IDs, byte sizes and available checksums;
2. copy each selected file with bounded concurrency and retry/backoff;
3. verify destination ID, size and available checksums; mark verified only when evidence supports it;
4. show completion to the user and require a fresh authenticated confirmation;
5. delete only the exact source IDs whose destination copy is verified, with an audit record and per-file outcome.

Google Photos and Drive have different APIs and constraints. Large files require resumable transfer, checkpoints, cancellation, quota/rate-limit handling, and idempotency. Avoid treating Google Drive MD5 as universally available; native Google Workspace files and Google Photos may require export/download-specific handling. Never infer a checksum when the API doesn't provide one.