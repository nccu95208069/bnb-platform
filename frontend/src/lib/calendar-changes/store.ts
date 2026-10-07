import type { PricingDecision } from '../pricing-decision';
import type { Channel } from '../availability';
import { randomUUID } from 'node:crypto';
import { redisCommand } from '../workspace-auth/store.ts';
import { pricingProperty } from '../property-pricing.ts';
import { type CalendarChange, digest, eventDigest } from './contract.ts';
import { encode, decode } from './merge.ts';

export type ChangeStatus = 'queued' | 'awaiting_source' | 'applied' | 'superseded' | 'partially_applied' | 'failed';
export type ChangeReceipt = {
  decision_readback?: {
    digest: string;
    cells: { date: string; room: string; channel: Channel; decision: PricingDecision | null; matches: boolean }[];
  };
  schema: 1;
  event_id: string;
  client_id: string;
  property_id: string;
  source_version: string;
  status: ChangeStatus;
  verified: boolean;
  received_at: string;
  checked_at: string | null;
  completed_at: string | null;
  attempts: number;
  next_check_at: string | null;
  booking_version: string | null;
  price_version: string | null;
  inventory_version: string | null;
  error_code: string | null;
  applied_values: number;
  superseded_values: number;
};
export type StoredChange = { digest: string; event: CalendarChange; receipt: ChangeReceipt };
export type LoadedChange = { key: string; raw: string; value: StoredChange };
export type Mutation = { before: string | null; after: string | null };
export interface ChangeStore {
  enqueue(client: string, event: CalendarChange, now: string): Promise<LoadedChange>;
  read(property: string, client: string, eventId: string): Promise<LoadedChange | null>;
  acquire(property: string): Promise<string | null>;
  release(property: string, owner: string): Promise<void>;
  pending(property: string, now: string, limit: number): Promise<LoadedChange[]>;
  rawPrice(property: string): Promise<string | null>;
  rawInventory(property: string): Promise<string | null>;
  commit(loaded: LoadedChange, owner: string, receipt: ChangeReceipt, prices?: Mutation, inventory?: Mutation): Promise<boolean>;
  revision(property: string): Promise<string>;
}
export const changePrefix = (property: string) => {
  pricingProperty(property);
  return `${process.env.CALENDAR_CHANGE_NAMESPACE || 'sweetfun-os:calendar-changes:v1'}:${property}`;
};
export const inventoryKey = (property: string) => `${changePrefix(property)}:inventory`;
export const receiptKey = (property: string, client: string, eventId: string) => `${changePrefix(property)}:event:${digest(client + ':' + eventId)}`;
export const ENQUEUE_SCRIPT = `
local prior=redis.call('GET',KEYS[1]); if prior then return prior end
if redis.call('ZCARD',KEYS[2])>=100 then return 'FULL' end
local calls=redis.call('INCR',KEYS[3]); if calls==1 then redis.call('EXPIRE',KEYS[3],60) end
if calls>60 then return 'FULL' end
redis.call('SET',KEYS[1],ARGV[1]); redis.call('ZADD',KEYS[2],ARGV[2],KEYS[1]); return ARGV[1]`;
export const COMMIT_CHANGE_SCRIPT = `
if redis.call('GET',KEYS[1])~=ARGV[1] or redis.call('GET',KEYS[2])~=ARGV[2] then return 0 end
if ARGV[5]=='1' and (redis.call('GET',KEYS[4]) or '')~=ARGV[6] then return 0 end
if ARGV[8]=='1' and (redis.call('GET',KEYS[6]) or '')~=ARGV[9] then return 0 end
if ARGV[5]=='1' and ARGV[7]~='' then if ARGV[6]~='' then redis.call('SET',KEYS[5],ARGV[6]) end; redis.call('SET',KEYS[4],ARGV[7]) end
if ARGV[8]=='1' and ARGV[10]~='' then if ARGV[9]~='' then redis.call('SET',KEYS[7],ARGV[9]) end; redis.call('SET',KEYS[6],ARGV[10]) end
redis.call('SET',KEYS[2],ARGV[3])
if ARGV[4]=='done' then
  redis.call('ZREM',KEYS[3],KEYS[2]); redis.call('EXPIRE',KEYS[2],2592000)
  redis.call('INCR',KEYS[8])
else redis.call('ZADD',KEYS[3],ARGV[4],KEYS[2]) end
return 1`;
export class RedisChangeStore implements ChangeStore {
  private command: typeof redisCommand;
  constructor(command = redisCommand) { this.command = command; }
  private loaded(key: string, raw: unknown): LoadedChange | null {
    if (raw === null) return null;
    if (typeof raw !== 'string') throw Error('CHANGE_STORAGE_INVALID');
    const value = decode(raw) as StoredChange;
    if (!value.event || !value.receipt || !value.digest || value.receipt.event_id !== value.event.event_id || value.receipt.property_id !== value.event.property_id) throw Error('CHANGE_STORAGE_INVALID');
    return { key, raw, value };
  }
  async enqueue(client: string, event: CalendarChange, now: string) {
    const key = receiptKey(event.property_id, client, event.event_id);
    const receipt: ChangeReceipt = { schema: 1, event_id: event.event_id, client_id: client, property_id: event.property_id, source_version: event.source_version,
      status: 'queued', verified: false, received_at: now, checked_at: null, completed_at: null, attempts: 0, next_check_at: now,
      booking_version: null, price_version: null, inventory_version: null, error_code: null, applied_values: 0, superseded_values: 0 };
    const value: StoredChange = { digest: eventDigest(event), event, receipt };
    const raw = await this.command(['EVAL', ENQUEUE_SCRIPT, 3, key, `${changePrefix(event.property_id)}:pending`, `${changePrefix(event.property_id)}:rate:${digest(client)}`, encode(value), Date.parse(now)]);
    if (raw === 'FULL') throw Error('CHANGE_QUEUE_FULL');
    const saved = this.loaded(key, raw);
    if (!saved || saved.value.digest !== value.digest) throw Error('CHANGE_ID_REUSED');
    // The first accepted body is immutable. Retries must use its exact semantic content.
    return saved;
  }
  async read(property: string, client: string, eventId: string) {
    const key = receiptKey(property, client, eventId);
    return this.loaded(key, await this.command(['GET', key]));
  }
  async acquire(property: string) {
    const owner = randomUUID();
    return await this.command(['SET', `${changePrefix(property)}:lock`, owner, 'NX', 'EX', 120]) === 'OK' ? owner : null;
  }
  async release(property: string, owner: string) {
    await this.command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end; return 0", 1, `${changePrefix(property)}:lock`, owner]);
  }
  async pending(property: string, now: string, limit: number) {
    const keys = await this.command(['ZRANGEBYSCORE', `${changePrefix(property)}:pending`, '-inf', Date.parse(now), 'LIMIT', 0, limit]);
    if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string' || !k.startsWith(`${changePrefix(property)}:event:`))) throw Error('CHANGE_STORAGE_INVALID');
    const found: LoadedChange[] = [];
    for (const key of keys) {
      const value = this.loaded(key, await this.command(['GET', key]));
      if (value) found.push(value);
      else await this.command(['ZREM', `${changePrefix(property)}:pending`, key]);
    }
    return found;
  }
  async rawPrice(property: string) { return await this.command(['GET', pricingProperty(property).key]) as string | null; }
  async rawInventory(property: string) { return await this.command(['GET', inventoryKey(property)]) as string | null; }
  async revision(property: string) { return String(await this.command(['GET', `${changePrefix(property)}:revision`]) ?? '0'); }
  async commit(loaded: LoadedChange, owner: string, receipt: ChangeReceipt, prices?: Mutation, inventory?: Mutation) {
    const property = loaded.value.event.property_id, prefix = changePrefix(property), price = pricingProperty(property).key;
    const raw = encode({ ...loaded.value, receipt });
    const done = !['queued', 'awaiting_source'].includes(receipt.status);
    const result = await this.command(['EVAL', COMMIT_CHANGE_SCRIPT, 8, `${prefix}:lock`, loaded.key, `${prefix}:pending`, price, `${price}:previous`, inventoryKey(property), `${inventoryKey(property)}:previous`, `${prefix}:revision`,
      owner, loaded.raw, raw, done ? 'done' : Date.parse(receipt.next_check_at!), prices ? '1' : '0', prices?.before ?? '', prices?.after ?? '', inventory ? '1' : '0', inventory?.before ?? '', inventory?.after ?? '']);
    if (result !== 1) return false;
    const confirmed = await this.command(['GET', loaded.key]);
    if (confirmed !== raw) throw Error('CHANGE_WRITE_UNCONFIRMED');
    if (prices?.after && await this.rawPrice(property) !== prices.after) throw Error('CHANGE_WRITE_UNCONFIRMED');
    if (inventory?.after && await this.rawInventory(property) !== inventory.after) throw Error('CHANGE_WRITE_UNCONFIRMED');
    return true;
  }
}
