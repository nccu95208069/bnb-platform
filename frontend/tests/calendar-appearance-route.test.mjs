import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { GET, PUT } from '../src/app/api/calendar-appearance/route.ts';
import { createOwnerSession, OWNER_COOKIE } from '../src/lib/calendar-owner-session.ts';

test('appearance API authenticates account writes, isolates guests and verifies persistence', async t => {
  process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('a'.repeat(32)).digest('hex');
  process.env.CALENDAR_OWNER_SESSION_SECRET='b'.repeat(64);
  process.env.KV_REST_API_URL='https://appearance.invalid';
  process.env.KV_REST_API_TOKEN='synthetic';
  const values=new Map(); let writes=0; let fail=false;
  t.mock.method(globalThis,'fetch',async (_url, options) => {
    if(fail) return Response.json({error:'down'},{status:503});
    const [command,key,value]=JSON.parse(options.body);
    if(key.endsWith(':credential')) return Response.json({result:JSON.stringify({schema:1,kind:'bootstrap',hash:process.env.CALENDAR_OWNER_CODE_HASH})});
    if(command==='SET'){values.set(key,value);writes++;}
    return Response.json({result:command==='GET'?values.get(key)??null:'OK'});
  });
  const request=(method='GET',body, cookie, origin='https://calendar.test')=>new NextRequest('https://calendar.test/api/calendar-appearance',{method,headers:{host:'calendar.test',origin,...(cookie?{cookie:`${OWNER_COOKIE}=${cookie}`}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const session=createOwnerSession();
  assert.equal((await (await GET(request())).json()).scope,'device');
  assert.equal((await PUT(request('PUT',{palette:'jewel'}))).status,401);
  assert.equal((await PUT(request('PUT',{palette:'jewel'},'tampered'))).status,401);
  assert.equal((await PUT(request('PUT',{palette:'jewel'},session,'https://evil.test'))).status,403);
  assert.equal((await PUT(request('PUT',{palette:'jewel',accountId:'another-user'},session))).status,400);
  assert.equal((await PUT(request('PUT',{palette:'custom-css'},session))).status,400);
  assert.equal(writes,0);
  assert.equal((await (await PUT(request('PUT',{palette:'jewel'},session))).json()).palette,'jewel');
  const saved=await GET(request('GET',null,createOwnerSession()));
  assert.equal((await saved.json()).palette,'jewel');
  assert.match(saved.headers.get('cache-control'),/no-store/);
  assert.equal((await (await GET(request())).json()).palette,'mist');
  fail=true;
  assert.equal((await PUT(request('PUT',{palette:'earth'},session))).status,503);
  assert.equal(writes,1);
});
