import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {NextRequest} from 'next/server';
import {GET} from '../src/app/api/v1/availability/route.ts';
import {POST} from '../src/app/api/v1/availability/refresh/route.ts';
import {createMemberSession,MEMBER_COOKIE} from '../src/lib/workspace-auth/session.ts';
import {createPasswordCredential} from '../src/lib/owner-password.ts';
test('Offland enabled routes enforce property and price access before data reads',async t=>{
 process.env.BOOKING_SHEET_SOURCES='sweetfun,offland';process.env.CALENDAR_OWNER_CODE_HASH=createHash('sha256').update('test').digest('hex');process.env.CALENDAR_OWNER_SESSION_SECRET='a'.repeat(64);process.env.KV_REST_API_URL='https://test.invalid';process.env.KV_REST_API_TOKEN='test';
 const member={id:'c'.repeat(32),displayName:'Test',role:'viewer_no_price',status:'active',propertyIds:['offland'],allProperties:false,credential:await createPasswordCredential('Synthetic password testing!')};
 const reads=[];t.mock.method(globalThis,'fetch',async(_url,opt)=>{const c=JSON.parse(opt.body);reads.push(c);return Response.json({result:JSON.stringify({version:1,members:[member]})});});
 function req(path,post=false){return new NextRequest('https://test.invalid'+path,{method:post?'POST':'GET',headers:{cookie:`${MEMBER_COOKIE}=${createMemberSession(member)}`,origin:'https://test.invalid',host:'test.invalid'}});}
 const url='/api/v1/availability?property=offland&start=2026-09-22&end=2026-09-23';
 assert.equal((await GET(req(url))).status,403);member.role='viewer';assert.equal((await GET(req(url+'&rooms=101'))).status,400);assert.equal((await GET(req(url+'&channel=owljourney'))).status,400);assert.equal((await GET(req(url.replace('offland','sweetfun')))).status,403);assert.equal((await POST(req('/api/v1/availability/refresh?property=offland',true))).status,403);member.role='admin';member.propertyIds=['sweetfun'];assert.equal((await POST(req('/api/v1/availability/refresh?property=offland',true))).status,403);assert.ok(reads.every(c=>!String(c[1]).includes(':pricing:')));
});
