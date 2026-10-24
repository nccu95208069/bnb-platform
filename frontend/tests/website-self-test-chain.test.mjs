import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { websiteFixture } from './helpers/website-booking-fixture.mjs';
import { prepareConnection, approveConnection, connectionStatus } from '../src/lib/website-booking/connections.ts';
import { guestAction } from '../src/lib/website-booking/booking.ts';
import { setWebsiteSales } from '../src/lib/website-booking/management.ts';
import { websiteManagement } from '../src/lib/website-booking/management.ts';
import { holdOperation } from '../src/lib/customer-workspaces/holds.ts';
import { runWebsiteEmailDelivery } from '../src/lib/website-booking/delivery.ts';
import { notificationStates } from '../src/lib/website-booking/notifications.ts';
import { addDays } from '../src/lib/website-booking/config.ts';
import { businessDate } from '../src/lib/customer-workspaces/domain.ts';
import { stageImportFile } from '../src/lib/customer-workspaces/file-import.ts';
import { sourceFor } from '../src/lib/customer-workspaces/customer-google.ts';
import { previewImport, commitImport } from '../src/lib/customer-workspaces/sheet-import.ts';
import { workspaceDirectory } from '../src/lib/customer-workspaces/directory.ts';
import { accountKey } from '../src/lib/customer-workspaces/auth.ts';

test('isolated UUID site rehearses sales-off approval, synthetic hold, owner receipt, confirmed email and pause', async t => {
  const env = ['WEBSITE_BOOKING_STUDIO_CLIENTS', 'WEBSITE_BOOKING_STUDIO_EMAIL_CLIENT_IDS'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of env) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; } });
  const f = await websiteFixture({ approve: false });
  const studio = { ...f.client, id: 'self-test-studio', site_ids: [], allow_new_sites: true };
  const siteId = randomUUID();
  process.env.WEBSITE_BOOKING_STUDIO_CLIENTS = JSON.stringify([studio]);
  process.env.WEBSITE_BOOKING_STUDIO_EMAIL_CLIENT_IDS = JSON.stringify([studio.id]);
  const pending = await prepareConnection(f.store, studio, { ...f.prepare, requestId: randomUUID(), siteId }, f.now);
  const approved = await approveConnection(f.store, f.account, { ...f.approval, connectionId: pending.connectionId }, f.now);
  assert.equal(approved.state, 'connected');
  const status = await connectionStatus(f.store, studio, { schemaVersion: 1, action: 'status', siteId, connectionId: pending.connectionId }, f.now);
  assert.equal(status.salesEnabled, false);
  const bindingKey = `website:binding:${status.bindingId}`;
  const binding = (await f.store.read(bindingKey)).value;
  const day = businessDate(f.now.toISOString());
  const stay = { checkIn: addDays(day, 10), checkOut: addDays(day, 11), roomTypeId: 'double', quantity: 1, adults: 2, children: 0 };
  const envelope = { schemaVersion: 1, source: 'Official Website', configurationHash: f.prepare.configurationHash };
  const guest = (action, data, key) => guestAction(f.store, binding.id, status.bindingToken, action, { ...envelope, ...data }, key, f.now);
  await assert.rejects(guest('availability', stay), /WEBSITE_BOOKING_UNAVAILABLE/);
  await assert.rejects(setWebsiteSales(f.store, f.account.id, binding.slug, { action: 'sales', bindingId: binding.id,
    revision: binding.revision, enabled: true, requestKey: randomUUID() }, f.now), /EMPTY_CALENDAR_CONFIRMATION_REQUIRED/);
  const args = [f.store, f.account.id, binding.slug, binding.propertyId];
  const roomId = binding.physicalMappings[0].roomIds[0];
  const soldDay = addDays(day, 15);
  const csv = Buffer.from(`入住日期,退房日期,房間,姓名,訂單編號\n${soldDay},${addDays(soldDay, 1)},101,Synthetic OTA,OTA-1\n`);
  const staged = await stageImportFile(...args, csv, 'synthetic-orders.csv');
  const source = await sourceFor(...args, staged.tabs[0].sourceId);
  const preview = await previewImport(...args, source, { headerRow: 1,
    columns: { checkIn: 0, checkOut: 1, rooms: 2, guestName: 3, externalId: 4, total: -1, received: -1 },
    roomMap: { '101': [roomId] }, granularity: 'order', amountBasis: 'none', receivedMeaning: 'none', currency: 'TWD',
    from: f.config.opensOn, coverageTo: addDays(f.config.closesOn, 1), coverageConfirmed: true });
  await commitImport(...args, preview.id, preview.rows.filter(row => !row.issues.length).map(row => row.row));
  const currentAccount = (await f.store.read(accountKey(f.account.email))).value;
  const directory = await workspaceDirectory(f.store, currentAccount);
  assert.equal(directory[0].properties[0].calendarState, 'ready');
  assert.equal(directory[0].properties[0].activeBookings, 1);
  const opened = await setWebsiteSales(f.store, f.account.id, binding.slug, { action: 'sales', bindingId: binding.id, revision: binding.revision, enabled: true, confirmedStaticSource: true, requestKey: randomUUID() }, f.now);
  assert.equal(opened.sites[0].enabled, true);
  const available = await guest('availability', stay);
  const sold = await guest('availability', { ...stay, checkIn: soldDay, checkOut: addDays(soldDay, 1) });
  assert.equal(sold.options[0].availableUnits, 0);
  const quote = await guest('quotes', { ...stay, availabilityToken: available.availabilityToken });
  const requestKey = randomUUID();
  const held = await guest('reservations', { quoteId: quote.quoteId, guest: { name: 'Synthetic guest', email: 'guest@example.test', phone: '+886912345678', note: '' }, acceptedPolicy: true, idempotencyKey: requestKey }, requestKey);
  assert.equal(held.status, 'hold_active');
  const saved = (await f.store.read(`workspace:${binding.workspaceId}`)).value;
  const booking = saved.bookings.find(row => row.id === held.orderId);
  assert(booking);
  assert.equal(booking.status, 'held');
  const converted = await holdOperation(f.store, f.account.id, binding.slug, { action: 'hold-convert', bookingId: booking.id,
    bookingVersion: booking.version, version: saved.version, requestKey: randomUUID(), confirmPlatformOnly: true,
    confirmedReceipt: true, amount: 500, method: 'cash', receivedAt: new Date(f.now.getTime() - 1000).toISOString() }, f.now);
  const finalBooking = converted.workspace.bookings.find(row => row.id === booking.id);
  assert.equal(finalBooking.status, 'confirmed');
  assert.equal(finalBooking.payments.length, 1);
  let sent = 0;
  const delivery = await runWebsiteEmailDelivery(f.store, [], { now: () => f.now, send: async (to, subject) => {
    assert(['guest@example.test', f.account.email].includes(to));
    assert.match(subject, /已確認訂金/);
    return `provider:synthetic-${++sent}`;
  } });
  assert.equal(delivery.sent, 2);
  const authoritative = (await f.store.read(`workspace:${binding.workspaceId}`)).value.bookings.find(row => row.id === booking.id);
  assert.equal((await notificationStates(f.store, authoritative)).guestEmail, 'sent');
  const latestBinding = (await f.store.read(bindingKey)).value;
  const paused = await setWebsiteSales(f.store, f.account.id, binding.slug, { action: 'sales', bindingId: binding.id,
    revision: latestBinding.revision, enabled: false, requestKey: randomUUID() }, f.now);
  assert.equal(paused.sites[0].enabled, false);
  assert.equal((await f.store.read(`workspace:${binding.workspaceId}`)).value.bookings.length, 2);
});

test('owner-confirmed new empty calendar can sell its explicit period and the first hold blocks a second booking', async () => {
  const f = await websiteFixture({ approve: false });
  const studio = { ...f.client, id: 'empty-calendar-studio', site_ids: [], allow_new_sites: true };
  const siteId = randomUUID();
  const pending = await prepareConnection(f.store, studio, { ...f.prepare, requestId: randomUUID(), siteId }, f.now);
  await approveConnection(f.store, f.account, { ...f.approval, connectionId: pending.connectionId }, f.now);
  const status = await connectionStatus(f.store, studio, { schemaVersion: 1, action: 'status', siteId, connectionId: pending.connectionId }, f.now);
  const binding = (await f.store.read(`website:binding:${status.bindingId}`)).value;
  const management = await websiteManagement(f.store, f.account.id, binding.slug);
  assert.equal(management.sites[0].source.mode, 'empty');
  assert.deepEqual(binding.emptyCalendarCoverage, { from: f.config.opensOn,
    to: addDays(f.config.closesOn, 1), confirmedAt: f.now.toISOString() });
  assert.equal(management.sites[0].enabled, false);
  await assert.rejects(setWebsiteSales(f.store, randomUUID(), binding.slug, { action: 'sales', bindingId: binding.id,
    revision: binding.revision, enabled: true, confirmedEmptyCalendar: true, requestKey: randomUUID() }, f.now), /FORBIDDEN|NOT_FOUND/);
  await assert.rejects(setWebsiteSales(f.store, f.account.id, binding.slug, { action: 'sales', bindingId: binding.id,
    revision: binding.revision, enabled: true, requestKey: randomUUID() }, f.now), /EMPTY_CALENDAR_CONFIRMATION_REQUIRED/);
  const opened = await setWebsiteSales(f.store, f.account.id, binding.slug, { action: 'sales', bindingId: binding.id,
    revision: binding.revision, enabled: true, confirmedEmptyCalendar: true, requestKey: randomUUID() }, f.now);
  assert.equal(opened.sites[0].enabled, true);
  const day = businessDate(f.now.toISOString());
  const stay = { checkIn: addDays(day, 10), checkOut: addDays(day, 11), roomTypeId: 'double', quantity: 1, adults: 2, children: 0 };
  const envelope = { schemaVersion: 1, source: 'Official Website', configurationHash: f.prepare.configurationHash };
  const guest = (action, data, key) => guestAction(f.store, binding.id, status.bindingToken, action, { ...envelope, ...data }, key, f.now);
  const available = await guest('availability', stay);
  assert.equal(available.options[0].availableUnits, 1);
  const quote = await guest('quotes', { ...stay, availabilityToken: available.availabilityToken });
  const requestKey = randomUUID();
  const held = await guest('reservations', { quoteId: quote.quoteId, guest: { name: 'Synthetic guest', email: 'guest@example.test', phone: '+886912345678', note: '' }, acceptedPolicy: true, idempotencyKey: requestKey }, requestKey);
  assert.equal(held.status, 'hold_active');
  const after = await guest('availability', stay);
  assert.equal(after.options[0].availableUnits, 0);
  await assert.rejects(guest('availability', { ...stay, checkIn: addDays(f.config.closesOn, 1), checkOut: addDays(f.config.closesOn, 2) }), /SOURCE_COVERAGE|INVALID_INPUT/);
});
