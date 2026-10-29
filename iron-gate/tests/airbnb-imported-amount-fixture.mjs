import {randomUUID} from 'node:crypto';
import {allocateWholeTwd} from '../scripts/reconcile-airbnb-group-amount.mjs';
import {correctedBooking} from '../scripts/reconcile-airbnb-imported-amounts.mjs';
export function importedAmountFixture({property='sweetfun',nights=2,rooms=2,cancelled=false}={}){
 const propertyId=property==='sweetfun'?'95ae9bd1-5e6d-4386-be5b-6af3c5668a16':'8595525a-ecfd-5949-953f-99f004928597';
 const workspaceId=randomUUID(),groupId=randomUUID(),sourceSystem=`${property}-calendar-sheet`;
 const sourceAccount=property==='sweetfun'?'1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc':'1jBJq1xWmM7xKpUxFjsLYQc7EbLAWmcMjQK0SBbaORuc';
 const roomNames=property==='sweetfun'?['101','102','201','202','301','302'].slice(0,rooms):['包棟'];
 const roomIds=Object.fromEntries(roomNames.map(n=>[n,randomUUID()]));
 const date=n=>`2026-01-${String(n).padStart(2,'0')}`;
 const original=50000,weights=Array.from({length:nights*roomNames.length},()=>original);
 const groupOriginalCents=weights.reduce((a,b)=>a+b,0),groupNetCents=cancelled?0:groupOriginalCents-200;
 const groupGrossCents=cancelled?0:groupNetCents+1500;
 const net=allocateWholeTwd(groupNetCents,weights),gross=allocateWholeTwd(groupGrossCents,weights);
 const targets=weights.map((_,i)=>{
  const id=randomUUID(),room=roomNames[i%roomNames.length],roomId=roomIds[room],start=1+Math.floor(i/roomNames.length),ref=`J:20260101000${100+i}`;
  const values=[room,'Synthetic Guest','Airbnb',date(start),date(start+1),'2025/12/01',String(original/100),'not_yet','OK',ref.slice(2),'','','','','','',''];
  const row={room,platform:'Airbnb',checkIn:date(start),checkOut:date(start+1),bookedAt:'2025-12-01',roomFeeCents:original,values};
  const booking={id,propertyId,workspaceId,version:1,status:'confirmed',source:'external',sourceKey:null,
   guestName:'Synthetic Guest',contact:null,notes:null,bookedAt:'2025/12/01',createdAt:'2026-10-01T00:00:00Z',
   totalCents:original,currency:'TWD',paymentEvents:[],channelSyncState:'not_required',channelOperationKey:null,
   stays:[{checkIn:date(start),checkOut:date(start+1),roomIds:[roomId]}],
   [`${property}Snapshot`]:{groupKey:ref,rows:[row],sourceHash:'b'.repeat(64),issues:[]},
   ...(property==='offland'?{roomNightPrices:[{roomId,date:date(start),amountCents:original}]}:{})};
  const amount={schema:2,sourceProperty:property,groupId,bookingVersion:2,sourceOrderRef:ref,externalOrderNo:'HMTEST1234',
   roomId,checkIn:date(start),checkOut:date(start+1),originalTotalCents:original,grossCents:gross[i],hostFeeCents:gross[i]-net[i],netCents:net[i],
   groupOriginalCents,groupGrossCents,groupHostFeeCents:groupGrossCents-groupNetCents,groupNetCents,
   groupTaxCents:0,groupGuestFeeCents:null,groupGuestPaidCents:null,groupSize:weights.length};
  return {booking,amount,link:{key:JSON.stringify([sourceSystem,sourceAccount,ref]),sourceSystem,sourceAccount,
   externalOrderId:ref,bookingId:id,sourceVersion:`sheet-v1:${'a'.repeat(64)}`,lastAppliedBookingVersion:1,diverged:false,tombstoneNights:[]}};
 });
 const evidence={orderId:'HMTEST1234',status:cancelled?'cancelled':'confirmed',checkIn:date(1),checkOut:date(nights+1),
  grossCents:groupGrossCents,hostFeeCents:groupGrossCents-groupNetCents,netCents:groupNetCents,taxCents:0,guestFeeCents:null,guestPaidCents:null,
  verifiedAt:'2026-10-28T05:00:00.000Z',platformEvidenceSha256:'d'.repeat(64),mailEvidenceSha256:'e'.repeat(64)};
 const manifest={schema:2,requestKey:randomUUID(),properties:[{sourceProperty:property,propertyId,expectedInventoryVersion:10,groups:[{groupId,evidence,targets}]}]};
 const state={propertyId,workspaceId,authorityEpoch:1,readOnly:false,version:10,bookings:targets.map(t=>t.booking),sourceLinks:targets.map(t=>t.link),
  channel:{mode:'none',ready:false,websiteSalesEnabled:false,grantId:null,websiteBindingId:null},sourceGrants:[],operations:[],fences:[],manualBlocks:[],receipts:[],roomIds:Object.values(roomIds)};
 const corrected=structuredClone(state);corrected.version++;corrected.bookings=targets.map(t=>correctedBooking(t,evidence.status));corrected.sourceLinks.forEach(l=>l.lastAppliedBookingVersion++);
 return {manifest,state,corrected,roomIds,targets};
}
