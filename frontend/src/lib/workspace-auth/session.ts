import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { OWNER_COOKIE, OWNER_SESSION_SECONDS, ownerAccessConfigured } from '../calendar-owner-session.ts';
import { RedisOwnerCredentialStore, credentialBinding, credentialSessionValid } from '../owner-password.ts';
import { RedisWorkspaceStore, type WorkspaceStore } from './store.ts';
import { ownerPrincipal, type Member, type Principal } from './types.ts';
import { PREVIEW_OWNER_COOKIE, OFFLAND_PREVIEW_OWNER_COOKIE,
  previewOwnerConfigured, previewOwnerPrincipal, validPreviewOwnerSession,
  offlandPreviewOwnerConfigured, offlandPreviewOwnerPrincipal,
  validOfflandPreviewOwnerSession } from '../iron-gate-preview-owner.ts';
export const MEMBER_COOKIE='sf_calendar_member';
export interface CookieRequest { cookies: {get(name:string):{value:string}|undefined} }
type RequestAuthReads = {
  members: Map<WorkspaceStore | undefined, Promise<Member | null>>;
  principals: Map<WorkspaceStore | undefined, Promise<Principal | null>>;
  ownerCredential?: ReturnType<RedisOwnerCredentialStore['read']>;
};
// The request object, never a cookie or user ID, is the cache boundary. A new
// request always reads current credentials/membership, including revocations.
const requestAuthReads = new WeakMap<CookieRequest, RequestAuthReads>();
function authReads(request: CookieRequest): RequestAuthReads {
  let reads = requestAuthReads.get(request);
  if (!reads) {
    reads = { members: new Map(), principals: new Map() };
    requestAuthReads.set(request, reads);
  }
  return reads;
}
function ownerCredentialFor(request: CookieRequest) {
  const reads = authReads(request);
  return reads.ownerCredential ??= new RedisOwnerCredentialStore().read();
}

// This is the public session projection shared by the GET route and a server
// render bootstrap. Raw Member records and credentials must never be serialized.
export type CalendarSessionData = {
  available: boolean;
  authenticated: boolean;
  requires_password_reset?: boolean;
  has_custom_password?: boolean;
  membership: (Principal & { tenantId: string; tenantName: string;
    phone: null; status: 'active' }) | null;
};
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
export function principalFor(request:CookieRequest,store?:WorkspaceStore):Promise<Principal|null> {
  const reads = authReads(request);
  let pending = reads.principals.get(store);
  if (!pending) {
    pending = readPrincipal(request, store);
    reads.principals.set(store, pending);
  }
  return pending;
}
async function readPrincipal(request:CookieRequest,store?:WorkspaceStore):Promise<Principal|null> {
  if (offlandPreviewOwnerConfigured() &&
    validOfflandPreviewOwnerSession(request.cookies.get(OFFLAND_PREVIEW_OWNER_COOKIE)?.value))
    return offlandPreviewOwnerPrincipal();
  if (previewOwnerConfigured()) return validPreviewOwnerSession(request.cookies.get(PREVIEW_OWNER_COOKIE)?.value) ? previewOwnerPrincipal() : null;
  if (offlandPreviewOwnerConfigured()) return null;
  if(!ownerAccessConfigured())return null;
  const owner=request.cookies.get(OWNER_COOKIE)?.value;
  if(owner&&credentialSessionValid(owner,(await ownerCredentialFor(request)).value))return ownerPrincipal();
  const member=await sessionMember(request,store);
  return member&&!member.mustResetPassword?memberPrincipal(member):null;
}
export function sessionMember(request:CookieRequest,store?:WorkspaceStore):Promise<Member|null> {
  const reads = authReads(request);
  let pending = reads.members.get(store);
  if (!pending) {
    pending = readSessionMember(request, store ?? new RedisWorkspaceStore());
    reads.members.set(store, pending);
  }
  return pending;
}
async function readSessionMember(request:CookieRequest,store:WorkspaceStore):Promise<Member|null> {
  const cookie=request.cookies.get(MEMBER_COOKIE)?.value;
  if(!cookie)return null;
  const id=cookie.split('.')[0];
  if(!/^[a-f0-9]{32}$/.test(id))return null;
  const member=(await store.read()).value.members.find(m=>m.id===id);
  return member&&validMemberSession(cookie,member)?member:null;
}
export async function calendarSessionFor(request: CookieRequest): Promise<CalendarSessionData> {
  const preview = previewOwnerConfigured() || offlandPreviewOwnerConfigured();
  if (!preview && !ownerAccessConfigured())
    return { available: false, authenticated: false, membership: null };
  if (!preview) {
    const limited = await sessionMember(request);
    if (limited?.mustResetPassword) return { available: true, authenticated: true,
      requires_password_reset: true, membership: null };
  }
  const principal = await principalFor(request);
  const hasCustomPassword = preview ? true : principal?.role === 'owner'
    ? (await ownerCredentialFor(request)).value.kind === 'password' : Boolean(principal);
  return { available: true, authenticated: Boolean(principal), has_custom_password: hasCustomPassword,
    membership: principal ? { ...principal, propertyIds: [...principal.propertyIds],
      tenantId: 'sweetfun-workspace', tenantName: 'Sweetfun OS', phone: null, status: 'active' } : null };
}
export async function requireOwner(request:CookieRequest) {
  const principal=await principalFor(request);
  if(principal?.role!=='owner')throw new Error('FORBIDDEN');
  return principal;
}

export async function requireManager(request:CookieRequest) {
  const principal=await principalFor(request);
  if(principal?.role!=='owner'&&principal?.role!=='admin'&&principal?.role!=='god')throw new Error('FORBIDDEN');
  return principal;
}
