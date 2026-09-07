import {randomBytes} from 'node:crypto';
import {redisCommand,workspacePrefix,type WorkspaceStore} from './store.ts';
import {sealMailPassword,openMailPassword} from './mail.ts';
import {createPasswordCredential} from '../owner-password.ts';
import {nextWorkspace,type Member} from './types.ts';
export async function sharedRecoveryPassword(){
 const key=`${workspacePrefix()}:recovery-password`;
 let raw=await redisCommand(['GET',key]);
 if(raw===null){
  const encrypted=sealMailPassword(`SF-${randomBytes(12).toString('base64url')}`);
  await redisCommand(['SET',key,JSON.stringify(encrypted),'NX']);
  raw=await redisCommand(['GET',key]);
 }
 if(typeof raw!=='string')throw new Error('STORE_UNAVAILABLE');
 return openMailPassword(JSON.parse(raw));
}
export async function beginRecovery(store:WorkspaceStore,input:Record<string,unknown>){
 const state=await store.read(),member=state.value.members.find(m=>m.id===input.id);
 if(!member||member.status==='suspended')throw new Error('NOT_FOUND');
 if(input.version!==member.version)throw new Error('VERSION_CONFLICT');
 const password=await sharedRecoveryPassword();
 const updated:Member={...member,status:'active',credential:await createPasswordCredential(password),mustResetPassword:true,invitation:null,version:member.version+1};
 await store.replace(state.raw,nextWorkspace(state.value,state.value.members.map(m=>m.id===member.id?updated:m),'admin_password_reset',member.id));
 return {password,member:updated};
}
