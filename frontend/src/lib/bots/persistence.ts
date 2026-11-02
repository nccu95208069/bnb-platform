import { randomUUID } from 'node:crypto';
import {redisCommand} from '../workspace-auth/store.ts';
import {openStore} from './store.mjs';
const PREFIX='sweetfun-os:bots:v1';
export const COMMIT=`if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; if (redis.call('GET',KEYS[2]) or '')~=ARGV[2] then return 0 end; redis.call('SET',KEYS[2],ARGV[3]); return 1`;
export const RELEASE=`if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0`;
// The lock expires after the route's maximum duration. The token fences late requests.
export async function withWorkspace<T>(operation:(store:ReturnType<typeof openStore>)=>Promise<T>,write:boolean){
 const stateKey=PREFIX+':state',lockKey=PREFIX+':lock',token=randomUUID();
 if(write&&await redisCommand(['SET',lockKey,token,'NX','EX',240])!=='OK')throw Error('BUSY');
 try{
  const raw=await redisCommand(['GET',stateKey]);
  if(raw!==null&&typeof raw!=='string')throw Error('STORE_INVALID');
  const s=openStore(raw?JSON.parse(raw):null);
  const result=await operation(s);
  if(write){
   const value=JSON.stringify(s.snapshot());
   if(Buffer.byteLength(value)>4*1024*1024)throw Error('STORE_FULL');
   if(await redisCommand(['EVAL',COMMIT,2,lockKey,stateKey,token,raw??'',value])!==1)throw Error('WRITE_CONFLICT');
   if(await redisCommand(['GET',stateKey])!==value)throw Error('WRITE_UNCONFIRMED');
  }
  return result;
 }finally{if(write)await redisCommand(['EVAL',RELEASE,1,lockKey,token]).catch(()=>{});}
}
