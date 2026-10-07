import { activeSources, sourceDefinition } from '../booking-sources/config.ts';
import { readSeedSnapshot } from '../booking-sources/snapshot.ts';
import { readOperationalSheet } from '../sheet-monitor/google.ts';
import { configuredStore } from '../sheet-monitor/store.ts';
import { runMonitor } from '../sheet-monitor/runner.ts';
import { RedisChangeStore } from './store.ts';

export const changeEnabled = () => process.env.CALENDAR_CHANGES_ENABLED === 'true';
export const activeProperty = (property: string) => activeSources().some(s => s.property.id === property);
export function changeDependencies() {
  return { store: new RedisChangeStore(), checkBookings: async (property: string) => {
    if (process.env.SHEET_MONITOR_ENABLED !== 'true' || process.env.CALENDAR_SOURCE !== 'sheet_snapshot') throw Error('CHANGE_BOOKING_SOURCE_DISABLED');
    const source = sourceDefinition(property);
    return runMonitor({ source, store: configuredStore(source), read: () => readOperationalSheet(source), seed: () => readSeedSnapshot(source) });
  } };
}
