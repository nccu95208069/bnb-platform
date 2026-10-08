import { digest } from "../customer-workspaces/auth.ts";
import type { Change, CustomerStore, Snapshot } from "../customer-workspaces/store.ts";
import type { Booking, Workspace } from "../customer-workspaces/types.ts";
import { email, fields, id, record, sameSecret, uuid } from "./config.ts";
import type { NotificationChannel, WebsiteBinding, WebsiteBooking, WebsiteNotification } from "./types.ts";

const channels: NotificationChannel[] = ["guestEmail", "ownerEmail", "ownerLine"];
const events = ["hold_created", "hold_expired", "hold_extended", "hold_converted", "hold_released", "booking_changed", "booking_cancelled"] as const;
const claimLifetime = 10 * 60_000;
const maxPending = 10_000;
const maxScan = 100;
type Event = WebsiteNotification["event"];
type PublicState = "queued" | "sent" | "failed" | "unknown";
type Payload = { recipient: string | null; subject: string; text: string };
type Job = WebsiteNotification & Payload & { schemaVersion: 1; semanticFingerprint: string; semanticFingerprintVersion?: 1 | 2; ackHash?: string; reconcileHash?: string; reconciledAt?: string };
type Index = { schemaVersion: 1; ids: string[] };
type Claim = { schemaVersion: 1; bindingId: string; workerId: string; attemptId: string; channels: NotificationChannel[]; jobId: string | null; createdAt: string; hasMore: boolean; queueFingerprint: string };
type Scan = { schemaVersion: 1; next: string | null };
export type WorkerSiteScope = { client_id: string; site_id: string };
export type NotificationWorker = { id: string; token_sha256: string; binding_ids: string[]; actions: string[]; channels?: NotificationChannel[]; site_scopes?: WorkerSiteScope[] };

const jobKey = (jobId: string) => `website:notification:${jobId}`;
const indexKey = (bindingId: string) => `website:notification-index:${bindingId}`;
const claimKey = (bindingId: string, workerId: string, attemptId: string) => `website:notification-claim:${bindingId}:${digest(workerId)}:${attemptId}`;
const jobId = (booking: WebsiteBooking, event: Event, channel: NotificationChannel) => digest(JSON.stringify([booking.id, booking.version, event, channel]));
const active = (job: Job) => job.state === "queued" || job.state === "sending";
const publicState = (state: Job["state"]): PublicState => state === "sending" ? "unknown" : state;
const safeLine = (value: string) => value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").slice(0, 160);

// General booking revisions include private notes, tags and receipt bookkeeping.
// They must not discard a still-correct notification. Configuration/policy text
// remains the immutable text accepted when this outbox event was created.
// Version 1 is retained for persisted jobs/expiry receipts from before deposit
// and accepted-terms tracking; a deployment must not supersede those by itself.
export function notificationFingerprint(booking: Booking, version: 1 | 2 = 2) {
  if (!booking.website || (version !== 1 && version !== 2)) throw Error("INVALID_INPUT");
  return digest(JSON.stringify({
    id: booking.id, propertyId: booking.propertyId, status: booking.status,
    hold: booking.hold ? { schema: booking.hold.schema, scope: booking.hold.scope, state: booking.hold.state,
      startedAt: booking.hold.startedAt, expiresAt: booking.hold.expiresAt,
      convertedAt: booking.hold.convertedAt, releasedAt: booking.hold.releasedAt } : null,
    checkIn: booking.checkIn, checkOut: booking.checkOut, roomIds: [...booking.roomIds].sort(), total: booking.total,
    ...(version === 2 ? { expectedDeposit: booking.expectedDeposit ?? null } : {}),
    reference: booking.website.reference, bindingId: booking.website.bindingId,
    email: booking.website.email, phone: booking.website.phone, guestName: booking.guestName,
    ...(version === 2 ? { acceptedTerms: booking.website.acceptedTerms ? {
      transferInstructions: booking.website.acceptedTerms.transferInstructions,
      cancellationPolicy: booking.website.acceptedTerms.cancellationPolicy,
    } : null } : {}),
  }));
}

function lineRecipient(binding: WebsiteBinding, now: Date) {
  const line = binding.ownerLine;
  if (!line || !/^[UCR][a-f0-9]{32}$/i.test(line.recipientId) ||
      typeof line.verifiedBy !== "string" || !line.verifiedBy.trim() ||
      !Number.isFinite(Date.parse(line.verifiedAt)) || Date.parse(line.verifiedAt) > now.getTime()) return null;
  return line.recipientId;
}
function recipient(binding: WebsiteBinding, booking: WebsiteBooking, channel: NotificationChannel, now: Date) {
  if (channel === "ownerLine") return lineRecipient(binding, now);
  try { return email(channel === "guestEmail" ? booking.website.email : binding.ownerEmail); }
  catch { return null; }
}
function payload(binding: WebsiteBinding, booking: WebsiteBooking, event: Event, channel: NotificationChannel, now: Date): Payload {
  const labels: Record<Event, string> = {
    hold_created: "訂房保留已建立", hold_expired: "訂房保留期限已到，等待旅宿確認",
    hold_extended: "訂房保留期限已延長", hold_converted: "已確認訂金並轉為正式訂單", hold_released: "訂房保留已釋放",
    booking_changed: "訂單資料已更新", booking_cancelled: "訂單已取消",
  };
  const deadline = booking.hold?.expiresAt;
  const changedHeld = event === "booking_changed" && booking.status === "held";
  const acceptedTerms = booking.website.acceptedTerms;
  const includeTerms = channel === "guestEmail" && (["hold_created", "hold_extended"].includes(event) || changedHeld);
  const lines = [
    `${safeLine(binding.siteName)}：${labels[event]}。`,
    `預訂編號：${safeLine(booking.website.reference)}`,
    `入住：${booking.checkIn}；退房：${booking.checkOut}`,
    `房間數：${booking.roomIds.length}`,
    ...(booking.total !== null ? [`房費總額：TWD ${booking.total.toFixed(2)}`] : []),
    ...(typeof booking.expectedDeposit === "number" && Number.isFinite(booking.expectedDeposit) ? [`約定訂金：TWD ${booking.expectedDeposit.toFixed(2)}`] : []),
    ...(deadline && (["hold_created", "hold_extended", "hold_expired"].includes(event) || changedHeld) ? [
      `保留期限（台灣時間）：${new Intl.DateTimeFormat("zh-TW", { timeZone: "Asia/Taipei", dateStyle: "medium", timeStyle: "short", hour12: false }).format(new Date(deadline))}`,
      "保留期限到後仍待旅宿決定，不會自動釋放房間。",
    ] : []),
    ...(changedHeld ? [
      ...(deadline && Date.parse(deadline) <= now.getTime() ? ["保留期限已到，仍待旅宿決定。"] : []),
      "本次資料更新不會自動延長保留期限；期限到後不會自動取消訂單。",
    ] : []),
    ...(event === "booking_changed" && booking.status === "confirmed" ? ["訂單狀態：已確認；付款狀況請以旅宿確認為準。"] : []),
    ...(includeTerms ? [
      "付款說明：", acceptedTerms?.transferInstructions || "請聯絡旅宿核對原訂單的付款說明。",
      "取消規則：", acceptedTerms?.cancellationPolicy || "請聯絡旅宿核對原訂單的取消規則。",
    ] : []),
    ...(channel !== "guestEmail" ? [
      `旅客：${safeLine(booking.guestName ?? "未填")}`,
      `聯絡信箱：${booking.website.email}`, `聯絡電話：${booking.website.phone}`,
    ] : []),
  ];
  return { recipient: recipient(binding, booking, channel, now), subject: `[Sweetfun OS] ${safeLine(binding.siteName)} ${labels[event]}`, text: lines.join("\n") };
}
function indexValue(snapshot: Snapshot<Index>): Index {
  const value = snapshot.value ?? { schemaVersion: 1, ids: [] };
  if (value.schemaVersion !== 1 || !Array.isArray(value.ids) || value.ids.length > maxPending ||
      value.ids.some(v => typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) || new Set(value.ids).size !== value.ids.length) throw Error("STORE_UNAVAILABLE");
  return value;
}
function assertJob(job: Job | null, bindingId: string, expectedId: string): asserts job is Job {
  if (!job || job.schemaVersion !== 1 || job.id !== expectedId || job.bindingId !== bindingId ||
      !channels.includes(job.channel) || !events.includes(job.event) || !["queued", "sending", "sent", "failed", "unknown"].includes(job.state) ||
      !Number.isSafeInteger(job.bookingVersion) || job.bookingVersion < 1 ||
      typeof job.semanticFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(job.semanticFingerprint) ||
      (job.semanticFingerprintVersion !== undefined && job.semanticFingerprintVersion !== 1 && job.semanticFingerprintVersion !== 2) ||
      (["booking_changed", "booking_cancelled"].includes(job.event) && job.semanticFingerprintVersion !== 2) ||
      typeof job.subject !== "string" || typeof job.text !== "string" ||
      (job.recipient !== null && typeof job.recipient !== "string")) throw Error("STORE_UNAVAILABLE");
}

// The caller must commit these changes together with its canonical booking and
// request receipt. Planning alone neither occupies a room nor queues a send.
export async function notificationPlan(store: CustomerStore, binding: WebsiteBinding, booking: WebsiteBooking, event: Event, now = new Date()) {
  if (!events.includes(event) || booking.website.bindingId !== binding.id || booking.propertyId !== binding.propertyId ||
      !Number.isSafeInteger(booking.version) || booking.version < 1) throw Error("INVALID_INPUT");
  const index = await store.read<Index>(indexKey(binding.id));
  const ids = [...indexValue(index).ids];
  const changes: Change[] = [];
  const notificationIds: Partial<Record<NotificationChannel, string>> = {};
  // Expiry is an owner decision while occupancy remains held. Do not generate
  // a guest email that could be mistaken for cancellation or release.
  for (const channel of event === "hold_expired" ? channels.filter(c => c !== "guestEmail") : channels) {
    const notificationId = jobId(booking, event, channel);
    notificationIds[channel] = notificationId;
    const existing = await store.read<Job>(jobKey(notificationId));
    let job: Job;
    if (existing.value) {
      assertJob(existing.value, binding.id, notificationId);
      job = existing.value;
      if (job.workspaceId !== binding.workspaceId || job.bookingId !== booking.id || job.bookingVersion !== booking.version || job.event !== event || job.channel !== channel) throw Error("NOTIFICATION_CONFLICT");
    } else {
      const content = payload(binding, booking, event, channel, now);
      job = {
        schemaVersion: 1, id: notificationId, bindingId: binding.id, workspaceId: binding.workspaceId,
        bookingId: booking.id, bookingVersion: booking.version, semanticFingerprint: notificationFingerprint(booking), semanticFingerprintVersion: 2, channel, event,
        ...content, state: content.recipient ? "queued" : "failed", createdAt: now.toISOString(),
        ...(!content.recipient ? { completedAt: now.toISOString(), lastError: "RECIPIENT_UNBOUND" } : {}),
      };
      changes.push({ key: jobKey(job.id), before: existing.raw, after: job });
    }
    if (active(job) && !ids.includes(job.id)) ids.push(job.id);
  }
  if (ids.length > maxPending) throw Error("NOTIFICATION_QUEUE_FULL");
  if (JSON.stringify(ids) !== JSON.stringify(indexValue(index).ids)) changes.push({ key: indexKey(binding.id), before: index.raw, after: { schemaVersion: 1, ids } });
  return { changes, notificationIds };
}

// The only notification projection available to a guest lookup. Missing or
// inconsistent records are unknown; absence is never evidence of delivery.
export async function notificationStates(store: CustomerStore, booking: WebsiteBooking): Promise<Record<NotificationChannel, PublicState>> {
  const states = {} as Record<NotificationChannel, PublicState>;
  for (const channel of channels) {
    const notificationId = booking.website.notificationIds[channel];
    if (!notificationId) { states[channel] = "unknown"; continue; }
    const job = (await store.read<Job>(jobKey(notificationId))).value;
    states[channel] = job && job.bindingId === booking.website.bindingId && job.bookingId === booking.id && job.channel === channel &&
      job.bookingVersion <= booking.version && ["queued", "sending", "sent", "failed", "unknown"].includes(job.state) ? publicState(job.state) : "unknown";
  }
  return states;
}

export function workerSiteScopes(value: unknown): WorkerSiteScope[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw Error("INVALID_INPUT");
  const result = value.map(item => {
    const scope = record(item); fields(scope, ["client_id", "site_id"]);
    return { client_id: id(scope.client_id), site_id: id(scope.site_id) };
  });
  if (new Set(result.map(s => JSON.stringify(s))).size !== result.length) throw Error("INVALID_INPUT");
  return result;
}

// This separate allowlist never falls back to the guest binding or editor token.
export function notificationWorker(token: string | null, requiredAction: "notifications" | "line_binding" | "owner_actions" = "notifications"): NotificationWorker {
  let parsed: unknown;
  try { parsed = JSON.parse(process.env.WEBSITE_BOOKING_WORKERS || "[]"); } catch { throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
  if (!Array.isArray(parsed) || parsed.length > 50) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  const rows: NotificationWorker[] = [];
  const seen = new Set<string>();
  const tokens = new Set<string>();
  for (const row of parsed) {
    try {
      const c = record(row);
      fields(c, ["id", "token_sha256", "binding_ids", "actions", "channels", "site_scopes"]);
      const workerId = id(c.id);
      const bindingIds = c.binding_ids ?? [], siteScopes = workerSiteScopes(c.site_scopes);
      if (seen.has(workerId) || typeof c.token_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(c.token_sha256) || tokens.has(c.token_sha256) ||
          !Array.isArray(bindingIds) || bindingIds.length > 100 || bindingIds.some(v => uuid(v) !== v) || new Set(bindingIds).size !== bindingIds.length ||
          (!bindingIds.length && !siteScopes.length) ||
          !Array.isArray(c.actions) || !c.actions.length || new Set(c.actions).size !== c.actions.length || c.actions.some(v => !["notifications", "line_binding", "owner_actions"].includes(v)) ||
          (c.channels !== undefined && (!Array.isArray(c.channels) || !c.channels.length || c.channels.some(v => !channels.includes(v)) || new Set(c.channels).size !== c.channels.length))) throw Error();
      seen.add(workerId); tokens.add(c.token_sha256); rows.push({ ...c, binding_ids: bindingIds, site_scopes: siteScopes } as NotificationWorker);
    } catch { throw Error("WEBSITE_BOOKING_UNAVAILABLE"); }
  }
  const found = rows.find(w => token && token.length >= 32 && token.length <= 512 && sameSecret(w.token_sha256, digest(token)));
  if (!found || !found.actions.includes(requiredAction)) throw Error("UNAUTHORIZED");
  return found;
}

function expired(job: Job, now: Date) {
  return job.state === "sending" && (!job.claimedAt || !Number.isFinite(Date.parse(job.claimedAt)) || Date.parse(job.claimedAt) + claimLifetime <= now.getTime());
}
function timedOut(job: Job, now: Date): Job {
  return { ...job, state: "unknown", completedAt: now.toISOString(), lastError: "CLAIM_EXPIRED" };
}
function workerJob(job: Job) {
  if (job.state !== "sending" || !job.recipient || !job.attemptId || !job.claimedAt) throw Error("STORE_UNAVAILABLE");
  return {
    id: job.id, attemptId: job.attemptId, event: job.event, channel: job.channel,
    recipient: job.recipient, subject: job.subject, text: job.text, bookingId: job.bookingId, bookingVersion: job.bookingVersion,
    state: "sending" as const, claimExpiresAt: new Date(Date.parse(job.claimedAt) + claimLifetime).toISOString(),
  };
}
function deliveryGuard(binding: WebsiteBinding, workspace: Workspace | null, job: Job, now: Date) {
  const booking = workspace?.bookings.find(b => b.id === job.bookingId) as WebsiteBooking | undefined;
  if (!workspace || workspace.id !== binding.workspaceId || !booking?.website || booking.website.bindingId !== binding.id ||
      booking.propertyId !== binding.propertyId || booking.version < job.bookingVersion) return "BOOKING_UNAVAILABLE";
  if (notificationFingerprint(booking, job.semanticFingerprintVersion ?? 1) !== job.semanticFingerprint) return "SUPERSEDED";
  const hold = booking.hold;
  const held = booking.status === "held" && (hold?.state === "active" || hold?.state === "awaiting_owner");
  if ((["hold_created", "hold_extended"].includes(job.event) && (!held || !hold || Date.parse(hold.expiresAt) <= now.getTime())) ||
      (job.event === "hold_expired" && (!held || !hold || Date.parse(hold.expiresAt) > now.getTime())) ||
      (job.event === "hold_converted" && (booking.status !== "confirmed" || hold?.state !== "converted")) ||
      (job.event === "hold_released" && (booking.status !== "cancelled" || hold?.state !== "released")) ||
      (job.event === "booking_changed" && booking.status !== "held" && booking.status !== "confirmed") ||
      (job.event === "booking_cancelled" && booking.status !== "cancelled")) return "SUPERSEDED";
  if (!workspace.members.some(m => m.accountId === binding.ownerAccountId && m.active && m.role === "owner" &&
      (m.allProperties || m.propertyIds.includes(binding.propertyId)))) return "RECIPIENT_REVOKED";
  const current = recipient(binding, booking, job.channel, now);
  if (!current) return "RECIPIENT_UNBOUND";
  if (current !== job.recipient) return "RECIPIENT_CHANGED";
  return null;
}
// An exact site grant follows only the approved binding in that site's existing
// server-owned index. Caller-supplied tenant/owner values and wildcards are never
// authority. Returned guards let owner actions fence revocation in their CAS.
export async function authorizeWorkerBinding(store: CustomerStore, worker: NotificationWorker, bindingId: string, options: { requireOwner?: boolean } = {}) {
  uuid(bindingId);
  const explicit = worker.binding_ids.includes(bindingId);
  const bindingSnapshot = await store.read<WebsiteBinding>(`website:binding:${bindingId}`);
  const binding = bindingSnapshot.value;
  if (!binding || binding.id !== bindingId) throw Error(explicit ? "NOT_FOUND" : "FORBIDDEN");
  const guards: Change[] = [{ key: `website:binding:${bindingId}`, before: bindingSnapshot.raw, after: binding }];
  if (!explicit) {
    const scope = worker.site_scopes?.find(s => s.client_id === binding.clientId && s.site_id === binding.siteId);
    if (!scope) throw Error("FORBIDDEN");
    const key = `website:site:${digest(JSON.stringify([scope.client_id, scope.site_id]))}`;
    const site = await store.read<{ bindingId: string; ownerAccountId: string }>(key);
    if (site.value?.bindingId !== bindingId || site.value.ownerAccountId !== binding.ownerAccountId ||
        !binding.approvedAt || !Number.isFinite(Date.parse(binding.approvedAt))) throw Error("FORBIDDEN");
    guards.push({ key, before: site.raw, after: site.value });
  }
  const workspaceSnapshot = await store.read<Workspace>(`workspace:${binding.workspaceId}`), workspace = workspaceSnapshot.value;
  if (options.requireOwner !== false && (!workspace || workspace.id !== binding.workspaceId ||
      !workspace.properties.some(p => p.id === binding.propertyId) ||
      !workspace.members.some(m => m.accountId === binding.ownerAccountId && m.active && m.role === "owner" &&
        (m.allProperties || m.propertyIds.includes(binding.propertyId))))) throw Error("BINDING_UNAVAILABLE");
  if (workspace) guards.push({ key: `workspace:${binding.workspaceId}`, before: workspaceSnapshot.raw, after: workspace });
  return { binding, bindingSnapshot: bindingSnapshot as Snapshot<WebsiteBinding> & { value: WebsiteBinding }, workspace, workspaceSnapshot, guards };
}

// Discovery follows only preconfigured grants and each exact site's index. It
// cannot enumerate workspaces or accept additional authority from a request.
export async function discoverWorkerBindings(store: CustomerStore, worker: NotificationWorker, now = new Date()) {
  if (!worker.actions.includes("notifications")) throw Error("FORBIDDEN");
  const candidates = new Set(worker.binding_ids);
  for (const scope of worker.site_scopes ?? []) {
    const site = await store.read<{ bindingId: string }>(`website:site:${digest(JSON.stringify([scope.client_id, scope.site_id]))}`);
    if (!site.value) continue;
    try { candidates.add(uuid(site.value.bindingId)); } catch { throw Error("STORE_UNAVAILABLE"); }
  }
  const bindings: { bindingId: string; lineConnected: boolean; inventoryMode: "platform_only" }[] = [];
  for (const bindingId of [...candidates].sort()) {
    let binding: WebsiteBinding;
    try { binding = (await authorizeWorkerBinding(store, worker, bindingId)).binding; }
    catch (error) {
      if (error instanceof Error && ["NOT_FOUND", "FORBIDDEN", "BINDING_UNAVAILABLE"].includes(error.message)) continue;
      throw error;
    }
    if (binding.inventoryMode !== "platform_only" || !binding.approvedAt ||
        !Number.isFinite(Date.parse(binding.approvedAt)) || Date.parse(binding.approvedAt) > now.getTime()) continue;
    bindings.push({ bindingId, lineConnected: lineRecipient(binding, now) !== null, inventoryMode: "platform_only" });
  }
  return bindings;
}

export async function notificationDispatchPlan(store: CustomerStore, worker: NotificationWorker, bindingId: string, attemptId: string, jobId: string, now = new Date()) {
  const authorized = await authorizeWorkerBinding(store, worker, bindingId);
  if (!worker.actions.includes("notifications")) throw Error("FORBIDDEN");
  const snapshot = await store.read<Job>(jobKey(jobId));
  assertJob(snapshot.value, bindingId, jobId);
  const job = snapshot.value;
  if (!(worker.channels ?? channels).includes(job.channel) || job.workerId !== worker.id || job.attemptId !== attemptId ||
      job.state !== "sending" || expired(job, now) || deliveryGuard(authorized.binding, authorized.workspace, job, now)) throw Error("NOTIFICATION_DISPATCH_UNAVAILABLE");
  return { job: workerJob(job), changes: [...authorized.guards, { key: jobKey(jobId), before: snapshot.raw, after: job }] as Change[] };
}

async function replayClaim(store: CustomerStore, worker: NotificationWorker, receipt: Claim, binding: WebsiteBinding, now: Date) {
  if (!receipt.jobId) return { schemaVersion: 1, jobs: [], results: [], replayed: true, hasMore: receipt.hasMore, queueFingerprint: receipt.queueFingerprint };
  const snapshot = await store.read<Job>(jobKey(receipt.jobId));
  assertJob(snapshot.value, binding.id, receipt.jobId);
  let job = snapshot.value;
  if (job.workerId !== receipt.workerId || job.attemptId !== receipt.attemptId || job.workspaceId !== binding.workspaceId) throw Error("STORE_UNAVAILABLE");
  if (job.state === "sending") {
    const authorized = await authorizeWorkerBinding(store, worker, binding.id, { requireOwner: false });
    const denied = authorized.binding.workspaceId !== job.workspaceId ? "RECIPIENT_REVOKED" : deliveryGuard(authorized.binding, authorized.workspace, job, now);
    if (expired(job, now)) job = timedOut(job, now);
    else if (denied) job = { ...job, state: "unknown", completedAt: now.toISOString(), lastError: denied };
    const changes: Change[] = [
      { key: jobKey(job.id), before: snapshot.raw, after: job },
      ...authorized.guards,
    ];
    await store.commit(changes);
  }
  // A replay recovers the same lease; it must not be treated as a new delivery
  // attempt. Completed/uncertain attempts never expose another sendable payload.
  return { schemaVersion: 1, jobs: job.state === "sending" ? [workerJob(job)] : [], results: [{ jobId: job.id, state: publicState(job.state) }], replayed: true,
    hasMore: receipt.hasMore, queueFingerprint: receipt.queueFingerprint };
}
async function claim(store: CustomerStore, worker: NotificationWorker, bindingId: string, attemptId: string, selectedChannels: NotificationChannel[], now: Date) {
  const receiptKey = claimKey(bindingId, worker.id, attemptId);
  const scanKey = `website:notification-scan:${bindingId}:${digest(JSON.stringify([worker.id, selectedChannels]))}`;
  for (let retry = 0; retry < 5; retry++) {
    try {
      const authorized = await authorizeWorkerBinding(store, worker, bindingId, { requireOwner: false }), binding = authorized.binding;
      const oldClaim = await store.read<Claim>(receiptKey);
      if (oldClaim.value) {
        if (oldClaim.value.schemaVersion !== 1 || oldClaim.value.bindingId !== bindingId || oldClaim.value.workerId !== worker.id || oldClaim.value.attemptId !== attemptId) throw Error("STORE_UNAVAILABLE");
        if (JSON.stringify(oldClaim.value.channels) !== JSON.stringify(selectedChannels)) throw Error("NOTIFICATION_CLAIM_CONFLICT");
        return await replayClaim(store, worker, oldClaim.value, binding, now);
      }
      const workspace = authorized.workspaceSnapshot;
      const index = await store.read<Index>(indexKey(bindingId)), queue = indexValue(index);
      const scan = await store.read<Scan>(scanKey);
      if (scan.value && (scan.value.schemaVersion !== 1 || (scan.value.next !== null && !/^[a-f0-9]{64}$/.test(scan.value.next)))) throw Error("STORE_UNAVAILABLE");
      const start = Math.max(0, scan.value?.next ? queue.ids.indexOf(scan.value.next) : 0);
      const end = Math.min(queue.ids.length, start + maxScan);
      const changes: Change[] = [];
      const remove = new Set<string>();
      let selected: Job | null = null;
      let nextPosition = start;
      for (const notificationId of queue.ids.slice(start, end)) {
        nextPosition++;
        const snapshot = await store.read<Job>(jobKey(notificationId));
        assertJob(snapshot.value, bindingId, notificationId);
        const job = snapshot.value;
        if (job.workspaceId !== binding.workspaceId) throw Error("STORE_UNAVAILABLE");
        if (!selectedChannels.includes(job.channel)) continue;
        if (expired(job, now)) {
          changes.push({ key: jobKey(job.id), before: snapshot.raw, after: timedOut(job, now) }); remove.add(job.id); continue;
        }
        if (!active(job)) { remove.add(job.id); continue; }
        if (job.state === "sending") continue;
        const denied = deliveryGuard(binding, workspace.value, job, now);
        if (denied) {
          changes.push({ key: jobKey(job.id), before: snapshot.raw, after: { ...job, state: "failed", completedAt: now.toISOString(), lastError: denied } });
          remove.add(job.id); continue;
        }
        selected = { ...job, state: "sending", workerId: worker.id, attemptId, claimedAt: now.toISOString() };
        changes.push({ key: jobKey(job.id), before: snapshot.raw, after: selected }); break;
      }
      const remaining: Index = { schemaVersion: 1, ids: queue.ids.filter(v => !remove.has(v)) };
      const receipt: Claim = { schemaVersion: 1, bindingId, workerId: worker.id, attemptId, channels: selectedChannels, jobId: selected?.id ?? null, createdAt: now.toISOString(),
        hasMore: !selected && nextPosition < queue.ids.length, queueFingerprint: digest(remove.size ? JSON.stringify(remaining) : index.raw ?? "") };
      changes.push({ key: receiptKey, before: oldClaim.raw, after: receipt });
      changes.push({ key: scanKey, before: scan.raw, after: { schemaVersion: 1, next: queue.ids[nextPosition] ?? null } });
      if (remove.size) changes.push({ key: indexKey(bindingId), before: index.raw, after: remaining });
      // Revocation racing with claim must win the same CAS, before PII leaves.
      changes.push(...authorized.guards);
      await store.commit(changes);
      const verified = await store.read<Claim>(receiptKey);
      if (JSON.stringify(verified.value) !== JSON.stringify(receipt)) throw Error("WRITE_UNCONFIRMED");
      return { ...await replayClaim(store, worker, receipt, binding, now), replayed: false };
    } catch (error) {
      if (error instanceof Error && error.message === "VERSION_CONFLICT" && retry < 4) continue;
      throw error;
    }
  }
  throw Error("VERSION_CONFLICT");
}
function acknowledgement(input: Record<string, unknown>) {
  if (typeof input.jobId !== "string" || !/^[a-f0-9]{64}$/.test(input.jobId) || typeof input.outcome !== "string" || !["sent", "failed", "unknown"].includes(input.outcome)) throw Error("INVALID_INPUT");
  const providerId = input.providerId;
  if (providerId !== undefined && (typeof providerId !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{2,199}|<[A-Za-z0-9][A-Za-z0-9_.:@/+=-]{2,197}>)$/.test(providerId))) throw Error("INVALID_INPUT");
  const errorCode = input.errorCode;
  if (errorCode !== undefined && (typeof errorCode !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(errorCode))) throw Error("INVALID_INPUT");
  if (input.outcome === "sent" && (!providerId || errorCode !== undefined)) throw Error("PROVIDER_PROOF_REQUIRED");
  const outcome = input.outcome as "sent" | "failed" | "unknown";
  return { jobId: input.jobId, outcome, providerId: providerId as string | undefined,
    errorCode: outcome === "sent" ? undefined : (errorCode as string | undefined) ?? (outcome === "failed" ? "DELIVERY_FAILED" : "DELIVERY_UNCERTAIN") };
}
async function ack(store: CustomerStore, worker: NotificationWorker, bindingId: string, attemptId: string, input: Record<string, unknown>, now: Date) {
  const accepted = acknowledgement(input), ackHash = digest(JSON.stringify(accepted));
  for (let retry = 0; retry < 5; retry++) {
    try {
      const binding = (await authorizeWorkerBinding(store, worker, bindingId, { requireOwner: false })).binding;
      const receipt = (await store.read<Claim>(claimKey(bindingId, worker.id, attemptId))).value;
      if (!receipt || receipt.workerId !== worker.id || receipt.bindingId !== bindingId || receipt.attemptId !== attemptId || receipt.jobId !== accepted.jobId) throw Error("NOTIFICATION_ACK_CONFLICT");
      const snapshot = await store.read<Job>(jobKey(accepted.jobId));
      assertJob(snapshot.value, bindingId, accepted.jobId);
      const job = snapshot.value;
      if (job.workerId !== worker.id || job.attemptId !== attemptId || job.workspaceId !== binding.workspaceId) throw Error("NOTIFICATION_ACK_CONFLICT");
      if (job.ackHash) {
        if (job.ackHash !== ackHash) throw Error("NOTIFICATION_ACK_CONFLICT");
        return { schemaVersion: 1, jobId: job.id, state: publicState(job.state), replayed: true };
      }
      // A late, matching provider receipt may resolve timeout uncertainty. An
      // explicit previous acknowledgement is immutable and cannot be rewritten.
      if (job.state !== "sending" && job.state !== "unknown") throw Error("NOTIFICATION_ACK_CONFLICT");
      const next: Job = { ...job, state: accepted.outcome, ackHash, completedAt: now.toISOString(),
        ...(accepted.providerId ? { providerId: accepted.providerId } : {}),
        ...(accepted.errorCode ? { lastError: accepted.errorCode } : {}) };
      if (accepted.outcome === "sent") delete next.lastError;
      const index = await store.read<Index>(indexKey(bindingId)), queue = indexValue(index);
      const changes: Change[] = [{ key: jobKey(job.id), before: snapshot.raw, after: next }];
      if (queue.ids.includes(job.id)) changes.push({ key: indexKey(bindingId), before: index.raw, after: { schemaVersion: 1, ids: queue.ids.filter(v => v !== job.id) } });
      await store.commit(changes);
      const saved = (await store.read<Job>(jobKey(job.id))).value;
      if (saved?.ackHash !== ackHash || saved.state !== accepted.outcome) throw Error("WRITE_UNCONFIRMED");
      return { schemaVersion: 1, jobId: job.id, state: publicState(saved.state), replayed: false };
    } catch (error) {
      if (error instanceof Error && error.message === "VERSION_CONFLICT" && retry < 4) continue;
      throw error;
    }
  }
  throw Error("VERSION_CONFLICT");
}

// Reconciliation cannot dispatch a message or turn unknown back into queued.
// Only the original scoped worker may attach confirmed provider readback to its
// uncertain attempt. The initial acknowledgement remains immutable audit data.
async function reconcile(store: CustomerStore, worker: NotificationWorker, bindingId: string, attemptId: string, input: Record<string, unknown>, now: Date) {
  if (input.outcome !== "sent" || input.providerReadbackVerified !== true) throw Error("PROVIDER_PROOF_REQUIRED");
  const accepted = acknowledgement(input);
  const reconcileHash = digest(JSON.stringify({ ...accepted, providerReadbackVerified: true }));
  for (let retry = 0; retry < 5; retry++) {
    try {
      const binding = (await authorizeWorkerBinding(store, worker, bindingId, { requireOwner: false })).binding;
      const receipt = (await store.read<Claim>(claimKey(bindingId, worker.id, attemptId))).value;
      if (!receipt || receipt.workerId !== worker.id || receipt.bindingId !== bindingId || receipt.attemptId !== attemptId || receipt.jobId !== accepted.jobId) throw Error("NOTIFICATION_ACK_CONFLICT");
      const snapshot = await store.read<Job>(jobKey(accepted.jobId));
      assertJob(snapshot.value, bindingId, accepted.jobId);
      const job = snapshot.value;
      if (job.workerId !== worker.id || job.attemptId !== attemptId || job.workspaceId !== binding.workspaceId) throw Error("NOTIFICATION_ACK_CONFLICT");
      if (job.reconcileHash) {
        if (job.reconcileHash !== reconcileHash || job.state !== "sent") throw Error("NOTIFICATION_ACK_CONFLICT");
        return { schemaVersion: 1, jobId: job.id, state: "sent" as const, replayed: true };
      }
      if (job.state !== "unknown") throw Error("NOTIFICATION_ACK_CONFLICT");
      const next: Job = { ...job, state: "sent", reconcileHash, providerId: accepted.providerId,
        reconciledAt: now.toISOString(), completedAt: now.toISOString() };
      delete next.lastError;
      const index = await store.read<Index>(indexKey(bindingId)), queue = indexValue(index);
      const changes: Change[] = [{ key: jobKey(job.id), before: snapshot.raw, after: next }];
      if (queue.ids.includes(job.id)) changes.push({ key: indexKey(bindingId), before: index.raw, after: { schemaVersion: 1, ids: queue.ids.filter(v => v !== job.id) } });
      await store.commit(changes);
      const saved = (await store.read<Job>(jobKey(job.id))).value;
      if (saved?.reconcileHash !== reconcileHash || saved.state !== "sent" || saved.ackHash !== job.ackHash) throw Error("WRITE_UNCONFIRMED");
      return { schemaVersion: 1, jobId: job.id, state: "sent" as const, replayed: false };
    } catch (error) {
      if (error instanceof Error && error.message === "VERSION_CONFLICT" && retry < 4) continue;
      throw error;
    }
  }
  throw Error("VERSION_CONFLICT");
}

function claimChannels(input: unknown, worker: NotificationWorker) {
  const allowed = worker.channels ?? channels;
  if (input === undefined) return channels.filter(c => allowed.includes(c));
  if (!Array.isArray(input) || !input.length || input.some(c => !channels.includes(c)) || new Set(input).size !== input.length) throw Error("INVALID_INPUT");
  if (input.some(c => !allowed.includes(c))) throw Error("FORBIDDEN");
  return channels.filter(c => input.includes(c));
}

export async function notificationOperation(store: CustomerStore, worker: NotificationWorker, value: unknown, now = new Date()) {
  const input = record(value);
  if (input.schemaVersion !== 1 || typeof input.action !== "string" || !["claim", "ack", "reconcile", "enqueue_expired"].includes(input.action)) throw Error("INVALID_INPUT");
  fields(input, ["schemaVersion", "action", "bindingId", "attemptId",
    ...(input.action === "claim" ? ["channels"] : []),
    ...(["ack", "reconcile"].includes(input.action) ? ["jobId", "outcome", "providerId", "errorCode"] : []),
    ...(input.action === "reconcile" ? ["providerReadbackVerified"] : []),
  ]);
  const bindingId = uuid(input.bindingId), attemptId = uuid(input.attemptId);
  if (!worker.actions.includes("notifications")) throw Error("FORBIDDEN");
  await authorizeWorkerBinding(store, worker, bindingId, { requireOwner: input.action === "enqueue_expired" });
  await store.limit(`website-notification:${digest(worker.id)}:${bindingId}`, 900);
  if (input.action === "enqueue_expired") {
    const { enqueueExpiredHolds } = await import("./lifecycle.ts");
    return { schemaVersion: 1, ...await enqueueExpiredHolds(store, bindingId, now) };
  }
  if (input.action === "claim") return claim(store, worker, bindingId, attemptId, claimChannels(input.channels, worker), now);
  return input.action === "reconcile" ? reconcile(store, worker, bindingId, attemptId, input, now) : ack(store, worker, bindingId, attemptId, input, now);
}
