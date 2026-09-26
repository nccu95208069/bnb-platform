import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {gzipSync} from 'node:zlib';
import {NextRequest} from 'next/server';
import {GET,POST} from '../../src/app/api/bots/[operation]/route.ts';
import {createOwnerSession,OWNER_COOKIE} from '../../src/lib/calendar-owner-session.ts';
import {withWorkspace} from '../../src/lib/bots/persistence.ts';
import {readLiveSource} from '../../src/lib/bots/source.ts';
import {SWEETFUN_SOURCE} from '../../src/lib/booking-sources/config.ts';
const values=new Map();const commands=[];let stale=false,conflict=false;
function configure(t){
 values.clear();commands.length=0;stale=false;conflict=false;
 process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('a'.repeat(32)).digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);process.env.KV_REST_API_URL='https://synthetic.invalid';process.env.KV_REST_API_TOKEN='synthetic';
 t.mock.method(globalThis,'fetch',async(url,opts)=>{
  assert.equal(url,'https://synthetic.invalid');const cmd=JSON.parse(opts.body);commands.push(cmd);let result=null;const [op,key,val]=cmd;
  if(op==='GET'){
   if(key.endsWith(':credential'))result=JSON.stringify({schema:1,kind:'bootstrap',hash:process.env.CALENDAR_OWNER_CODE_HASH});
   else if(key.startsWith('sweetfun:sheet-monitor:'))result='gz1:'+gzipSync(JSON.stringify({schema:1,checkedAt:stale?'2020-01-01T00:00:00Z':new Date().toISOString(),pending:null,error:null,audit:[],archived:[],snapshot:{source:{id:SWEETFUN_SOURCE.sourceId,read_only:true,anonymized:true,snapshot_version:'synthetic'},bookings:[]}})).toString('base64');
   else result=values.get(key)??null;
  }else if(op==='SET'){if(!values.has(key)){values.set(key,val);result='OK'}}
  else if(op==='EVAL'){
   if(key.includes("INCR"))result=1;
   else if(cmd[2]===1){if(values.get(cmd[3])===cmd[4])values.delete(cmd[3]);result=1;}
   else{const [, , ,lock,state,token,raw,next]=cmd;if(!conflict&&values.get(lock)===token&&(values.get(state)||'')===raw){values.set(state,next);result=1}else result=0;}
  }
  return Response.json({result});
 });
}
const request=(operation,body,cookie,origin='https://bots.test')=>new NextRequest('https://bots.test/api/bots/'+operation,{method:body?'POST':'GET',headers:{host:'bots.test',origin,'content-type':'application/json','x-csrf-token':'same-origin',...(cookie?{cookie:`${OWNER_COOKIE}=${cookie}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
const params=operation=>({params:Promise.resolve({operation})});
test('API denies unsigned, forged, expired and cross-origin requests before bot storage',async t=>{configure(t);assert.equal((await GET(request('state'),params('state'))).status,401);assert.equal((await GET(request('state',null,'forged'),params('state'))).status,401);assert.equal((await GET(request('state',null,createOwnerSession(Date.now()-31*86400000)),params('state'))).status,401);assert.equal((await POST(request('tool',{tool:'calculate'},createOwnerSession(),'https://evil.test'),params('tool'))).status,403);assert.ok(!commands.some(c=>c.includes('sweetfun-os:bots:v1:state')));});
test('authenticated sandbox write survives another request; duplicate does not repeat; source writes never happen',async t=>{configure(t);const cookie=createOwnerSession();const body={botId:'reservations',property:'sweetfun',dataset:'sandbox',tool:'orders.create',key:'same',args:{room:'302',start:'2027-01-01',end:'2027-01-02',guest:'synthetic',total:1000,channel:'direct'}};const first=await POST(request('tool',body,cookie),params('tool'));assert.equal(first.status,200);const one=await first.json();const two=await (await POST(request('tool',body,cookie),params('tool'))).json();assert.deepEqual(one,two);const get=await POST(request('tool',{...body,tool:'orders.list',key:'read',args:{id:one.record.id}},cookie),params('tool'));assert.equal((await get.json()).rows.length,1);const blocked=await POST(request('tool',{...body,dataset:'live'},cookie),params('tool'));assert.equal(blocked.status,403);assert.ok(!commands.some(c=>c[0]!=='GET'&&c.some(v=>String(v).startsWith('sweetfun:sheet-monitor:'))));});
test('live source fails closed when stale and never falls back to seed',async t=>{configure(t);assert.ok(await readLiveSource());stale=true;await assert.rejects(readLiveSource(),/SOURCE_UNAVAILABLE/);});
test('Redis lock blocks concurrency; failed CAS never reports success',async t=>{configure(t);let release,started;const signal=new Promise(r=>started=r);const hold=new Promise(r=>release=r);const first=withWorkspace(async()=>{started();await hold;return 'ok'},true);await signal;await assert.rejects(withWorkspace(async()=>0,true),/BUSY/);release();assert.equal(await first,'ok');conflict=true;await assert.rejects(withWorkspace(async s=>{s.put('tasks',{id:'uncommitted'});return 'fake success'},true),/WRITE_CONFLICT/);assert.equal(await withWorkspace(async s=>s.get('tasks','uncommitted'),false),null);});
test('bootstrap returns no cookie or provider secret and state is private',async t=>{configure(t);const cookie=createOwnerSession();const response=await GET(request('bootstrap',null,cookie),params('bootstrap'));assert.equal(response.status,200);assert.equal(response.headers.get('set-cookie'),null);assert.match(response.headers.get('cache-control'),/no-store/);const state=await (await GET(request('state',null,cookie),params('state'))).json();assert.equal(state.bots.length,5);assert.equal(state.history.available,true);assert.equal(state.history.mode,'live');assert.equal(state.provider.key,undefined);});

test('all authenticated member roles are denied the owner-only workspace',async t=>{
 configure(t);const {createMemberSession,MEMBER_COOKIE}=await import('../../src/lib/workspace-auth/session.ts');
 for(const role of ['god','admin','housekeeper','viewer','viewer_no_price']){
  const member={id:'a'.repeat(32),status:'active',role,displayName:'synthetic',email:'synthetic@example.test',allProperties:true,propertyIds:['sweetfun'],mustResetPassword:false,credential:{kind:'password',revision:'c'.repeat(64)}};
  values.set('sweetfun-os:workspace-auth:v1:members',JSON.stringify({version:1,members:[member]}));
  const req=new NextRequest('https://bots.test/api/bots/state',{headers:{host:'bots.test',cookie:`${MEMBER_COOKIE}=${createMemberSession(member)}`}});
  assert.equal((await GET(req,params('state'))).status,403);
 }
});
