import test from 'node:test';
import assert from 'node:assert/strict';
import {validateHistory,historySql} from '../scripts/prepare-confirmed-history.mjs';
const id='11111111-1111-4111-8111-111111111111';
const bid='22222222-2222-4222-8222-222222222222';
const room='33333333-3333-4333-8333-333333333333';
function fixture(){return {schema:1,repairKey:id,ownerConfirmedActualStay:true,ownerEvidenceRef:'synthetic-owner-decision',asOfDate:'2026-11-02',properties:[{
 propertyId:id,workspaceId:id,version:2,epoch:1,stateHash:'a'.repeat(64),sourceSystem:'sweetfun-calendar-sheet',sourceAccount:'synthetic',orders:[{
 kind:'create',bookingId:bid,orderId:'OBETEST123',totalCents:100000,bookedAt:'2025-10-01',evidenceSha256:'b'.repeat(64),messageId:'123456789abcdef0',internalDate:1760000000000,messageSha256:'c'.repeat(64),guestName:'Synthetic guest',stays:[{checkIn:'2025-10-10',checkOut:'2025-10-11',roomIds:[room]}],platform:'booking',externalOrderNo:'12345'}]}]};}
test('owner confirmation is mandatory, future stays are rejected',()=>{
 for(const edit of [m=>m.ownerConfirmedActualStay=false,m=>m.properties[0].orders[0].stays[0].checkOut='2026-11-03',m=>m.properties[0].orders[0].stays[0].checkIn='2025-02-30']){const m=fixture();edit(m);assert.throws(()=>validateHistory(m));}
});
test('payment and arbitrary booking changes are not accepted',()=>{
 for(const key of ['paymentEvents','channelSyncState','notes','status']){const m=fixture();m.properties[0].orders[0][key]=[];assert.throws(()=>validateHistory(m));}
});
test('duplicate identity and same room-night targets are rejected',()=>{
 const m=fixture();m.properties[0].orders.push(structuredClone(m.properties[0].orders[0]));assert.throws(()=>validateHistory(m));
 m.properties[0].orders[1].bookingId='44444444-4444-4444-8444-444444444444';assert.throws(()=>validateHistory(m));
});
test('paid, diverged, or non-extension legacy amendments are rejected',()=>{
 const m=fixture(),o=m.properties[0].orders[0];o.kind='extend';o.totalCents=200000;o.stays[0].checkOut='2025-10-12';
 o.beforeBooking={id:bid,propertyId:id,workspaceId:id,status:'confirmed',source:'external',sourceKey:null,channelSyncState:'not_required',channelOperationKey:null,guestName:o.guestName,version:1,totalCents:100000,stays:[{checkIn:'2025-10-11',checkOut:'2025-10-12',roomIds:[room]}],paymentEvents:[]};
 o.beforeLinks=[{bookingId:bid,diverged:false,lastAppliedBookingVersion:1,tombstoneNights:[]}];
 assert.equal(validateHistory(structuredClone(m)).properties[0].orders[0].addCells.length,1);
 for(const edit of [x=>x.beforeBooking.paymentEvents.push({amountCents:1}),x=>x.beforeLinks[0].diverged=true,x=>x.stays[0].checkOut='2025-10-11']){const n=structuredClone(m);edit(n.properties[0].orders[0]);assert.throws(()=>validateHistory(n));}
});
test('SQL defaults to rollback and rejects existing repair receipts',()=>{
 const q=historySql(fixture());assert.ok(q.endsWith('ROLLBACK;'));assert.match(q,/HISTORY_REPAIR_ALREADY_RECORDED/);assert.match(q,/HISTORY_REPAIR_STATE_CHANGED/);assert.ok(historySql(fixture(),false).endsWith('COMMIT;'));
});
