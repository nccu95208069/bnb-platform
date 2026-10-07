import { randomUUID } from "node:crypto";
import { digest } from "../customer-workspaces/auth.ts";
import { bookingsOverlap, businessDate, cents } from "../customer-workspaces/domain.ts";
import { holdPhase, holdsEnabled, occupiesInventory } from "../customer-workspaces/hold-state.ts";
import type { CustomerStore, Snapshot } from "../customer-workspaces/store.ts";
import type { Property, Workspace } from "../customer-workspaces/types.ts";
import { addDays, bindingToken, email, enabled, fields, plain, record, sameSecret, stayInput, uuid } from "./config.ts";
import { bindingKey, nativeProperty } from "./connections.ts";
import { notificationPlan, notificationStates } from "./notifications.ts";
import type { RoomOffer, Stay, WebsiteBinding, WebsiteBooking, WebsiteObservation, WebsiteQuote, WebsiteReceipt } from "./types.ts";

export async function authenticatedBinding(store: CustomerStore, bindingId: string, token: string | null) {
  uuid(bindingId);
  const saved = await store.read<WebsiteBinding>(bindingKey(bindingId));
  if (!saved.value || !token || token.length < 32 || token.length > 256 || !sameSecret(token, bindingToken(saved.value))) throw Error("UNAUTHORIZED");
  return { ...saved, value: saved.value };
}
export async function bindingWorkspace(store: CustomerStore, binding: WebsiteBinding) {
  const saved = await store.read<Workspace>(`workspace:${binding.workspaceId}`), w = saved.value;
  const property = w?.properties.find(p => p.id === binding.propertyId);
  if (!w || !property || w.slug !== binding.slug || !w.members.some(m => m.accountId === binding.ownerAccountId && m.active && m.role === "owner" && (m.allProperties || m.propertyIds.includes(binding.propertyId)))) throw Error("BINDING_UNAVAILABLE");
  nativeProperty(w, property);
  if (binding.offers.some(o => o.roomIds.some(id => !property.rooms.some(r => r.id === id)))) throw Error("BINDING_UNAVAILABLE");
  return { raw: saved.raw, workspace: w, property };
}
function availableRooms(workspace: Workspace, property: Property, offer: RoomOffer, stay: Stay) {
  const free = offer.roomIds.filter(id => {
    const window = { checkIn: stay.checkIn, checkOut: stay.checkOut, roomIds: [id] };
    return !workspace.bookings.some(b => b.propertyId === property.id && occupiesInventory(b) && bookingsOverlap(b, window)) &&
      !workspace.blocks?.some(b => b.propertyId === property.id && b.status === "active" && bookingsOverlap(b, window));
  });
  return offer.wholeHouse ? (free.length === offer.roomIds.length ? free : []) : free;
}
function units(offer: RoomOffer, rooms: string[]) { return offer.wholeHouse ? (rooms.length ? 1 : 0) : rooms.length; }
function requireReady(binding: WebsiteBinding, configurationHash: unknown) {
  if (!enabled() || !holdsEnabled() || !binding.enabled) throw Error("WEBSITE_BOOKING_UNAVAILABLE");
  if (configurationHash !== binding.configurationHash) throw Error("CONFIGURATION_CHANGED");
}
function sameStay(left: Stay, right: Stay) { return JSON.stringify(left) === JSON.stringify(right); }
function pricingFor(property: Property, offer: RoomOffer, roomIds: string[], stay: Stay) {
  if (!property.pricing?.enabled) throw Error("PRICING_NOT_ENABLED");
  const pricing = property.pricing;
  const nightly = [];
  for (let date = stay.checkIn; date < stay.checkOut; date = addDays(date, 1)) {
    const ids = offer.wholeHouse ? ["villa"] : roomIds;
    const values = ids.map(id => {
      const amount = pricing.overrides.find(p => p.roomId === id && p.from <= date && p.to >= date)?.amount ?? pricing.base[id];
      if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0 || cents(amount) > 100_000_000) throw Error("PRICING_NOT_ENABLED");
      return cents(amount);
    });
    // One advertised room type has one nightly unit price. Divergent physical
    // room rates need an explicit owner mapping, not a silently averaged quote.
    if (new Set(values).size !== 1) throw Error("ROOM_TYPE_PRICE_CONFLICT");
    nightly.push({ date, unitPriceCents: values[0], quantity: stay.quantity });
  }
  const totalCents = nightly.reduce((n, row) => n + row.unitPriceCents * row.quantity, 0);
  if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > 10_000_000_000) throw Error("INVALID_INPUT");
  return { nightly, totalCents, pricingHash: digest(JSON.stringify(pricing)) };
}
function receiptKey(binding: string, key: string) { return `website:request:${binding}:${key}`; }
const quoteKey = (binding: string, key: string) => `website:quote:${binding}:${key}`;
const observationKey = (binding: string, key: string) => `website:availability:${binding}:${key}`;

async function resultFor(store: CustomerStore, binding: WebsiteBinding, receipt: WebsiteReceipt, now: Date) {
  const workspace = (await store.read<Workspace>(`workspace:${receipt.workspaceId}`)).value;
  const booking = workspace?.bookings.find(b => b.id === receipt.orderId) as WebsiteBooking | undefined;
  if (!booking?.website || booking.website.bindingId !== binding.id || booking.website.reference !== receipt.reference || booking.platform !== "Official Website") throw Error("WRITE_UNCONFIRMED");
  const phase = holdPhase(booking, now);
  const status = booking.status === "confirmed" ? "confirmed" : booking.status === "cancelled" ? "released" :
    phase === "awaiting_owner" ? "hold_expired_waiting_owner" : phase === "active" ? "hold_active" : "review_required";
  return { status, orderId: booking.id, reference: receipt.reference,
    ...(["hold_active", "hold_expired_waiting_owner"].includes(status) ? { holdUntil: booking.hold!.expiresAt } : {}),
    notifications: await notificationStates(store, booking) };
}

export async function guestAction(store: CustomerStore, bindingId: string, token: string | null, action: string,
  input: Record<string, unknown>, idempotencyHeader?: string | null, now = new Date()) {
  const snapshot = await authenticatedBinding(store, bindingId, token), binding = snapshot.value;
  const common = ["schemaVersion", "configurationHash", "source"];
  if (input.schemaVersion !== 1 || input.source !== "Official Website") throw Error("INVALID_INPUT");
  if (action === "requests") {
    fields(input, [...common, "idempotencyKey"]);
    // Deliberately independent of current sales flags/configuration and quote
    // expiry: the original capability must recover an uncertain prior write.
    const key = uuid(input.idempotencyKey);
    await store.limit(`website-status:${binding.id}`, 3000);
    const receipt = (await store.read<WebsiteReceipt>(receiptKey(binding.id, key))).value;
    return receipt ? resultFor(store, binding, receipt, now) : { status: "not_found" };
  }
  if (action === "reservations") return reserve(store, snapshot, input, idempotencyHeader, now);
  if (action === "bootstrap") {
    fields(input, common);
    let ready = true;
    try { requireReady(binding, input.configurationHash); await bindingWorkspace(store, binding); } catch { ready = false; }
    return { schemaVersion: 1, state: ready ? "ready" : "unavailable", inventoryMode: binding.inventoryMode, configurationHash: binding.configurationHash };
  }
  if (!["availability", "quotes"].includes(action)) throw Error("NOT_FOUND");
  fields(input, [...common, "checkIn", "checkOut", "roomTypeId", "quantity", "adults", "children", ...(action === "quotes" ? ["availabilityToken"] : [])]);
  requireReady(binding, input.configurationHash);
  await store.limit(`website-query:${binding.id}`, 3000);
  const stay = stayInput(input, binding, now), loaded = await bindingWorkspace(store, binding);
  const offer = binding.offers.find(o => o.id === stay.roomTypeId)!;
  const free = availableRooms(loaded.workspace, loaded.property, offer, stay);
  if (action === "availability") {
    const observation: WebsiteObservation = { id: randomUUID(), bindingId, configurationHash: binding.configurationHash, stay,
      expiresAt: new Date(now.getTime() + 120000).toISOString() };
    await store.commit([{ key: observationKey(bindingId, observation.id), before: null, after: observation, ttlSeconds: 120 }]);
    return { options: binding.offers.map(o => ({ roomTypeId: o.id, availableUnits: units(o, availableRooms(loaded.workspace, loaded.property, o, stay)) })),
      availabilityToken: observation.id, checkedAt: now.toISOString() };
  }
  const observed = (await store.read<WebsiteObservation>(observationKey(bindingId, uuid(input.availabilityToken)))).value;
  if (!observed || observed.bindingId !== bindingId || observed.configurationHash !== binding.configurationHash ||
    Date.parse(observed.expiresAt) <= now.getTime() || !sameStay(observed.stay, stay)) throw Error("QUOTE_EXPIRED");
  if (units(offer, free) < stay.quantity) throw Error("ROOM_CONFLICT");
  const roomIds = offer.wholeHouse ? free : free.slice(0, stay.quantity);
  const calculated = pricingFor(loaded.property, offer, roomIds, stay);
  const quote: WebsiteQuote = { id: randomUUID(), bindingId, configurationHash: binding.configurationHash, stay, roomIds,
    currency: "TWD", ...calculated, expiresAt: new Date(now.getTime() + 5 * 60000).toISOString() };
  await store.commit([{ key: quoteKey(bindingId, quote.id), before: null, after: quote, ttlSeconds: 86400 }]);
  return { quoteId: quote.id, currency: quote.currency, totalCents: quote.totalCents, nightly: quote.nightly, expiresAt: quote.expiresAt };
}

async function reserve(store: CustomerStore, snapshot: Snapshot<WebsiteBinding> & {value: WebsiteBinding}, input: Record<string, unknown>, header: string | null | undefined, now: Date) {
  fields(input, ["schemaVersion", "configurationHash", "source", "quoteId", "guest", "acceptedPolicy", "idempotencyKey"]);
  const binding = snapshot.value, key = uuid(input.idempotencyKey), quoteId = uuid(input.quoteId);
  if (header !== key || input.acceptedPolicy !== true) throw Error("INVALID_INPUT");
  const guest = record(input.guest); fields(guest, ["name", "email", "phone", "note"]);
  const normalized = { name: plain(guest.name, 80)!, email: email(guest.email), phone: plain(guest.phone, 40)!, note: plain(guest.note, 800, false) ?? "" };
  if (!/^[+\d][\d\s()+-]{5,39}$/.test(normalized.phone)) throw Error("INVALID_INPUT");
  const requestHash = digest(JSON.stringify({ quoteId, guest: normalized, acceptedPolicy: true, configurationHash: input.configurationHash }));
  const previous = await store.read<WebsiteReceipt>(receiptKey(binding.id, key));
  if (previous.value) {
    if (previous.value.requestHash !== requestHash) throw Error("IDEMPOTENCY_CONFLICT");
    return resultFor(store, binding, previous.value, now);
  }
  try {
  requireReady(binding, input.configurationHash);
  await store.limit(`website-reserve:${binding.id}`, 300);
  const savedQuote = await store.read<WebsiteQuote>(quoteKey(binding.id, quoteId)), quote = savedQuote.value;
  if (!quote || quote.bindingId !== binding.id || quote.configurationHash !== binding.configurationHash ||
    Date.parse(quote.expiresAt) <= now.getTime() || quote.usedBy) throw Error("QUOTE_EXPIRED");
  const loaded = await bindingWorkspace(store, binding), { workspace, property } = loaded;
  if (workspace.bookings.length >= 5000) throw Error("LIMIT_REACHED");
  stayInput(quote.stay, binding, now);
  const offer = binding.offers.find(o => o.id === quote.stay.roomTypeId)!;
  const free = availableRooms(workspace, property, offer, quote.stay);
  if (units(offer, free) < quote.stay.quantity) throw Error("ROOM_CONFLICT");
  // A quote sells the room type. Allocate currently free physical rooms while
  // preserving every quoted nightly price, under the shared workspace CAS.
  const roomIds = offer.wholeHouse ? free : free.slice(0, quote.stay.quantity);
  const price = pricingFor(property, offer, roomIds, quote.stay);
  if (price.pricingHash !== quote.pricingHash || price.totalCents !== quote.totalCents || JSON.stringify(price.nightly) !== JSON.stringify(quote.nightly)) throw Error("CONFIGURATION_CHANGED");
  const at = now.toISOString(), bookingId = randomUUID(), reference = `WEB-${bookingId}`;
  const booking: WebsiteBooking = { id: bookingId, version: 1, propertyId: property.id, guestName: normalized.name,
    checkIn: quote.stay.checkIn, checkOut: quote.stay.checkOut, roomIds, total: quote.totalCents / 100,
    nightlyPrices: quote.nightly.flatMap(row => {
      const total = row.unitPriceCents * row.quantity, perRoom = Math.floor(total / roomIds.length), extra = total % roomIds.length;
      return roomIds.map((roomId, i) => ({ roomId, date: row.date, amount: (perRoom + (i < extra ? 1 : 0)) / 100 }));
    }), payments: [], contact: `${normalized.phone} / ${normalized.email}`, notes: normalized.note || null,
    status: "held", hold: { schema: 1, scope: "platform_only", startedAt: at, expiresAt: new Date(now.getTime() + 86400000).toISOString(), state: "active" },
    platform: "Official Website", bookedAt: businessDate(at), bookedAtSource: "manual", bookedAtTimeZone: "Asia/Taipei",
    guestNotified: false, createdAt: at, actor: `website:${binding.id}`, entry: "os", requestKey: key, requestHash,
    website: { bindingId: binding.id, quoteId, requestId: key, reference, email: normalized.email, phone: normalized.phone,
      adults: quote.stay.adults, children: quote.stay.children, notificationIds: {} } };
  const notifications = await notificationPlan(store, binding, booking, "hold_created", now);
  booking.website.notificationIds = notifications.notificationIds;
  const receipt: WebsiteReceipt = { bindingId: binding.id, workspaceId: workspace.id, orderId: booking.id, reference, requestHash, createdAt: at };
  await store.commit([
    { key: `workspace:${workspace.id}`, before: loaded.raw, after: { ...workspace, version: workspace.version + 1, bookings: [...workspace.bookings, booking],
      audit: [...workspace.audit, { at, actor: booking.actor, action: "hold.created", targetId: booking.id }] } },
    { key: bindingKey(binding.id), before: snapshot.raw, after: binding },
    { key: quoteKey(binding.id, quoteId), before: savedQuote.raw, after: { ...quote, usedBy: key } },
    { key: receiptKey(binding.id, key), before: null, after: receipt },
    ...notifications.changes,
  ]);
  const verified = (await store.read<WebsiteReceipt>(receiptKey(binding.id, key))).value;
  if (!verified || verified.requestHash !== requestHash || verified.orderId !== booking.id) throw Error("WRITE_UNCONFIRMED");
  return resultFor(store, binding, verified, now);
  } catch (error) {
    // A concurrent identical request may have committed while this request was
    // preparing. Recover its receipt before returning a definite conflict.
    // This also covers a store response lost after the atomic commit.
    const recovered = (await store.read<WebsiteReceipt>(receiptKey(binding.id, key))).value;
    if (recovered) {
      if (recovered.requestHash !== requestHash) throw Error("IDEMPOTENCY_CONFLICT");
      return resultFor(store, binding, recovered, now);
    }
    throw error;
  }
}
