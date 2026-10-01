import { redisCommand } from "../workspace-auth/store.ts";
export type Snapshot<T> = { raw: string | null; value: T | null };
export type Change = { key: string; before: string | null; after: unknown };
export interface CustomerStore {
  read<T>(key: string): Promise<Snapshot<T>>;
  commit(changes: Change[]): Promise<void>;
  limit(key: string, max: number): Promise<void>;
}
// A distinct namespace prevents new accounts or customer data reaching legacy stores.
export class RedisCustomerStore implements CustomerStore {
  private prefix =
    process.env.CUSTOMER_WORKSPACE_NAMESPACE || "bnb:customers:v1";
  async read<T>(key: string): Promise<Snapshot<T>> {
    const raw = await redisCommand(["GET", `${this.prefix}:${key}`]);
    if (raw === null) return { raw: null, value: null };
    if (typeof raw !== "string") throw new Error("STORE_UNAVAILABLE");
    return { raw, value: JSON.parse(raw) as T };
  }
  async commit(changes: Change[]) {
    const result = await redisCommand([
      "EVAL",
      `for i=1,#KEYS do if (redis.call('GET',KEYS[i]) or '') ~= ARGV[i*2-1] then return 0 end end
      for i=1,#KEYS do redis.call('SET',KEYS[i],ARGV[i*2]) end return 1`,
      changes.length,
      ...changes.map((c) => `${this.prefix}:${c.key}`),
      ...changes.flatMap((c) => [c.before ?? "", JSON.stringify(c.after)]),
    ]);
    if (result !== 1) throw new Error("VERSION_CONFLICT");
  }
  async limit(key: string, max: number) {
    const count = await redisCommand([
      "EVAL",
      "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n",
      1,
      `${this.prefix}:rate:${key}`,
    ]);
    if (typeof count !== "number" || count > max)
      throw new Error("RATE_LIMITED");
  }
}
