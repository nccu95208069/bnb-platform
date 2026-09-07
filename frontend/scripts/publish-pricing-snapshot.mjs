// Operator bridge; Redis credentials must already be present in the environment.
// node --experimental-strip-types --loader ./tests/helpers/next-route-loader.mjs scripts/publish-pricing-snapshot.mjs /private/prices.json
import {readFile} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import {validatePricingSnapshot,PRICING_KEY} from '../src/lib/pricing-snapshot.ts';
import {redisCommand} from '../src/lib/workspace-auth/store.ts';
const snapshot=validatePricingSnapshot(JSON.parse(await readFile(process.argv[2],'utf8')));
if(Date.now()-Date.parse(snapshot.observed_at)>15*60000)throw Error('Export is too old to publish; read source again');
const old=await redisCommand(['GET',PRICING_KEY]);
if(old){
  const prior=validatePricingSnapshot(JSON.parse(gunzipSync(Buffer.from(old.slice(4),'base64')).toString('utf8')));
  if(Date.parse(prior.observed_at)>=Date.parse(snapshot.observed_at))throw Error('Newer or identical snapshot already published');
}
const value='gz1:'+gzipSync(JSON.stringify(snapshot)).toString('base64');
// Preserve one rollback version and atomically reject concurrent publication.
const result=await redisCommand(['EVAL',"local old=redis.call('GET',KEYS[1]); if (old or '')~=ARGV[1] then return 0 end; if old then redis.call('SET',KEYS[2],old) end; redis.call('SET',KEYS[1],ARGV[2]); return 1",2,PRICING_KEY,PRICING_KEY+':previous',old??'',value]);
if(result!==1)throw Error('Concurrent publication; retry with a fresh read');
if(await redisCommand(['GET',PRICING_KEY])!==value)throw Error('Publication verification failed');
console.log(JSON.stringify({published:true,version:snapshot.version,cells:snapshot.cells.length,bytes:value.length}));
