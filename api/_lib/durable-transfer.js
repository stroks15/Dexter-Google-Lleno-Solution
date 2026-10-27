import crypto from "node:crypto";
import { env, redis, redisSet, sb } from "./runtime.js";
import { getAccessToken } from "./drive.js";

const CHUNK_BYTES = 4 * 1024 * 1024;
const STATE_TTL = 7 * 24 * 60 * 60;
const PROGRESS_TTL = 24 * 60 * 60;
const MAX_PHOTO_BYTES = 200 * 1024 * 1024;
const MAX_VIDEO_BYTES = 20 * 1024 * 1024 * 1024;

function parseRedis(value) {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return null; }
  }
  return value;
}
async function googleError(response) {
  return (await response.text().catch(() => "")).slice(0, 240);
}
async function googleJson(url, token, init = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: "Bearer " + token, ...(init.headers || {}) } });
  if (!response.ok) throw Object.assign(new Error("google_api_error:" + response.status + ":" + await googleError(response)), { status: response.status });
  if (response.status === 204) return null;
  return response.json();
}
async function publishNext(jobId, userId, delaySeconds = 0) {
  const url = env("APP_BASE_URL").replace(/\/$/, "") + "/api/workers/transfer";
  const response = await fetch("https://qstash.upstash.io/v2/publish/" + encodeURIComponent(url), {
    method: "POST",
    headers: {
      Authorization: "Bearer " + env("QSTASH_TOKEN"),
      "Content-Type": "application/json",
      "Upstash-Forward-Authorization": "Bearer " + env("WORKER_SHARED_SECRET"),
      ...(delaySeconds > 0 ? { "Upstash-Delay": String(delaySeconds) + "s" } : {})
    },
    body: JSON.stringify({ jobId, userId })
  });
  if (!response.ok) throw Object.assign(new Error("qstash_requeue_failed:" + response.status), { status: 503 });
}
async function setProgress(jobId, processed, total, status) {
  await redisSet("migration:progress:" + jobId, {
    jobId, percent: total ? Math.min(99, Math.floor(processed / total * 100)) : 0,
    remainingSeconds: null, processedBytes: processed, totalBytes: total, status
  }, PROGRESS_TTL);
}
async function sourceRange(url, token, start, requestedEnd) {
  const response = await fetch(url, { headers: { Authorization: "Bearer " + token, Range: "bytes=" + start + "-" + requestedEnd } });
  if (response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw Object.assign(new Error("source_range_not_supported_or_expired:" + response.status), { status: response.status });
  }
  const value = response.headers.get("content-range") || "";
  const match = value.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match || Number(match[1]) !== start) {
    await response.body?.cancel().catch(() => {});
    throw new Error("source_content_range_invalid");
  }
  const end = Number(match[2]), total = Number(match[3]), length = end - start + 1;
  if (!response.body || length < 1 || length > CHUNK_BYTES || end > requestedEnd) {
    await response.body?.cancel().catch(() => {});
    throw new Error("source_range_length_invalid");
  }
  return { response, end, total, length };
}
async function startDriveUpload(meta, token, sourceId) {
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,md5Checksum,sha256Checksum", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token, "Content-Type": "application/json",
      "X-Upload-Content-Type": meta.mimeType || "application/octet-stream"
    },
    body: JSON.stringify({
      name: meta.name, mimeType: meta.mimeType || "application/octet-stream",
      appProperties: { dexterSourceId: sourceId }
    })
  });
  if (!response.ok) throw Object.assign(new Error("drive_upload_init_failed:" + response.status + ":" + await googleError(response)), { status: response.status });
  const sessionUrl = response.headers.get("location");
  if (!sessionUrl) throw new Error("drive_upload_session_missing");
  return sessionUrl;
}
async function findExistingCopy(sourceId, token) {
  const q = "appProperties has { key='dexterSourceId' and value='" + sourceId.replace(/'/g, "\\'") + "' } and trashed = false";
  const params = new URLSearchParams({ q, spaces: "drive", pageSize: "1", fields: "files(id,name,mimeType,size,md5Checksum,sha256Checksum)" });
  return googleJson("https://www.googleapis.com/drive/v3/files?" + params, token);
}
async function driveUploadStatus(sessionUrl, token, total) {
  const response = await fetch(sessionUrl, {
    method: "PUT", headers: { Authorization: "Bearer " + token, "Content-Length": "0", "Content-Range": "bytes */" + total }
  });
  if (response.status === 308) {
    const range = response.headers.get("range") || "";
    const match = range.match(/bytes=0-(\d+)/);
    return { offset: match ? Number(match[1]) + 1 : 0, complete: false };
  }
  if (response.ok) return { offset: total, complete: true, data: await response.json().catch(() => null) };
  throw Object.assign(new Error("drive_upload_status_failed:" + response.status + ":" + await googleError(response)), { status: response.status });
}
async function uploadDriveChunk(sessionUrl, token, chunk, offset, total) {
  const response = await fetch(sessionUrl, {
    method: "PUT",
    headers: { Authorization: "Bearer " + token, "Content-Length": String(chunk.length), "Content-Range": "bytes " + offset + "-" + (offset + chunk.length - 1) + "/" + total },
    body: chunk.response.body,
    duplex: "half"
  });
  if (response.status === 308) {
    const range = response.headers.get("range") || "";
    const match = range.match(/bytes=0-(\d+)/);
    return { complete: false, offset: match ? Number(match[1]) + 1 : offset, data: null };
  }
  if (response.ok) return { complete: true, offset: total, data: await response.json().catch(() => null) };
  throw Object.assign(new Error("drive_chunk_upload_failed:" + response.status + ":" + await googleError(response)), { status: response.status });
}
async function startPhotosUpload(token, mimeType, total) {
  const response = await fetch("https://photoslibrary.googleapis.com/v1/uploads", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token, "Content-Length": "0",
      "X-Goog-Upload-Command": "start", "X-Goog-Upload-Content-Type": mimeType || "application/octet-stream",
      "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Raw-Size": String(total)
    }
  });
  if (!response.ok) throw Object.assign(new Error("photos_upload_init_failed:" + response.status + ":" + await googleError(response)), { status: response.status });
  const url = response.headers.get("x-goog-upload-url");
  if (!url) throw new Error("photos_upload_session_missing");
  return { url, granularity: Number(response.headers.get("x-goog-upload-chunk-granularity") || 262144) };
}
async function photosUploadStatus(session, token) {
  const response = await fetch(session.url, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Length": "0", "X-Goog-Upload-Command": "query" }
  });
  if (!response.ok) throw Object.assign(new Error("photos_upload_status_failed:" + response.status), { status: response.status });
  return Number(response.headers.get("x-goog-upload-size-received") || 0);
}
async function uploadPhotosChunk(session, token, chunk, offset, last) {
  const response = await fetch(session.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token, "Content-Length": String(chunk.length),
      "X-Goog-Upload-Command": last ? "upload, finalize" : "upload",
      "X-Goog-Upload-Offset": String(offset)
    },
    body: chunk.response.body, duplex: "half"
  });
  if (!response.ok) throw Object.assign(new Error("photos_chunk_upload_failed:" + response.status + ":" + await googleError(response)), { status: response.status });
  const body = await response.text();
  return last ? body.trim() : null;
}
async function photosItems(sessionId, token) {
  const selected = new Map();
  let pageToken = null;
  do {
    const params = new URLSearchParams({ sessionId, pageSize: "100" });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch("https://photospicker.googleapis.com/v1/mediaItems?" + params, { headers: { Authorization: "Bearer " + token } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error("photos_picker_list_failed:" + response.status), { status: response.status });
    for (const item of data.mediaItems || []) selected.set(item.id, item);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return selected;
}
async function markFileVerified(jobId, userId, file, destinationId, size, checksum = null) {
  const now = new Date().toISOString();
  await sb("dexter_google_migration_files?id=eq." + encodeURIComponent(file.id), {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ destination_file_id: destinationId, size_bytes: size, status: "verified", ...(checksum ? { source_md5: checksum, destination_md5: checksum } : {}), verified_at: now, updated_at: now })
  });
  await sb("dexter_google_transfer_logs?job_id=eq." + encodeURIComponent(jobId) + "&source_service=eq." + file.source_service + "&file_id=eq." + encodeURIComponent(file.source_file_id), {
    method: "PATCH", headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ status: "verified", destination_file_id: destinationId, source_size_bytes: size, destination_size_bytes: size, ...(checksum ? { source_checksum: checksum, destination_checksum: checksum } : {}), verified_at: now, updated_at: now })
  });
}
async function processDriveFile(jobId, userId, file, state, sourceToken, targetToken, processed, totalBytes) {
  let completedBase = Math.max(0, processed - Number(state.offset || 0));
  const meta = await googleJson("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.source_file_id) + "?fields=id,name,mimeType,size,md5Checksum,sha256Checksum", sourceToken);
  if (meta.size === undefined) throw new Error("native_google_workspace_export_not_supported");
  const size = Number(meta.size);
  if (!state.sessionUrl) {
    const existing = await findExistingCopy(file.source_file_id, targetToken);
    if (existing.files?.length) {
      const copy = existing.files[0];
      if (Number(copy.size) === size && meta.md5Checksum && copy.md5Checksum && meta.md5Checksum.toLowerCase() === copy.md5Checksum.toLowerCase()) {
        await markFileVerified(jobId, userId, file, copy.id, size, meta.md5Checksum);
        return { processed: completedBase + size, continue: true, state: null };
      }
      throw new Error("existing_destination_copy_integrity_check_failed");
    }
    state = { fileId: file.id, service: "drive", sessionUrl: await startDriveUpload(meta, targetToken, file.source_file_id), offset: 0, totalSize: size, sourceMd5: meta.md5Checksum || null, name: meta.name, mimeType: meta.mimeType };
    await redisSet("migration:worker-state:" + jobId, state, STATE_TTL);
    await sb("dexter_google_migration_files?id=eq." + encodeURIComponent(file.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "copying", updated_at: new Date().toISOString() }) });
  }
  if (size === 0) {
    throw new Error("zero_byte_drive_file_requires_manual_review");
  }
  const status = await driveUploadStatus(state.sessionUrl, targetToken, size);
  if (status.complete) {
    const dest = status.data;
    if (!dest?.id) throw new Error("drive_upload_completed_without_destination_id");
    const destMeta = await googleJson("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(dest.id) + "?fields=id,size,md5Checksum", targetToken);
    if (Number(destMeta.size) !== size || !meta.md5Checksum || !destMeta.md5Checksum || meta.md5Checksum.toLowerCase() !== destMeta.md5Checksum.toLowerCase()) throw new Error("drive_integrity_verification_failed");
    await markFileVerified(jobId, userId, file, dest.id, size, meta.md5Checksum);
    return { processed: completedBase + size, continue: true, state: null };
  }
  const offset = status.offset;
  const end = Math.min(size - 1, offset + CHUNK_BYTES - 1);
  const chunk = await sourceRange("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(file.source_file_id) + "?alt=media", sourceToken, offset, end);
  if (chunk.total !== size || chunk.end !== end) throw new Error("drive_source_range_mismatch");
  const uploaded = await uploadDriveChunk(state.sessionUrl, targetToken, chunk, offset, size);
  if (uploaded.complete) {
    if (!uploaded.data?.id) throw new Error("drive_upload_completed_without_destination_id");
    const dest = await googleJson("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(uploaded.data.id) + "?fields=id,size,md5Checksum", targetToken);
    if (Number(dest.size) !== size || !meta.md5Checksum || !dest.md5Checksum || meta.md5Checksum.toLowerCase() !== dest.md5Checksum.toLowerCase()) throw new Error("drive_integrity_verification_failed");
    await markFileVerified(jobId, userId, file, dest.id, size, meta.md5Checksum);
    return { processed: completedBase + size, continue: true, state: null };
  }
  state.offset = uploaded.offset;
  await redisSet("migration:worker-state:" + jobId, state, STATE_TTL);
  return { processed: completedBase + uploaded.offset, continue: true, state };
}
async function processPhotosFile(jobId, userId, file, state, sourceToken, targetToken, photosSessionId, processed, totalBytes) {
  const selected = await photosItems(photosSessionId, sourceToken);
  const item = selected.get(file.source_file_id);
  const media = item?.mediaFile;
  if (!media?.baseUrl || !media?.mimeType) throw new Error("photos_selected_item_missing_or_expired");
  let completedBase = Math.max(0, processed - Number(state.offset || 0));
  const suffix = item.type === "VIDEO" ? "=dv" : "=d";
  const sourceUrl = media.baseUrl.endsWith("=dv") || media.baseUrl.endsWith("=d") ? media.baseUrl : media.baseUrl + suffix;
  if (!state.sessionUrl) {
    const probe = await sourceRange(sourceUrl, sourceToken, 0, 0);
    const size = probe.total;
    await probe.response.body?.cancel().catch(() => {});
    const maxSize = item.type === "VIDEO" ? MAX_VIDEO_BYTES : MAX_PHOTO_BYTES;
    if (!size || size > maxSize) throw new Error("photos_item_size_outside_google_api_limit");
    const upload = await startPhotosUpload(targetToken, media.mimeType, size);
    state = { fileId: file.id, service: "photos", sessionUrl: upload.url, granularity: upload.granularity, offset: 0, totalSize: size, filename: String(media.filename || file.file_name || "media").slice(0, 255), mimeType: media.mimeType };
    // Picker selections do not expose reliable byte sizes in the scan response.
    // Add the size exactly once, when this file's resumable session is first created.
    await sb("dexter_google_migration_jobs?id=eq." + encodeURIComponent(jobId), {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ total_bytes: totalBytes + size, updated_at: new Date().toISOString() })
    });
    await redisSet("migration:worker-state:" + jobId, state, STATE_TTL);
    await sb("dexter_google_migration_files?id=eq." + encodeURIComponent(file.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "copying", updated_at: new Date().toISOString() }) });
  }
  const received = await photosUploadStatus({ url: state.sessionUrl }, targetToken);
  if (received > state.totalSize) throw new Error("photos_upload_offset_invalid");
  if (received === state.totalSize) throw new Error("photos_upload_finalized_without_persisted_token_manual_review");
  const end = Math.min(state.totalSize - 1, received + CHUNK_BYTES - 1);
  const chunk = await sourceRange(sourceUrl, sourceToken, received, end);
  if (chunk.total !== state.totalSize || chunk.end !== end) throw new Error("photos_source_range_mismatch");
  const last = chunk.end === state.totalSize - 1;
  if (!last && chunk.length % state.granularity !== 0) throw new Error("photos_chunk_granularity_mismatch");
  const uploadToken = await uploadPhotosChunk({ url: state.sessionUrl }, targetToken, chunk, received, last);
  if (last) {
    if (!uploadToken) throw new Error("photos_upload_token_missing");
    const response = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:batchCreate", {
      method: "POST", headers: { Authorization: "Bearer " + targetToken, "Content-Type": "application/json" },
      body: JSON.stringify({ newMediaItems: [{ simpleMediaItem: { uploadToken, fileName: state.filename } }] })
    });
    const resultData = await response.json().catch(() => ({}));
    const result = resultData.newMediaItemResults?.[0];
    if (!response.ok || !result?.mediaItem?.id) throw Object.assign(new Error("photos_media_create_failed:" + (result?.status?.message || response.status)), { status: response.status });
    await markFileVerified(jobId, userId, file, result.mediaItem.id, state.totalSize);
    return { processed: completedBase + state.totalSize, continue: true, state: null };
  }
  state.offset = received + chunk.length;
  await redisSet("migration:worker-state:" + jobId, state, STATE_TTL);
  return { processed: completedBase + received + chunk.length, continue: true, state };
}

export async function runDurableTransferStep({ jobId, userId }) {
  const lockKey = "migration:worker-lock:" + jobId;
  const lockToken = crypto.randomUUID();
  const acquired = await redis(["SET", lockKey, lockToken, "NX", "EX", "240"]);
  if (acquired !== "OK") return { statusCode: 202, body: { jobId, status: "already_processing" }, continue: false };
  let shouldContinue = false;
  try {
    const jobs = await sb("dexter_google_migration_jobs?select=id,user_id,status,total_bytes,processed_bytes,mode&id=eq." + encodeURIComponent(jobId));
    const job = jobs?.[0];
    if (!job || job.user_id !== userId) return { statusCode: 404, body: { error: "job_not_found" }, continue: false };
    if (["verified", "deleted", "cancelled"].includes(job.status)) return { statusCode: 200, body: { jobId, status: job.status }, continue: false };
    const files = await sb("dexter_google_migration_files?select=id,source_file_id,destination_file_id,file_name,mime_type,size_bytes,status,source_service&job_id=eq." + encodeURIComponent(jobId) + "&status=in.(queued,copying)&order=id.asc");
    const state = parseRedis(await redis(["GET", "migration:worker-state:" + jobId]));
    if (!files?.length) {
      const remaining = await sb("dexter_google_migration_files?select=status&job_id=eq." + encodeURIComponent(jobId) + "&status=not.in.(verified,deleted)");
      const complete = !remaining?.length;
      const now = new Date().toISOString();
      await sb("dexter_google_migration_jobs?id=eq." + encodeURIComponent(jobId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: complete ? "verified" : "failed", updated_at: now }) });
      await redisSet("migration:progress:" + jobId, { jobId, percent: complete ? 100 : 0, remainingSeconds: null, processedBytes: Number(job.processed_bytes) || 0, totalBytes: Number(job.total_bytes) || 0, status: complete ? "verified" : "failed" }, PROGRESS_TTL);
      return { statusCode: 200, body: { jobId, status: complete ? "verified" : "failed" }, continue: false };
    }
    const file = (state?.fileId && files.find(item => item.id === state.fileId)) || files[0];
    let activeState = state;
    if (activeState?.fileId !== file.id || activeState?.service !== file.source_service) activeState = { fileId: file.id, service: file.source_service, offset: 0 };
    const sourceToken = await getAccessToken("source", userId);
    const targetToken = await getAccessToken("destination", userId);
    const verifiedRows = await sb("dexter_google_migration_files?select=size_bytes&job_id=eq." + encodeURIComponent(jobId) + "&status=in.(verified,deleted)");
    const verifiedBytes = (verifiedRows || []).reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
    let processed = verifiedBytes + Number(activeState?.offset || 0);
    const totalBytes = Number(job.total_bytes) || files.reduce((sum, f) => sum + Number(f.size_bytes || 0), 0);
    let result;
    if (file.source_service === "drive") {
      result = await processDriveFile(jobId, userId, file, activeState, sourceToken, targetToken, processed, totalBytes);
    } else if (file.source_service === "photos") {
      const sessionRaw = parseRedis(await redis(["GET", "migration:photos-session:" + jobId]));
      if (!sessionRaw || sessionRaw.userId !== userId) throw new Error("photos_picker_session_expired_reselect_media");
      result = await processPhotosFile(jobId, userId, file, activeState, sourceToken, targetToken, sessionRaw.sessionId, processed, totalBytes);
    } else {
      throw new Error("unsupported_source_service");
    }
    if (result.state === null) await redis(["DEL", "migration:worker-state:" + jobId]);
    const refreshedJobs = await sb("dexter_google_migration_jobs?select=total_bytes&id=eq." + encodeURIComponent(jobId));
    const refreshedTotal = Number(refreshedJobs?.[0]?.total_bytes) || totalBytes || result.processed;
    const newProcessed = Math.max(processed, result.processed);
    await sb("dexter_google_migration_jobs?id=eq." + encodeURIComponent(jobId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ processed_bytes: newProcessed, updated_at: new Date().toISOString(), status: "copying" }) });
    await setProgress(jobId, newProcessed, refreshedTotal, "copying");
    await redis(["DEL", "migration:retry-count:" + jobId]).catch(() => {});
    shouldContinue = result.continue;
    return { statusCode: 200, body: { jobId, status: "copying", processedBytes: newProcessed, totalBytes: refreshedTotal, nextChunkScheduled: shouldContinue }, continue: shouldContinue };
  } catch (error) {
    const message = String(error?.message || "transfer_step_failed").slice(0, 300);
    const retryable = [429, 500, 502, 503, 504].includes(Number(error?.status)) || error?.name === "TypeError";
    const retryKey = "migration:retry-count:" + jobId;
    if (retryable) {
      const attempts = Number(await redis(["INCR", retryKey]).catch(() => 99));
      await redis(["EXPIRE", retryKey, "3600"]).catch(() => {});
      if (attempts <= 8) {
        return { statusCode: 200, body: { jobId, status: "retrying", retryableError: message, attempt: attempts }, continue: true, retryAfterSeconds: Number(error?.status) === 429 ? 30 : Math.min(60, 2 ** attempts) };
      }
    }
    await redis(["DEL", retryKey]).catch(() => {});
    const files = await sb("dexter_google_migration_files?select=id,source_file_id,source_service&job_id=eq." + encodeURIComponent(jobId) + "&status=in.(queued,copying)&order=id.asc").catch(() => []);
    const state = parseRedis(await redis(["GET", "migration:worker-state:" + jobId]).catch(() => null));
    const file = (state?.fileId && files.find(item => item.id === state.fileId)) || files?.[0];
    if (file) {
      const now = new Date().toISOString();
      await sb("dexter_google_migration_files?id=eq." + encodeURIComponent(file.id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error_message: message, updated_at: now }) }).catch(() => {});
      await sb("dexter_google_transfer_logs?job_id=eq." + encodeURIComponent(jobId) + "&source_service=eq." + file.source_service + "&file_id=eq." + encodeURIComponent(file.source_file_id), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", error_message: message, updated_at: now }) }).catch(() => {});
      await redis(["DEL", "migration:worker-state:" + jobId]).catch(() => {});
    }
    const remaining = await sb("dexter_google_migration_files?select=id&job_id=eq." + encodeURIComponent(jobId) + "&status=in.(queued,copying)").catch(() => []);
    if (remaining?.length) {
      await sb("dexter_google_migration_jobs?id=eq." + encodeURIComponent(jobId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "copying", updated_at: new Date().toISOString() }) }).catch(() => {});
      return { statusCode: 200, body: { jobId, status: "copying", lastFileError: message }, continue: true };
    }
    await redisSet("migration:progress:" + jobId, { jobId, status: "failed", error: message }, PROGRESS_TTL).catch(() => {});
    await sb("dexter_google_migration_jobs?id=eq." + encodeURIComponent(jobId), { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "failed", updated_at: new Date().toISOString() }) }).catch(() => {});
    return { statusCode: 200, body: { jobId, status: "failed", error: message }, continue: false };
  } finally {
    const current = await redis(["GET", lockKey]).catch(() => null);
    if (current === lockToken) await redis(["DEL", lockKey]).catch(() => {});
  }
}

export async function dispatchNextTransfer({ jobId, userId, delaySeconds = 0 }) {
  await publishNext(jobId, userId, delaySeconds);
}
