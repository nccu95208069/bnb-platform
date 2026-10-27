import {previewCardSync,commitCardSync} from '../src/lib/booking-sources/iron-gate-card-sync.server.ts';
import {assertNotCardManaged} from '../src/lib/card-payment-ownership.ts';
import {cardAliases} from '../../iron-gate/src/card-sync.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { NextRequest } from 'next/server';
import { MemoryPropertyRepository } from '../../iron-gate/src/memory-repository.ts';
import { IronGateService } from '../../iron-gate/src/service.ts';
import { createHandler } from '../../iron-gate/src/http.ts';
import { createOsMemberProofVerifier } from '../../iron-gate/src/os-member-proof.mjs';
import { createOwnerSession, OWNER_COOKIE } from '../src/lib/calendar-owner-session.ts';
import { SWEETFUN_SOURCE as source } from '../src/lib/booking-sources/config.ts';
import { initialState } from '../src/lib/sheet-monitor/reconcile.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { HEADERS } from '../src/lib/sheet-monitor/reconcile.ts';
import { financeKey } from '../src/lib/finance-store.ts';
import { ledgerKey } from '../src/lib/os-payments.ts';
import { summarize, revenueSummary } from '../src/lib/finance-model.ts';
import { ironGateFinanceConfig, readDirectFinance, projectDirectFinance } from '../src/lib/booking-sources/iron-gate-finance.server.ts';
import { createManualBooking, ironGateManualConfig } from '../src/lib/booking-sources/iron-gate-manual.server.ts';
import { GET as financeGET, POST as financePOST } from '../src/app/api/v1/finance/route.ts';
import { POST as paymentPOST } from '../src/app/api/v1/bookings/manual/[bookingId]/payments/route.ts';
import { GET as recoverGET } from '../src/app/api/v1/bookings/manual/payment-requests/[requestKey]/route.ts';
import { POST as legacyPOST } from '../src/app/api/v1/order-payments/route.ts';

const uuid = () => crypto.randomUUID();
const workspaceId = '11111111-1111-4111-8111-111111111111';
const propertyId = '22222222-2222-4222-8222-222222222222';
const credentialId = '33333333-3333-4333-8333-333333333333';
const clientId = '44444444-4444-4444-8444-444444444444';
const roomIds = Object.fromEntries(['101', '102', '201', '202', '301', '302'].map((room, i) =>
  [room, `55555555-5555-4555-8555-55555555555${i}`]));
const owner = { id: 'synthetic-owner', role: 'owner', allProperties: true, propertyIds: ['sweetfun'], viewPrices: true };
const grant = { credentialId, clientId, workspaceId, propertyId, token: 'x'.repeat(43) };
const secret = 'synthetic-finance-proof-secret-32-bytes';
const principal = { clientId, subjectId: owner.id, origin: 'os', workspaceId,
  propertyIds: [propertyId], authorityEpoch: 1, actions: ['finance:ledger', 'payment:write', 'booking:read'], fields: ['money'] };

async function fixture(t) {
  const env = { CALENDAR_SOURCE: 'sheet_snapshot', SHEET_MONITOR_ENABLED: 'true', BOOKING_SHEET_SOURCES: 'sweetfun',
    CALENDAR_OWNER_CODE_HASH: 'a'.repeat(64), CALENDAR_OWNER_SESSION_SECRET: 'b'.repeat(64),
    IRON_GATE_CARD_SYNC_ENABLED:'true', CC_SYNC_OS_TOKEN:'synthetic-card-secret-at-least-32-bytes',
    IRON_GATE_CARD_SYNC_GRANT:JSON.stringify({...grant,token:'c'.repeat(43)}),
    KV_REST_API_URL: 'https://redis.invalid', KV_REST_API_TOKEN: 'test',
    IRON_GATE_SWEETFUN_CALENDAR_ENABLED: 'true', IRON_GATE_SWEETFUN_MANUAL_ENABLED: 'true',
    IRON_GATE_SWEETFUN_MANUAL_PAYMENTS_ENABLED: 'true', IRON_GATE_SWEETFUN_FINANCE_ENABLED: 'true',
    IRON_GATE_SWEETFUN_BASE_URL: 'https://iron-gate.example', IRON_GATE_SWEETFUN_AUTHORITY_EPOCH: '1',
    IRON_GATE_SWEETFUN_ROOM_IDS: JSON.stringify(roomIds), IRON_GATE_SWEETFUN_OS_PROOF_SECRET: secret,
    ...Object.fromEntries(['CALENDAR', 'MANUAL', 'MANUAL_PAYMENT', 'FINANCE'].map(name =>
      [`IRON_GATE_SWEETFUN_${name}_GRANT`, JSON.stringify(grant)])) };
  const before = { ...process.env };
  Object.assign(process.env, env);
  delete process.env.UPSTASH_REDIS_REST_URL; delete process.env.UPSTASH_REDIS_REST_TOKEN;
  t.after(() => { for (const name of Object.keys(process.env)) if (!(name in before)) delete process.env[name]; Object.assign(process.env, before); });
  const repository = new MemoryPropertyRepository();
  repository.seed({ workspaceId, propertyId, roomIds: Object.values(roomIds), version: 1, authorityEpoch: 1,
    readOnly: false, channel: { mode: 'none', ready: false, websiteSalesEnabled: false, grantId: null, websiteBindingId: null },
    sourceGrants: [], bookings: [], sourceLinks: [], operations: [], fences: [], manualBlocks: [], receipts: [] });
  const service = new IronGateService(repository), verifier = createOsMemberProofVerifier(secret);
  const handle = createHandler(service, async request => {
    if(request.headers.get('authorization')==='Bearer '+'c'.repeat(43))return {...principal,origin:'finance',subjectId:'card-sync',actions:['card:sync']};
    const proof = await verifier(request, { ...grant, origin: 'os' });
    return proof ? { ...principal, subjectId: proof.subjectId, actions: proof.actions, fields: proof.fields } : null;
  });
  const send = (url, options) => handle(new Request(url, options));
  const created = await createManualBooking(owner, ironGateManualConfig(), {
    expectedInventoryVersion: 1, stays: [{ checkIn: '2026-10-15', checkOut: '2026-10-17', roomNumbers: ['101', '102'] }],
    guestName: 'Synthetic Guest', contact: 'synthetic private contact', notes: 'synthetic private notes',
    totalCents: 100000, bookedAt: null }, uuid(), send);
  const snapshot = adaptSheetBookings([HEADERS], source.sourceId, new Date().toISOString(), [], [], source.property);
  const db = new Map([
    ['sweetfun-os:owner-auth:v1:credential', JSON.stringify({ schema: 1, kind: 'bootstrap', hash: process.env.CALENDAR_OWNER_CODE_HASH })],
    ['sweetfun:sheet-monitor:v1:sweetfun-operations-sheet-v1:state', 'gz1:' + gzipSync(JSON.stringify(initialState(snapshot))).toString('base64')],
  ]);
  const state = { repository, service, send, db, bookingId: created.bookingId, failAfterWrite: false,
    failSnapshots: false, writeCalls: 0, foreignCalls: 0 };
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).startsWith('https://iron-gate.example/')) {
      if (String(url).endsWith('/direct-snapshot') && state.failSnapshots) return Response.json({}, { status: 503 });
      const response = await send(url, options);
      if(String(url).endsWith('/card-sync/commit')&&state.cardUnknown&&response.ok)throw Error('simulated response lost after commit');
      if (options.method === 'POST' && String(url).endsWith('/payment-events')) {
        state.writeCalls++;
        if (state.failAfterWrite && response.ok) state.failSnapshots = true;
      }
      return response;
    }
    if (String(url) !== 'https://redis.invalid') { state.foreignCalls++; throw Error('unexpected external access'); }
    const command = JSON.parse(options.body); let result = null;
    if (command[0] === 'GET') result = db.get(command[1]) ?? null;
    else if (command[0] === 'MGET') result = command.slice(1).map(key => db.get(key) ?? null);
    else if (command[0] === 'SCAN') {
      const pattern = new RegExp('^' + command[3].replaceAll('*', '.*') + '$');
      result = ['0', [...db.keys()].filter(key => pattern.test(key))];
    } else if (command[0] === 'SET') {
      if (!command.includes('NX') || !db.has(command[1])) { db.set(command[1], command[2]); result = 'OK'; }
    } else if(command[0]==='EVAL'&&command[1].includes('for i=2,#KEYS')){
      const keys=command.slice(3,3+command[2]),args=command.slice(3+command[2]);
      if(db.get(keys[0])!==args[0])result=-1;else if(keys.slice(1).some(key=>db.has(key)&&db.get(key)!==args[1]))result=-2;else{for(const key of keys.slice(1))db.set(key,args[1]);result=1;}
    } else if (command[0] === 'EVAL' && command[1].includes('INCR')) result = 1;
    else if (command[0] === 'EVAL' && command[1].includes('DEL')) {
      if (db.get(command[3]) === command[4]) { db.delete(command[3]); result = 1; }
    } else throw Error('unexpected Redis mutation');
    return Response.json({ result });
  });
  const cookie = `${OWNER_COOKIE}=${createOwnerSession()}`;
  state.request = (path, input, requestKey) => new NextRequest(`https://os.test${path}`, {
    method: input ? 'POST' : 'GET', headers: { cookie, origin: 'https://os.test', host: 'os.test',
      'content-type': 'application/json', ...(requestKey ? { 'idempotency-key': requestKey } : {}) },
    ...(input ? { body: JSON.stringify(input) } : {}) });
  state.finance = () => financeGET(state.request('/api/v1/finance?property=sweetfun&year=2026'));
  state.payment = (input, requestKey = uuid()) => paymentPOST(state.request(`/api/v1/bookings/manual/${created.bookingId}/payments`, input, requestKey),
    { params: Promise.resolve({ bookingId: created.bookingId }) });
  state.recover = requestKey => recoverGET(state.request(`/api/v1/bookings/manual/payment-requests/${requestKey}`),
    { params: Promise.resolve({ requestKey }) });
  return state;
}
const receipt = (patch = {}) => ({ expectedBookingVersion: 1, kind: 'received', amountCents: 40000,
  method: 'bank_transfer', evidenceRef: 'synthetic unique receipt', occurredAt: '2026-09-30T15:00:00.000Z', ...patch });
async function body(response, status = 200) { const value = await response.json(); assert.equal(response.status, status, JSON.stringify(value)); return value; }

test('signed direct snapshot includes native orders only, excludes PII and changes revision for payments', async t => {
  const f = await fixture(t);
  await f.repository.transact(propertyId, state => state.bookings.push({ ...structuredClone(state.bookings[0]),
    id: uuid(), source: 'external', paymentEvents: [] }));
  const raw = await f.service.directFinanceSnapshot(principal, propertyId);
  assert.equal(raw.bookings.length, 1);
  assert.doesNotMatch(JSON.stringify(raw), /Synthetic Guest|synthetic private|guestName|contact|notes|sourceKey/);
  for (const patch of [{ actions: ['booking:read'] }, { fields: [] }, { origin: 'line' }, { propertyIds: [] }, { authorityEpoch: 2 }])
    await assert.rejects(f.service.directFinanceSnapshot({ ...principal, ...patch }, propertyId));
  const report = await readDirectFinance(owner, ironGateFinanceConfig(), [], f.send);
  assert.equal(report.orders[0].total, 100000);
  assert.deepEqual(report.orders[0].rooms, ['101', '102']);
  await body(await f.payment(receipt()), 201);
  const after = await f.service.directFinanceSnapshot(principal, propertyId);
  assert.equal(after.inventoryVersion, raw.inventoryVersion);
  assert.notEqual(after.revision, raw.revision);
  assert.throws(() => projectDirectFinance({ ...after, revision: raw.revision }, ironGateFinanceConfig(), []), /INCOMPLETE/);
});

test('real finance and payment routes count receipts and refunds once, including retries and cash/stay months', async t => {
  const f = await fixture(t), initial = await body(await f.finance()), requestKey = uuid();
  assert.equal(initial.iron_gate_direct_excluded, false);
  assert.equal(initial.orders[0].receivable, 100000);
  const received = await body(await f.payment(receipt(), requestKey), 201);
  assert.equal(received.financeVerified, true);
  assert.equal((await body(await f.payment(receipt(), requestKey), 201)).financeEntryId, received.financeEntryId);
  const partial = await body(await f.finance());
  assert.equal(partial.entries.length, 1); assert.equal(partial.orders[0].received, 40000);
  assert.notEqual(initial.projection_version, partial.projection_version);
  const refundKey = uuid();
  await body(await f.payment(receipt({ expectedBookingVersion: 2, kind: 'refunded', amountCents: 10000,
    refundOfEventId: requestKey, evidenceRef: 'synthetic refund', occurredAt: '2026-09-30T16:00:00.000Z' }), refundKey), 201);
  const report = await body(await f.finance());
  assert.equal(report.entries.length, 2); assert.equal(new Set(report.entries.map(entry => entry.id)).size, 2);
  assert.equal(report.orders[0].received, 30000); assert.equal(report.orders[0].receivable, 70000);
  assert.deepEqual(revenueSummary(report.orders, report.entries, '2026-10'), { received: 30000, receivable: 70000, total: 100000 });
  assert.equal(summarize(report.entries, '2026-09').net, 40000);
  assert.equal(summarize(report.entries, '2026-10').refund, 10000);
  assert.equal(summarize(report.entries, '2026-10').expense, 0);
  assert.equal(summarize(report.entries, '2026-10').net, -10000);
  assert.equal((await body(await f.recover(refundKey))).financeVerified, true);
  assert.equal([...f.db.keys()].filter(key => key.startsWith('sweetfun-os:finance:') || /^sweetfun-os:payments:v1:sweetfun:[a-f0-9]{64}$/.test(key)).length, 0);
  assert.equal(f.foreignCalls, 0);
});

test('both legacy entry points reject native receipts before mutating any ledger', async t => {
  const f = await fixture(t), report = await body(await f.finance()), id = `IG-${f.bookingId}`;
  const response = await financePOST(f.request('/api/v1/finance', { property_id: 'sweetfun', year: 2026,
    projection_version: report.projection_version, request_id: uuid(), action: 'create', kind: 'income', category: 'lodging',
    platform: 'direct', method: 'cash', amount: 10, allocations: [{ order_id: id, amount_cents: 1000 }] }));
  assert.equal((await body(response, 409)).code, 'IRON_GATE_DIRECT_PAYMENT_REQUIRED');
  const legacy = await legacyPOST(f.request('/api/v1/order-payments', { property_id: 'sweetfun',
    order_id: id, ig_booking_id: id, request_id: uuid(), amount: 10 }));
  assert.equal((await body(legacy, 409)).code, 'IRON_GATE_DIRECT_PAYMENT_REQUIRED');
  assert.equal(f.writeCalls, 0); assert.equal(f.foreignCalls, 0);
});

test('old manual allocations, calendar receipt identities and duplicate events block partial totals and new writes', async t => {
  const f = await fixture(t), id = `IG-${f.bookingId}`;
  for (const link of [{ allocations: [{ order_id: id, amount_cents: 1000 }] }, { order_id: id }, { order_key: ledgerKey('sweetfun', id) }]) {
    f.db.set(financeKey('sweetfun', 2025), JSON.stringify({ version: 1, entries: [{ id: uuid(), source: 'manual', property_id: 'sweetfun',
      kind: 'income', category: 'lodging', amount_cents: 1000, date: '2025-12-31', method: 'cash', status: 'active', ...link }], operations: [] }));
    assert.equal((await body(await f.finance(), 409)).code, 'IRON_GATE_LEGACY_LEDGER_CONFLICT');
    assert.equal((await body(await f.payment(receipt()), 409)).code, 'IRON_GATE_LEGACY_LEDGER_CONFLICT');
  }
  assert.equal(f.writeCalls, 0);
  f.db.delete(financeKey('sweetfun', 2025));
  await body(await f.payment(receipt()), 201);
  await f.repository.transact(propertyId, state => {
    const copy = structuredClone(state.bookings[0]); copy.id = uuid(); state.bookings.push(copy);
  });
  await body(await f.finance(), 503);
});

test('committed receipt with failed finance readback remains unknown; original request recovery proves one entry', async t => {
  const f = await fixture(t), requestKey = uuid();
  f.failAfterWrite = true;
  const uncertain = await body(await f.payment(receipt(), requestKey), 202);
  assert.equal(uncertain.outcome, 'unknown'); assert.equal(uncertain.request_key, requestKey);
  assert.equal((await f.repository.read(propertyId)).bookings[0].paymentEvents.length, 1);
  assert.equal((await body(await f.recover(requestKey), 202)).outcome, 'unknown');
  f.failSnapshots = false; f.failAfterWrite = false;
  const recovered = await body(await f.recover(requestKey));
  assert.equal(recovered.financeVerified, true); assert.equal(f.writeCalls, 1);
  assert.equal((await body(await f.finance())).entries.length, 1);
});

test('refund references, overpayment, stale versions and cancellations preserve authoritative balances', async t => {
  const f = await fixture(t), requestKey = uuid();
  assert.equal((await body(await f.payment(receipt({ amountCents: 100001 })), 409)).code, 'RECEIPT_EXCEEDS_DUE');
  await body(await f.payment(receipt(), requestKey), 201);
  assert.equal((await body(await f.payment(receipt({ evidenceRef: 'another' })), 409)).code, 'VERSION_CONFLICT');
  const refund = receipt({ expectedBookingVersion: 2, kind: 'refunded', refundOfEventId: requestKey,
    evidenceRef: 'refund', occurredAt: '2026-10-01T00:00:00.000Z' });
  assert.equal((await body(await f.payment({ ...refund, amountCents: 40001 }), 409)).code, 'REFUND_EXCEEDS_RECEIVED');
  assert.equal((await body(await f.payment({ ...refund, refundOfEventId: uuid() }), 400)).code, 'INVALID_REFUND_REFERENCE');
  await body(await f.payment(refund), 201);
  await f.repository.transact(propertyId, state => { state.bookings[0].status = 'cancelled'; state.bookings[0].version++; });
  const report = await body(await f.finance());
  assert.equal(report.entries.length, 2); assert.equal(report.orders[0].receivable, 0);
  assert.deepEqual(revenueSummary(report.orders, report.entries, '2026-10'), { received: 0, receivable: 0, total: 0 });
  assert.equal((await body(await f.payment(receipt({ expectedBookingVersion: 4, evidenceRef: 'cancelled receipt' })), 409)).code, 'RECEIPT_EXCEEDS_DUE');
});

test('a refund cannot exceed its original receipt even when another receipt leaves enough overall balance', async t => {
  const f = await fixture(t), first = uuid();
  await body(await f.payment(receipt({ amountCents: 20000 }), first), 201);
  await body(await f.payment(receipt({ expectedBookingVersion: 2, amountCents: 20000, evidenceRef: 'second receipt' })), 201);
  const rejected = await body(await f.payment(receipt({ expectedBookingVersion: 3, kind: 'refunded',
    refundOfEventId: first, amountCents: 30000, evidenceRef: 'oversized refund' })), 409);
  assert.equal(rejected.code, 'REFUND_EXCEEDS_RECEIVED');
  assert.equal((await body(await f.finance())).orders[0].received, 40000);
});

test('missing finance configuration fails closed and a source failure cannot produce a partial report', async t => {
  const f = await fixture(t);
  delete process.env.IRON_GATE_SWEETFUN_FINANCE_GRANT;
  await body(await f.finance(), 503);
  await body(await f.payment(receipt()), 503);
  assert.equal(f.writeCalls, 0);
  process.env.IRON_GATE_SWEETFUN_FINANCE_GRANT = JSON.stringify(grant);
  f.failSnapshots = true;
  await body(await f.finance(), 503);
  assert.equal(((await f.repository.read(propertyId)).bookings[0].paymentEvents ?? []).length, 0);
  let calls = 0;
  for (const patch of [{ role: 'housekeeper' }, { viewPrices: false }, { allProperties: false, propertyIds: ['offland'] }])
    await assert.rejects(readDirectFinance({ ...owner, ...patch }, ironGateFinanceConfig(), [],
      async () => { calls++; throw Error('must not send'); }), /FORBIDDEN/);
  assert.equal(calls, 0);
});

const cardInput={sheetId:'1ccdaF5t0uIo0yqoJdSgKoG68UnBeWzCXfV5dQtMeK4A',tab:'20261027-20261101',row:2,platform:'booking',orderId:'1234567890',checkIn:'2026-10-15',checkOut:'2026-10-17',amountCents:100000,status:'done',chargeDate:'2026-10-27'};
async function cardFixture(t){
 const f=await fixture(t);
 const rows=['101','102'].flatMap(room=>['15','16'].map((night,i)=>[room,'Synthetic','Booking.com',`2026-10-${night}`,`2026-10-${Number(night)+1}`,'2026-10-01','250','not_yet','OK',`synthetic-${room}-${i}`,'','synthetic-order','2','1234567890','','','']));
 await f.repository.transact(propertyId,state=>{const b=state.bookings[0];b.source='external';b.sourceCalendar={platform:'Booking.com',externalOrderNo:cardInput.orderId};b.sweetfunSnapshot={groupKey:'L:synthetic-order',rows:rows.map(values=>({values,roomFeeCents:25000}))};});
 const snapshot=adaptSheetBookings([HEADERS,...rows],source.sourceId,new Date().toISOString(),[],[],source.property);
 f.db.set('sweetfun:sheet-monitor:v1:sweetfun-operations-sheet-v1:state','gz1:'+gzipSync(JSON.stringify(initialState(snapshot))).toString('base64'));
 f.aliases=cardAliases(await f.repository.read(propertyId),(await f.repository.read(propertyId)).bookings[0]);
 return f;
}
test('Booking card preview/commit and actual OS finance route count whole multi-room stay once across retries and week moves',async t=>{
 const f=await cardFixture(t),before=await body(await f.finance());
 assert.equal(before.orders.length,1);assert.equal(before.entries.length,0);
 const preview=await previewCardSync(cardInput);assert.equal(preview.action,'record_received');
 const confirmed=await commitCardSync({input:cardInput,previewToken:preview.previewToken});assert.equal(confirmed.financeVerified,true);
 await commitCardSync({input:cardInput,previewToken:preview.previewToken});
 const after=await body(await f.finance());assert.equal(after.orders.length,1);assert.equal(after.entries.length,1);
 assert.equal(after.orders[0].platform,'booking');assert.equal(after.orders[0].total,100000);assert.equal(after.orders[0].received,100000);assert.equal(after.orders[0].receivable,0);
 assert.equal(after.entries[0].method,'credit_card');assert.equal(after.entries[0].date,'2026-10-27');
 assert.equal((await previewCardSync({...cardInput,row:8,tab:'20261102-20261108'})).action,'already_synced');
 for(const alias of f.aliases)await assert.rejects(()=>assertNotCardManaged('sweetfun',[alias]),/CARD_PAYMENT_REVIEW_REQUIRED/);
 assert.equal(f.foreignCalls,0);
});
test('OS legacy receipt under original SF identity blocks before IronGate write',async t=>{
 const f=await cardFixture(t),alias=f.aliases.find(id=>id.startsWith('SF-'));
 f.db.set(ledgerKey('sweetfun',alias),JSON.stringify({version:1,receipts:[{id:uuid(),status_only:true}]}));
 await assert.rejects(()=>previewCardSync(cardInput),/CARD_LEGACY_PAYMENT_REVIEW/);
 assert.equal((await f.repository.read(propertyId)).bookings[0].paymentEvents?.length??0,0);
});
test('lost response retains ownership; fresh preview and replay find exactly the original event',async t=>{
 const f=await cardFixture(t),preview=await previewCardSync(cardInput);f.cardUnknown=true;
 await assert.rejects(()=>commitCardSync({input:cardInput,previewToken:preview.previewToken}),/CARD_RESULT_UNKNOWN/);
 assert.equal((await f.repository.read(propertyId)).bookings[0].paymentEvents.length,1);
 for(const alias of f.aliases)await assert.rejects(()=>assertNotCardManaged('sweetfun',[alias]),/CARD_PAYMENT_REVIEW_REQUIRED/);
 assert.equal((await previewCardSync(cardInput)).action,'already_synced');f.cardUnknown=false;
 await commitCardSync({input:cardInput,previewToken:preview.previewToken});assert.equal((await body(await f.finance())).entries.length,1);
});
test('signed plan rejects edits, and a legacy receipt between preview and confirm blocks',async t=>{
 const f=await cardFixture(t),preview=await previewCardSync(cardInput);
 await assert.rejects(()=>commitCardSync({input:{...cardInput,amountCents:200000},previewToken:preview.previewToken}),/CARD_SOURCE_CHANGED/);
 await assert.rejects(()=>commitCardSync({input:cardInput,previewToken:preview.previewToken+'x'}),/CARD_PREVIEW_REQUIRED/);
 f.db.set(ledgerKey('sweetfun',f.aliases[0]),JSON.stringify({version:1,receipts:[{id:uuid(),status_only:true}]}));
 await assert.rejects(()=>commitCardSync({input:cardInput,previewToken:preview.previewToken}),/CARD_LEGACY_PAYMENT_REVIEW/);
 assert.equal((await f.repository.read(propertyId)).bookings[0].paymentEvents?.length??0,0);
});
