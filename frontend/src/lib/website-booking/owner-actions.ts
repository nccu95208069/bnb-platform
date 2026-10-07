import { financeSummary } from "../customer-workspaces/domain.ts";
import { enabled } from "../customer-workspaces/auth.ts";
import { holdPhase } from "../customer-workspaces/hold-state.ts";
import { HOLD_ACTIONS, holdOperation } from "../customer-workspaces/holds.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { Workspace } from "../customer-workspaces/types.ts";
import { fields, uuid } from "./config.ts";
import { nativeProperty } from "./connections.ts";
import { authorizeWorkerBinding, type NotificationWorker } from "./notifications.ts";

// The LINE connector must verify the webhook signature and supply its actual
// one-to-one sender. A service token alone cannot select a workspace or actor.
export async function ownerAction(store: CustomerStore, worker: NotificationWorker, input: Record<string, unknown>, now = new Date()) {
  if (!enabled()) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  const action = String(input.action), inspect = action === "inspect";
  const common = ["schemaVersion", "bindingId", "recipientId", "action", "bookingId"];
  const mutation = ["requestKey", "version", "bookingVersion", "confirmed", "confirmPlatformOnly"];
  const receipt = ["confirmedReceipt", "amount", "method", "receiptAccountId", "receivedAt", "allowOverpayment", "note"];
  fields(input, [...common, ...(!inspect ? mutation : []), ...(action === "hold-extend" ? ["hours", "expiresAt"] : []),
    ...(["hold-convert", "hold-late-payment", "hold-refund"].includes(action) ? receipt : [])]);
  if (input.schemaVersion !== 1 || !worker.actions.includes("owner_actions") ||
    (!inspect && !HOLD_ACTIONS.includes(action as typeof HOLD_ACTIONS[number]))) throw Error("FORBIDDEN");
  const bindingId = uuid(input.bindingId), bookingId = uuid(input.bookingId);
  if (typeof input.recipientId !== "string" || !/^U[a-f0-9]{32}$/i.test(input.recipientId)) throw Error("FORBIDDEN");
  const authorized = await authorizeWorkerBinding(store, worker, bindingId), binding = authorized.binding;
  if (!binding || binding.ownerLine?.recipientId !== input.recipientId || !binding.ownerLine.pairingId) throw Error("FORBIDDEN");
  const workspaceKey = `workspace:${binding.workspaceId}`, saved = authorized.workspaceSnapshot, workspace = authorized.workspace;
  if (!workspace) throw Error("FORBIDDEN");
  const booking = workspace.bookings.find(b => b.id === bookingId && b.propertyId === binding.propertyId && b.website?.bindingId === bindingId);
  if (!booking) throw Error("NOT_FOUND");
  const property = workspace.properties.find(p => p.id === binding.propertyId);
  if (!property) throw Error("NOT_FOUND");
  nativeProperty(workspace, property);
  await store.limit(`website-owner-actions:${worker.id}:${bindingId}`, 100);
  let operation: { key: string; verified: boolean; replayed: boolean } | undefined;
  if (!inspect) {
    if (input.confirmed !== true) throw Error("OWNER_CONFIRMATION_REQUIRED");
    const { schemaVersion: _schema, bindingId: _binding, recipientId: _recipient, confirmed: _confirmed, ...command } = input;
    void _schema; void _binding; void _recipient; void _confirmed;
    const guarded: CustomerStore = {
      read: store.read.bind(store), limit: store.limit.bind(store),
      async commit(changes) {
        // Fence revocation, re-pairing and booking/property edits between the
        // authorization read and the shared hold mutation's atomic commit.
        if (changes.find(c => c.key === workspaceKey)?.before !== saved.raw) throw Error("VERSION_CONFLICT");
        for (const guard of authorized.guards) {
          const present = changes.find(c => c.key === guard.key);
          if (present && present.before !== guard.before) throw Error("VERSION_CONFLICT");
        }
        await store.commit([...changes, ...authorized.guards.filter(g => !changes.some(c => c.key === g.key))]);
      },
    };
    try { operation = (await holdOperation(guarded, binding.ownerAccountId, binding.slug, command, now)).operation; }
    catch (error) {
      // A lost commit response is recoverable only through the authoritative
      // operation receipt and the identical normalized command.
      const latest = (await store.read<Workspace>(workspaceKey)).value;
      if (!latest?.operations?.some(o => o.key === command.requestKey && o.actor === binding.ownerAccountId)) throw error;
      operation = (await holdOperation(guarded, binding.ownerAccountId, binding.slug, command, now)).operation;
    }
  }
  const readbackScope = await authorizeWorkerBinding(store, worker, bindingId);
  const currentBinding = readbackScope.binding, current = readbackScope.workspace;
  if (currentBinding?.ownerLine?.pairingId !== binding.ownerLine.pairingId || currentBinding.ownerLine.recipientId !== input.recipientId ||
    !current?.members.some(m => m.accountId === binding.ownerAccountId && m.active && m.role === "owner" && (m.allProperties || m.propertyIds.includes(binding.propertyId)))) throw Error("FORBIDDEN");
  const readback = current.bookings.find(b => b.id === bookingId && b.propertyId === binding.propertyId && b.website?.bindingId === bindingId);
  if (!readback) throw Error("WRITE_UNCONFIRMED");
  const finance = financeSummary(readback);
  return { schemaVersion: 1, bindingId, bookingId, reference: readback.website!.reference,
    version: current.version, bookingVersion: readback.version, status: readback.status, holdPhase: holdPhase(readback, now),
    holdUntil: readback.hold?.expiresAt, checkIn: readback.checkIn, checkOut: readback.checkOut,
    total: readback.total, received: finance.received, remaining: finance.remaining, source: readback.platform,
    receiptAccounts: property.receiptAccounts?.map(a => ({ id: a.id, name: a.name, last4: a.last4 })) ?? [], ...(operation ? { operation } : {}) };
}
