import { activeSources, sourceDefinition } from '../booking-sources/config.ts';
import { readOperationalSheet } from '../sheet-monitor/google.ts';
import { normalizeRows, HEADERS } from '../sheet-monitor/reconcile.ts';
import { adaptSheetBookings } from '../booking-sources/sweetfun-sheet.ts';
import { attachPrivateGuestNames } from '../booking-sources/private-guest-names.ts';
import { loadWorkspace } from '../customer-workspaces/service.ts';
import type { CustomerStore } from '../customer-workspaces/store.ts';
import { legacyArrivals, nativeArrivals, taipeiDay, tomorrow, type ArrivalList } from './domain.ts';

export async function legacyList(propertyId: string, now = new Date(), read = readOperationalSheet): Promise<ArrivalList> {
  if (process.env.CALENDAR_SOURCE !== 'sheet_snapshot' || !activeSources().some(s => s.property.id === propertyId)) throw Error('FORBIDDEN');
  const definition = sourceDefinition(propertyId), values = await read(definition);
  const columns = (values[0] ?? []).map(value => { const name = String(value).trim(); return definition.headerAliases?.[name] ?? name; });
  if (columns.filter(name => name === "備註").length !== 1) throw Error("ARRIVAL_SOURCE_UNCONFIRMED");
  const normalized = normalizeRows(values, definition);
  const snapshot = adaptSheetBookings([HEADERS, ...normalized.map(r => r.cells)], definition.sourceId, now.toISOString(), [], normalized.map(r => r.sourceRow), definition.property);
  // Complete private read, no bundled/cached fallback. Never persist names/notes here.
  const rows = attachPrivateGuestNames(snapshot.bookings, values, definition);
  if (snapshot.issues.some(i => !i.date || [taipeiDay(now), tomorrow(taipeiDay(now))].includes(i.date))) throw Error('ARRIVAL_SOURCE_UNCONFIRMED');
  return { scope: `legacy:${propertyId}`, propertyName: definition.property.name, checkedAt: now.toISOString(), day: taipeiDay(now), arrivals: legacyArrivals(rows, propertyId, taipeiDay(now)) };
}
export async function customerList(store: CustomerStore, accountId: string, slug: string, propertyId: string, now = new Date()): Promise<ArrivalList> {
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  if (!['owner', 'admin'].includes(member.role) || (!member.allProperties && !member.propertyIds.includes(propertyId))) throw Error('FORBIDDEN');
  const property = workspace.properties.find(p => p.id === propertyId);
  if (!property) throw Error('NOT_FOUND');
  if (property.setup && (!property.setup.readyAt || (property.setup.unresolvedCount ?? 0) > 0)) throw Error('ARRIVAL_SOURCE_UNCONFIRMED');
  if (property.setup?.mode === 'calendar' && ((!property.setup.coverageFrom || property.setup.coverageFrom > taipeiDay(now)) || (!property.setup.coverageTo || property.setup.coverageTo <= tomorrow(taipeiDay(now))))) throw Error('ARRIVAL_SOURCE_UNCONFIRMED');
  if (workspace.calendarSources?.some(s => s.propertyId === propertyId && s.mode === 'connected' && (s.error || s.issueCount > 0 || s.pendingCount > 0 || !Number.isFinite(Date.parse(s.lastSuccessfulAt)) || now.getTime() - Date.parse(s.lastSuccessfulAt) > 10 * 60000))) throw Error('ARRIVAL_SOURCE_UNCONFIRMED');
  return { scope: `workspace:${slug}:${propertyId}`, propertyName: property.name, checkedAt: now.toISOString(), day: taipeiDay(now), arrivals: nativeArrivals(workspace.bookings, property, slug, taipeiDay(now)) };
}
