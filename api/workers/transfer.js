import { apiError, env, json, method } from "../_lib/runtime.js";
import { dispatchNextTransfer, runDurableTransferStep } from "../_lib/durable-transfer.js";

export default async function handler(req, res) {
  if (!method(req, res, ["POST"])) return;
  try {
    const supplied = req.headers["x-worker-secret"] || req.headers.authorization?.replace(/^Bearer /, "");
    if (!supplied || supplied !== env("WORKER_SHARED_SECRET")) return json(res, 401, { error: "unauthorized_worker" });
    const { jobId, userId } = req.body || {};
    if (typeof jobId !== "string" || typeof userId !== "string" || !jobId || !userId) {
      return json(res, 400, { error: "jobId_and_userId_required" });
    }
    const result = await runDurableTransferStep({ jobId, userId });
    if (result.continue) {
      try {
        await dispatchNextTransfer({ jobId, userId, delaySeconds: result.retryAfterSeconds || 0 });
      } catch {
        // Return a retryable status: the durable offset/session is already persisted,
        // so a QStash retry can safely continue from the server-confirmed offset.
        return json(res, 503, { jobId, status: "retry_scheduling_failed" });
      }
    }
    return json(res, result.statusCode, result.body);
  } catch (error) {
    return apiError(res, error);
  }
}
