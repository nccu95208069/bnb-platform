import type { Booking, FirstNewOrderNotification, PropertyState } from "./types.ts";

export const GMAIL_NOTIFICATION_SOURCE = "sweetfun-calendar-sheet";
export const GMAIL_NOTIFICATION_SUBJECT = "gmail-order-handler";
const GMAIL_VERSION = /^gmail-v1:([1-9]\d{12}):[0-9a-f]{64}$/;
// The source API accepts these UUIDs. UUID version is not an authority proof;
// authenticated creation and its exact durable receipt establish provenance.
const SOURCE_REQUEST_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Called only on a successful canonical create, after source-grant validation.
 * Gmail internalDate is a notification-received time, never an OTA booking date. */
export function firstGmailNotification(sourceSystem: string, sourceVersion: string,
  requestKey: string, createdAt: string): FirstNewOrderNotification | null {
  const match = typeof sourceVersion === "string" ? GMAIL_VERSION.exec(sourceVersion) : null;
  const created = Date.parse(createdAt);
  if (sourceSystem !== GMAIL_NOTIFICATION_SOURCE || !match ||
    !SOURCE_REQUEST_KEY.test(requestKey) || !Number.isFinite(created)) return null;
  const received = Number(match[1]);
  // A delayed import may be later than the notice. It can never precede it.
  if (!Number.isSafeInteger(received) || received > created) return null;
  return { schema: 1, receivedAt: new Date(received).toISOString(), sourceVersion, requestKey };
}

/** Validate private provenance before supplying only its timestamp to reporting.
 * The mutable link.sourceVersion is deliberately not a reporting date source. */
export function firstNotificationAt(state: PropertyState, booking: Booking): string | null {
  if (booking.source !== "external" || booking.sweetfunSnapshot || booking.osSnapshot ||
    !booking.sourceKey) return null;
  const links = state.sourceLinks.filter((link) => link.key === booking.sourceKey &&
    link.bookingId === booking.id);
  if (links.length !== 1) return null;
  const link = links[0], evidence = link.firstNewOrderNotification;
  if (!evidence || evidence.schema !== 1 || link.key !== JSON.stringify([
    link.sourceSystem, link.sourceAccount, link.externalOrderId])) return null;
  const verified = firstGmailNotification(link.sourceSystem, evidence.sourceVersion,
    evidence.requestKey, booking.createdAt);
  if (!verified || verified.receivedAt !== evidence.receivedAt) return null;
  const receipts = state.receipts.filter((receipt) => receipt.propertyId === state.propertyId &&
    receipt.key === evidence.requestKey && receipt.action === "source:write" &&
    receipt.subjectId === GMAIL_NOTIFICATION_SUBJECT && receipt.grantId !== null &&
    receipt.response.state === "applied" && receipt.response.bookingId === booking.id &&
    receipt.response.bookingVersion === 1);
  return receipts.length === 1 ? verified.receivedAt : null;
}

/** Coverage is an explicit operator-established full day, not the earliest observed order. */
export function notificationCoverageFrom(state: PropertyState, now = new Date()): string | null {
  const policy = state.reportingPolicy;
  if (!policy || policy.schema !== 1 || policy.authorityEpoch !== state.authorityEpoch ||
    !Number.isSafeInteger(policy.authorityEpoch) || policy.authorityEpoch < 1 ||
    !/^\d{4}-\d{2}-\d{2}$/.test(policy.notificationCoverageFrom) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(policy.recordedAt)) return null;
  const coverage = Date.parse(`${policy.notificationCoverageFrom}T00:00:00.000Z`);
  const recorded = Date.parse(policy.recordedAt);
  if (!Number.isFinite(coverage) || !Number.isFinite(recorded) || recorded > now.getTime() ||
    new Date(coverage).toISOString().slice(0, 10) !== policy.notificationCoverageFrom ||
    new Date(recorded).toISOString() !== policy.recordedAt) return null;
  const nextFullDay = new Date(recorded + (24 + 8) * 60 * 60 * 1000).toISOString().slice(0, 10);
  return policy.notificationCoverageFrom >= nextFullDay ? policy.notificationCoverageFrom : null;
}
