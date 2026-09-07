import {randomBytes} from 'node:crypto';
import type {NextRequest,NextResponse} from 'next/server';
import {redisCommand,workspacePrefix} from './store.ts';
export const DEVICE_COOKIE='sf_device_id';
export async function recordDevice(request:NextRequest,response:NextResponse,accountId:string,sessionSeconds:number) {
 const supplied=request.cookies.get(DEVICE_COOKIE)?.value;
 const id=supplied&&/^[a-f0-9]{32}$/.test(supplied)?supplied:randomBytes(16).toString('hex');
 const now=new Date().toISOString();
 const record={id,accountId,lastLoginAt:now,sessionExpiresAt:new Date(Date.now()+sessionSeconds*1000).toISOString(),userAgent:(request.headers.get('user-agent')??'未知瀏覽器').slice(0,300)};
 // One record per browser ID; a repeated login updates the existing record.
 await redisCommand(['HSET',`${workspacePrefix()}:devices:${accountId}`,id,JSON.stringify(record)]);
 if(await redisCommand(['HGET',`${workspacePrefix()}:devices:${accountId}`,id])!==JSON.stringify(record))throw new Error('WRITE_UNCONFIRMED');
 await redisCommand(['EXPIRE',`${workspacePrefix()}:devices:${accountId}`,366*86400]);
 response.cookies.set(DEVICE_COOKIE,id,{httpOnly:true,secure:request.nextUrl.protocol==='https:',sameSite:'lax',path:'/',maxAge:365*86400});
}
export async function accountDevices(accountId:string){
 const values=await redisCommand(['HVALS',`${workspacePrefix()}:devices:${accountId}`]);
 return Array.isArray(values)?values.map(v=>JSON.parse(v)).sort((a,b)=>b.lastLoginAt.localeCompare(a.lastLoginAt)):[];
}
