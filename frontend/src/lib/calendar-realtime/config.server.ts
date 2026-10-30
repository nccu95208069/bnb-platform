export type CalendarStreamProperty = 'sweetfun' | 'offland';
export type CalendarStreamTarget = { property: CalendarStreamProperty; propertyId: string; topic: string };
export type CalendarStreamConfig = { url: string; key: string; targets: CalendarStreamTarget[] };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOPIC = /^calendar:[a-f0-9]{64}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function streamProperties(raw: string | null): CalendarStreamProperty[] {
  if (!raw || raw.length > 40) throw Error('INVALID_PROPERTIES');
  const values = raw.split(',');
  if (values.length > 2 || new Set(values).size !== values.length ||
      values.some(value => value !== 'sweetfun' && value !== 'offland')) throw Error('INVALID_PROPERTIES');
  return values.sort() as CalendarStreamProperty[];
}

// This server-only capability grants receipt of non-personal invalidation signals.
// It is never an Iron Gate data credential or part of the browser response.
export function calendarStreamConfig(properties: CalendarStreamProperty[],
  env: NodeJS.ProcessEnv = process.env): CalendarStreamConfig {
  try {
    const value: unknown = JSON.parse(env.CALENDAR_REALTIME_CONFIG ?? 'null');
    if (!object(value) || !object(value.properties) || typeof value.url !== 'string' ||
        typeof value.key !== 'string' || value.key.length < 30 || value.key.length > 4096) throw Error();
    const url = new URL(value.url);
    if (url.protocol !== 'https:' || !/^[a-z0-9]{20}\.supabase\.co$/.test(url.hostname) ||
        url.pathname !== '/' || url.search || url.hash || url.username || url.password || url.port) throw Error();
    const targets = properties.map(property => {
      const target = (value.properties as Record<string, unknown>)[property];
      const prefix = property === 'sweetfun' ? 'IRON_GATE_SWEETFUN' : 'IRON_GATE_OFFLAND';
      const grant = JSON.parse(env[`${prefix}_CALENDAR_GRANT`] ?? 'null');
      if (env[`${prefix}_CALENDAR_ENABLED`] !== 'true' || !object(target) ||
          typeof target.propertyId !== 'string' || !UUID.test(target.propertyId) ||
          !object(grant) || grant.propertyId !== target.propertyId ||
          typeof target.topic !== 'string' || !TOPIC.test(target.topic)) throw Error();
      return { property, propertyId: target.propertyId, topic: target.topic };
    });
    if (new Set(targets.map(target => target.topic)).size !== targets.length) throw Error();
    return { url: url.origin, key: value.key, targets };
  } catch { throw Error('CALENDAR_STREAM_UNAVAILABLE'); }
}
