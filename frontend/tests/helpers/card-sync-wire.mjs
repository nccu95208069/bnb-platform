/** Synthetic cross-repository acceptance harness. Stdin/stdout only; rejects external I/O. */
import {createInterface} from 'node:readline';
import {gzipSync} from 'node:zlib';
import {MemoryPropertyRepository} from '../../../iron-gate/src/memory-repository.ts';
import {IronGateService} from '../../../iron-gate/src/service.ts';
import {createHandler} from '../../../iron-gate/src/http.ts';
import {POST} from '../../src/app/api/internal/card-sync/route.ts';
import {financeContext} from '../../src/lib/finance-context.ts';
import {SWEETFUN_SOURCE as source} from '../../src/lib/booking-sources/config.ts';
import {HEADERS,initialState} from '../../src/lib/sheet-monitor/reconcile.ts';
import {adaptSheetBookings} from '../../src/lib/booking-sources/sweetfun-sheet.ts';
import {createOsMemberProofVerifier} from '../../../iron-gate/src/os-member-proof.mjs';
const w='11111111-1111-4111-8111-111111111111',p='22222222-2222-4222-8222-222222222222',b='33333333-3333-4333-8333-333333333333';
const rooms=Object.fromEntries(['101','102','201','202','301','302'].map((room,i)=>[room,`55555555-5555-4555-8555-55555555555${i}`]));
const grant={credentialId:'66666666-6666-4666-8666-666666666666',clientId:'77777777-7777-4777-8777-777777777777',workspaceId:w,propertyId:p,token:'x'.repeat(43)};
const secret='synthetic-card-wire-secret-minimum-32-bytes',proof='synthetic-os-proof-secret-minimum-32-bytes';
Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',SHEET_MONITOR_ENABLED:'true',BOOKING_SHEET_SOURCES:'sweetfun',KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'synthetic',IRON_GATE_CARD_SYNC_ENABLED:'true',CC_SYNC_OS_TOKEN:secret,IRON_GATE_CARD_SYNC_GRANT:JSON.stringify({...grant,token:'c'.repeat(43)}),IRON_GATE_SWEETFUN_CALENDAR_ENABLED:'true',IRON_GATE_SWEETFUN_FINANCE_ENABLED:'true',IRON_GATE_SWEETFUN_BASE_URL:'https://iron-gate.invalid',IRON_GATE_SWEETFUN_AUTHORITY_EPOCH:'1',IRON_GATE_SWEETFUN_ROOM_IDS:JSON.stringify(rooms),IRON_GATE_SWEETFUN_OS_PROOF_SECRET:proof,IRON_GATE_SWEETFUN_CALENDAR_GRANT:JSON.stringify(grant),IRON_GATE_SWEETFUN_FINANCE_GRANT:JSON.stringify(grant)});
delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
const repository=new MemoryPropertyRepository();repository.seed({workspaceId:w,propertyId:p,roomIds:Object.values(rooms),version:1,authorityEpoch:1,readOnly:false,channel:{mode:'none',ready:false,websiteSalesEnabled:false,grantId:null,websiteBindingId:null},sourceGrants:[],sourceLinks:[],operations:[],fences:[],manualBlocks:[],receipts:[],bookings:[{id:b,propertyId:p,workspaceId:w,version:1,status:'confirmed',channelSyncState:'verified',channelOperationKey:null,source:'external',sourceKey:null,stays:[{checkIn:'2026-11-01',checkOut:'2026-11-03',roomIds:[rooms['101']]}],guestName:'Synthetic',contact:null,notes:null,totalCents:100000,currency:'TWD',bookedAt:null,createdAt:'2026-10-01T00:00:00Z',sourceCalendar:{platform:'Booking.com',externalOrderNo:'1234567890'}}]});
const service=new IronGateService(repository),verify=createOsMemberProofVerifier(proof);
const principal={clientId:grant.clientId,subjectId:'synthetic',workspaceId:w,propertyIds:[p],authorityEpoch:1,fields:['money']};
const handle=createHandler(service,async request=>{
 if(request.headers.get('authorization')==='Bearer '+'c'.repeat(43))return {...principal,origin:'finance',actions:['card:sync']};
 const member=await verify(request,{...grant,origin:'os'});
 return member?{...principal,origin:'os',subjectId:member.subjectId,actions:member.actions,fields:member.fields}:null;
});
const snapshot=adaptSheetBookings([HEADERS],source.sourceId,new Date().toISOString(),[],[],source.property);
const db=new Map([['sweetfun:sheet-monitor:v1:sweetfun-operations-sheet-v1:state','gz1:'+gzipSync(JSON.stringify(initialState(snapshot))).toString('base64')]]);
globalThis.fetch=async (url,options={})=>{
 if(String(url).startsWith('https://iron-gate.invalid/'))return handle(new Request(url,options));
 if(String(url)!=='https://redis.invalid')throw Error('external access forbidden');
 const c=JSON.parse(options.body);let result=null;
 if(c[0]==='GET')result=db.get(c[1])??null;
 else if(c[0]==='MGET')result=c.slice(1).map(key=>db.get(key)??null);
 else if(c[0]==='SCAN')result=['0',[...db.keys()].filter(key=>new RegExp('^'+c[3].replaceAll('*','.*')+'$').test(key))];
 else if(c[0]==='SET'){if(!c.includes('NX')||!db.has(c[1])){db.set(c[1],c[2]);result='OK';}}
 else if(c[0]==='EVAL'){
  const keys=c.slice(3,3+c[2]),args=c.slice(3+c[2]);
  if(c[1].includes('for i=2,#KEYS')){if(db.get(keys[0])!==args[0])result=-1;else if(keys.slice(1).some(key=>db.has(key)&&db.get(key)!==args[1]))result=-2;else{for(const key of keys.slice(1))db.set(key,args[1]);result=1;}}
  else if(c[1].includes('DEL')){if(db.get(keys[0])===args[0]){db.delete(keys[0]);result=1;}}
  else throw Error('unexpected mutation');
 }else throw Error('unexpected Redis command');
 return Response.json({result});
};
const owner={id:'synthetic',role:'owner',allProperties:true,propertyIds:['sweetfun'],viewPrices:true};
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
 try{const command=JSON.parse(line);let output;
  if(command.mode==='inspect'){
   const state=await repository.read(p),report=await financeContext(source,2026,false,owner);
   output={ok:true,events:state.bookings[0].paymentEvents??[],attempts:state.bookings[0].cardChargeResults??[],orders:report.orders,entries:report.entries};
  }else{
   const response=await POST(new Request('https://os.invalid/api/internal/card-sync',{method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},body:JSON.stringify(command)}));output=await response.json();
  }
  process.stdout.write(JSON.stringify(output)+'\n');
 }catch{process.stdout.write(JSON.stringify({ok:false,error:'HARNESS_FAILURE'})+'\n');}
}
