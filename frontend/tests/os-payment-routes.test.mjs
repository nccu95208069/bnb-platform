import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomUUID} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {NextRequest} from 'next/server';
import {GET,POST} from '../src/app/api/v1/order-payments/route.ts';
import {createOwnerSession,OWNER_COOKIE} from '../src/lib/calendar-owner-session.ts';
import {SWEETFUN_SOURCE as source} from '../src/lib/booking-sources/config.ts';
import {HEADERS,normalizeRows,initialState} from '../src/lib/sheet-monitor/reconcile.ts';
import {adaptSheetBookings} from '../src/lib/booking-sources/sweetfun-sheet.ts';
import {APPEND_PAYMENT,readLedger} from '../src/lib/os-payments.ts';
import {calendarIncome,financeKey} from '../src/lib/finance-store.ts';
const order='SF-'+createHash('sha256').update(`${source.sourceId}:order:synthetic-http`).digest('hex').slice(0,20);
const account={id:'account-1',property_id:'sweetfun',method:'bank_transfer',last_digits:'12345',name:'測試帳戶',created_at:'2026-10-01T00:00:00Z',actor_id:'owner'};
function setup(t){
 Object.assign(process.env,{CALENDAR_SOURCE:'sheet_snapshot',SHEET_MONITOR_ENABLED:'true',BOOKING_SHEET_SOURCES:'sweetfun',CALENDAR_OWNER_CODE_HASH:'a'.repeat(64),CALENDAR_OWNER_SESSION_SECRET:'b'.repeat(64),KV_REST_API_URL:'https://redis.invalid',KV_REST_API_TOKEN:'test'});
 delete process.env.UPSTASH_REDIS_REST_URL;delete process.env.UPSTASH_REDIS_REST_TOKEN;
 const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS=JSON.stringify({client_email:'synthetic@example.test',private_key:privateKey.export({type:'pkcs8',format:'pem'})});
 const values=[HEADERS,['101','','line','2026-10-09','2026-10-10','2026-10-01','2000','not_yet','OK','synthetic-uid-a','','synthetic-http',''],['102','','line','2026-10-09','2026-10-10','2026-10-01','2000','not_yet','OK','synthetic-uid-b','','synthetic-http','']];
 const grid=values.map(row=>row.map(v=>({formattedValue:v,userEnteredValue:{stringValue:v}})));
 const normalized=normalizeRows(values,source),snapshot=adaptSheetBookings([HEADERS,...normalized.map(r=>r.cells)],source.sourceId,new Date().toISOString(),[],normalized.map(r=>r.sourceRow),source.property);
 const db=new Map([['sweetfun-os:owner-auth:v1:credential',JSON.stringify({schema:1,kind:'bootstrap',hash:process.env.CALENDAR_OWNER_CODE_HASH})],['sweetfun:sheet-monitor:v1:sweetfun-operations-sheet-v1:state','gz1:'+gzipSync(JSON.stringify(initialState(snapshot))).toString('base64')],[financeKey('sweetfun',2026),JSON.stringify({version:1,entries:[],operations:[],payment_accounts:[account]})]]);
 const state={db,grid,writes:0,loseResponse:false,rejectWrites:false,skipApply:false,scopes:[]};
 t.mock.method(globalThis,'fetch',async(url,options={})=>{
  const u=String(url);
  if(u==='https://redis.invalid'){
   const c=JSON.parse(options.body);let result=null;
   if(c[0]==='GET')result=db.get(c[1])??null;
   else if(c[0]==='MGET')result=c.slice(1).map(k=>db.get(k)??null);
   else if(c[0]==='SET'){if(c.includes('NX')&&db.has(c[1]))result=null;else{db.set(c[1],c[2]);result='OK';}}
   else if(c[0]==='SCAN'){const pattern=new RegExp('^'+c[3].replaceAll('*','.*')+'$');result=['0',[...db.keys()].filter(k=>pattern.test(k))];}
   else if(c[0]==='EVAL'){
    const keys=c.slice(3,3+c[2]),args=c.slice(3+c[2]);
    if(c[1]===APPEND_PAYMENT){result=(db.get(keys[0])??'')===args[0]&&(!keys[2]||db.get(keys[2])===args[3])?1:0;if(result){db.set(keys[0],args[1]);db.set(keys[1],args[2]);}}
    else if(c[1].includes('INCR'))result=1;
    else if(c[1].includes('DEL')){result=db.get(keys[0])===args[0]?1:0;if(result)db.delete(keys[0]);}
    else throw Error('Unknown EVAL');
   }else throw Error('Unknown Redis command');
   return Response.json({result});
  }
  if(u==='https://oauth2.googleapis.com/token'){const payload=String(options.body.get('assertion')).split('.')[1];state.scopes.push(JSON.parse(Buffer.from(payload,'base64url')).scope);return Response.json({access_token:'synthetic'});}
  if(!u.startsWith(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}`))throw Error('Unexpected external request');
  if(u.endsWith(':batchUpdate')){
   state.writes++;if(state.rejectWrites)return Response.json({}, {status:403});
   if(!state.skipApply)for(const {updateCells:r} of JSON.parse(options.body).requests){const cell=grid[r.start.rowIndex][r.start.columnIndex];Object.assign(cell,r.rows[0].values[0]);if(r.fields.includes('userEnteredValue'))cell.formattedValue=cell.userEnteredValue.stringValue;}
   if(state.loseResponse){state.loseResponse=false;return Response.json({}, {status:503});}return Response.json({});
  }
  if(u.includes('/values/'))return Response.json({majorDimension:'ROWS',values:grid.map(r=>r.map(c=>c.formattedValue))});
  if(u.includes('includeGridData'))return Response.json({sheets:[{properties:{sheetId:source.sheetId},data:[{rowData:grid.map(values=>({values}))}]}]});
  return Response.json({properties:{timeZone:'Asia/Taipei'},sheets:[{properties:{sheetId:source.sheetId,title:source.sheetTitle,gridProperties:{rowCount:100,columnCount:38}}}]});
 });
 const cookie=`${OWNER_COOKIE}=${createOwnerSession()}`;
 state.request=(input,authenticated=true)=>new NextRequest(`https://os.test/api/v1/order-payments?property=sweetfun&order=${order}`,{method:input?'POST':'GET',headers:{origin:'https://os.test',host:'os.test',...(authenticated?{cookie}:{})},...(input?{body:JSON.stringify(input)}:{})});
 return state;
}
const receiptInput=(check,patch={})=>({property_id:'sweetfun',order_id:order,amount:1000,payment_type:'deposit',payment_method:'bank_transfer',payment_account_id:account.id,received_at:new Date().toISOString(),note:'測試收款',settles_room:false,request_id:randomUUID(),source_version:check.source_version,expected_version:check.ledger.version,...patch});
async function json(response,status=200){const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;}
test('HTTP partial receipt writes main Sheet note, reuses scoped finance account and is counted once in finance',async t=>{
 const f=setup(t);await json(await GET(f.request(undefined,false)),401);const check=await json(await GET(f.request()));assert.equal(check.payment_accounts[0].id,account.id);
 const input=receiptInput(check);const saved=await json(await POST(f.request(input)));assert.equal(saved.sheet_verified,true);assert.equal(f.writes,1);assert.equal(f.grid[1][7].formattedValue,'not_yet');assert.match(f.grid[1][7].note,/測試帳戶.*12345/);
 await json(await POST(f.request(input)));assert.equal(f.writes,1);const current=await json(await GET(f.request()));assert.equal(current.ledger.receipts.length,1);assert.equal(current.ledger.receipts[0].sheet_sync.targets,undefined);
 const income=await calendarIncome('sweetfun',2026);assert.equal(income.length,1);assert.equal(income[0].amount_cents,100000);assert.equal(income[0].payment_account.id,account.id);
 assert.ok(f.scopes.includes('https://www.googleapis.com/auth/spreadsheets'));assert.ok(f.scopes.includes('https://www.googleapis.com/auth/spreadsheets.readonly'));
});
test('HTTP status-only confirmation updates all main rows and permits immediate GET before monitor refresh, without income',async t=>{
 const f=setup(t),check=await json(await GET(f.request()));const input=receiptInput(check,{status_only:true,amount:0,payment_type:'full',payment_method:'other',payment_account_id:undefined,settles_room:true});
 await json(await POST(f.request(input)));assert.ok(f.grid.slice(1).every(r=>r[7].formattedValue==='done'));const next=await json(await GET(f.request()));assert.equal(next.payment_status,'paid');assert.equal((await calendarIncome('sweetfun',null)).length,0);
});
test('lost Sheet response leaves a durable pending receipt; refresh/retry verifies it without duplicate income or note',async t=>{
 const f=setup(t),check=await json(await GET(f.request()));f.loseResponse=true;const input=receiptInput(check);
 const failure=await json(await POST(f.request(input)),503);assert.equal(failure.code,'SHEET_SYNC_PENDING');const pending=await json(await GET(f.request()));assert.equal(pending.ledger.receipts[0].sheet_sync.state,'pending');
 await json(await POST(f.request(receiptInput(pending))),503);assert.equal((await readLedger('sweetfun',order)).ledger.receipts.length,1);
 await json(await POST(f.request({property_id:'sweetfun',order_id:order,action:'retry_sync',request_id:input.request_id})));assert.equal(f.writes,1);assert.equal(f.grid[1][7].note.split(input.request_id).length,2);assert.equal((await readLedger('sweetfun',order)).ledger.receipts[0].sheet_sync.state,'verified');
});
test('successful write response without matching readback remains pending and can be repaired',async t=>{
 const f=setup(t),check=await json(await GET(f.request()));f.skipApply=true;const input=receiptInput(check);await json(await POST(f.request(input)),503);assert.equal((await readLedger('sweetfun',order)).ledger.receipts[0].sheet_sync.state,'pending');f.skipApply=false;await json(await POST(f.request(input)));assert.equal((await readLedger('sweetfun',order)).ledger.receipts.length,1);
});
test('invalid account and altered idempotency input cannot append or update main Sheet',async t=>{
 const f=setup(t),check=await json(await GET(f.request()));await json(await POST(f.request(receiptInput(check,{payment_account_id:'foreign'}))),400);assert.equal(f.writes,0);const input=receiptInput(check);await json(await POST(f.request(input)));await json(await POST(f.request({...input,amount:1001})),409);assert.equal(f.writes,1);
});
test('server-side connection probe checks write permission without touching cells or creating a receipt',async t=>{
 const f=setup(t),before=JSON.stringify(f.grid),input={property_id:'sweetfun',action:'check_sheet_access'};
 await json(await POST(f.request(input,false)),401);assert.equal(f.writes,0);
 const result=await json(await POST(f.request(input)));assert.equal(result.sheet_write_enabled,true);assert.equal(f.writes,1);assert.equal(JSON.stringify(f.grid),before);assert.equal((await readLedger('sweetfun',order)).ledger.receipts.length,0);
});
test('connection probe surfaces missing Sheet permission without creating a pending payment',async t=>{
 const f=setup(t);f.rejectWrites=true;
 const result=await json(await POST(f.request({property_id:'sweetfun',action:'check_sheet_access'})),503);assert.equal(result.code,'SHEET_PAYMENT_PERMISSION');assert.equal((await readLedger('sweetfun',order)).ledger.receipts.length,0);
});
