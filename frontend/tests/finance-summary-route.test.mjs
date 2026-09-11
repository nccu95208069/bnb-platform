import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {GET,POST} from '../src/app/api/v1/finance-summary/route.ts';
test('summary API denies anonymous reads and cross-origin writes without source access',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected source access');});
 const response=await GET(new NextRequest('https://os.test/api/v1/finance-summary?property=sweetfun'));
 assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/);
 const denied=await POST(new NextRequest('https://os.test/api/v1/finance-summary',{method:'POST',headers:{host:'os.test',origin:'https://evil.test'},body:'{}'}));assert.equal(denied.status,403);assert.equal(calls,0);
});
