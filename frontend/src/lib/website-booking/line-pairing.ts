import { createHmac, randomBytes } from "node:crypto";
import type { Account, Workspace } from "../customer-workspaces/types.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import { fields, requireEnabled, sameSecret, uuid } from "./config.ts";
import { bindingKey, connectionFor } from "./connections.ts";
import type { WebsiteBinding } from "./types.ts";
import { authorizeWorkerBinding, type NotificationWorker } from "./notifications.ts";

type Pairing = { id: string; bindingId: string; ownerAccountId: string; bindingRevision: number; nonce: string; expiresAt: string;
  previousPairingId: string | null;
  recipientId?: string; consumedAt?: string; consumedBy?: string };
const keyFor = (bindingId: string, id: string) => `website:line-pair:${bindingId}:${id}`;
function tokenFor(pair: Pairing) {
  const secret = process.env.CUSTOMER_SESSION_SECRET;
  if (!secret || secret.length < 32) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  const signature = createHmac("sha256", secret).update(`website-line:v1:${pair.bindingId}:${pair.id}:${pair.nonce}`).digest("base64url");
  return `${pair.bindingId}.${pair.id}.${signature}`;
}
function ownerMember(w: Workspace, b: WebsiteBinding) { return w.members.some(m => m.accountId === b.ownerAccountId && m.active && m.role === "owner" && (m.allProperties || m.propertyIds.includes(b.propertyId))); }

export async function prepareLinePairing(store: CustomerStore, account: Account, input: Record<string, unknown>, now = new Date()) {
  requireEnabled(); fields(input, ["action", "connectionId", "requestKey"]);
  if (input.action !== "line-prepare" || !account.emailVerifiedAt) throw Error("FORBIDDEN");
  const connection = (await connectionFor(store, input.connectionId, now)).value;
  if (connection.state !== "connected" || connection.approvedBy !== account.id) throw Error("FORBIDDEN");
  const binding = (await store.read<WebsiteBinding>(bindingKey(connection.bindingId!))).value;
  if (!binding || binding.connectionId !== connection.id || binding.ownerAccountId !== account.id || binding.ownerEmail !== account.email) throw Error("FORBIDDEN");
  const workspace = (await store.read<Workspace>(`workspace:${binding.workspaceId}`)).value;
  if (!workspace || !ownerMember(workspace, binding)) throw Error("FORBIDDEN");
  const id = uuid(input.requestKey), key = keyFor(binding.id, id), previous = await store.read<Pairing>(key);
  if (previous.value && (previous.value.ownerAccountId !== account.id || previous.value.bindingRevision !== binding.revision || Date.parse(previous.value.expiresAt) <= now.getTime())) throw Error("PAIRING_EXPIRED");
  const pair: Pairing = previous.value ?? { id, bindingId: binding.id, ownerAccountId: account.id, bindingRevision: binding.revision,
    previousPairingId: binding.ownerLine?.pairingId ?? null,
    nonce: randomBytes(32).toString("base64url"), expiresAt: new Date(now.getTime() + 10 * 60000).toISOString() };
  await store.limit(`website-line-pair:${account.id}`, 10);
  if (!previous.value) {
    try { await store.commit([{ key, before: null, after: pair, ttlSeconds: 600 }]); }
    catch (error) {
      const recovered = (await store.read<Pairing>(key)).value;
      if (!recovered || recovered.ownerAccountId !== account.id || recovered.bindingRevision !== binding.revision) throw error;
      const token = tokenFor(recovered);
      return { pairingId: recovered.id, pairingToken: token, expiresAt: recovered.expiresAt, command: `連接OS ${token}` };
    }
  }
  const token = tokenFor(pair);
  return { pairingId: pair.id, pairingToken: token, expiresAt: pair.expiresAt, command: `連接OS ${token}` };
}

// The connector is responsible for verifying LINE webhook signatures and using
// the one-to-one webhook's actual userId. Neither public guest credentials nor
// an owner browser can assert an arbitrary recipient as verified.
export async function consumeLinePairing(store: CustomerStore, worker: NotificationWorker, input: Record<string, unknown>, now = new Date()) {
  requireEnabled();
  fields(input, ["schemaVersion", "bindingId", "pairingToken", "recipientId"]);
  if (input.schemaVersion !== 1 || !worker.actions.includes("line_binding")) throw Error("FORBIDDEN");
  const bindingId = uuid(input.bindingId);
  if (typeof input.pairingToken !== "string" || input.pairingToken.length > 180 || typeof input.recipientId !== "string" || !/^U[a-f0-9]{32}$/i.test(input.recipientId)) throw Error("INVALID_INPUT");
  const [bound, pairingId, signature, ...extra] = input.pairingToken.split(".");
  if (bound !== bindingId || extra.length || !/^[A-Za-z0-9_-]{43}$/.test(signature ?? "")) throw Error("PAIRING_EXPIRED");
  uuid(pairingId);
  await store.limit(`website-line-consume:${worker.id}:${bindingId}`, 30);
  const key = keyFor(bindingId, pairingId), saved = await store.read<Pairing>(key), pair = saved.value;
  if (!pair || !sameSecret(tokenFor(pair), input.pairingToken)) throw Error("PAIRING_EXPIRED");
  const authorized = await authorizeWorkerBinding(store, worker, bindingId);
  const bindingSaved = authorized.bindingSnapshot, binding = authorized.binding;
  if (pair.ownerAccountId !== binding.ownerAccountId || pair.bindingRevision !== binding.revision) throw Error("FORBIDDEN");
  if (pair.recipientId) {
    if (pair.recipientId !== input.recipientId || pair.consumedBy !== worker.id || binding.ownerLine?.recipientId !== pair.recipientId || binding.ownerLine.pairingId !== pair.id) throw Error("IDEMPOTENCY_CONFLICT");
    return { schemaVersion: 1, state: "connected", bindingId };
  }
  if (pair.previousPairingId !== (binding.ownerLine?.pairingId ?? null)) throw Error("PAIRING_EXPIRED");
  if (Date.parse(pair.expiresAt) <= now.getTime()) throw Error("PAIRING_EXPIRED");
  const nextPair = { ...pair, recipientId: input.recipientId, consumedBy: worker.id, consumedAt: now.toISOString() };
  const next: WebsiteBinding = { ...binding, ownerLine: { recipientId: input.recipientId, verifiedAt: now.toISOString(), verifiedBy: worker.id, pairingId } };
  try {
    await store.commit([
      { key: bindingKey(bindingId), before: bindingSaved.raw, after: next },
      { key, before: saved.raw, after: nextPair, ttlSeconds: 86400 },
      ...authorized.guards.filter(c => c.key !== bindingKey(bindingId)),
    ]);
  } catch (error) {
    const recovered = (await store.read<Pairing>(key)).value;
    if (!recovered?.recipientId) throw error;
    if (recovered.recipientId !== input.recipientId || recovered.consumedBy !== worker.id) throw Error("IDEMPOTENCY_CONFLICT");
  }
  const readback = (await authorizeWorkerBinding(store, worker, bindingId)).binding;
  if (readback?.ownerLine?.recipientId !== input.recipientId || readback.ownerLine.verifiedBy !== worker.id || readback.ownerLine.pairingId !== pair.id) throw Error("WRITE_UNCONFIRMED");
  return { schemaVersion: 1, state: "connected", bindingId };
}
