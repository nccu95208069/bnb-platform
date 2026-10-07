import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { digest } from '../../src/lib/customer-workspaces/auth.ts';
import { notificationPlan } from '../../src/lib/website-booking/notifications.ts';

export const fixtureNow = new Date('2026-10-07T04:00:00.000Z');
export function memoryEmailStore(values = new Map()) {
  return {
    values,
    async read(key) { const raw = values.get(key) ?? null; return { raw, value: raw === null ? null : JSON.parse(raw) }; },
    async commit(changes) {
      assert.equal(new Set(changes.map(c => c.key)).size, changes.length);
      if (changes.some(c => (values.get(c.key) ?? null) !== c.before)) throw Error('VERSION_CONFLICT');
      for (const c of changes) values.set(c.key, JSON.stringify(c.after));
    },
    async limit() {},
  };
}
export const storedRecords = (store, prefix) => [...store.values].filter(([key]) => key.startsWith(prefix)).map(([, value]) => JSON.parse(value));
export async function emailFixture({ count = 1, line = true, bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', store = memoryEmailStore(), siteId = 'synthetic-email-site' } = {}) {
  const binding = {
    id: bindingId, clientId: 'synthetic-editor', siteId, siteName: 'Synthetic email inn', ownerAccountId: `owner-${bindingId}`,
    ownerEmail: 'owner@example.invalid', workspaceId: `workspace-${bindingId}`, propertyId: `property-${bindingId}`, slug: 'synthetic-email-inn', enabled: true,
    approvedAt: '2026-10-06T00:00:00.000Z', config: { transferInstructions: 'Synthetic payment instructions.', cancellationPolicy: 'Synthetic cancellation policy.' },
    ...(line ? { ownerLine: { recipientId: `U${'a'.repeat(32)}`, verifiedAt: '2026-10-06T00:00:00.000Z', verifiedBy: `owner-${bindingId}`, pairingId: randomUUID() } } : {}),
  };
  const property = { id: binding.propertyId, name: 'Synthetic email inn', sourceMode: 'native', kind: 'rooms', setup: { mode: 'empty', readyAt: binding.approvedAt },
    rooms: Array.from({ length: count }, (_, i) => ({ id: `synthetic-room-${i}`, name: `Test ${i}` })), villaRoomIds: [] };
  const workspace = { id: binding.workspaceId, slug: binding.slug, name: 'Synthetic email inn', version: 1, properties: [property], bookings: [], audit: [],
    members: [{ accountId: binding.ownerAccountId, active: true, role: 'owner', allProperties: true, propertyIds: [] }] };
  store.values.set(`website:binding:${bindingId}`, JSON.stringify(binding));
  store.values.set(`workspace:${workspace.id}`, JSON.stringify(workspace));
  const siteKey = `website:site:${digest(JSON.stringify([binding.clientId, binding.siteId]))}`;
  store.values.set(siteKey, JSON.stringify({ bindingId, ownerAccountId: binding.ownerAccountId, ownerEmail: binding.ownerEmail }));
  for (let i = 0; i < count; i++) {
    const booking = { id: `synthetic-email-booking-${bindingId}-${i}`, version: 1, propertyId: binding.propertyId,
      guestName: `Synthetic guest ${i}`, platform: 'Official Website', checkIn: '2026-10-20', checkOut: '2026-10-21', roomIds: [property.rooms[i].id], total: 1200,
      status: 'held', entry: 'os', payments: [], contact: null, notes: null, guestNotified: false,
      hold: { schema: 1, scope: 'platform_only', state: 'active', startedAt: fixtureNow.toISOString(), expiresAt: '2026-10-08T04:00:00.000Z' },
      website: { bindingId, quoteId: randomUUID(), requestId: randomUUID(), reference: `EMAIL-TEST-${i}`, email: `guest-${i}@example.invalid`, phone: '0000000000', adults: 2, children: 0, notificationIds: {} } };
    const plan = await notificationPlan(store, binding, booking, 'hold_created', fixtureNow);
    booking.website.notificationIds = plan.notificationIds;
    const saved = await store.read(`workspace:${workspace.id}`);
    workspace.bookings.push(booking);
    await store.commit([{ key: `workspace:${workspace.id}`, before: saved.raw, after: workspace }, ...plan.changes]);
  }
  const mutate = (key, fn) => { const value = JSON.parse(store.values.get(key)); fn(value); store.values.set(key, JSON.stringify(value)); };
  return { store, binding, bindingId, workspace, bookings: workspace.bookings, siteKey, mutate };
}
