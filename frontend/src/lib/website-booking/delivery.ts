import { randomUUID } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import type { Change, CustomerStore, Snapshot } from "../customer-workspaces/store.ts";
import { sendCustomerLifecycleMail } from "../workspace-auth/mail.ts";
import { uuid } from "./config.ts";
import { authorizeWorkerBinding, notificationDispatchPlan, notificationOperation, workerSiteScopes, type NotificationWorker, type WorkerSiteScope } from "./notifications.ts";

const workerId = "internal:website-email:v1";
const sendingLifetime = 10 * 60_000;
const maxBatch = 10;
type Sender = (to: string, subject: string, text: string) => Promise<string>;
type Cursor = {
  schemaVersion: 1; bindingId: string; attemptId: string | null; updatedAt: string;
  emptyQueueFingerprint?: string;
};
type Delivery = {
  schemaVersion: 1; bindingId: string; jobId: string; attemptId: string; workerId: string;
  dispatchId: string; state: "sending" | "accepted" | "sent" | "unknown";
  startedAt: string; updatedAt: string; providerId?: string; acknowledgedAt?: string; lastError?: string;
};
type Receipt = {
  id: string; bindingId: string; workerId?: string; attemptId?: string;
  state: "queued" | "sending" | "sent" | "failed" | "unknown";
  providerId?: string; ackHash?: string;
};
type ClaimResult = Extract<Awaited<ReturnType<typeof notificationOperation>>, { jobs: unknown[] }>;
type ClaimedJob = ClaimResult["jobs"][number];
type Outcome = "sent" | "unknown" | "pending";
const cursorKey = (bindingId: string) => `website:email-cursor:${bindingId}`;
const deliveryKey = (jobId: string) => `website:email-delivery:${jobId}`;
const queueKey = (bindingId: string) => `website:notification-index:${bindingId}`;
const validProviderId = (value: unknown): value is string => typeof value === "string" &&
  /^(?:[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{2,199}|<[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{2,197}>)$/.test(value);

export function emailDeliveryBindings() {
  let input: unknown;
  try { input = JSON.parse(process.env.WEBSITE_BOOKING_EMAIL_BINDINGS || "[]"); } catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
  if (!Array.isArray(input) || input.length > 100 || new Set(input).size !== input.length) throw Error("EMAIL_DELIVERY_UNAVAILABLE");
  try { return input.map(uuid); } catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
}

export function emailDeliverySiteScopes() {
  try { return workerSiteScopes(JSON.parse(process.env.WEBSITE_BOOKING_EMAIL_SITE_SCOPES || "[]")); }
  catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
}

function internalWorker(bindingIds: string[], siteScopes: WorkerSiteScope[]): NotificationWorker {
  return { id: workerId, token_sha256: "", binding_ids: bindingIds, site_scopes: siteScopes, actions: ["notifications"], channels: ["guestEmail", "ownerEmail"] };
}
async function resolvedBindings(store: CustomerStore, worker: NotificationWorker) {
  const found = [...worker.binding_ids];
  for (const scope of worker.site_scopes ?? []) {
    const siteKey = `website:site:${digest(JSON.stringify([scope.client_id, scope.site_id]))}`;
    const site = (await store.read<{ bindingId: string }>(siteKey)).value;
    if (!site) continue; // The owner has not approved a binding for this site yet.
    const bindingId = uuid(site.bindingId);
    await authorizeWorkerBinding(store, worker, bindingId, { requireOwner: false });
    if (!found.includes(bindingId)) found.push(bindingId);
  }
  return found;
}
function assertDelivery(value: Delivery | null, bindingId: string, jobId: string, attemptId: string): asserts value is Delivery {
  if (!value || value.schemaVersion !== 1 || value.bindingId !== bindingId || value.jobId !== jobId || value.attemptId !== attemptId ||
      value.workerId !== workerId || !["sending", "accepted", "sent", "unknown"].includes(value.state) ||
      !Number.isFinite(Date.parse(value.startedAt)) || typeof value.dispatchId !== "string") throw Error("STORE_UNAVAILABLE");
}
async function activeCursor(store: CustomerStore, bindingId: string, now: () => Date) {
  for (let retry = 0; retry < 5; retry++) {
    const snapshot = await store.read<Cursor>(cursorKey(bindingId));
    const current = snapshot.value;
    if (current && (current.schemaVersion !== 1 || current.bindingId !== bindingId ||
        (current.attemptId !== null && uuid(current.attemptId) !== current.attemptId))) throw Error("STORE_UNAVAILABLE");
    if (current?.attemptId) return current;
    // Idle polls do not manufacture permanent empty claim receipts. A new
    // outbox entry changes this fingerprint and wakes the next bounded scan.
    const queue = await store.read(queueKey(bindingId));
    if (current?.emptyQueueFingerprint === digest(queue.raw ?? "")) return null;
    const next: Cursor = { schemaVersion: 1, bindingId, attemptId: randomUUID(), updatedAt: now().toISOString() };
    try {
      await store.commit([{ key: cursorKey(bindingId), before: snapshot.raw, after: next }]);
      const check = (await store.read<Cursor>(cursorKey(bindingId))).value;
      if (check?.attemptId === next.attemptId) return check;
      // Another concurrent run may have already completed this attempt. It
      // still used the same outbox claim and pre-send record; retry the cursor.
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "VERSION_CONFLICT") throw error;
    }
  }
  throw Error("VERSION_CONFLICT");
}
async function finishCursor(store: CustomerStore, cursor: Cursor, now: () => Date, emptyQueueFingerprint?: string) {
  const saved = await store.read<Cursor>(cursorKey(cursor.bindingId));
  if (saved.value?.attemptId !== cursor.attemptId) return;
  const next: Cursor = { schemaVersion: 1, bindingId: cursor.bindingId, attemptId: null, updatedAt: now().toISOString(),
    ...(emptyQueueFingerprint ? { emptyQueueFingerprint } : {}) };
  await store.commit([{ key: cursorKey(cursor.bindingId), before: saved.raw, after: next }]);
  const check = (await store.read<Cursor>(cursorKey(cursor.bindingId))).value;
  if (!check || check.attemptId === cursor.attemptId) throw Error("WRITE_UNCONFIRMED");
}
async function replaceDelivery(store: CustomerStore, snapshot: Snapshot<Delivery>, next: Delivery, guards: Change[] = []) {
  await store.commit([{ key: deliveryKey(next.jobId), before: snapshot.raw, after: next }, ...guards]);
  const saved = await store.read<Delivery>(deliveryKey(next.jobId));
  if (JSON.stringify(saved.value) !== JSON.stringify(next)) throw Error("WRITE_UNCONFIRMED");
  return saved as Snapshot<Delivery> & { value: Delivery };
}
async function outboxReceipt(store: CustomerStore, delivery: Delivery) {
  const receipt = (await store.read<Receipt>(`website:notification:${delivery.jobId}`)).value;
  if (!receipt || receipt.id !== delivery.jobId || receipt.bindingId !== delivery.bindingId || receipt.workerId !== workerId || receipt.attemptId !== delivery.attemptId) throw Error("WRITE_UNCONFIRMED");
  return receipt;
}
async function acknowledge(store: CustomerStore, worker: NotificationWorker, saved: Snapshot<Delivery> & { value: Delivery }, now: () => Date): Promise<Outcome> {
  const delivery = saved.value;
  if (delivery.state === "sending") return "pending";
  const wantsSent = delivery.state === "accepted" || delivery.state === "sent";
  if (wantsSent && !validProviderId(delivery.providerId)) throw Error("WRITE_UNCONFIRMED");
  try {
    await notificationOperation(store, worker, {
      schemaVersion: 1, action: "ack", bindingId: delivery.bindingId, attemptId: delivery.attemptId, jobId: delivery.jobId,
      outcome: wantsSent ? "sent" : "unknown",
      ...(wantsSent ? { providerId: delivery.providerId } : { errorCode: "EMAIL_DELIVERY_UNCERTAIN" }),
    }, now());
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "NOTIFICATION_ACK_CONFLICT") throw error;
    const uncertain = await outboxReceipt(store, delivery);
    if (uncertain.state !== "unknown" || !uncertain.ackHash) throw error;
    // A concurrent timeout may already have explicitly acknowledged unknown.
    // Retain any late provider evidence for the separate reconciliation action;
    // this is never a reason to resend or assert provider readback happened.
    await replaceDelivery(store, saved, { ...delivery, state: "unknown", acknowledgedAt: now().toISOString(),
      updatedAt: now().toISOString(), lastError: "EMAIL_RECONCILIATION_REQUIRED" });
    return "unknown";
  }
  const receipt = await outboxReceipt(store, delivery);
  if (receipt.state === "sent" && validProviderId(receipt.providerId) &&
      (!wantsSent || receipt.providerId === delivery.providerId)) {
    await replaceDelivery(store, saved, { ...delivery, state: "sent", providerId: receipt.providerId,
      acknowledgedAt: now().toISOString(), updatedAt: now().toISOString() });
    return "sent";
  }
  if (receipt.state !== "unknown" || wantsSent) throw Error("WRITE_UNCONFIRMED");
  await replaceDelivery(store, saved, { ...delivery, state: "unknown", acknowledgedAt: now().toISOString(), updatedAt: now().toISOString() });
  return "unknown";
}

async function processDelivery(store: CustomerStore, worker: NotificationWorker, cursor: Cursor, claim: ClaimResult, send: Sender, now: () => Date): Promise<Outcome> {
  const job: ClaimedJob | undefined = claim.jobs[0];
  const jobId = job?.id ?? claim.results[0]?.jobId;
  if (!jobId || !cursor.attemptId) throw Error("INVALID_INPUT");
  let saved = await store.read<Delivery>(deliveryKey(jobId));
  if (saved.value) {
    assertDelivery(saved.value, cursor.bindingId, jobId, cursor.attemptId);
    if (saved.value.state === "sending") {
      if (Date.parse(saved.value.startedAt) + sendingLifetime > now().getTime()) return "pending";
      saved = await replaceDelivery(store, saved, { ...saved.value, state: "unknown", updatedAt: now().toISOString(), lastError: "EMAIL_WORKER_INTERRUPTED" });
    }
    return acknowledge(store, worker, saved as Snapshot<Delivery> & { value: Delivery }, now);
  }
  // The outbox lease expired or was revoked before any dispatch record existed.
  // There is no proof this process sent anything, and the lease is not reopened.
  if (!job || job.state !== "sending" || Date.parse(job.claimExpiresAt) <= now().getTime()) return "unknown";
  if (job.channel !== "guestEmail" && job.channel !== "ownerEmail") throw Error("FORBIDDEN");
  const sending: Delivery = { schemaVersion: 1, bindingId: cursor.bindingId, jobId, attemptId: cursor.attemptId,
    workerId, dispatchId: randomUUID(), state: "sending", startedAt: now().toISOString(), updatedAt: now().toISOString() };
  // This CAS and readback precede the sole external send. A crash at any point
  // after it leaves a durable uncertain attempt, never a sendable queued job.
  const dispatch = await notificationDispatchPlan(store, worker, cursor.bindingId, cursor.attemptId, jobId, now());
  saved = await replaceDelivery(store, saved, sending, dispatch.changes);
  let providerId: string;
  try {
    providerId = await send(dispatch.job.recipient, dispatch.job.subject, dispatch.job.text);
    if (!validProviderId(providerId)) throw Error("EMAIL_PROVIDER_RESPONSE_INVALID");
  } catch {
    saved = await replaceDelivery(store, saved, { ...sending, state: "unknown", updatedAt: now().toISOString(), lastError: "EMAIL_PROVIDER_UNCERTAIN" });
    return acknowledge(store, worker, saved as Snapshot<Delivery> & { value: Delivery }, now);
  }
  // SMTP/Gmail acceptance is provider evidence; it is not inbox delivery. If
  // persistence or ACK fails now, recovery may retry only persistence/ACK.
  saved = await replaceDelivery(store, saved, { ...sending, state: "accepted", providerId, updatedAt: now().toISOString() });
  return acknowledge(store, worker, saved as Snapshot<Delivery> & { value: Delivery }, now);
}

export async function runWebsiteExpiryReminders(store: CustomerStore, bindingIds: string[], options: { siteScopes?: WorkerSiteScope[]; now?: () => Date } = {}) {
  if (bindingIds.length > 100 || new Set(bindingIds).size !== bindingIds.length) throw Error("INVALID_INPUT");
  bindingIds.forEach(uuid);
  const worker = internalWorker(bindingIds, workerSiteScopes(options.siteScopes));
  const result = { bindings: 0, queued: 0 };
  for (const bindingId of await resolvedBindings(store, worker)) {
    try {
      const queued = await notificationOperation(store, worker, { schemaVersion: 1, action: "enqueue_expired", bindingId, attemptId: randomUUID() }, options.now?.() ?? new Date());
      if (!("queued" in queued)) throw Error("STORE_UNAVAILABLE");
      result.bindings++; result.queued += queued.queued;
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "BINDING_UNAVAILABLE") throw error;
    }
  }
  return result;
}

export async function runWebsiteEmailDelivery(
  store: CustomerStore, bindingIds: string[],
  options: { send?: Sender; now?: () => Date; maxJobs?: number; siteScopes?: WorkerSiteScope[]; enqueueExpired?: boolean } = {},
) {
  if (bindingIds.length > 100 || new Set(bindingIds).size !== bindingIds.length) throw Error("INVALID_INPUT");
  bindingIds.forEach(uuid);
  const limit = options.maxJobs ?? maxBatch;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxBatch) throw Error("INVALID_INPUT");
  const send = options.send ?? sendCustomerLifecycleMail, now = options.now ?? (() => new Date());
  const worker = internalWorker(bindingIds, workerSiteScopes(options.siteScopes));
  const result = { schemaVersion: 1, processed: 0, sent: 0, unknown: 0, pending: 0, scanned: 0 };
  let remaining = limit;
  for (const bindingId of await resolvedBindings(store, worker)) {
    if (remaining <= 0) break;
    if (options.enqueueExpired !== false) try {
      await notificationOperation(store, worker, { schemaVersion: 1, action: "enqueue_expired", bindingId, attemptId: randomUUID() }, now());
    } catch (error) {
      // A revoked owner's pending accepted receipt can still be acknowledged;
      // only new send claims require current binding/owner authorization.
      if (!(error instanceof Error) || error.message !== "BINDING_UNAVAILABLE") throw error;
    }
    while (remaining > 0) {
      const cursor = await activeCursor(store, bindingId, now);
      if (!cursor) break;
      remaining--; result.scanned++;
      try {
        const claim = await notificationOperation(store, worker, { schemaVersion: 1, action: "claim", bindingId, attemptId: cursor.attemptId,
          channels: ["guestEmail", "ownerEmail"] }, now());
        if (!("jobs" in claim)) throw Error("STORE_UNAVAILABLE");
        if (!claim.jobs.length && !claim.results.length) {
          await finishCursor(store, cursor, now, claim.hasMore ? undefined : claim.queueFingerprint);
          if (!claim.hasMore) break;
          continue;
        }
        const outcome = await processDelivery(store, worker, cursor, claim, send, now);
        result[outcome]++;
        if (outcome === "pending") break;
        result.processed++;
        await finishCursor(store, cursor, now);
      } catch {
        // Do not print provider errors, guest content, recipients or credentials.
        // The durable cursor/record determines the only allowed recovery path.
        result.pending++;
        break;
      }
    }
  }
  return result;
}
