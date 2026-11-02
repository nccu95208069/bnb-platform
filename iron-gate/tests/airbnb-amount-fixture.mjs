import {randomUUID} from 'node:crypto';
import {allocateWholeTwd} from '../scripts/reconcile-airbnb-group-amount.mjs';
export function amountFixture() {
  const propertyId='95ae9bd1-5e6d-4386-be5b-6af3c5668a16',workspaceId=randomUUID();
  const sourceSystem='sweetfun-calendar-sheet',sourceAccount='1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc';
  const weights=[437000,371400,387800,387800,216000],roomNames=['101','201','202','301','302'];
  const gross=allocateWholeTwd(2300000,weights),net=allocateWholeTwd(1943500,weights),groupId=randomUUID();
  const targets=weights.map((totalCents,i)=>{
    const id=randomUUID(),roomId=randomUUID(),ref=`J:20270101000${100+i}`;
    const booking={id,propertyId,workspaceId,version:2,status:'confirmed',source:'external',sourceKey:null,
      guestName:'Synthetic Guest',contact:null,notes:null,bookedAt:'2026/10/01',createdAt:'2026-10-01T00:00:00Z',
      totalCents,currency:'TWD',paymentEvents:[],channelSyncState:'not_required',channelOperationKey:null,
      sourceCalendar:{platform:'airbnb',externalOrderNo:'HMTEST1234'},
      sourceIdentityEnrichment:{schema:1,bookingVersion:2,sourceOrderRef:ref},
      stays:[{checkIn:'2027-01-01',checkOut:'2027-01-02',roomIds:[roomId]}],
      sweetfunSnapshot:{groupKey:ref,rows:[{room:roomNames[i],platform:'Airbnb',checkIn:'2027-01-01',
        checkOut:'2027-01-02',roomFeeCents:totalCents,values:[roomNames[i],'Synthetic Guest','Airbnb',
          '2027/1/1','2027/1/2','2026/10/1',String(totalCents/100),'not_yet','OK',ref.slice(2),'','','','']}]}};
    return {booking,link:{key:JSON.stringify([sourceSystem,sourceAccount,ref]),sourceSystem,sourceAccount,
      externalOrderId:ref,bookingId:id,sourceVersion:`sheet-v1:${'a'.repeat(64)}`,lastAppliedBookingVersion:2,
      diverged:false,tombstoneNights:[]},amount:{schema:1,groupId,bookingVersion:3,sourceOrderRef:ref,
      externalOrderNo:'HMTEST1234',roomId,checkIn:'2027-01-01',checkOut:'2027-01-02',
      originalTotalCents:totalCents,grossCents:gross[i],hostFeeCents:gross[i]-net[i],netCents:net[i],
      groupOriginalCents:1800000,groupGrossCents:2300000,groupHostFeeCents:356500,groupNetCents:1943500,
      groupTaxCents:115000,groupGuestFeeCents:0,groupGuestPaidCents:2415000,groupSize:5}};
  });
  const manifest={schema:1,propertyId,requestKey:groupId,expectedInventoryVersion:10,targets,evidence:{
    orderId:'HMTEST1234',cancelledOrderId:'HMOLDX1234',confirmationMessageId:'a'.repeat(16),
    cancellationMessageId:'b'.repeat(16),mailEvidenceSha256:'c'.repeat(64),verifiedAt:'2026-10-27T16:00:00Z',
    reservationUrl:'https://www.airbnb.com.tw/hosting/stay/HMTEST1234',platformPayoutCents:1943500,
    internalTotalCents:1800000,grossCents:2300000,hostFeeCents:356500,taxCents:115000,guestFeeCents:0,
    guestPaidCents:2415000,platformEvidenceSha256:'d'.repeat(64),planEvidenceSha256:'e'.repeat(64)}};
  const state={propertyId,workspaceId,authorityEpoch:1,readOnly:false,version:10,
    bookings:targets.map(t=>t.booking),sourceLinks:targets.map(t=>t.link),
    channel:{mode:'none',ready:false,websiteSalesEnabled:false,grantId:null,websiteBindingId:null},
    sourceGrants:[],operations:[],fences:[],manualBlocks:[],receipts:[],roomIds:targets.map(t=>t.amount.roomId)};
  const corrected=structuredClone(state);corrected.version++;
  corrected.bookings.forEach((b,i)=>{b.version++;b.totalCents=targets[i].amount.netCents;
    b.sourceAmountReconciliation=targets[i].amount;b.sourceIdentityEnrichment.bookingVersion++;});
  corrected.sourceLinks.forEach(l=>l.lastAppliedBookingVersion++);
  return {manifest,state,corrected,roomNames};
}
