import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import {
  createPasswordCredential,
  credentialBinding,
  credentialMatches,
} from "../owner-password.ts";
import type { Account } from "./types.ts";
import type { CustomerStore } from "./store.ts";
export type AccountLink = {
  id: string;
  purpose: "onboarding" | "recovery";
  email: string;
  generation: string;
  expiresAt: number;
  accountId: string | null;
  binding: string | null;
  usedAccountId?: string;
  usedBinding?: string;
};
function secret(link: AccountLink) {
  const key = process.env.CUSTOMER_SESSION_SECRET;
  if (!key || key.length < 32) throw new Error("FEATURE_UNAVAILABLE");
  return createHmac("sha256", key)
    .update(
      `customer-link:v1:${link.purpose}:${link.id}:${link.generation}:${link.email}`,
    )
    .digest("base64url");
}
const linkKey = (purpose: string, id: string) =>
  `account-link:${purpose}:${id}`;
export function accountLinkUrl(link: AccountLink) {
  return `https://sweetfun-os.vercel.app/account-setup#${link.purpose}.${link.id}.${secret(link)}`;
}
export async function issueAccountLink(
  store: CustomerStore,
  purpose: AccountLink["purpose"],
  id: string,
  email: string,
  replace = false,
) {
  const key = linkKey(purpose, id),
    current = await store.read<AccountLink>(key);
  if (current.value && !replace) return current.value;
  const account = (await store.read<Account>(accountKey(email))).value;
  const link: AccountLink = {
    id,
    purpose,
    email,
    generation: randomUUID(),
    expiresAt: Date.now() + 86400000,
    accountId: account?.id ?? null,
    binding: account ? credentialBinding(account.credential) : null,
  };
  await store.commit([
    { key, before: current.raw, after: link, ttlSeconds: 2 * 86400 },
  ]);
  return link;
}
async function checkedLink(store: CustomerStore, value: unknown) {
  if (typeof value !== "string" || value.length > 150)
    throw new Error("LINK_INVALID");
  const [purpose, id, provided, ...extra] = value.split(".");
  if (
    !["onboarding", "recovery"].includes(purpose) ||
    !/^[-\w]{36}$/.test(id) ||
    !/^[\w-]{43}$/.test(provided ?? "") ||
    extra.length
  )
    throw new Error("LINK_INVALID");
  const key = linkKey(purpose, id),
    snapshot = await store.read<AccountLink>(key),
    link = snapshot.value;
  if (
    !link ||
    link.expiresAt < Date.now() ||
    !timingSafeEqual(Buffer.from(secret(link)), Buffer.from(provided))
  )
    throw new Error("LINK_INVALID");
  return { key, snapshot, link };
}
export async function accountLinkInfo(store: CustomerStore, value: unknown) {
  const { link } = await checkedLink(store, value);
  return {
    email: link.email,
    purpose: link.purpose,
    used: Boolean(link.usedAccountId),
  };
}
export async function consumeAccountLink(
  store: CustomerStore,
  value: unknown,
  password: unknown,
  confirmation: unknown,
) {
  const { key, snapshot, link } = await checkedLink(store, value);
  await store.limit(`link:${digest(link.email)}`, 15);
  if (typeof password !== "string" || password !== confirmation)
    throw new Error("PASSWORD_INVALID");
  const current = await store.read<Account>(accountKey(link.email));
  if (link.usedAccountId) {
    // Recover a lost HTTP response only with the password chosen on consumption.
    // The email link alone cannot be reused as a session credential.
    if (
      current.value?.id !== link.usedAccountId ||
      credentialBinding(current.value.credential) !== link.usedBinding ||
      !(await credentialMatches(password, current.value.credential))
    )
      throw new Error("LINK_INVALID");
    return { account: current.value, link };
  }
  if (
    (current.value?.id ?? null) !== link.accountId ||
    (current.value ? credentialBinding(current.value.credential) : null) !==
      link.binding
  )
    throw new Error("LINK_INVALID");
  if (link.purpose === "recovery" && !current.value)
    throw new Error("LINK_INVALID");
  const account: Account = {
    ...(current.value ?? {
      id: randomUUID(),
      email: link.email,
      workspaces: [],
    }),
    credential: await createPasswordCredential(password),
    emailVerifiedAt: new Date().toISOString(),
  };
  const consumed = {
    ...link,
    usedAccountId: account.id,
    usedBinding: credentialBinding(account.credential),
  };
  await store.commit([
    { key: accountKey(link.email), before: current.raw, after: account },
    { key, before: snapshot.raw, after: consumed, ttlSeconds: 2 * 86400 },
  ]);
  const verified = (await store.read<Account>(accountKey(link.email))).value;
  if (
    !verified ||
    verified.id !== account.id ||
    credentialBinding(verified.credential) !== consumed.usedBinding
  )
    throw new Error("WRITE_UNCONFIRMED");
  return { account: verified, link: consumed };
}
