import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  credentialBinding,
  credentialMatches,
  createPasswordCredential,
} from "../owner-password.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import type { Account } from "./types.ts";
import type { CustomerStore } from "./store.ts";
export const CUSTOMER_COOKIE = "bnb_customer_session";
export const SESSION_SECONDS = 7 * 86400;
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const accountKey = (email: string) => `account:${digest(email)}`;
export function enabled() {
  return (
    process.env.CUSTOMER_WORKSPACES_ENABLED === "true" &&
    (process.env.CUSTOMER_SESSION_SECRET?.length ?? 0) >= 32
  );
}
function signature(payload: string, account: Account) {
  if (!enabled()) throw new Error("FEATURE_UNAVAILABLE");
  return createHmac(
    "sha256",
    `${process.env.CUSTOMER_SESSION_SECRET}:customer:${credentialBinding(account.credential)}`,
  )
    .update(payload)
    .digest("base64url");
}
export function sessionFor(account: Account, now = Date.now()) {
  const payload = `${digest(account.email)}.${account.id}.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  return `${payload}.${signature(payload, account)}`;
}
export async function authenticate(
  store: CustomerStore,
  cookie?: string,
  now = Date.now(),
) {
  if (!enabled()) throw new Error("FEATURE_UNAVAILABLE");
  if (!cookie || cookie.length > 250) throw new Error("UNAUTHORIZED");
  const parts = cookie.split(".");
  if (
    parts.length !== 4 ||
    !/^[a-f0-9]{64}$/.test(parts[0]) ||
    !/^[\w-]{36}$/.test(parts[1]) ||
    !/^\d{10}$/.test(parts[2]) ||
    !/^[\w-]{43}$/.test(parts[3])
  )
    throw new Error("UNAUTHORIZED");
  const expiry = Number(parts[2]);
  if (
    expiry <= Math.floor(now / 1000) ||
    expiry > Math.floor(now / 1000) + SESSION_SECONDS
  )
    throw new Error("UNAUTHORIZED");
  const { value } = await store.read<Account>(`account:${parts[0]}`);
  if (
    !value ||
    value.id !== parts[1] ||
    !timingSafeEqual(
      Buffer.from(signature(parts.slice(0, 3).join("."), value)),
      Buffer.from(parts[3]),
    )
  )
    throw new Error("UNAUTHORIZED");
  return value;
}
export async function login(
  store: CustomerStore,
  input: Record<string, unknown>,
) {
  const email = normalizedEmail(input.email);
  if (!validEmail(email)) throw new Error("INVALID_INPUT");
  await store.limit(`identity:${digest(email)}`, 15);
  const key = accountKey(email);
  const previous = await store.read<Account>(key);
  if (input.mode === "register") {
    if (process.env.CUSTOMER_SELF_SIGNUP_PREVIEW !== "true")
      throw new Error("REGISTRATION_CLOSED");
    if (previous.value) throw new Error("ACCOUNT_EXISTS");
    if (
      input.password !== input.confirmPassword ||
      typeof input.password !== "string"
    )
      throw new Error("PASSWORD_INVALID");
    const value: Account = {
      id: randomUUID(),
      email,
      credential: await createPasswordCredential(input.password),
      workspaces: [],
    };
    await store.commit([{ key, before: null, after: value }]);
    const verified = (await store.read<Account>(key)).value;
    if (verified?.id !== value.id) throw new Error("WRITE_UNCONFIRMED");
    return value;
  }
  if (
    !previous.value ||
    !(await credentialMatches(input.password, previous.value.credential))
  )
    throw new Error("UNAUTHORIZED");
  return previous.value;
}
