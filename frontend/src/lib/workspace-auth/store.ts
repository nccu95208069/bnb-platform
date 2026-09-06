import { createHash } from 'node:crypto';
import type { WorkspaceState } from './types.ts';
export async function redisCommand(command: (string | number)[]) {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token || new URL(url).protocol !== 'https:') throw new Error('STORE_UNAVAILABLE');
  const response = await fetch(url,{method:'POST',cache:'no-store',signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(command)});
  if(!response.ok) throw new Error('STORE_UNAVAILABLE');
  const result=await response.json(); if(result.error)throw new Error('STORE_UNAVAILABLE'); return result.result;
}
export interface WorkspaceStore {
  read(): Promise<{raw:string | null; value:WorkspaceState}>;
  replace(raw:string | null, value:WorkspaceState): Promise<void>;
  limit(key:string,max:number,seconds:number): Promise<void>;
}
export const workspacePrefix = () => process.env.WORKSPACE_AUTH_NAMESPACE || 'sweetfun-os:workspace-auth:v1';
export class RedisWorkspaceStore implements WorkspaceStore {
  async read() {
    const raw=await redisCommand(['GET',`${workspacePrefix()}:members`]);
    if(raw===null)return {raw:null,value:{version:0,members:[]}};
    if(typeof raw!=='string')throw new Error('STORE_UNAVAILABLE');
    const value=JSON.parse(raw) as WorkspaceState;
    if(!Number.isSafeInteger(value.version)||!Array.isArray(value.members)||value.members.length>100)throw new Error('STORE_UNAVAILABLE');
    return {raw,value};
  }
  async replace(raw:string | null,value:WorkspaceState) {
    const result=await redisCommand(['EVAL',"local old=redis.call('GET',KEYS[1]); if (old or '')~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1",1,`${workspacePrefix()}:members`,raw??'',JSON.stringify(value)]);
    if(result!==1)throw new Error('VERSION_CONFLICT');
    const check=await this.read();
    if(check.value.version!==value.version)throw new Error('WRITE_UNCONFIRMED');
  }
  async limit(key:string,max:number,seconds:number) {
    const digest=createHash('sha256').update(key).digest('hex');
    const count=await redisCommand(['EVAL',"local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n",1,`${workspacePrefix()}:rate:${digest}`,seconds]);
    if(typeof count!=='number'||count>max)throw new Error('RATE_LIMITED');
  }
}
