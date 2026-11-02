import test from 'node:test';
import assert from 'node:assert/strict';
import {NextRequest} from 'next/server';
import {GET} from '../src/app/api/v1/finance/route.ts';
test('audit denies anonymous requests without reading private ledgers',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('Unexpected private access');});
 const response=await GET(new NextRequest('https://os.test/api/v1/finance?property=sweetfun&year=2026&audit=1'));
 assert.equal(response.status,401);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(calls,0);
});
