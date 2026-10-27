import { createHash, timingSafeEqual } from "node:crypto";
import { transferWithRuntime } from "../dist/channel-review-runtime.mjs";
import { createFreshChannelAuthorization } from "./channel-worker.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const INTENT_FIELDS = "expectedCells,expectedClaimId,expectedInventoryVersion,expiresAt,issuedAt,propertyId,reviewReason,targetOperationKey";
const hash = value => createHash("sha256").update(value).digest();

function response(status, state) {
  return new Response(JSON.stringify({state}), {status, headers: {
    "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  }});
}

/** Deployment-pinned intent only. Neither target nor provider evidence comes from HTTP. */
function configuredIntent(env, now) {
  const digest = env.IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256;
  if (!/^[a-f0-9]{64}$/.test(digest ?? "")) return null;
  // Review authorization must be independent of all ordinary runtime callers.
  for (const value of [env.CRON_SECRET, env.IRON_GATE_CHANNEL_AUTH_TOKEN,
    env.IRON_GATE_CHANNEL_ALERT_TOKEN]) {
    if (typeof value === "string" && timingSafeEqual(hash(value), Buffer.from(digest, "hex")))
      return null;
  }
  let intent;
  try {
    const raw = env.IRON_GATE_CHANNEL_REVIEW_TRANSFER_INTENT_JSON;
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 65_536) return null;
    intent = JSON.parse(raw);
  } catch { return null; }
  if (!intent || Array.isArray(intent) || Object.keys(intent).sort().join(",") !== INTENT_FIELDS ||
    !UUID.test(intent.propertyId ?? "") || intent.propertyId !== env.IRON_GATE_CHANNEL_PROPERTY_ID ||
    !UUID.test(intent.targetOperationKey ?? "") || !UUID.test(intent.expectedClaimId ?? "") ||
    !Number.isSafeInteger(intent.expectedInventoryVersion) || intent.expectedInventoryVersion < 0 ||
    typeof intent.reviewReason !== "string" || intent.reviewReason.trim().length < 8 ||
    intent.reviewReason.length > 256 || !Array.isArray(intent.expectedCells) ||
    intent.expectedCells.length === 0 || intent.expectedCells.length > 512) return null;
  const issuedAt = Date.parse(intent.issuedAt), expiresAt = Date.parse(intent.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) ||
    new Date(issuedAt).toISOString() !== intent.issuedAt ||
    new Date(expiresAt).toISOString() !== intent.expiresAt ||
    issuedAt > now || expiresAt <= now || expiresAt <= issuedAt ||
    expiresAt - issuedAt > 15 * 60_000) return null;
  const seen = new Set();
  for (const cell of intent.expectedCells) {
    const date = Date.parse(cell?.date), key = `${cell?.roomId}|${cell?.date}`;
    if (!cell || Object.keys(cell).sort().join(",") !== "date,desired,roomId" ||
      !UUID.test(cell.roomId ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(cell.date ?? "") ||
      !Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== cell.date ||
      !["open", "closed"].includes(cell.desired) || seen.has(key)) return null;
    seen.add(key);
  }
  return intent;
}

async function emptyObjectBody(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? ""))
    return false;
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > 128)) return false;
  const reader = request.body?.getReader();
  if (!reader) return false;
  let bytes = 0, body = "";
  const decoder = new TextDecoder("utf-8", {fatal: true});
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128) { await reader.cancel(); return false; }
      body += decoder.decode(value, {stream: true});
    }
    body += decoder.decode();
    // Accept only an empty object, including normal JSON whitespace.
    return /^[\x20\t\r\n]*\{[\x20\t\r\n]*\}[\x20\t\r\n]*$/.test(body);
  } catch { return false; }
  finally { reader.releaseLock(); }
}

/** Disabled by default; a single expiring deployment can execute one exact legacy transfer. */
export function createChannelReviewTransferFetch(env = process.env, dependencies = {}) {
  const now = dependencies.now ?? Date.now;
  const execute = dependencies.execute ?? (intent => transferWithRuntime({...intent, runtimeEnv: env},
    {createAuthorization: createFreshChannelAuthorization}));
  return async request => {
    if (env.VERCEL_ENV !== "production" || env.IRON_GATE_PRODUCTION_ENABLED !== "true" ||
      env.IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED !== "true" ||
      env.IRON_GATE_PRODUCTION_CHANNEL_REVIEW_TRANSFER_ENABLED !== "true")
      return response(404, "disabled");
    if (request.method !== "POST") return response(405, "method_not_allowed");
    const url = new URL(request.url);
    if (url.pathname !== "/api/channel-review-transfer" || url.search)
      return response(400, "invalid_request");
    const intent = configuredIntent(env, now());
    if (!intent) return response(403, "unavailable");
    const authorization = request.headers.get("authorization") ?? "";
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!SECRET.test(token) || !timingSafeEqual(hash(token),
      Buffer.from(env.IRON_GATE_CHANNEL_REVIEW_TRANSFER_TOKEN_SHA256, "hex")))
      return response(401, "unauthorized");
    if (!await emptyObjectBody(request)) return response(400, "invalid_request");
    // The body may arrive slowly; expiration is checked again before runtime access,
    // then in the transfer's claim transaction after its provider GET.
    if (!configuredIntent(env, now())) return response(403, "unavailable");
    try {
      const result = await execute(intent);
      if (!["sync_verified", "review_required"].includes(result?.state) ||
        result.propertyId !== intent.propertyId || result.operationKey !== intent.targetOperationKey)
        return response(503, "unavailable");
      return response(result.state === "sync_verified" ? 200 : 409, result.state);
    } catch (error) {
      const conflict = ["CHANNEL_REVIEW_TRANSFER_STATE_MOVED", "CHANNEL_REVIEW_TRANSFER_EXPIRED",
        "CHANNEL_REVIEW_TRANSFER_READBACK_INVALID", "CHANNEL_REVIEW_BLOCKED",
        "CHANNEL_PROPERTY_CLAIMED", "CHANNEL_OPERATION_NOT_DISPATCHABLE"].includes(error?.message);
      return response(conflict ? 409 : 503, conflict ? "state_moved" : "unavailable");
    }
  };
}

export default {fetch: createChannelReviewTransferFetch()};
