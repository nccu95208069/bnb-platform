import test from "node:test";
import assert from "node:assert/strict";
import {createHash,randomUUID} from "node:crypto";
import {prepareVerifiedDates,verifiedDatesSql} from "../scripts/prepare-verified-booking-dates.mjs";
function fixture(){
 const propertyId=randomUUID(),bookingId=randomUUID(),workspace=randomUUID(),messageId="1234567890abcdef",internalDate=Date.parse("2026-10-21T16:01:00Z");
 const version=`gmail-v1:${internalDate}:${createHash("sha256").update(messageId).digest("hex")}`;
 const link={sourceSystem:"offland-calendar-sheet",sourceAccount:"synthetic",externalOrderId:"Q:OBESYNTHETIC",bookingId,sourceVersion:version,diverged:false,tombstoneNights:[],lastAppliedBookingVersion:1};
 link.key=JSON.stringify([link.sourceSystem,link.sourceAccount,link.externalOrderId]);
 const receipt={key:randomUUID(),propertyId,action:"source:write",subjectId:"gmail-order-handler",grantId:randomUUID(),response:{state:"applied",bookingId,bookingVersion:1}};
 const snapshot=[{property_id:propertyId,workspace_id:workspace,inventory_version:3,authority_epoch:1,state_hash:"a".repeat(64),targets:[{booking:{id:bookingId,source:"external",sourceKey:link.key,version:1,status:"confirmed",bookedAt:null,createdAt:"2026-10-22T01:00:00Z",stays:[{checkIn:"2026-11-12"}]},bookingHash:"b".repeat(64),link,linkHash:"c".repeat(64),receipts:[receipt]}]}];
 const manifest={schema:1,repairKey:randomUUID(),entries:[{kind:"first-new-notice",propertyId,bookingId,noticeKind:"new",sender:"owlnest@owlting.com",messageId,messageSha256:"d".repeat(64),internalDate,externalOrderId:"OBESYNTHETIC"}]};
 return {snapshot,manifest};
}
test("original first-notice evidence yields a metadata-only guarded transaction",()=>{
 const {snapshot,manifest}=fixture(),before=structuredClone(snapshot),plan=prepareVerifiedDates(snapshot,manifest);
 assert.deepEqual(snapshot,before);assert.equal(plan.entries[0].notification.receivedAt,"2026-10-21T16:01:00.000Z");
 const sql=verifiedDatesSql(plan);assert.match(sql,/FOR UPDATE/);assert.match(sql,/DATE_REPAIR_RECEIPT_CHANGED/);assert.match(sql,/DATE_REPAIR_REPLAY_CHANGED/);assert.match(sql,/ROLLBACK;/);
 assert.ok(!sql.includes("UPDATE iron_gate.occupied_room_nights"));assert.match(verifiedDatesSql(plan,false),/COMMIT;/);
});
test("amendment, spoofed sender, wrong mail, wrong scope and missing creation receipt fail closed",()=>{
 for(const change of [
  (s,m)=>{m.entries[0].noticeKind="modify";},(s,m)=>{m.entries[0].sender="attacker@example.com";},
  (s,m)=>{m.entries[0].messageId="ffffffffffffffff";},(s,m)=>{m.entries[0].propertyId=randomUUID();},
  (s,m)=>{m.entries[0].externalOrderId="OTHER";},(s,m)=>{m.entries[0].internalDate++;},
  (s,m)=>{s[0].targets[0].receipts=[];},(s,m)=>{s[0].targets[0].receipts[0].response.bookingVersion=2;},
  (s,m)=>{s[0].targets[0].link.diverged=true;},(s,m)=>{s[0].targets[0].booking.offlandSnapshot={};},
  (s,m)=>{s[0].targets[0].booking.createdAt="2026-10-20T00:00:00Z";},
 ]){const {snapshot,manifest}=fixture();change(snapshot,manifest);assert.throws(()=>prepareVerifiedDates(snapshot,manifest),/VERIFIED_DATE_REPAIR_INVALID/);}
});
test("owner date requires native OS booking, explicit attestation, valid day and empty prior date",()=>{
 const {snapshot,manifest}=fixture(),t=snapshot[0].targets[0];t.booking.source="os";t.booking.sourceKey=null;t.link=null;t.receipts=[];
 manifest.entries=[{kind:"owner-booking-date",propertyId:snapshot[0].property_id,bookingId:t.booking.id,bookedAt:"2026-10-22",evidenceType:"owner_attestation",evidenceRef:"synthetic-owner-confirmation"}];
 assert.equal(prepareVerifiedDates(snapshot,manifest).entries[0].notification,null);
 for(const date of ["2026-02-30","2026-13-01","2026-11-13","2026/10/22"]){const m=structuredClone(manifest);m.entries[0].bookedAt=date;assert.throws(()=>prepareVerifiedDates(snapshot,m));}
 t.booking.bookedAt="2026-10-20";assert.throws(()=>prepareVerifiedDates(snapshot,manifest));
});
