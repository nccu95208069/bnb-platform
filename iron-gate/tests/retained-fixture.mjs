import { MemoryPropertyRepository } from '../src/memory-repository.ts';
import { IronGateService } from '../src/service.ts';
import { OFFLAND_HEADERS, auditOfflandSnapshot } from '../src/offland-sheet-audit.mjs';
import { prepareOfflandShadow } from '../src/offland-shadow.mjs';

export const key = () => crypto.randomUUID();
export const code = wanted => error => error?.code === wanted;
export const retainReason = 'Synthetic guest will choose a new stay later';

export async function retentionFixture(options = {}) {
  const workspaceId = key(), propertyId = key(), roomId = key(), secondRoomId = key();
  const bookingId = key(), otherBookingId = key(), sourceGrantId = key(), channelGrantId = key();
  const row = (number, date, sourceId, parentId) => ({ rowNumber: number,
    values: ['OFFLAND', 'Synthetic Guest', options.platform ?? 'LINE', date,
      new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10),
      '2026-10-01', '6000', '', 'OK', sourceId, '', '', '', '', '', '', parentId] });
  const snapshot = { headers: [...OFFLAND_HEADERS], rows: [
    row(2, '2027-01-31', 'synthetic-child-a', 'synthetic-parent'),
    row(3, '2027-02-01', 'synthetic-child-b', 'synthetic-parent'),
    row(4, '2027-03-01', 'synthetic-single-c', ''),
  ] };
  const importConfig = { workspaceId, propertyId, roomId,
    inventoryVersion: 1, authorityEpoch: 0,
    expectedSourceHash: auditOfflandSnapshot(snapshot).sourceHash,
    sourceId: 'synthetic-offland-sheet', sourceCopyId: 'synthetic-offland-copy',
    capturedAt: '2026-10-28T00:00:00.000Z', sourceCopyCreatedAt: '2026-10-28T00:00:00.000Z',
    bookingIds: { 'Q:synthetic-parent': bookingId, 'J:synthetic-single-c': otherBookingId } };
  const { state } = prepareOfflandShadow(snapshot, importConfig);
  state.readOnly = false; state.authorityEpoch = 1;
  state.roomIds.push(secondRoomId);
  state.sourceGrants = [{ grantId: sourceGrantId, sourceSystem: 'offland-calendar-sheet',
    sourceAccount: 'synthetic-offland-sheet', active: true }];
  if (options.mode === 'owlnest') state.channel = { mode: 'owlnest', ready: true,
    websiteSalesEnabled: false, grantId: channelGrantId, websiteBindingId: null,
    sourceReadbackEnabled: true, stockObservedFrom: '2026-01-01', stockObservedThrough: '2028-12-31' };
  if (options.native) {
    state.bookings = []; state.sourceLinks = []; delete state.offlandImport;
  }
  const repository = options.repository ?? new MemoryPropertyRepository();
  await repository.seed(state);
  const service = new IronGateService(repository);
  const owner = { clientId: 'synthetic-os', subjectId: 'synthetic-owner', origin: 'os',
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1,
    actions: ['booking:read', 'booking:create', 'booking:amend', 'booking:cancel',
      'payment:write', 'event:read', 'booking:aggregate', 'occupancy:aggregate', 'housekeeping:read'],
    fields: ['guest_name', 'contact', 'notes', 'money', 'payment_status'] };
  let targetId = bookingId;
  if (options.native) {
    const created = await service.createBooking(owner, propertyId, key(), {
      expectedInventoryVersion: state.version,
      stays: [{ checkIn: '2027-01-31', checkOut: '2027-02-02', roomIds: [roomId] }],
      guestName: 'Synthetic Guest', contact: null, notes: null, totalCents: 1200000,
      bookedAt: '2026-10-01', source: 'os',
      roomNightPrices: [{ roomId, date: '2027-01-31', amountCents: 600000 },
        { roomId, date: '2027-02-01', amountCents: 600000 }],
    });
    targetId = created.bookingId;
  }
  const read = async () => {
    const current = await repository.read(propertyId);
    return { state: current, booking: current.bookings.find(b => b.id === targetId) };
  };
  const source = { clientId: 'synthetic-source', subjectId: 'synthetic-source', origin: 'source',
    workspaceId, propertyIds: [propertyId], authorityEpoch: 1, actions: ['source:write'], fields: [],
    grantId: sourceGrantId, sourceSystem: 'offland-calendar-sheet', sourceAccount: 'synthetic-offland-sheet' };
  const retainInput = async overrides => {
    const { state: current, booking } = await read();
    return { expectedBookingVersion: booking.version, expectedInventoryVersion: current.version,
      reason: retainReason, ...overrides };
  };
  const rescheduleInput = async overrides => {
    const { state: current, booking } = await read();
    return { expectedBookingVersion: booking.version, expectedInventoryVersion: current.version,
      reason: 'Synthetic new stay agreed',
      stays: [{ checkIn: '2027-04-04', checkOut: '2027-04-06', roomIds: [roomId] }],
      totalCents: 1400000,
      roomNightPrices: [{ roomId, date: '2027-04-04', amountCents: 600000 },
        { roomId, date: '2027-04-05', amountCents: 800000 }], ...overrides };
  };
  const sourceInput = async overrides => {
    const { state: current } = await read();
    const link = current.sourceLinks.find(item => item.bookingId === targetId);
    return { propertyId, sourceSystem: source.sourceSystem, sourceAccount: source.sourceAccount,
      externalOrderId: 'Q:synthetic-parent', sourceVersion: `synthetic:${key()}`,
      previousSourceVersion: link?.sourceVersion ?? null, kind: 'upsert',
      expectedInventoryVersion: current.version,
      stays: [{ checkIn: '2027-01-31', checkOut: '2027-02-02', roomIds: [roomId] }],
      guestName: 'Synthetic Guest', bookedAt: '2026-10-01', totalCents: 1200000, currency: 'TWD', ...overrides };
  };
  return { workspaceId, propertyId, roomId, secondRoomId, bookingId: targetId, otherBookingId,
    sourceGrantId, channelGrantId, repository, service, owner, source, read, retainInput,
    rescheduleInput, sourceInput, snapshot, importConfig };
}

export async function retain(fixture, requestKey = key(), overrides = {}) {
  const input = await fixture.retainInput(overrides);
  const response = await fixture.service.retainBooking(fixture.owner, fixture.propertyId,
    fixture.bookingId, requestKey, input);
  return { input, requestKey, response };
}

export function occupancy(state) {
  return state.bookings.filter(booking => ['held', 'confirmed'].includes(booking.status))
    .flatMap(booking => booking.stays.flatMap(stay => {
      const cells = [];
      for (let date = Date.parse(stay.checkIn); date < Date.parse(stay.checkOut); date += 86400000)
        for (const room of stay.roomIds) cells.push({ room_id: room,
          night: new Date(date).toISOString().slice(0, 10), booking_id: booking.id });
      return cells;
    }));
}
