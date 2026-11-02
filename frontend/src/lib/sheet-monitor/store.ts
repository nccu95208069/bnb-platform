import { SWEETFUN_SOURCE, type SheetSourceDefinition } from "../booking-sources/config.ts";
import { randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import type { MonitorState } from "./reconcile.ts";

export interface MonitorStore {
  acquire(): Promise<string | null>;
  read(): Promise<MonitorState | null>;
  commit(owner: string, state: MonitorState): Promise<boolean>;
  release(owner: string): Promise<void>;
}

export const COMMIT_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2])
return 1`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

export class RedisMonitorStore implements MonitorStore {
  private url: string;
  private token: string;
  private prefix: string;
  private source: SheetSourceDefinition;
  constructor(url: string, token: string, source: SheetSourceDefinition = SWEETFUN_SOURCE) {
    if (new URL(url).protocol !== "https:" || !token) throw new Error("MONITOR_STORAGE_CONFIG");
    this.url = url; this.token = token; this.source = source;
    this.prefix = `${source.property.id}:sheet-monitor:v1:${source.sourceId}`;
  }
  private async command(command: (string | number)[]): Promise<unknown> {
    const response = await fetch(this.url, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(8_000),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    if (!response.ok) throw new Error("MONITOR_STORAGE_UNAVAILABLE");
    const body = await response.json();
    if (body.error) throw new Error("MONITOR_STORAGE_UNAVAILABLE");
    return body.result;
  }
  async acquire(): Promise<string | null> {
    const owner = randomUUID();
    return await this.command(["SET", `${this.prefix}:lock`, owner, "NX", "EX", 120]) === "OK" ? owner : null;
  }
  async read(): Promise<MonitorState | null> {
    const value = await this.command(["GET", `${this.prefix}:state`]);
    if (value === null) return null;
    if (typeof value !== "string") throw new Error("MONITOR_STORAGE_INVALID");
    if (!value.startsWith("gz1:")) throw new Error("MONITOR_STORAGE_INVALID");
    const state = JSON.parse(gunzipSync(Buffer.from(value.slice(4), "base64"), { maxOutputLength: 8 * 1024 * 1024 }).toString("utf8")) as MonitorState;
    if (state.schema !== 1 || !state.snapshot?.source?.anonymized || !state.snapshot?.source?.read_only || !Array.isArray(state.audit) || !Array.isArray(state.archived)) throw new Error("MONITOR_STORAGE_INVALID");
    if (state.snapshot.source.id !== this.source.sourceId) throw new Error("MONITOR_SOURCE_MISMATCH");
    return state;
  }
  async commit(owner: string, state: MonitorState): Promise<boolean> {
    if (state.snapshot.source.id !== this.source.sourceId) throw new Error("MONITOR_SOURCE_MISMATCH");
    const json = JSON.stringify(state);
    if (Buffer.byteLength(json) > 8 * 1024 * 1024) throw new Error("MONITOR_STORAGE_SIZE_LIMIT");
    const compressed = `gz1:${gzipSync(json).toString("base64")}`;
    return await this.command(["EVAL", COMMIT_SCRIPT, 2, `${this.prefix}:lock`, `${this.prefix}:state`, owner, compressed]) === 1;
  }
  async release(owner: string): Promise<void> {
    await this.command(["EVAL", RELEASE_SCRIPT, 1, `${this.prefix}:lock`, owner]);
  }
}
export function configuredStore(source: SheetSourceDefinition = SWEETFUN_SOURCE): RedisMonitorStore {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) throw new Error("MONITOR_STORAGE_CONFIG");
  return new RedisMonitorStore(url, token, source);
}
