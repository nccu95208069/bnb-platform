import type { CalendarReadEvent } from './calendar-reader';

// Both current health and a bounded failure/recovery history contain only fixed identifiers,
// timing, status codes and correlation IDs. No provider errors or booking data are stored.
export const HEALTH_SCRIPT = `
local events = cjson.decode(ARGV[1])
local alerts = {}
for _, event in ipairs(events) do
  local field = event.property_id .. ':' .. event.phase
  local raw = redis.call('HGET', KEYS[1], field)
  local previous = raw and cjson.decode(raw) or nil
  if not previous or event.started_at > previous.started_at then
    event.consecutive_failures = event.status == 'error' and ((previous and previous.consecutive_failures or 0) + 1) or 0
    local recovery = previous and previous.status == 'error' and event.status == 'ok'
    event.recovered = recovery or false
    redis.call('HSET', KEYS[1], field, cjson.encode(event))
    if event.status == 'error' or recovery then redis.call('LPUSH', KEYS[2], cjson.encode(event)) end
    if event.consecutive_failures == 3 then table.insert(alerts, field) end
  end
end
redis.call('LTRIM', KEYS[2], 0, 199)
redis.call('EXPIRE', KEYS[1], 2592000)
redis.call('EXPIRE', KEYS[2], 2592000)
if #alerts == 0 then return '[]' end
return cjson.encode(alerts)`;

export async function recordCalendarHealth(events: CalendarReadEvent[], requestId: string, startedAt: number) {
  if (!events.length) return;
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token || new URL(url).protocol !== 'https:') return;
    const payload = events.map(event => ({ ...event, request_id: requestId, started_at: startedAt, at: new Date().toISOString() }));
    const response = await fetch(url, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(500),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', HEALTH_SCRIPT, 2, 'sweetfun-os:calendar-health:v1:state', 'sweetfun-os:calendar-health:v1:history', JSON.stringify(payload)]) });
    if (!response.ok) throw Error();
    const body = await response.json();
    if (body.error || typeof body.result !== 'string') throw Error();
    const alerts = JSON.parse(body.result);
    if (Array.isArray(alerts) && alerts.length) console.error(JSON.stringify({ event: 'calendar_consecutive_failure', request_id: requestId, phases: alerts }));
  } catch {
    // Diagnostics must never turn a usable snapshot into a failed request.
    console.warn(JSON.stringify({ event: 'calendar_diagnostics_unavailable', request_id: requestId }));
  }
}
