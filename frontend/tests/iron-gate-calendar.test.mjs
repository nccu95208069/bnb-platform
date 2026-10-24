import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { ironGateCalendarConfig, readSweetfunIronGateCalendar, readSweetfunIronGateCalendarSnapshot, readSweetfunIronGatePaymentOrder, readSweetfunIronGateNotificationOrder } from
  '../src/lib/booking-sources/iron-gate-calendar.server.ts';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302']
  .map((room, i) => [room, `55555555-5555-4555-8555-55555555555${i}`]));
const secret = 'private-test-proof-secret-32-bytes-long';
const grant = { credentialId, clientId, workspaceId, propertyId,
  token: 'a'.repeat(43) };
const principal = { id: 'current-os-member', role: 'owner', allProperties: true,
  propertyIds: ['sweetfun'], viewPrices: true };

function config() {
  return ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
  });
}

function fixture({ version = 7, sold = true, blocked = true } = {}) {
  const booking = { id: '66666666-6666-4666-8666-666666666666',
    workspaceId, propertyId, version: 1, status: 'confirmed',
    stays: [{ checkIn: '2026-10-25', checkOut: '2026-10-26', roomIds: [roomIds['101']] }],
    guestName: 'Sample Guest', sourceCalendar: {
      platform: 'Booking.com', externalOrderNo: 'private-source-order', bookedAt: '2026-09-01',
    } };
  const page = { propertyId, inventoryVersion: version, authorityEpoch: 1,
    readOnly: false, bookings: [booking], nextCursor: null };
  const cells = Object.entries(roomIds).map(([room, roomId]) => ({ roomId,
    date: '2026-10-25', state: room === '101' && sold ? 'sold' :
      room === '102' && blocked ? 'blocked' : 'unsold', saleReady: false }));
  const availability = { propertyId, inventoryVersion: version,
    authorityEpoch: 1, cells };
  return { page, availability };
}

function sender(data, configValue, mutate = () => {}, actingPrincipal = principal) {
  const verify = createOsMemberProofVerifier(configValue.proofSecret);
  let calls = 0;
  return async (url, init) => {
    const request = new Request(url, init);
    const proof = await verify(request, { ...configValue.grant, origin: 'os' });
    assert.equal(proof?.subjectId, actingPrincipal.id);
    assert.deepEqual(proof?.actions, ['booking:read']);
    assert.deepEqual(proof?.fields, actingPrincipal.viewPrices ?
      ['guest_name', 'payment_status', 'money'] : ['guest_name']);
    assert.equal(request.headers.get('authorization'), `Bearer ${grant.token}`);
    calls++;
    const value = url.includes('/availability?') ?
      structuredClone(data.availability) : structuredClone(data.page);
    mutate(value, calls);
    return Response.json(value);
  };
}

test('Iron Gate calendar needs explicit authority epoch and separate closed switch', () => {
  assert.throws(() => ironGateCalendarConfig({}), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
  assert.throws(() => ironGateCalendarConfig({
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true',
    IRON_GATE_SWEETFUN_CALENDAR_GRANT: JSON.stringify(grant),
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds),
    IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example/',
    IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '0',
  }), /IRON_GATE_CALENDAR_CONFIG_INVALID/);
});

test('calendar reads signed booking plus inventory, preserving blocked room nights', async () => {
  const c = config();
  const data = fixture();
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.inventoryVersion, 7);
  assert.equal(result.authorityEpoch, 1);
  assert.equal(result.blockedRoomNights, 1);
  assert.equal(result.soldRoomNights, 1);
  assert.equal(result.bookings.length, 2);
  assert.equal(result.bookings[0].room_number, '101');
  assert.equal(result.bookings[0].guest_name, 'Sample Guest');
  assert.equal(result.bookings[0].platform, 'booking');
  assert.equal(result.bookings[0].external_order_no, 'private-source-order');
  assert.equal(result.bookings[0].booked_at, '2026-09-01');
  assert.equal(result.bookings[0].price_hidden, true);
  assert.equal(result.bookings[0].payment_status, 'unknown');
  assert.equal(result.bookings[1].room_number, '102');
  assert.equal(result.bookings[1].source_conflict, true);
});

test('calendar leaves an unproven source booking date blank', async () => {
  const c = config(), data = fixture({ blocked: false });
  data.page.bookings[0].sourceCalendar.bookedAt = '2026-02-30';
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.bookings[0].booked_at, null);
});

test('unchanged imported order keeps its existing OS payment identity only for price roles', async () => {
  const c = config(), data = fixture({ blocked: false });
  data.page.bookings[0].sourceCalendar.sourceOrderRef = 'L:OBE12345678901234567890';
  const owner = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  const expected = 'SF-' + createHash('sha256').update(
    'sweetfun-operations-sheet-v1:order:OBE12345678901234567890').digest('hex').slice(0, 20);
  assert.equal(owner.bookings[0].payment_order_id, expected);
  assert.equal(owner.bookings[0].notification_order_id, expected);
  assert.equal(owner.bookings[0].source_booking_version, 1);
  assert.equal(owner.bookings[0].owlnest_order_no, 'OBE12345678901234567890');
  const viewer = { ...principal, viewPrices: false };
  const withoutMoney = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    viewer, c, sender(data, c, () => {}, viewer));
  assert.equal(withoutMoney.bookings[0].payment_order_id, 'IG-66666666-6666-4666-8666-666666666666');
  assert.equal(withoutMoney.bookings[0].owlnest_order_no, null);
  assert.equal(withoutMoney.bookings[0].external_order_no, null);
  assert.equal(withoutMoney.bookings[0].notification_order_id, undefined);
});

test('payment preflight checks the exact booking identity, total and current room nights', async () => {
  const c = config(), data = fixture({ blocked: false });
  const booking = { ...data.page.bookings[0], totalCents: 225700, currency: 'TWD',
    sourceCalendar: { ...data.page.bookings[0].sourceCalendar,
      sourceOrderRef: 'L:OBE12345678901234567890' },
    paymentReview: { status: 'unknown', source: 'unknown' } };
  const send = async (url, init) => {
    assert.match(url, /\/bookings\/66666666-6666-4666-8666-666666666666$/);
    assert.equal((await createOsMemberProofVerifier(c.proofSecret)(
      new Request(url, init), { ...c.grant, origin: 'os' }))?.subjectId, principal.id);
    return Response.json(booking);
  };
  const read = await readSweetfunIronGatePaymentOrder(booking.id, principal, c, send);
  assert.equal(read.totalCents, 225700);
  assert.equal(read.legacyImported, true);
  assert.equal(read.nights, 1);
  assert.match(read.paymentOrderId, /^SF-[a-f0-9]{20}$/);
  await assert.rejects(readSweetfunIronGatePaymentOrder(booking.id,
    { ...principal, viewPrices: false }, c, send), /IRON_GATE_PAYMENT_FORBIDDEN/);
  await assert.rejects(readSweetfunIronGatePaymentOrder(booking.id,
    principal, c, async () => Response.json({ ...booking, status: 'cancelled' })),
  /IRON_GATE_PAYMENT_SOURCE_INVALID/);
});

test('manual notification checks an active exact booking without requesting price access', async () => {
  const c = config(), booking = fixture().page.bookings[0];
  const housekeeper = { ...principal, role: 'housekeeper', viewPrices: false };
  const send = async (url, init) => {
    assert.match(url, /\/bookings\/66666666-6666-4666-8666-666666666666$/);
    const proof = await createOsMemberProofVerifier(c.proofSecret)(
      new Request(url, init), { ...c.grant, origin: 'os' });
    assert.equal(proof?.subjectId, housekeeper.id);
    assert.deepEqual(proof?.fields, ['guest_name']);
    return Response.json(booking);
  };
  assert.equal(await readSweetfunIronGateNotificationOrder(booking.id, housekeeper, c, send),
    `IG-${booking.id}`);
  await assert.rejects(readSweetfunIronGateNotificationOrder(booking.id,
    { ...housekeeper, allProperties: false, propertyIds: ['offland'] }, c, send),
  /IRON_GATE_CALENDAR_FORBIDDEN/);
  await assert.rejects(readSweetfunIronGateNotificationOrder(booking.id,
    housekeeper, c, async () => Response.json({ ...booking, status: 'cancelled' })),
  /IRON_GATE_NOTIFICATION_SOURCE_INVALID/);
  await assert.rejects(readSweetfunIronGateNotificationOrder(booking.id,
    housekeeper, c, async () => Response.json({ ...booking, propertyId: clientId })),
  /IRON_GATE_NOTIFICATION_SOURCE_INVALID/);
});

test('Iron Gate uses the same Sweetfun channel palette as the former Sheet calendar', async () => {
  for (const [source, expected] of [['Agoda', 'agoda'], ['LINE', 'direct'],
    ['CTrip', 'ctrip'], ['Airbnb', 'airbnb'], ['OwlJourney', 'owljourney'],
    ['unknown', 'other']]) {
    const c = config();
    const data = fixture({ blocked: false });
    data.page.bookings[0].sourceCalendar.platform = source;
    const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
      principal, c, sender(data, c));
    assert.equal(result.bookings[0].platform, expected, source);
  }
});

test('booking and availability requests begin together', async () => {
  const c = config();
  const data = fixture();
  let releaseBooking;
  let availabilityStarted;
  const availabilitySeen = new Promise(resolve => { availabilityStarted = resolve; });
  const senderWithDelay = async (url) => {
    if (url.includes('/availability?')) {
      availabilityStarted();
      return Response.json(data.availability);
    }
    if (!releaseBooking) await new Promise(resolve => { releaseBooking = resolve; });
    return Response.json(data.page);
  };
  const read = readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, senderWithDelay);
  await Promise.race([availabilitySeen, new Promise((_, reject) =>
    setTimeout(() => reject(Error('availability did not start with bookings')), 1000))]);
  releaseBooking();
  assert.equal((await read).soldRoomNights, 1);
});

test('calendar rejects inventory that omits a confirmed sold night', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture({ sold: false }), c)),
  /IRON_GATE_CALENDAR_INVENTORY_DRIFT/);
});

test('calendar excludes a stay that checks out on the first requested day', async () => {
  const c = config();
  const data = fixture({ sold: false, blocked: false });
  data.page.bookings[0].stays[0] = {
    checkIn: '2026-10-24', checkOut: '2026-10-25', roomIds: [roomIds['101']],
  };
  const result = await readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c));
  assert.equal(result.bookings.length, 0);
  assert.equal(result.soldRoomNights, 0);
});

test('calendar rejects a version change before the final readback', async () => {
  const c = config();
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(fixture(), c, (value, calls) => {
      if (calls === 3) value.inventoryVersion++;
    })), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});

test('calendar refuses a still read-only shadow even when it has bookings', async () => {
  const c = config();
  const data = fixture();
  data.page.readOnly = true;
  await assert.rejects(readSweetfunIronGateCalendar('2026-10-25', '2026-10-26',
    principal, c, sender(data, c)), /IRON_GATE_CALENDAR_VERSION_DRIFT/);
});

test('one signed snapshot returns calendar bookings and blocks with no pagination', async () => {
  const c = config();
  const data = fixture();
  const snapshot = { propertyId, workspaceId, from: '2026-10-25', to: '2026-10-26',
    inventoryVersion: 7, authorityEpoch: 1, readOnly: false,
    bookings: data.page.bookings,
    cells: data.availability.cells.filter(cell => cell.state !== 'unsold') };
  let requests = 0;
  const verify = createOsMemberProofVerifier(c.proofSecret);
  const send = async (url, init) => {
    requests++;
    assert.match(url, /calendar-snapshot\?from=2026-10-25&to=2026-10-26$/);
    assert.equal((await verify(new Request(url, init), { ...c.grant, origin: 'os' }))?.subjectId, principal.id);
    return Response.json(snapshot);
  };
  const result = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    principal, c, send);
  assert.equal(requests, 1);
  assert.equal(result.soldRoomNights, 1);
  assert.equal(result.blockedRoomNights, 1);
  assert.equal(result.bookings[0].platform, 'booking');
  await assert.rejects(readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    principal, c, async () => Response.json({ ...snapshot, cells: snapshot.cells.slice(1) })),
  /IRON_GATE_CALENDAR_INVENTORY_DRIFT/);
});

test('manual Iron Gate booking projects its edit identity and sync state', async () => {
  const c = config(), data = fixture({ blocked: false });
  const booking = { ...data.page.bookings[0], source: 'os', version: 3,
    channelSyncState: 'verified', sourceReviewRequired: false,
    bookedAt: '2026-10-13', sourceCalendar: undefined };
  const snapshot = { propertyId, workspaceId, from: '2026-10-25', to: '2026-10-26',
    inventoryVersion: 7, authorityEpoch: 1, readOnly: false,
    bookings: [booking], cells: [{ roomId: roomIds['101'],
      date: '2026-10-25', state: 'sold' }] };
  const result = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    principal, c, async () => Response.json(snapshot));
  assert.equal(result.bookings[0].iron_gate_booking_id, booking.id);
  assert.equal(result.bookings[0].iron_gate_booking_version, 3);
  assert.equal(result.bookings[0].iron_gate_source, 'os');
  assert.equal(result.bookings[0].iron_gate_channel_sync, 'verified');
  assert.equal(result.bookings[0].iron_gate_source_review, false);
  assert.equal(result.bookings[0].booked_at, '2026-10-13');
  assert.equal(result.bookings[0].platform, 'direct');
});

test('calendar shows verified stay price to price roles and hides it from no-price roles', async () => {
  const c = config(), data = fixture({ blocked: false });
  const snapshot = { propertyId, workspaceId, from: '2026-10-25', to: '2026-10-26',
    inventoryVersion: 7, authorityEpoch: 1, readOnly: false,
    bookings: [{ ...data.page.bookings[0], totalCents: 360000, currency: 'TWD',
      stayAmountsCents: [360000], paymentReview: {
      status: 'paid', source: 'sheet_flag' } }],
    cells: data.availability.cells.filter(cell => cell.state === 'sold') };
  const send = async () => Response.json(snapshot);
  const owner = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    principal, c, send);
  assert.equal(owner.bookings[0].payment_status, 'paid');
  assert.equal(owner.bookings[0].payment_review_status, 'paid');
  assert.equal(owner.bookings[0].price_hidden, false);
  assert.equal(owner.bookings[0].room_rate, 3600);
  assert.equal(owner.bookings[0].source_order_total_cents, 360000);
  assert.equal(owner.bookings[0].source_payment_flag, 'done');
  const noPrice = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    { ...principal, viewPrices: false }, c, send);
  assert.equal(noPrice.bookings[0].payment_status, 'unknown');
  assert.equal(noPrice.bookings[0].payment_review_status, undefined);
  assert.equal(noPrice.bookings[0].source_payment_flag, 'unknown');
  assert.equal(noPrice.bookings[0].price_hidden, true);
  assert.equal(noPrice.bookings[0].room_rate, 0);
  assert.equal(noPrice.bookings[0].source_order_total_cents, undefined);
});

test('four-room OTA order exposes only the whole total without fabricating room prices', async () => {
  const c = config(), data = fixture({ blocked: false });
  const booking = { ...data.page.bookings[0],
    stays: ['101', '102', '201', '302'].map(room => ({
      checkIn: '2026-10-25', checkOut: '2026-10-26', roomIds: [roomIds[room]] })),
    sourceCalendar: { platform: 'booking', externalOrderNo: '9876543210', bookedAt: null },
    totalCents: 2061400, currency: 'TWD', stayAmountsCents: null };
  const snapshot = { propertyId, workspaceId, from: '2026-10-25', to: '2026-10-26',
    inventoryVersion: 7, authorityEpoch: 1, readOnly: false,
    bookings: [booking], cells: booking.stays.map(stay => ({
      roomId: stay.roomIds[0], date: '2026-10-25', state: 'sold' })) };
  const owner = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    principal, c, async () => Response.json(snapshot));
  assert.equal(owner.bookings.length, 4);
  assert.ok(owner.bookings.every(row => row.platform === 'booking' &&
    row.external_order_no === '9876543210' && row.price_hidden &&
    row.room_rate === 0 && row.source_order_total_cents === 2061400));
  const noPrice = await readSweetfunIronGateCalendarSnapshot(snapshot.from, snapshot.to,
    { ...principal, viewPrices: false }, c, async () => Response.json(snapshot));
  assert.ok(noPrice.bookings.every(row => row.source_order_total_cents === undefined));
});
