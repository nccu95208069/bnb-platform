import { randomInt } from 'node:crypto';
import { redisCommand } from '../workspace-auth/store.ts';
import { refreshOwlNest } from '../owlnest-refresh.ts';
import { changePrefix } from './store.ts';

// Persist the chosen minute. Concurrent cron deliveries/restarts cannot create a
// second automated read. Uncertain/failed reads wait for manual action or tomorrow.
export async function dailyObservation(property: string, deps = { command: redisCommand, refresh: (p: string) => refreshOwlNest(undefined, p), now: () => new Date(), minute: () => randomInt(60) }) {
  const now = deps.now(), local = new Date(now.getTime() + 8 * 3600_000);
  if (local.getUTCHours() !== 8) return { status: 'outside_window' };
  const key = `${changePrefix(property)}:daily:${local.toISOString().slice(0, 10)}`;
  const plan = JSON.stringify({ status: 'scheduled', minute: deps.minute() });
  await deps.command(['SET', key, plan, 'NX', 'EX', 7 * 86400]);
  const raw = await deps.command(['GET', key]);
  if (typeof raw !== 'string') throw Error('DAILY_STORAGE_INVALID');
  const current = JSON.parse(raw);
  if (current.status !== 'scheduled' || local.getUTCMinutes() < current.minute) return current;
  const running = JSON.stringify({ ...current, status: 'running', started_at: now.toISOString() });
  const cas = "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2],'EX',604800); return 1";
  if (await deps.command(['EVAL', cas, 1, key, raw, running]) !== 1) return { status: 'already_claimed' };
  let result;
  try { result = { ...current, status: 'verified', result: await deps.refresh(property), completed_at: deps.now().toISOString() }; }
  catch { result = { ...current, status: 'needs_attention', checked_at: deps.now().toISOString(), code: 'DAILY_OBSERVATION_UNCONFIRMED' }; }
  const encoded = JSON.stringify(result);
  if (await deps.command(['EVAL', cas, 1, key, running, encoded]) !== 1 || await deps.command(['GET', key]) !== encoded) throw Error('DAILY_WRITE_UNCONFIRMED');
  return result;
}
