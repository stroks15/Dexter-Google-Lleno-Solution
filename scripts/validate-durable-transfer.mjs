import fs from "node:fs";

const worker = fs.readFileSync("api/workers/transfer.js", "utf8");
const transfer = fs.readFileSync("api/_lib/durable-transfer.js", "utf8");
const enqueue = fs.readFileSync("api/migrations/enqueue.js", "utf8");
const required = [
  ["QStash continuation", transfer.includes("publishNext") && worker.includes("dispatchNextTransfer")],
  ["Redis resumable state", transfer.includes("migration:worker-state:") && transfer.includes("redisSet(")],
  ["per-job lock", transfer.includes("migration:worker-lock:") && transfer.includes('"NX"')],
  ["Drive byte ranges", transfer.includes("Range: \"bytes=")],
  ["Photos resumable upload", transfer.includes("X-Goog-Upload-Command") && transfer.includes("X-Goog-Upload-Offset")],
  ["streaming request bodies", transfer.includes("chunk.response.body") && transfer.includes('duplex: "half"')],
  ["bounded chunks", transfer.includes("const CHUNK_BYTES = 4 * 1024 * 1024")],
  ["async enqueue response", enqueue.includes('json(res,202,{jobId,status:"queued"})')],
  ["no whole-file arrayBuffer buffering", !transfer.includes("arrayBuffer()")],
];
const failures = required.filter(([, ok]) => !ok);
for (const [name, ok] of required) console.log((ok ? "PASS " : "FAIL ") + name);
if (failures.length) process.exit(1);
