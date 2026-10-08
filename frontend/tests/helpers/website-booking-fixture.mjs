import { randomUUID } from 'node:crypto';
import { accountKey, digest } from '../../src/lib/customer-workspaces/auth.ts';
import { newPasswordlessCredential } from '../../src/lib/customer-workspaces/identity.ts';
import { addDays } from '../../src/lib/website-booking/config.ts';
import { businessDate } from '../../src/lib/customer-workspaces/domain.ts';
import { approveConnection, prepareConnection, connectionStatus } from '../../src/lib/website-booking/connections.ts';
import { guestAction } from '../../src/lib/website-booking/booking.ts';

export function memoryStore() {
 const values=new Map();return {values,
 async read(key){const raw=values.get(key)??null;return {raw,value:raw?JSON.parse(raw):null};},
 async commit(changes){if(new Set(changes.map(c=>c.key)).size!==changes.length)throw Error('duplicate transaction key');if(changes.some(c=>(values.get(c.key)??null)!==c.before))throw Error('VERSION_CONFLICT');for(const c of changes)values.set(c.key,JSON.stringify(c.after));},
 async limit(){},
 };
}
export const editorToken='synthetic-website-editor-token-for-local-tests-only';
export const client={id:'synthetic-editor',token_sha256:digest(editorToken),site_ids:['synthetic:website'],editor_origin:'https://editor.example.invalid'};
export function testEnvironment(){
 process.env.CUSTOMER_WORKSPACES_ENABLED='true';process.env.CUSTOMER_SESSION_SECRET='synthetic-local-session-secret-not-for-production';
 process.env.CUSTOMER_HOLDS_ENABLED='true';process.env.WEBSITE_BOOKING_ENABLED='true';process.env.WEBSITE_BOOKING_CLIENTS=JSON.stringify([client]);
}
export async function websiteFixture({store=memoryStore(),units=1,mode='mixed',approve=true,now=new Date()}={}) {
 testEnvironment();const day=businessDate(now.toISOString());
 const config={schema:1,kind:'new',sellingMode:mode,currency:'TWD',timezone:'Asia/Taipei',holdHours:24,
  opensOn:day,closesOn:addDays(day,60),transferInstructions:'Synthetic instructions for isolated tests.',cancellationPolicy:'Synthetic cancellation policy.',availabilityConfirmed:true,
  wholeHouseNightly:'5000',rooms:[{roomTypeId:'double',enabled:true,units:String(units),capacity:'2',nightly:'2000'}]};
 const roomRecords=[{id:'double',name:'Synthetic double'}],configurationHash=digest(JSON.stringify({reservationConfig:config,roomIds:roomRecords.map(r=>r.id)}));
 const account={id:randomUUID(),email:'synthetic-owner@example.invalid',credential:newPasswordlessCredential(),emailVerifiedAt:now.toISOString(),workspaces:[]};
 await store.commit([{key:accountKey(account.email),before:null,after:account}]);
 const prepare={schemaVersion:1,action:'prepare',requestId:randomUUID(),siteId:'synthetic:website',siteName:'Synthetic property',ownerEmail:account.email,
  reservationConfig:config,roomRecords,configurationHash};
 const connection=await prepareConnection(store,client,prepare,now);
 const approval={action:'approve',connectionId:connection.connectionId,requestKey:randomUUID(),confirmed:true,mode:'new',slug:'synthetic-'+randomUUID().slice(0,8)};
 if(!approve)return {store,client,config,prepare,connection,approval,account,now};
 await approveConnection(store,account,approval,now);
 const status=await connectionStatus(store,client,{schemaVersion:1,action:'status',siteId:prepare.siteId,connectionId:connection.connectionId},now);
 const binding=(await store.read('website:binding:'+status.bindingId)).value;
 const envelope={schemaVersion:1,configurationHash,source:'Official Website'};
 const stay={checkIn:addDays(day,10),checkOut:addDays(day,12),roomTypeId:mode==='whole_house'?'whole-house':'double',quantity:1,adults:2,children:0};
 const call=(action,data={},at=now)=>guestAction(store,binding.id,status.bindingToken,action,{...envelope,...data},data.idempotencyKey,at);
 const quote=async(data={})=>{const selected={...stay,...data};const a=await call('availability',selected);return call('quotes',{...selected,availabilityToken:a.availabilityToken});};
 const reserve=async(q)=>{const input={quoteId:(q??await quote()).quoteId,guest:{name:'Synthetic guest',email:'synthetic-guest@example.invalid',phone:'+000000000',note:'Synthetic request'},acceptedPolicy:true,idempotencyKey:randomUUID()};return {input,result:await call('reservations',input)};};
 const workspace=async()=>(await store.read('workspace:'+binding.workspaceId)).value;
 return {store,client,config,prepare,connection,approval,account,now,status,binding,envelope,stay,call,quote,reserve,workspace};
}
