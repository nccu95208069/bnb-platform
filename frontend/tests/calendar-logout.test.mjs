import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {DELETE} from '../src/app/api/calendar-session/route.ts';
import {OWNER_COOKIE} from '../src/lib/calendar-owner-session.ts';
import {MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';

test('logout expires both member and owner cookies; cross-origin requests cannot log users out',async()=>{
 const request=origin=>new NextRequest('https://calendar.test/api/calendar-session',{method:'DELETE',headers:{host:'calendar.test',origin,cookie:`${MEMBER_COOKIE}=test-member; ${OWNER_COOKIE}=test-owner`}});
 const denied=await DELETE(request('https://other.test'));
 assert.equal(denied.status,403);assert.equal(denied.cookies.getAll().length,0);
 const result=await DELETE(request('https://calendar.test'));
 assert.equal(result.status,200);assert.equal((await result.json()).authenticated,false);
 for(const key of [MEMBER_COOKIE,OWNER_COOKIE]){
  const cookie=result.cookies.get(key);assert.equal(cookie.value,'');assert.equal(cookie.maxAge,0);
  assert.equal(cookie.path,'/');assert.equal(cookie.secure,true);assert.equal(cookie.httpOnly,true);
 }
});
