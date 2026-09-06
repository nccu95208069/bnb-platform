import type { OwnerCredential } from '../owner-password.ts';
export const ADMIN_EMAIL = 'sweetfuntw@gmail.com';
export const PROPERTY_IDS = ['sweetfun', 'offland'];
export type MemberRole = 'admin' | 'housekeeper' | 'viewer' | 'viewer_no_price';
export type Member = {
  id: string; displayName: string; email: string; phone: string | null;
  role: MemberRole; status: 'invited' | 'active' | 'suspended';
  allProperties: boolean; propertyIds: string[];
  invitedAt: string; acceptedAt: string | null; lastActiveAt: string | null;
  credential: OwnerCredential | null;
  invitation: { hash: string; expires: number; sent: 'pending' | 'sent' | 'failed' } | null;
  version: number;
};
export type WorkspaceState = { version: number; members: Member[]; audit?: { at: string; actor: string; action: string; memberId: string }[] };
export function nextWorkspace(state: WorkspaceState, members: Member[], action: string, memberId: string, actor = "calendar-owner"): WorkspaceState {
  return { version: state.version + 1, members, audit: [...(state.audit ?? []), { at: new Date().toISOString(), actor, action, memberId }].slice(-200) };
}
export type Principal = { id: string; displayName: string; email: string; role: 'owner' | MemberRole; allProperties: boolean; propertyIds: string[]; viewPrices: boolean };
export const ownerPrincipal = (): Principal => ({id:'calendar-owner',displayName:'管理者',email:ADMIN_EMAIL,role:'owner',allProperties:true,propertyIds:[...PROPERTY_IDS],viewPrices:true});
export function publicMember(member: Member) {
  const { id,displayName,email,phone,role,status,allProperties,propertyIds,invitedAt,acceptedAt,lastActiveAt,version } = member;
  return {id,displayName,email,phone,role,status,allProperties,propertyIds,invitedAt,acceptedAt,lastActiveAt,version,invitationStatus:member.invitation?.sent ?? null};
}
export const normalizedEmail = (input: unknown) => typeof input === 'string' ? input.trim().toLowerCase() : '';
export const validEmail = (input: string) => /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(input) && input.length <= 254;
