import type { Member, Principal } from './types.ts';

export function canManageMember(actor: Principal, member: Pick<Member, 'allProperties' | 'propertyIds'>) {
  return actor.role === 'owner' || actor.role === 'god' || (actor.role === 'admin' && (actor.allProperties ||
    (!member.allProperties && member.propertyIds.every(id => actor.propertyIds.includes(id)))));
}
export function checkManagement(actor: Principal, input: Record<string, unknown>, existing?: Member) {
  if (existing?.role === 'god' || input.role === 'god') throw new Error('FORBIDDEN');
  if (actor.role === 'owner' || actor.role === 'god') return;
  if (actor.role !== 'admin' || (existing && !canManageMember(actor, existing))) throw new Error('FORBIDDEN');
  if (input.id === 'calendar-owner' || input.role === 'owner') throw new Error('FORBIDDEN');
  // Only the owner can disable or demote an Admin, including self-demotion.
  if (existing?.role === 'admin' && (input.status === 'suspended' || (input.role !== undefined && input.role !== 'admin'))) throw new Error('FORBIDDEN');
  if (input.role !== undefined && !actor.allProperties && (input.allProperties === true ||
    !Array.isArray(input.propertyIds) || input.propertyIds.some(id => !actor.propertyIds.includes(String(id))))) throw new Error('FORBIDDEN');
}
