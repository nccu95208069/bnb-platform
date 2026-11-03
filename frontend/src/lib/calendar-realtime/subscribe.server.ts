import { createClient } from '@supabase/supabase-js';
import type { CalendarStreamConfig } from './config.server.ts';
import type { StreamCallbacks } from './stream.server.ts';

export function subscribeCalendarChanges(config: CalendarStreamConfig, callbacks: StreamCallbacks): () => void {
  const client = createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    realtime: { timeout: 10_000 },
  });
  let stopped = false;
  const joined = new Set<string>();
  for (const target of config.targets) {
    client.channel(target.topic, { config: { private: true, broadcast: { self: false } } })
      .on('broadcast', { event: 'calendar.changed' }, ({ payload }) => {
        if (!stopped) callbacks.changed(target.property, payload);
      })
      .subscribe(status => {
        if (stopped) return;
        if (status === 'SUBSCRIBED') {
          joined.add(target.property);
          if (joined.size === config.targets.length) callbacks.ready();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          callbacks.failed();
        }
      });
  }
  return () => {
    if (stopped) return;
    stopped = true;
    void client.removeAllChannels().catch(() => {});
    client.realtime.disconnect();
  };
}
