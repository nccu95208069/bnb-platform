import type {Principal} from './workspace-auth/types.ts';
import {redisCommand} from './workspace-auth/store.ts';
export type NotificationState={version:number;notified:boolean;at:string;actor:string;actor_name:string;request_id:string};
export const notificationKey=(property:string)=>`sweetfun-os:guest-notification:v1:${property}`;
export const canNotify=(actor:Principal)=>['owner','god','admin','housekeeper'].includes(actor.role);
export function parseNotification(raw:unknown):NotificationState{
 const v=JSON.parse(String(raw));
 if(!v||!Number.isSafeInteger(v.version)||v.version<1||typeof v.notified!=='boolean'||typeof v.at!=='string'||!Number.isFinite(Date.parse(v.at))||typeof v.actor!=='string'||typeof v.actor_name!=='string'||typeof v.request_id!=='string')throw Error('UNAVAILABLE');
 return v;
}
export async function notificationStates(property:string){
 const result=await redisCommand(['HGETALL',notificationKey(property)]);
 if(!Array.isArray(result)||result.length%2)throw Error('UNAVAILABLE');
 const states:Record<string,NotificationState>={};
 for(let i=0;i<result.length;i+=2){if(typeof result[i]!=='string'||!/^SF-[a-f0-9]{20}$/.test(result[i]))throw Error('UNAVAILABLE');states[result[i]]=parseNotification(result[i+1]);}
 return states;
}
export async function setNotification(property:string,order:string,notified:boolean,version:number,requestId:string,actor:Principal){
 const key=notificationKey(property),raw=await redisCommand(['HGET',key,order]);
 const before=raw===null?null:parseNotification(raw);
 if(before?.request_id===requestId){if(before.actor!==actor.id||before.notified!==notified)throw Error('VERSION_CONFLICT');return before;}
 if((before?.version??0)!==version)throw Error('VERSION_CONFLICT');
 const after:NotificationState={version:version+1,notified,at:new Date().toISOString(),actor:actor.id,actor_name:actor.displayName,request_id:requestId};
 const audit=JSON.stringify({action:notified?'guest_notified':'guest_notification_revoked',property_id:property,order_id:order,before,after,actor:{id:actor.id,email:actor.email,role:actor.role},at:after.at});
 const stored=await redisCommand(['EVAL',"local old=redis.call('HGET',KEYS[1],ARGV[1]); if (old or '')~=ARGV[2] then return 0 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[3]); redis.call('RPUSH',KEYS[2],ARGV[4]); return 1",2,key,`${key}:audit`,order,raw??'',JSON.stringify(after),audit]);
 if(stored!==1)throw Error('VERSION_CONFLICT');
 const verified=parseNotification(await redisCommand(['HGET',key,order]));
 if(verified.request_id!==requestId)throw Error('VERSION_CONFLICT');
 return verified;
}
