import { holdPhase } from "../customer-workspaces/hold-state.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Booking, Workspace } from "../customer-workspaces/types.ts";
import { bindingKey } from "./connections.ts";
import { uuid } from "./config.ts";
import { notificationFingerprint, notificationPlan } from "./notifications.ts";
import type { WebsiteBinding, WebsiteBooking, WebsiteNotification } from "./types.ts";

// Shared by private owner operations and the separately scoped LINE adapter.
// This adds delivery work to the same atomic mutation, never sends inline.
export async function holdNotificationChanges(store: CustomerStore, workspace: Workspace, booking: Booking, event: WebsiteNotification["event"], now = new Date()) {
  if (!booking.website) return { booking, changes: [] as Change[] };
  const saved = await store.read<WebsiteBinding>(bindingKey(booking.website.bindingId)), binding = saved.value;
  if (!binding || binding.workspaceId !== workspace.id || binding.propertyId !== booking.propertyId || booking.platform !== "Official Website") throw Error("HOLD_INTEGRATION_REQUIRED");
  const plan = await notificationPlan(store, binding, booking as WebsiteBooking, event, now);
  return { booking: { ...booking, website: { ...booking.website, notificationIds: { ...booking.website.notificationIds, ...plan.notificationIds } } },
    changes: [{ key: bindingKey(binding.id), before: saved.raw, after: binding }, ...plan.changes] as Change[] };
}

export async function enqueueExpiredHolds(store: CustomerStore, bindingId: string, now = new Date()) {
  uuid(bindingId);
  const bindingSnapshot = await store.read<WebsiteBinding>(bindingKey(bindingId)), binding = bindingSnapshot.value;
  if (!binding) throw Error("NOT_FOUND");
  const initial = (await store.read<Workspace>(`workspace:${binding.workspaceId}`)).value;
  const authorized = (w: Workspace) => w.members.some(m => m.accountId === binding.ownerAccountId && m.active && m.role === "owner" && (m.allProperties || m.propertyIds.includes(binding.propertyId)));
  if (!initial || !authorized(initial)) throw Error("BINDING_UNAVAILABLE");
  // A deployment that extends notification semantics must not send an old
  // expiry reminder again solely because its stored fingerprint predates v2.
  const alreadyNotified = (b: WebsiteBooking) => [notificationFingerprint(b), notificationFingerprint(b, 1)].includes(b.website.expiryNotifiedFingerprint ?? "");
  const due = initial.bookings.filter(b => b.website?.bindingId === bindingId && holdPhase(b, now) === "awaiting_owner" && !alreadyNotified(b as WebsiteBooking)).slice(0, 50);
  let queued = 0;
  for (const item of due) {
    const saved = await store.read<Workspace>(`workspace:${binding.workspaceId}`), workspace = saved.value;
    const booking = workspace?.bookings.find(b => b.id === item.id);
    if (workspace && !authorized(workspace)) throw Error("BINDING_UNAVAILABLE");
    if (!workspace || !booking?.website || booking.version !== item.version || holdPhase(booking, now) !== "awaiting_owner" || alreadyNotified(booking as WebsiteBooking)) continue;
    const plan = await holdNotificationChanges(store, workspace, booking, "hold_expired", now);
    const fingerprint = notificationFingerprint(booking as WebsiteBooking);
    const next = { ...plan.booking, website: { ...plan.booking.website!, expiryNotifiedFingerprint: fingerprint } };
    try {
      await store.commit([{ key: `workspace:${workspace.id}`, before: saved.raw, after: { ...workspace, version: workspace.version + 1,
        bookings: workspace.bookings.map(b => b.id === booking.id ? next : b) } }, ...plan.changes]);
      // Confirmation means durable notification work, not delivery or release.
      const verified = (await store.read<Workspace>(`workspace:${workspace.id}`)).value?.bookings.find(b => b.id === booking.id);
      if (!verified?.website || verified.website.expiryNotifiedFingerprint !== fingerprint) throw Error("WRITE_UNCONFIRMED");
      queued++;
    } catch (e) { if (!(e instanceof Error) || e.message !== "VERSION_CONFLICT") throw e; }
  }
  return { queued };
}
