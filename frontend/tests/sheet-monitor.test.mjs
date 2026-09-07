import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { adaptSweetfunSheet } from "../src/lib/booking-sources/sweetfun-sheet.ts";
import { HEADERS, SOURCE_ID, cutoffDay, initialState, normalizeRows, reconcile, publicSnapshot, scopedRows } from "../src/lib/sheet-monitor/reconcile.ts";
import { authorized, runMonitor } from "../src/lib/sheet-monitor/runner.ts";
import { readOperationalSheet } from "../src/lib/sheet-monitor/google.ts";
import { RedisMonitorStore, COMMIT_SCRIPT } from "../src/lib/sheet-monitor/store.ts";
import { SWEETFUN_SOURCE, OFFLAND_SOURCE, sourceDefinition } from "../src/lib/booking-sources/config.ts";
import { collectSnapshots } from "../src/lib/booking-sources/collection.ts";

const t0 = "2026-09-06T00:00:00Z", t1 = "2026-09-06T00:01:00Z", t2 = "2026-09-06T00:02:00Z", t3 = "2026-09-06T00:03:00Z";
const row = (id, start = "2026-09-15", patch = {}) => Object.assign(["301", "DO_NOT_STORE_GUEST", "Agoda", start, new Date(Date.parse(start) + 86400000).toISOString().slice(0,10), "2026-08-01", "2500", "done", "OK", id, "DO_NOT_STORE_NOTE", ""], patch);
const values = rows => [HEADERS, ...rows];
const seed = rows => adaptSweetfunSheet(values(rows), SOURCE_ID, t0);
const ready = rows => reconcile(reconcile(initialState(seed(rows)), values(rows), t0), values(rows), t1);
const confirm = (state, rows) => reconcile(reconcile(state, values(rows), t2), values(rows), t3);
// Synthetic second property; this is not an assumption about OFFLAND's unread Sheet.
const otherSource = { ...SWEETFUN_SOURCE, key:"fixture-villa", sourceId:"fixture-villa-sheet",
  property:{ id:"fixture-villa",name:"Fixture villa",sourceLabel:"Fixture source",rooms:[{number:"301",id:"fixture-villa-unit"}] } };

test("identical source row/order IDs are namespaced across properties",()=>{
  const rows=values([row("same-row",undefined,{11:"same-order"})]);
  const a=seed([row("same-row",undefined,{11:"same-order"})]);
  const b=adaptSweetfunSheet(rows,otherSource.sourceId,t0,[],undefined,otherSource.property);
  assert.notEqual(a.bookings[0].id,b.bookings[0].id);assert.notEqual(a.bookings[0].order_id,b.bookings[0].order_id);
  assert.equal(b.bookings[0].property_id,"fixture-villa");assert.equal(b.bookings[0].room_id,"fixture-villa-unit");
  const state=reconcile(reconcile(initialState(b),rows,t0,otherSource),rows,t1,otherSource);
  assert.equal(state.snapshot.source.id,otherSource.sourceId);
  assert.equal(state.snapshot.bookings[0].property_id,"fixture-villa");
  assert.throws(()=>reconcile(state,rows,t2,SWEETFUN_SOURCE),/MONITOR_SOURCE_MISMATCH/);
});
test("conflicts block only configured units, with no cross-source acknowledgement reuse",()=>{
  const rows=values([row("same"),row("same")]);
  const a=seed([row("same"),row("same")]);
  const b=adaptSweetfunSheet(rows,otherSource.sourceId,t0,a.issues.map(i=>i.fingerprint),undefined,otherSource.property);
  assert.equal(b.summary.new_issue_rows,2);assert.equal(b.bookings.length,1);assert.equal(b.bookings[0].room_id,"fixture-villa-unit");
  const unknown=adaptSweetfunSheet(values([row("unknown",undefined,{0:"UNKNOWN ROOM"})]),otherSource.sourceId,t0,[],undefined,otherSource.property);
  assert.equal(unknown.bookings.length,1);assert.equal(unknown.bookings[0].property_id,"fixture-villa");
});
test("unverified sources and object prototype names are never routable",()=>{
  assert.throws(()=>sourceDefinition("unregistered-property"),/NOT_CONFIGURED/);
  assert.throws(()=>sourceDefinition("__proto__"),/NOT_CONFIGURED/);
});
test("OFFLAND verified headers map O to parent ID, L to guest count and NT$ to room-night amount",()=>{
  const headers=["房間","用戶名稱","預定平台","入住日期","退房日期","預訂日期","房費","全額支付狀態","檢查狀態","唯一ID","備註","入住人數","付款日期","已付金額","刷卡狀態","付款UID"];
  const first=["OFFLAND","PRIVATE NAME","Booking","2026/9/15","2026/9/16","2026/8/1","NT$10,000","","OK","row1","PRIVATE NOTE","8人","","","OBE123",""];
  const second=[...first];second[0]="OFFLAND(連住)";second[3]="2026/9/16";second[4]="2026/9/17";second[9]="row2";second[6]="NT$12,000";
  const rows=normalizeRows([headers,first,second],OFFLAND_SOURCE);
  const snapshot=adaptSweetfunSheet([HEADERS,...rows.map(r=>r.cells)],OFFLAND_SOURCE.sourceId,t0,[],undefined,OFFLAND_SOURCE.property);
  assert.equal(snapshot.summary.quarantined_rows,0);
  assert.equal(snapshot.bookings[0].order_id,snapshot.bookings[1].order_id);
  assert.deepEqual(snapshot.bookings.map(b=>b.room_rate),[10000,12000]);
  assert.equal(snapshot.bookings[0].source_guest_count,8);
  assert.equal(snapshot.bookings[0].payment_status,"unknown");assert.deepEqual(snapshot.bookings[0].payments,[]);
  assert.equal(snapshot.bookings[0].room_id,"offland-villa");assert.equal(JSON.stringify(snapshot).includes("OBE123"),false);
  assert.equal(JSON.stringify(rows).includes("PRIVATE"),false);
});
test("a failed property remains explicitly unavailable without discarding another property",async()=>{
  const result=await collectSnapshots([SWEETFUN_SOURCE,OFFLAND_SOURCE],async source=>{
    if(source.key==="offland")throw new Error("private provider error");return seed([row("a")]);
  });
  assert.equal(result.snapshots.length,1);assert.equal(result.snapshots[0].definition.key,"sweetfun");
  assert.deepEqual(result.errors,[{property_id:"offland",label:"OFFLAND 訂房表"}]);
  await assert.rejects(()=>collectSnapshots([SWEETFUN_SOURCE],async()=>{throw new Error("offline");}),/UNAVAILABLE/);
});
test("separate property locks and storage keys cannot overwrite each other",async()=>{
  const original=globalThis.fetch;const acquired=[];
  globalThis.fetch=async(_url,options)=>{const command=JSON.parse(options.body);acquired.push(command[1]);return Response.json({result:"OK"});};
  try{
    const a=new RedisMonitorStore("https://test.invalid","token",SWEETFUN_SOURCE);
    const b=new RedisMonitorStore("https://test.invalid","token",otherSource);
    assert.ok(await a.acquire());assert.ok(await b.acquire());assert.notEqual(acquired[0],acquired[1]);
    await assert.rejects(()=>b.commit("owner",ready([row("a")])),/MONITOR_SOURCE_MISMATCH/);
  }finally{globalThis.fetch=original;}
});

test("Taipei calendar cutoff is inclusive and crosses UTC midnight correctly", () => {
  assert.equal(cutoffDay("2026-09-05T16:00:00Z"), "2026-08-07");
  assert.equal(cutoffDay("2026-09-05T15:59:59Z"), "2026-08-06");
  const old = normalizeRows(values([row("archive", "2026-08-06"), row("boundary", "2026-08-07"), row("future", "2028-01-01")]));
  const next = scopedRows(old, normalizeRows(values([row("archive", "2026-08-06", {6:"9999"}), row("boundary", "2026-08-07", {6:"3000"}), row("future", "2028-01-01", {6:"3500"})])), t0);
  assert.deepEqual(Object.fromEntries(next.map(r => [r.cells[9], r.cells[6]])), {archive:"2500",boundary:"3000",future:"3500"});
});
test("check-ins before cutoff that have not checked out and complete parent groups remain selected", () => {
  const old = [{cells:row("long", "2026-07-01", {4:"2026-09-10",11:"parent"}),sourceRow:2}, {cells:row("earlier", "2026-06-30",{11:"parent"}),sourceRow:3}];
  const next = old.map(r=>({...r,cells:[...r.cells]})); next[1].cells[6]="4000";
  assert.equal(scopedRows(old,next,t0).find(r=>r.cells[9]==="earlier").cells[6], "4000");
});
test("new changes require two separated observations, not duplicate retries", () => {
  const state = ready([row("a")]);
  const changed = values([row("a",undefined,{6:"3100"}),row("b","2026-09-16")]);
  const pending = reconcile(state,changed,t2);
  assert.equal(pending.snapshot.bookings.length,1);
  assert.equal(reconcile(pending,changed,t2).snapshot.bookings[0].room_rate,2500);
  const next = reconcile(pending,changed,t3);
  assert.equal(next.snapshot.bookings.length,2);
  assert.equal(next.snapshot.bookings[0].room_rate,3100);
  assert.deepEqual(next.audit.at(-1), {at:t3,version:next.snapshot.source.snapshot_version,added:1,removed:0,changed:1});
});
test("delete/reinsert transient is never published; a stable actual removal is retired", () => {
  const rows=[row("a"),row("b","2026-09-16")];
  const state=ready(rows);
  const pending=reconcile(state,values([rows[0]]),t2);
  assert.equal(pending.snapshot.bookings.length,2);
  const restored=reconcile(pending,values(rows),t3);
  assert.equal(restored.pending,null);
  assert.equal(restored.snapshot.bookings.length,2);
  const removed=confirm(state,[rows[0]]);
  assert.equal(removed.snapshot.bookings.length,1);
  assert.equal(removed.audit.at(-1).removed,1);
});
test("rescheduling outside the window replaces the previous date; historical data is retained", () => {
  const state=ready([row("move"),row("old","2026-01-01")]);
  const next=confirm(state,[row("move","2026-07-01")]);
  assert.deepEqual(next.snapshot.bookings.map(b=>b.check_in).sort(),["2026-01-01","2026-07-01"]);
  assert.equal(next.audit.at(-1).removed,0);
});
test("first activation does not erase historical seed cards absent from today's Sheet", () => {
  const initial=initialState(seed([row("old","2026-01-01"),row("a")]));
  const state=reconcile(reconcile(initial,values([row("a")]),t0),values([row("a")]),t1);
  assert.equal(state.snapshot.bookings.length,2);
  assert.equal(reconcile(state,values([row("a")]),t2).snapshot.bookings.length,2);
});
test("changing identity without parent becomes remove/add, never guest-name matching", () => {
  const state=ready([row("a")]);
  const next=confirm(state,[row("b")]);
  assert.notEqual(next.snapshot.bookings[0].id,state.snapshot.bookings[0].id);
  assert.equal(next.audit.at(-1).removed,1);
  assert.equal(next.audit.at(-1).added,1);
});
test("row reorder is a no-op business version but refreshes current issue row references", () => {
  const rows=[row("a"),row("b","2026-09-16"),row("a")];
  const state=ready(rows);
  const next=reconcile(state,values([rows[1],rows[0],rows[2]]),t2);
  assert.equal(next.snapshot.source.snapshot_version,state.snapshot.source.snapshot_version);
  assert.equal(next.audit.length,state.audit.length);
  assert.deepEqual(next.snapshot.issues.find(i=>i.code==="duplicate_row_id").rows,[3,4]);
});
test("old issue acknowledgements survive aging out, while future new conflicts alert", () => {
  const rows=[row("old","2026-01-01"),row("old","2026-01-01"),row("a")];
  const snapshot=seed(rows);
  snapshot.issues.forEach(i=>i.acknowledged=true);
  let state=reconcile(reconcile(initialState(snapshot),values(rows),t0),values(rows),t1);
  state=confirm(state,[row("a"),row("a")]);
  assert.equal(state.snapshot.summary.historical_issue_rows,2);
  assert.equal(state.snapshot.summary.new_issue_rows,2);
  assert.equal(state.snapshot.bookings.filter(b=>b.source_conflict).length,2);
});
test("a resolved active conflict recurs as new; previous exception is not blanket approval", () => {
  const rows=[row("a"),row("a")];const snapshot=seed(rows);snapshot.issues.forEach(i=>i.acknowledged=true);
  const state=reconcile(reconcile(initialState(snapshot),values(rows),t0),values(rows),t1);
  const resolved=confirm(state,[rows[0]]);
  const next=reconcile(reconcile(resolved,values(rows),"2026-09-06T00:04:00Z"),values(rows),"2026-09-06T00:05:00Z");
  assert.equal(next.snapshot.summary.new_issue_rows,2);
});
test("identity/date/schema errors and an empty source fail closed", () => {
  const state=ready([row("a")]);
  for(const v of [[['wrong']],values([]),values([row("")]),values([row("a",undefined,{3:"2026-02-30"})]),values([row("a",undefined,{4:"2026-09-17"})])]) assert.throws(()=>reconcile(state,v,t2));
});
test("neither private persisted projection nor public response retains guest/contact notes", () => {
  const state=ready([row("PRIVATE_ROW",undefined,{11:"PRIVATE_PARENT"})]);
  assert.equal(JSON.stringify(state).includes("DO_NOT_STORE"),false);
  const output=JSON.stringify(publicSnapshot(state,t2));
  assert.equal(output.includes("PRIVATE"),false);
  assert.equal(output.includes('"rows"'),true); // Only a numeric public summary, no source cells.
  assert.equal(output.includes('"cells"'),false);
  assert.equal(state.snapshot.source.payment_ledger_available,false);
});
test("monitor status distinguishes waiting, confirming, healthy and missed checks", () => {
  const init=initialState(seed([row("a")]));
  assert.equal(publicSnapshot(init,t0).source.sync.status,"waiting");
  assert.equal(publicSnapshot(reconcile(init,values([row("a")]),t0),t0).source.sync.status,"confirming");
  const state=ready([row("a")]);
  assert.equal(publicSnapshot(state,t2).source.sync.status,"healthy");
  assert.equal(publicSnapshot(state,"2026-09-06T00:07:00Z").source.sync.status,"stale");
});
class MemoryStore {
  owner=null; state=null;
  async acquire(){ if(this.owner)return null; return this.owner="owner"; }
  async read(){return structuredClone(this.state);}
  async commit(owner,state){if(owner!==this.owner)return false;this.state=structuredClone(state);return true;}
  async release(owner){if(owner===this.owner)this.owner=null;}
}
test("runner serializes concurrent work, persists across instances and verifies commits", async () => {
  const store=new MemoryStore(); let releaseRead;
  const input=values([row("a")]);
  const first=runMonitor({store,seed:async()=>seed([row("a")]),read:()=>new Promise(r=>{releaseRead=r;}),now:()=>t0});
  while(!releaseRead) await new Promise(r=>setImmediate(r));
  assert.equal((await runMonitor({store,seed:async()=>{throw new Error("unexpected");},read:async()=>input})).status,"busy");
  releaseRead(input);assert.equal((await first).status,"confirming");
  const restart=new MemoryStore();restart.state=await store.read();
  assert.equal((await runMonitor({store:restart,seed:async()=>{throw new Error("unexpected");},read:async()=>input,now:()=>t1})).status,"ok");
  assert.equal(restart.state.snapshot.bookings.length,1);
});
test("source errors retain last data, clear pending deletion and never return provider secrets",async()=>{
  const store=new MemoryStore();store.state=ready([row("a"),row("b","2026-09-16")]);
  store.state=reconcile(store.state,values([row("a")]),t2);
  const result=await runMonitor({store,seed:async()=>null,read:async()=>{throw new Error("secret-key-and-guest");},now:()=>t3});
  assert.equal(result.status,"error");assert.equal(result.sync.error_code,"MONITOR_CHECK_FAILED");
  assert.equal(store.state.snapshot.bookings.length,2);assert.equal(store.state.pending,null);
  assert.equal(JSON.stringify(result).includes("secret"),false);
});
test("expired lock owner cannot publish and missing/bad auth fails closed",async()=>{
  const store=new MemoryStore();store.state=ready([row("a")]);const before=store.state;
  const result=await runMonitor({store,seed:async()=>null,read:async()=>{store.owner="replacement";return values([row("a")]);},now:()=>t2});
  assert.equal(result.status,"superseded");assert.deepEqual(store.state,before);
  assert.equal(store.owner,"replacement");
  assert.equal(authorized(null,undefined),false);assert.equal(authorized("Bearer undefined",undefined),false);
  assert.equal(authorized("Bearer short","short"),false);
  const secret="x".repeat(32);assert.equal(authorized(`Bearer ${secret}`,secret),true);assert.equal(authorized(`Bearer ${secret}x`,secret),false);
});
test("Google reader uses readonly scope, fixed target and a complete metadata-bounded read",async()=>{
  const oldFetch=globalThis.fetch,oldCred=process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS;
  const {privateKey}=generateKeyPairSync("rsa",{modulusLength:2048});
  process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS=JSON.stringify({client_email:"test@example.invalid",private_key:privateKey.export({type:"pkcs8",format:"pem"})});
  const calls=[];
  globalThis.fetch=async(url,options)=>{
    calls.push(String(url));
    if(calls.length===1){
      const claims=JSON.parse(Buffer.from(options.body.get("assertion").split(".")[1],"base64url"));
      assert.equal(claims.scope,"https://www.googleapis.com/auth/spreadsheets.readonly");
      return Response.json({access_token:"test-token"});
    }
    assert.equal(options.headers.Authorization,"Bearer test-token");
    if(calls.length===2)return Response.json({properties:{timeZone:"Asia/Taipei"},sheets:[{properties:{sheetId:1097364331,title:"工作表1",gridProperties:{rowCount:2000,columnCount:38}}}]});
    assert.match(decodeURIComponent(String(url)),/工作表1'!A1:N2000/);
    return Response.json({majorDimension:"ROWS",values:values([row("a")])});
  };
  try {assert.equal((await readOperationalSheet()).length,2);assert.equal(calls.length,3);}
  finally{globalThis.fetch=oldFetch;if(oldCred===undefined)delete process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS;else process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS=oldCred;}
});
test("Redis REST transport compresses private state, restores it and rejects provider failures",async()=>{
  const oldFetch=globalThis.fetch;
  let stored=null,lock=null,fail=false;
  globalThis.fetch=async(url,options)=>{
    assert.equal(url,"https://test.invalid");assert.equal(options.headers.Authorization,"Bearer test-token");
    if(fail)return Response.json({error:"private provider detail"},{status:500});
    const c=JSON.parse(options.body);
    if(c[0]==="SET"){assert.deepEqual(c.slice(3),["NX","EX",120]);if(lock)return Response.json({result:null});lock=c[2];return Response.json({result:"OK"});}
    if(c[0]==="GET")return Response.json({result:stored});
    if(c[1]===COMMIT_SCRIPT){if(lock!==c[5])return Response.json({result:0});stored=c[6];assert.match(stored,/^gz1:/);return Response.json({result:1});}
    assert.equal(c[4],lock);lock=null;return Response.json({result:1});
  };
  try{
    const store=new RedisMonitorStore("https://test.invalid","test-token");
    const owner=await store.acquire();assert.ok(owner);assert.equal(await store.acquire(),null);
    const state=ready([row("source-key")]);assert.equal(await store.commit(owner,state),true);
    assert.deepEqual(await new RedisMonitorStore("https://test.invalid","test-token").read(),state);
    await store.release(owner);fail=true;await assert.rejects(()=>store.read(),/MONITOR_STORAGE_UNAVAILABLE/);
  }finally{globalThis.fetch=oldFetch;}
});
