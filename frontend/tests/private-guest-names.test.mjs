import test from "node:test";
import assert from "node:assert/strict";
import { attachPrivateGuestNames } from "../src/lib/booking-sources/private-guest-names.ts";
import { adaptSheetBookings } from "../src/lib/booking-sources/sweetfun-sheet.ts";
import { SWEETFUN_SOURCE, OFFLAND_SOURCE } from "../src/lib/booking-sources/config.ts";
import { normalizeRows, HEADERS } from "../src/lib/sheet-monitor/reconcile.ts";
const row = (patch = {}) => Object.assign(["301", "測試旅客甲", "Agoda", "2026/9/15", "2026/9/16", "2026/8/1", "2500", "done", "OK", "test-row", "private note", "test-order", "2"], patch);
const snapshot = (values, source = SWEETFUN_SOURCE) => { const normalized = normalizeRows(values, source); return adaptSheetBookings([HEADERS, ...normalized.map(r => r.cells)], source.sourceId, "2026-09-06T00:00:00Z", [], normalized.map(r => r.sourceRow), source.property).bookings; };
test("real source name overlays matching booking without changing public snapshot", () => { const values = [HEADERS, row()]; const publicRows = snapshot(values); const named = attachPrivateGuestNames(publicRows, values, SWEETFUN_SOURCE); assert.equal(named[0].guest_name, "測試旅客甲"); assert.equal(named[0].guest_name_kind, "real"); assert.equal(publicRows[0].guest_name_kind, "anonymous"); assert.equal(JSON.stringify(publicRows).includes("測試旅客甲"), false); assert.equal(named[0].source_notes[0].text, "private note"); assert.equal(JSON.stringify(publicRows).includes("private note"), false); });
test("missing, moved, deleted or duplicated identities never attach an unrelated name", () => { const base = snapshot([HEADERS, row()]); for (const rows of [[], [row({0:"302"})], [row({3:"2026/9/16",4:"2026/9/17"})], [row({11:"different-order"})], [row(),row({1:"測試旅客乙"})], [row({1:""})]]) { const result = attachPrivateGuestNames(base, [HEADERS,...rows], SWEETFUN_SOURCE); assert.notEqual(result[0].guest_name_kind, "real"); } });
test("OFFLAND name/header aliases remain isolated from Sweetfun", () => { const headers = [...HEADERS]; headers[0]="房間"; headers[1]="用戶名稱"; headers[11]="刷卡狀態"; const values = [headers, row({0:"OFFLAND",1:"測試旅客乙"})]; const base = snapshot(values, OFFLAND_SOURCE); assert.equal(attachPrivateGuestNames(base, values, OFFLAND_SOURCE)[0].guest_name, "測試旅客乙"); const sweetfun = snapshot([HEADERS,row()]); assert.equal(attachPrivateGuestNames(sweetfun, values, OFFLAND_SOURCE)[0].guest_name_kind, "anonymous"); });
test('remarks accompany authorized name without truncating its source', () => { const name='測試旅客 加床 +1人 國旅 國旅補 收據 嬰兒床 '+ '完整原文'.repeat(70);const values=[HEADERS,row({1:name})];const source=snapshot(values);const result=attachPrivateGuestNames(source,values,SWEETFUN_SOURCE)[0];assert.equal(result.guest_name,name);assert.equal(result.guest_remarks.length,6);assert.equal(source[0].guest_remarks,undefined); });

test('private OTA and OwlNest IDs stay distinct, mismatched rows do not disclose IDs',()=>{const values=[[...HEADERS,'OTA訂單編號'],[...row(),'OTA-TEST-123']];const base=snapshot(values);const result=attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0];assert.equal(result.external_order_no,'OTA-TEST-123');assert.equal(result.owlnest_order_no,'test-order');assert.equal(base[0].external_order_no,null);values[1][11]='changed-parent';assert.equal(attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0].external_order_no,null);});
test('authorized main Sheet notes retain their source and do not duplicate the extracted tag',()=>{const values=[HEADERS,row({1:'Test 國旅補',10:'國旅補助800; confidential unrelated text'})];const base=snapshot(values);const named=attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0];assert.equal(named.guest_remarks.filter(r=>r.kind==='travel_subsidy').length,1);assert.equal(named.source_notes[0].text,'國旅補助800; confidential unrelated text');assert.equal(JSON.stringify(base).includes('confidential unrelated text'),false);values[1][1]='Test';assert.equal(attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0].guest_remarks[0].kind,'travel_subsidy');values[1][0]='302';assert.equal(attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0].guest_remarks.length,0);});

test('full multiline note survives only an exact current row match, including unnamed guests',()=>{
 const note='晚到請保留房間\n不用加床\n<script>synthetic text</script>\n'+'完整備註'.repeat(300);
 const values=[HEADERS,row({1:'',10:note})];const base=snapshot(values);
 const named=attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0];
 assert.equal(named.source_notes[0].text,note);assert.equal(named.source_notes_unconfirmed,false);
 assert.equal(named.guest_name_kind,'missing');assert.equal(named.guest_remarks.length,0);
 for(const patch of [{0:'302'},{3:'2026/9/16',4:'2026/9/17'},{6:'3000'},{11:'different-order'}]){
  const result=attachPrivateGuestNames(base,[HEADERS,row({...patch,10:note})],SWEETFUN_SOURCE)[0];
  assert.deepEqual(result.source_notes,[]);assert.equal(result.source_notes_unconfirmed,true);
 }
 const duplicate=attachPrivateGuestNames(base,[HEADERS,row({10:note}),row({10:'unrelated note'})],SWEETFUN_SOURCE)[0];
 assert.deepEqual(duplicate.source_notes,[]);assert.equal(duplicate.source_notes_unconfirmed,true);
 assert.equal(JSON.stringify(base).includes(note),false);
});
test('blank verified notes and missing source records remain distinguishable',()=>{
 const values=[HEADERS,row({10:''})];const base=snapshot(values);
 const empty=attachPrivateGuestNames(base,values,SWEETFUN_SOURCE)[0];
 assert.deepEqual(empty.source_notes,[]);assert.equal(empty.source_notes_unconfirmed,false);
 const missing=attachPrivateGuestNames(base,[HEADERS],SWEETFUN_SOURCE)[0];
 assert.deepEqual(missing.source_notes,[]);assert.equal(missing.source_notes_unconfirmed,true);
});
test('source notes are removed for hidden-price accounts and excluded across property scopes',async()=>{
 const {projectBookings}=await import('../src/lib/workspace-auth/projection.ts');
 const values=[HEADERS,row({10:'已收款 12345'}),row({0:'302',9:'second-room'})];
 const rows=attachPrivateGuestNames(snapshot(values),values,SWEETFUN_SOURCE);
 const viewer={viewPrices:false,allProperties:false,propertyIds:['sweetfun']};
 assert.equal(JSON.stringify(projectBookings(rows,viewer)).includes('12345'),false);
 assert.equal(projectBookings(rows,viewer)[0].source_notes,undefined);
 assert.deepEqual(projectBookings(rows,{...viewer,viewPrices:true,propertyIds:['offland']}),[]);
 assert.equal(projectBookings(rows,{...viewer,viewPrices:true})[0].source_notes[0].text,'已收款 12345');
});
