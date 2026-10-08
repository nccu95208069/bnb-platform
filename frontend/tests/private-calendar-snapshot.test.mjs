import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { RedisPrivateCalendarCache, makePrivateSnapshot, sealPrivateSnapshot, openPrivateSnapshot } from '../src/lib/booking-sources/private-calendar-snapshot.ts';
import { BlobPrivateCalendarCache, MirroredPrivateCalendarCache } from '../src/lib/booking-sources/private-calendar-backup.ts';
import { readCalendarSources } from '../src/lib/booking-sources/calendar-reader.ts';
import { attachPrivateGuestNames } from '../src/lib/booking-sources/private-guest-names.ts';
import { SWEETFUN_SOURCE } from '../src/lib/booking-sources/config.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { HEADERS } from '../src/lib/sheet-monitor/reconcile.ts';
import { localRedis } from './helpers/redis-command.mjs';
const secret = 'synthetic-secret-'.repeat(4);
const source = { ...SWEETFUN_SOURCE, sourceId: `synthetic-${randomUUID()}` };
const values = [HEADERS, ['301', 'PRIVATE_GUEST', 'Agoda', '2026-09-30', '2026-10-01', '2026-08-01', '2500', 'done', 'OK', 'one', 'PRIVATE_NOTE', 'parent'], ['301', 'PRIVATE_GUEST', 'Agoda', '2026-10-01', '2026-10-02', '2026-08-01', '2500', 'done', 'OK', 'two', 'PRIVATE_NOTE', 'parent'], ['301', 'FUTURE_GUEST', 'Agoda', '2026-12-01', '2026-12-02', '2026-08-01', '3000', 'done', 'OK', 'future', 'PRIVATE_NOTE', 'future-parent']];
function fixture(offset = 0, name = 'PRIVATE_GUEST') {
 const snapshot = adaptSheetBookings(values, source.sourceId, new Date(Date.now() - 1000 + offset).toISOString(), [], undefined, source.property);
 snapshot.source.sync = { status: 'healthy', last_successful_check_at: new Date(Date.now() - 1000 + offset).toISOString(), last_checked_at: new Date().toISOString(), last_published_at: new Date().toISOString(), cutoff: '2026-09-01', interval_seconds: 30, error_code: null };
 const bookings = attachPrivateGuestNames(snapshot.bookings, values, source).map(b => ({...b, guest_name: name}));
 return {snapshot, bookings};
}
function objects() {
 const files = new Map();
 return { files, list: async prefix => [...files.keys()].filter(k => k.startsWith(prefix)), read: async path => files.get(path) ?? null, write: async (path, data) => { assert.ok(!files.has(path)); files.set(path, data); }, remove: async paths => paths.forEach(p => files.delete(p)) };
}
test('authenticated encrypted envelope hides private data and rejects tampering, cross-property, expiry and a truncated month', () => {
 const {snapshot, bookings} = fixture(), v = makePrivateSnapshot(source, snapshot, bookings, Date.now()-2000), e=sealPrivateSnapshot(v, source, secret);
 assert.equal(JSON.stringify(e).includes('PRIVATE'), false); assert.equal(openPrivateSnapshot(e,source,secret).bookings[0].guest_name,'PRIVATE_GUEST');
 assert.throws(()=>openPrivateSnapshot({...e,started_at:e.started_at+1},source,secret));
 assert.throws(()=>openPrivateSnapshot(e,{...source,sourceId:'other'},secret));
 assert.throws(()=>openPrivateSnapshot(e,source,'another-secret-'.repeat(4)));
 const old={...v,captured_at:new Date(Date.now()-31*86400000).toISOString()};assert.throws(()=>sealPrivateSnapshot(old,source,secret));
 assert.throws(()=>sealPrivateSnapshot({...v,bookings:bookings.slice(0,1)},source,secret));
 assert.equal(makePrivateSnapshot(source,{...snapshot,source:{...snapshot.source,sync:{...snapshot.source.sync,status:'error'}}},bookings,Date.now()),null);
 assert.equal(makePrivateSnapshot(source,snapshot,bookings.map(b=>({...b,payment_unconfirmed:true})),Date.now()),null);
});
test('real Redis preserves three encrypted versions and ignores older request completions', async t => {
 const keys = new Set(); const cmd = command => { if(command[0]==='EVAL')keys.add(command[3]);return localRedis(command); };
 const cache = new RedisPrivateCalendarCache(cmd,secret);
 t.after(async()=>{for(const key of keys)await localRedis(['DEL',key]);});
 const started=Date.now()-2000;const base=fixture();
 for(let i=0;i<4;i++)await cache.publish(source,base.snapshot,base.bookings.map(b=>({...b,guest_name:`version-${i}`})),started+i);
 await cache.publish(source,base.snapshot,base.bookings,started-10);
 assert.equal((await cache.read(source)).bookings[0].guest_name,'version-3');
 const key=[...keys][0], history=JSON.parse(await localRedis(['GET',key]));assert.equal(history.length,3);assert.ok(await localRedis(['TTL',key])>0);
 history[0].encrypted='broken';await localRedis(['SET',key,JSON.stringify(history)]);
 assert.equal((await cache.read(source)).bookings[0].guest_name,'version-2');
});
test('independent immutable backup retains newest versions and survives a broken latest object and primary outage', async () => {
 const store=objects(), backup=new BlobPrivateCalendarCache(store,secret), broken={read:async()=>{throw Error('down');},publish:async()=>{throw Error('down');}}, cache=new MirroredPrivateCalendarCache([broken,backup]);
 const base=fixture(), started=Date.now()-2000;
 for(let i=0;i<4;i++)await assert.rejects(()=>cache.publish(source,base.snapshot,base.bookings.map(b=>({...b,guest_name:`version-${i}`})),started+i),/PRIVATE_SNAPSHOT_WRITE/);
 assert.equal(store.files.size,3);assert.equal((await cache.read(source)).bookings[0].guest_name,'version-3');
 await backup.publish(source,base.snapshot,base.bookings,started-10);assert.equal((await backup.read(source)).bookings[0].guest_name,'version-3');
 const latest=[...store.files.keys()].sort()[0];store.files.set(latest,'broken');assert.equal((await backup.read(source)).bookings[0].guest_name,'version-2');
 assert.ok([...store.files.values()].every(s=>!s.includes('PRIVATE_GUEST')));
});
test('first load and unvisited months use the full private snapshot after source failure; recovery replaces readonly fallback', async () => {
 const store=objects(), cache=new BlobPrivateCalendarCache(store,secret), {snapshot}=fixture();
 const deps={cache,snapshot:async()=>snapshot,details:async()=>values,payments:async rows=>rows};
 const live=await readCalendarSources([source],'2026-10-01','2026-11-01',true,deps);
 assert.equal(live.bookings.length,2);assert.equal(live.bookings[0].snapshot_only,undefined);assert.equal((await cache.read(source)).bookings.length,3);
 const failed=async()=>{throw Error('STORE_UNAVAILABLE');};
 for (const broken of [{snapshot:failed},{snapshot:async()=>({...snapshot,bookings:[]})},{details:failed},{payments:failed}]) {
  const result=await readCalendarSources([source],'2026-12-01','2027-01-01',true,{...deps,...broken});
  assert.equal(result.bookings.length,1);assert.equal(result.bookings[0].guest_name,'FUTURE_GUEST');assert.equal(result.bookings[0].snapshot_only,true);assert.equal(result.warnings[0].phase,'private_snapshot');assert.ok(result.warnings[0].captured_at);assert.equal(result.snapshots[0].snapshot.source.sync.status,'stale');
 }
 const recovery=await readCalendarSources([source],'2026-10-01','2026-11-01',true,deps);assert.equal(recovery.bookings[0].snapshot_only,undefined);
 const brokenPublish={read:async()=>null,publish:async()=>{throw Error('down');}};
 assert.equal((await readCalendarSources([source],'2026-10-01','2026-11-01',true,{...deps,cache:brokenPublish})).bookings.length,2);
});
