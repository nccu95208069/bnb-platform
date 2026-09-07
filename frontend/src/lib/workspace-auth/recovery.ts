import {checkManagement} from './management.ts';
import {ownerPrincipal,type Principal} from './types.ts';
import {randomBytes,createHash} from 'node:crypto';
import {redisCommand,workspacePrefix,RedisWorkspaceStore,type WorkspaceStore} from './store.ts';
import {sealMailPassword,openMailPassword} from './mail.ts';
import {createPasswordCredential,passwordProblem} from '../owner-password.ts';
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
export async function beginRecovery(store:WorkspaceStore,input:Record<string,unknown>,actor:Principal=ownerPrincipal()){
 const state=await store.read(),member=state.value.members.find(m=>m.id===input.id);
 if(!member||member.status==='suspended')throw new Error('NOT_FOUND');
 checkManagement(actor,input,member);
 if(input.version!==member.version)throw new Error('VERSION_CONFLICT');
 const password=await sharedRecoveryPassword();
 const updated:Member={...member,status:'active',credential:await createPasswordCredential(password),mustResetPassword:true,invitation:null,version:member.version+1};
 await store.replace(state.raw,nextWorkspace(state.value,state.value.members.map(m=>m.id===member.id?updated:m),'admin_password_reset',member.id,actor.id));
 return {password,member:updated};
}

export async function recoverySettings(){
 await sharedRecoveryPassword();
 const raw=await redisCommand(['GET',`${workspacePrefix()}:recovery-password`]);
 if(typeof raw!=='string')throw new Error('STORE_UNAVAILABLE');
 return {password:openMailPassword(JSON.parse(raw)),revision:createHash('sha256').update(raw).digest('hex')};
}
export async function setRecoveryPassword(input:Record<string,unknown>,actor:Principal=ownerPrincipal()){
 if(passwordProblem(input.password)||input.password!==input.confirmPassword)throw new Error('PASSWORD_INVALID');
 const store=new RedisWorkspaceStore(),state=await store.read();
 const key=`${workspacePrefix()}:recovery-password`,raw=await redisCommand(['GET',key]);
 if(typeof raw!=='string'||input.revision!==createHash('sha256').update(raw).digest('hex'))throw new Error('VERSION_CONFLICT');
 const password=input.password as string;
 const members:Member[]=[];
 let updatedCount=0;
 for(const member of state.value.members){
  if(member.mustResetPassword && member.role !== 'god'){members.push({...member,credential:await createPasswordCredential(password),version:member.version+1});updatedCount++;}
  else members.push(member);
 }
 const next=JSON.stringify(nextWorkspace(state.value,members,'shared_recovery_password_changed','workspace',actor.id));
 const encrypted=JSON.stringify(sealMailPassword(password));
 // Both settings and pending credentials change atomically, including when there
 // are no pending members. Concurrent beginRecovery/password completion then fails CAS.
 const changed=await redisCommand(['EVAL',"local members=redis.call('GET',KEYS[1]); local secret=redis.call('GET',KEYS[2]); if (members or '')~=ARGV[1] or (secret or '')~=ARGV[2] then return 0 end; redis.call('SET',KEYS[1],ARGV[3]); redis.call('SET',KEYS[2],ARGV[4]); return 1",2,`${workspacePrefix()}:members`,key,state.raw??'',raw,next,encrypted]);
 if(changed!==1)throw new Error('VERSION_CONFLICT');
 const verified=await recoverySettings();
 if(verified.password!==password||(await store.read()).raw!==next)throw new Error('WRITE_UNCONFIRMED');
 return {...verified,updatedCount};
}
