import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { GET } from '../src/app/api/cron/sheet-monitor/route.ts';
import { SWEETFUN_SOURCE as source } from '../src/lib/booking-sources/config.ts';
import { configuredPrivateCalendarCache } from '../src/lib/booking-sources/private-calendar-snapshot.ts';
import { HEADERS, initialState, reconcile } from '../src/lib/sheet-monitor/reconcile.ts';
import { adaptSheetBookings } from '../src/lib/booking-sources/sweetfun-sheet.ts';
import { localRedis } from './helpers/redis-command.mjs';
test('authorized scheduled check reuses one Sheet read to save private backup without adding names to anonymous monitor state', async t => {
 const old={...process.env};t.after(()=>{for(const k of Object.keys(process.env))if(!(k in old))delete process.env[k];Object.assign(process.env,old);});
 Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',SHEET_MONITOR_ENABLED:'true',BOOKING_SHEET_SOURCES:'sweetfun',CRON_SECRET:'c'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'s'.repeat(64),KV_REST_API_URL:'https://synthetic.invalid',KV_REST_API_TOKEN:'synthetic'});
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;delete process.env.CALENDAR_BACKUP_BLOB_STORE_ID;
 process.env[source.credentialEnv]=JSON.stringify({client_email:'synthetic@example.test',private_key:generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString()});
 const today=new Date().toISOString().slice(0,10), tomorrow=new Date(Date.now()+86400000).toISOString().slice(0,10);
 const values=[HEADERS,['301','SYNTHETIC_PRIVATE','Agoda',today,tomorrow,today,'2500','done','OK','one','SYNTHETIC_NOTE','parent']];
 const base=adaptSheetBookings(values,source.sourceId,new Date().toISOString(),[],undefined,source.property);
 const state=reconcile(reconcile(initialState(base),values,new Date(Date.now()-60000).toISOString()),values,new Date(Date.now()-30000).toISOString());
 const stateKey=`${source.property.id}:sheet-monitor:v1:${source.sourceId}:state`, cacheKey=`sweetfun-os:private-calendar:v1:${source.property.id}:${source.sourceId}`;
 t.after(()=>localRedis(['DEL',stateKey,stateKey.replace(':state',':lock'),cacheKey,'sweetfun-os:calendar-health:v1:state','sweetfun-os:calendar-health:v1:history']));
 await localRedis(['SET',stateKey,`gz1:${gzipSync(JSON.stringify(state)).toString('base64')}`]);
 let googleReads=0,commands=0;const logs=[];
 t.mock.method(console,'info',s=>logs.push(s));
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url==='https://oauth2.googleapis.com/token')return Response.json({access_token:'synthetic'});
  if(String(url).startsWith('https://sheets.googleapis.com/')){
   if(String(url).includes('/values/')){googleReads++;return Response.json({majorDimension:'ROWS',values});}
   return Response.json({properties:{timeZone:'Asia/Taipei'},sheets:[{properties:{sheetId:source.sheetId,title:source.sheetTitle,gridProperties:{rowCount:2,columnCount:20}}}]});
  }
  assert.equal(url,'https://synthetic.invalid');commands++;return Response.json({result:await localRedis(JSON.parse(options.body))});
 });
 const url='https://synthetic.invalid/api/cron/sheet-monitor?source=sweetfun';
 assert.equal((await GET(new Request(url))).status,401);assert.equal(commands,0);
 const result=await GET(new Request(url,{headers:{authorization:`Bearer ${process.env.CRON_SECRET}`}}));assert.equal(result.status,200);assert.equal((await result.json()).status,'ok');assert.equal(googleReads,1);
 assert.equal((await configuredPrivateCalendarCache().read(source)).bookings[0].guest_name,'SYNTHETIC_PRIVATE');
 const anonymous=gunzipSync(Buffer.from((await localRedis(['GET',stateKey])).slice(4),'base64')).toString();assert.equal(anonymous.includes('SYNTHETIC_PRIVATE'),false);assert.equal(logs.join('').includes('SYNTHETIC_PRIVATE'),false);
});
