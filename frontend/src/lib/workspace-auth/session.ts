import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OWNER_COOKIE, OWNER_SESSION_SECONDS, ownerAccessConfigured } from '../calendar-owner-session.ts';
import { RedisOwnerCredentialStore, credentialBinding, credentialSessionValid } from '../owner-password.ts';
import { RedisWorkspaceStore, type WorkspaceStore } from './store.ts';
import { ownerPrincipal, type Member, type Principal } from './types.ts';
export const MEMBER_COOKIE='sf_calendar_member';
export interface CookieRequest { cookies: {get(name:string):{value:string}|undefined} }
function signature(payload:string,revision:string) {
  if(!ownerAccessConfigured())throw new Error('AUTH_UNAVAILABLE');
  return createHmac('sha256',`${process.env.CALENDAR_OWNER_SESSION_SECRET}:member:${revision}`).update(payload).digest('base64url');
}
export function createMemberSession(member:Member,now=Date.now()) {
  if(member.status!=='active'||!member.credential)throw new Error('UNAUTHORIZED');
  const payload=`${member.id}.${Math.floor(now/1000)+(member.mustResetPassword ? 30*60 : OWNER_SESSION_SECONDS)}.${randomBytes(16).toString('base64url')}`;
  return `${payload}.${signature(payload,credentialBinding(member.credential))}`;
}
export function validMemberSession(cookie:string|undefined,member:Member,now=Date.now()) {
  if(!cookie||cookie.length>300||member.status!=='active'||!member.credential)return false;
  const parts=cookie.split('.');
  if(parts.length!==4||parts[0]!==member.id||!/^\d{10}$/.test(parts[1])||!/^[\w-]{22}$/.test(parts[2])||!/^[\w-]{43}$/.test(parts[3]))return false;
  const expiry=Number(parts[1]),seconds=Math.floor(now/1000);
  if(expiry<=seconds||expiry>seconds+OWNER_SESSION_SECONDS)return false;
  return timingSafeEqual(Buffer.from(signature(parts.slice(0,3).join('.'),credentialBinding(member.credential))),Buffer.from(parts[3]));
}
export function memberPrincipal(member:Member):Principal {
  return {id:member.id,displayName:member.displayName,email:member.email,role:member.role,allProperties:member.allProperties,propertyIds:member.propertyIds,viewPrices:member.role!=='viewer_no_price'};
}
export async function principalFor(request:CookieRequest,store:WorkspaceStore=new RedisWorkspaceStore()):Promise<Principal|null> {
  if(!ownerAccessConfigured())return null;
  const owner=request.cookies.get(OWNER_COOKIE)?.value;
  if(owner&&credentialSessionValid(owner,(await new RedisOwnerCredentialStore().read()).value))return ownerPrincipal();
  const member=await sessionMember(request,store);
  return member&&!member.mustResetPassword?memberPrincipal(member):null;
}
export async function sessionMember(request:CookieRequest,store:WorkspaceStore=new RedisWorkspaceStore()):Promise<Member|null> {
  const cookie=request.cookies.get(MEMBER_COOKIE)?.value;
  if(!cookie)return null;
  const id=cookie.split('.')[0];
  if(!/^[a-f0-9]{32}$/.test(id))return null;
  const member=(await store.read()).value.members.find(m=>m.id===id);
  return member&&validMemberSession(cookie,member)?member:null;
}
export async function requireOwner(request:CookieRequest) {
  const principal=await principalFor(request);
  if(principal?.role!=='owner')throw new Error('FORBIDDEN');
  return principal;
}
