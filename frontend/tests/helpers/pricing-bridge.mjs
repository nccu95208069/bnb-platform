// Test-only stdio bridge: Python outbox -> actual Next handlers -> isolated Redis.
// No HTTP server and no production credentials. Every fetch is intercepted.
import readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { digest } from '../../src/lib/calendar-changes/contract.ts';
import { POST, GET } from '../../src/app/api/v1/calendar/changes/route.ts';
import { pricingProperty } from '../../src/lib/property-pricing.ts';
import { localRedis } from './redis-command.mjs';
if (!process.env.CALENDAR_TEST_REDIS_PORT) throw Error('isolated Redis required');
process.env.CALENDAR_CHANGE_NAMESPACE='python-bridge:'+randomUUID();
process.env.CALENDAR_CHANGE_CLIENTS=JSON.stringify([{id:'python-synthetic',token_sha256:digest('synthetic-bridge-token-test-only-long'),properties:['sweetfun','offland'],changes:['prices','sales_probability','inventory','pricing_decisions']}]);
process.env.CALENDAR_CHANGES_ENABLED='true';
process.env.BOOKING_SHEET_SOURCES='sweetfun,offland';
process.env.UPSTASH_REDIS_REST_URL='https://redis.test.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN='synthetic';
globalThis.fetch=async(url,options)=>{
 if(url!=='https://redis.test.invalid')throw Error('external request forbidden');
 return Response.json({result:await localRedis(JSON.parse(options.body))});
};
for (const property of ['sweetfun','offland']) await localRedis(['DEL',pricingProperty(property).key]);
for await (const line of readline.createInterface({input:process.stdin})) {
 try {
  const packet=JSON.parse(line);
  const request=new NextRequest(packet.url,{method:packet.method,headers:{authorization:'Bearer '+packet.token,'content-type':'application/json'},...(packet.body?{body:packet.body}:{})});
  const response=await (packet.method==='POST'?POST(request):GET(request));
  process.stdout.write(JSON.stringify({status:response.status,body:await response.json()})+'\n');
 } catch {process.stdout.write(JSON.stringify({status:599,body:{verified:false}})+'\n');}
}
