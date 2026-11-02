import {redisCommand} from './workspace-auth/store.ts';
import {emptyRegistry,type SummaryRegistry} from './finance-summary.ts';
const key=(property:string)=>`sweetfun-os:finance-summary:v1:${property}`;
export async function readSummaryRegistry(property:string){
 const raw=await redisCommand(['GET',key(property)]);
 if(raw===null)return {raw:null,state:emptyRegistry()};
 if(typeof raw!=='string')throw new Error('STORE_UNAVAILABLE');
 const state=JSON.parse(raw) as SummaryRegistry;
 if(state.schema!==1||!Number.isSafeInteger(state.version)||state.version<0||!Array.isArray(state.orders)||!Array.isArray(state.audits))throw new Error('STORE_UNAVAILABLE');
 return {raw,state};
}
export async function saveSummaryRegistry(property:string,raw:string|null,state:SummaryRegistry){
 const encoded=JSON.stringify(state);
 const ok=await redisCommand(['EVAL',"if (redis.call('GET',KEYS[1]) or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1",1,key(property),raw??'',encoded]);
 if(ok!==1)throw new Error('VERSION_CONFLICT');
 const checked=await readSummaryRegistry(property);
 if(!checked.state.audits.some(a=>a.version===state.version&&a.source_version===state.audits.at(-1)?.source_version))throw new Error('WRITE_UNCONFIRMED');
}
