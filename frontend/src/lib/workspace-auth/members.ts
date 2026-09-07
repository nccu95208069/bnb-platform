import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {createPasswordCredential,passwordProblem} from '../owner-password.ts';
import {ADMIN_EMAIL,PROPERTY_IDS,nextWorkspace,normalizedEmail,validEmail,type Member,type MemberRole} from './types.ts';
import type {WorkspaceStore} from './store.ts';
export const hashToken=(value:string)=>createHash('sha256').update(value).digest('hex');
export type InviteSender=(to:string,token:string)=>Promise<void>;
const roles:MemberRole[]=['admin','housekeeper','viewer','viewer_no_price'];
export function memberInput(input:Record<string,unknown>) {
  const email=normalizedEmail(input.email),displayName=typeof input.displayName==='string'?input.displayName.trim():'';
  const role=input.role as MemberRole,allProperties=input.allProperties===true;
  const propertyIds=allProperties?[...PROPERTY_IDS]:Array.isArray(input.propertyIds)?[...new Set(input.propertyIds)].filter((p):p is string=>typeof p==='string'&&PROPERTY_IDS.includes(p)):[];
  if(!validEmail(email)||email===ADMIN_EMAIL||!displayName||displayName.length>100||!roles.includes(role)||!propertyIds.length)throw new Error('INVALID_INPUT');
  if(!allProperties&&(!Array.isArray(input.propertyIds)||input.propertyIds.length!==propertyIds.length))throw new Error('INVALID_INPUT');
  return {email,displayName,role,allProperties,propertyIds,phone:typeof input.phone==='string'?input.phone.trim().slice(0,30)||null:null};
}
export async function inviteMember(store:WorkspaceStore,input:Record<string,unknown>,send:InviteSender,now=Date.now()) {
  const state=await store.read();
  const id=typeof input.id==='string'?input.id:null;
  let member:Member;
  const token=randomBytes(32).toString('base64url');
  if(id) {
    const existing=state.value.members.find(m=>m.id===id);
    if(!existing)throw new Error('NOT_FOUND');
    if(existing.status==='suspended')throw new Error('INVITE_INVALID');
    if(input.version!==existing.version)throw new Error('VERSION_CONFLICT');
    member={...existing,version:existing.version+1};
  } else {
    const values=memberInput(input);
    if(state.value.members.some(m=>m.email===values.email))throw new Error('EMAIL_EXISTS');
    if(state.value.members.length>=100)throw new Error('INVALID_INPUT');
    member={...values,id:randomBytes(16).toString('hex'),status:'invited',invitedAt:new Date(now).toISOString(),acceptedAt:null,lastActiveAt:null,credential:null,invitation:null,version:1};
  }
  member.invitation={hash:hashToken(token),expires:now+86400000,sent:'pending'};
  member.invitedAt=new Date(now).toISOString();
  const members=id?state.value.members.map(m=>m.id===id?member:m):[...state.value.members,member];
  await store.replace(state.raw,nextWorkspace(state.value,members,'invite_prepared',member.id));
  // A delivery failure keeps a recoverable pending member, never a fake "sent" success.
  let sent=false;
  try {await send(member.email,`${member.id}.${token}`);sent=true;}catch{/* Only safe status is returned. */}
  const latest=await store.read();
  const current=latest.value.members.find(m=>m.id===member.id);
  if(!current||current.invitation?.hash!==member.invitation.hash)throw new Error('VERSION_CONFLICT');
  const updated={...current,version:current.version+1,invitation:{...current.invitation,sent:sent?'sent' as const:'failed' as const}};
  await store.replace(latest.raw,nextWorkspace(latest.value,latest.value.members.map(m=>m.id===updated.id?updated:m),sent?'invite_sent':'invite_delivery_failed',member.id));
  return {member:updated,delivery:sent?'sent' as const:'failed' as const};
}
export function invitedMember(token:unknown,members:Member[],now=Date.now()) {
  if(typeof token!=='string'||! /^[a-f0-9]{32}\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error('INVITE_INVALID');
  const [id,secret]=token.split('.'),member=members.find(m=>m.id===id);
  if(!member||member.status==='suspended'||!member.invitation||member.invitation.expires<=now||!timingSafeEqual(Buffer.from(member.invitation.hash),Buffer.from(hashToken(secret))))throw new Error('INVITE_INVALID');
  return member;
}
export async function activateMember(store:WorkspaceStore,input:Record<string,unknown>,now=Date.now()) {
  const state=await store.read(),member=invitedMember(input.token,state.value.members,now);
  if(passwordProblem(input.password)||input.password!==input.confirmPassword)throw new Error('PASSWORD_INVALID');
  const credential=await createPasswordCredential(input.password as string);
  const updated:Member={...member,mustResetPassword:false,credential,status:'active',acceptedAt:member.acceptedAt??new Date(now).toISOString(),invitation:null,version:member.version+1};
  await store.replace(state.raw,nextWorkspace(state.value,state.value.members.map(m=>m.id===member.id?updated:m),'password_activated',member.id,member.id));
  return updated;
}
export async function updateMember(store:WorkspaceStore,input:Record<string,unknown>) {
  const state=await store.read(),member=state.value.members.find(m=>m.id===input.id);
  if(!member)throw new Error('NOT_FOUND');
  if(input.version!==member.version)throw new Error('VERSION_CONFLICT');
  let updated:Member;
  if(input.status!==undefined) {
    if(!['suspended','invited'].includes(input.status as string))throw new Error('INVALID_INPUT');
    updated={...member,status:input.status==='suspended'?'suspended':member.credential?'active':'invited',invitation:null,version:member.version+1};
    // Suspend revokes every old session, including after re-enabling the account.
    if(updated.credential?.kind==='password')updated.credential={...updated.credential,revision:randomBytes(32).toString('hex')};
  } else {
    const values=memberInput(input);
    if(values.email!==member.email)throw new Error('INVALID_INPUT');
    updated={...member,...values,version:member.version+1};
  }
  await store.replace(state.raw,nextWorkspace(state.value,state.value.members.map(m=>m.id===member.id?updated:m),input.status?'status_updated':'permissions_updated',member.id));
  return updated;
}
