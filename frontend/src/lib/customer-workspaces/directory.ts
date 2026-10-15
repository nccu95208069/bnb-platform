import type { Account } from './types.ts';
import type { CustomerStore } from './store.ts';
import { loadWorkspace } from './service.ts';
import { propertyReadiness } from './domain.ts';

// Account references are hints, never authorization or current display names.
export async function workspaceDirectory(store: CustomerStore, account: Account) {
  const entries = await Promise.all(account.workspaces.map(async reference => {
    try {
      const { workspace, member } = await loadWorkspace(store, account.id, reference.slug);
      const properties = workspace.properties.filter(p => member.allProperties || member.propertyIds.includes(p.id));
      if (!properties.length) return null;
      return { id: workspace.id, slug: workspace.slug, name: workspace.name,
        properties: properties.map(p => ({ id: p.id, name: p.name,
          calendarState: p.setup?.readyAt && propertyReadiness(workspace, p).complete ? 'ready' as const : 'pending' as const,
          activeBookings: workspace.bookings.filter(b => b.propertyId === p.id && (b.status === 'held' || b.status === 'confirmed')).length })),
        href: `/w/${workspace.slug}/calendar` };
    } catch (error) {
      if (error instanceof Error && error.message === 'NOT_FOUND') return null;
      throw error;
    }
  }));
  return entries.filter(entry => entry !== null);
}
