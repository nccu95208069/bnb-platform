import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { createOwnerSession, validOwnerSession } from "./calendar-owner-session.ts";

export type OwnerCredential = { schema: 1; kind: "bootstrap"; hash: string } | { schema: 1; kind: "password"; salt: string; hash: string; revision: string };
export type StoredCredential = { raw: string; value: OwnerCredential };
export interface OwnerCredentialStore {
  read(): Promise<StoredCredential>;
  consumeAttempt(): Promise<boolean>;
  replace(expected: string, next: OwnerCredential): Promise<boolean>;
}
const hex = (s: unknown, n: number) => typeof s === "string" && new RegExp(`^[a-f0-9]{${n}}$`).test(s);
export function parseCredential(raw: unknown): StoredCredential {
  if (typeof raw !== "string") throw new Error("OWNER_STORE_UNAVAILABLE");
  let value: OwnerCredential;
  try { value = JSON.parse(raw); } catch { throw new Error("OWNER_STORE_UNAVAILABLE"); }
  if (!value || value.schema !== 1 || !(value.kind === "bootstrap" ? hex(value.hash, 64) : value.kind === "password" && hex(value.hash, 128) && hex(value.salt, 32) && hex(value.revision, 64))) throw new Error("OWNER_STORE_UNAVAILABLE");
  return { raw, value };
}
export const credentialBinding = (value: OwnerCredential) => value.kind === "bootstrap" ? value.hash : value.revision;
export function credentialSessionValid(cookie: string | undefined, value: OwnerCredential): boolean {
  if (value.kind === "bootstrap" && value.hash !== process.env.CALENDAR_OWNER_CODE_HASH) return false;
  return validOwnerSession(cookie, Date.now(), credentialBinding(value));
}
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, result) => error ? reject(error) : resolve(result)));
}
export async function credentialMatches(password: unknown, value: OwnerCredential): Promise<boolean> {
  if (typeof password !== "string" || password.length > 128) return false;
  if (value.kind === "bootstrap") return value.hash === process.env.CALENDAR_OWNER_CODE_HASH && /^[A-Za-z0-9_-]{32}$/.test(password) && timingSafeEqual(createHash("sha256").update(password).digest(), Buffer.from(value.hash, "hex"));
  return timingSafeEqual(await derive(password, value.salt), Buffer.from(value.hash, "hex"));
}
export function passwordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) return "新密碼需要 12～128 個字元。";
  if (!password.trim() || /^(.)\1+$/.test(password) || ["password1234", "123456789012"].includes(password.toLowerCase())) return "請使用較不容易猜到的密碼或長句。";
  return null;
}
export async function createPasswordCredential(password: string): Promise<OwnerCredential> {
  if (passwordProblem(password)) throw new Error("PASSWORD_INVALID");
  const salt = randomBytes(16).toString("hex");
  return { schema: 1, kind: "password", salt, hash: (await derive(password, salt)).toString("hex"), revision: randomBytes(32).toString("hex") };
}
export async function changeOwnerPassword(store: OwnerCredentialStore, cookie: string | undefined, input: { currentPassword?: unknown; password?: unknown; confirmPassword?: unknown }) {
  const previous = await store.read();
  if (!credentialSessionValid(cookie, previous.value)) throw new Error("OWNER_UNAUTHORIZED");
  if (!await store.consumeAttempt()) throw new Error("OWNER_RATE_LIMITED");
  if (previous.value.kind === "password" && !await credentialMatches(input.currentPassword, previous.value)) throw new Error("OWNER_CURRENT_PASSWORD");
  const problem = passwordProblem(input.password);
  if (problem) throw new Error(problem);
  if (input.password !== input.confirmPassword) throw new Error("兩次新密碼不一致。");
  const salt = randomBytes(16).toString("hex");
  const next: OwnerCredential = { schema: 1, kind: "password", salt, hash: (await derive(input.password as string, salt)).toString("hex"), revision: randomBytes(32).toString("hex") };
  if (!await store.replace(previous.raw, next)) throw new Error("OWNER_CHANGED_CONCURRENTLY");
  const verified = await store.read();
  if (verified.value.kind !== "password" || verified.value.revision !== next.revision) throw new Error("OWNER_WRITE_UNCERTAIN");
  return createOwnerSession(Date.now(), next.revision);
}
export class RedisOwnerCredentialStore implements OwnerCredentialStore {
  private prefix = process.env.CALENDAR_OWNER_AUTH_NAMESPACE || "sweetfun-os:owner-auth:v1";
  private async command(command: (string | number)[]) {
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    if (!url || !token || new URL(url).protocol !== "https:") throw new Error("OWNER_STORE_UNAVAILABLE");
    const response = await fetch(url, { method: "POST", cache: "no-store", signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(command) });
    if (!response.ok) throw new Error("OWNER_STORE_UNAVAILABLE");
    const body = await response.json();
    if (body.error) throw new Error("OWNER_STORE_UNAVAILABLE");
    return body.result;
  }
  async read() { return parseCredential(await this.command(["GET", `${this.prefix}:credential`])); }
  async consumeAttempt() {
    const count = await this.command(["EVAL", "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],900) end; return n", 1, `${this.prefix}:attempts`]);
    return typeof count === "number" && count <= 20;
  }
  async replace(expected: string, next: OwnerCredential) {
    return await this.command(["EVAL", "if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); return 1", 1, `${this.prefix}:credential`, expected, JSON.stringify(next)]) === 1;
  }
}
