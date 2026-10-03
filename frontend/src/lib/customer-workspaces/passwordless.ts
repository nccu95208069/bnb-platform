import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import {
  customerCredentialBinding,
  newPasswordlessCredential,
} from "./identity.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { customerOrigin } from "./site-url.ts";
import type { Account } from "./types.ts";
import type { CustomerStore } from "./store.ts";
import { deliverOnce, type CustomerMail } from "../customer-intake/delivery.ts";
export const LOGIN_PROOF_COOKIE = "bnb_customer_login_proof";
export const LOGIN_SECONDS = 15 * 60;
type LoginLink = {
  id: string;
  email: string;
  proof: string;
  expiresAt: number;
  draftHash?: string;
  accountId: string | null;
  binding: string | null;
  // The request creates an account only for an active calendar preview. Generic
  // login responses never disclose whether the supplied email has an account.
  allowCreate: boolean;
  usedAccountId?: string;
  usedBinding?: string;
};
function secret(link: LoginLink) {
  const key = process.env.CUSTOMER_SESSION_SECRET;
  if (!key || key.length < 32) throw new Error("FEATURE_UNAVAILABLE");
  return createHmac("sha256", key)
    .update(
      `customer-login:v1:${link.id}:${link.email}:${link.proof}:${link.expiresAt}`,
    )
    .digest("base64url");
}
export function loginLinkToken(link: LoginLink) {
  return `${link.id}.${secret(link)}`;
}
export async function requestEmailLogin(
  store: CustomerStore,
  input: {
    email: unknown;
    requestKey: unknown;
    proof?: string;
    draftHash?: string;
  },
  send: CustomerMail,
  preview = false,
) {
  const email = normalizedEmail(input.email);
  if (
    !validEmail(email) ||
    /[\r\n]/.test(email) ||
    typeof input.requestKey !== "string" ||
    !/^[\w-]{36}$/.test(input.requestKey)
  )
    throw new Error("INVALID_INPUT");
  if (!input.proof || !/^[\w-]{43}$/.test(input.proof))
    throw new Error("LOGIN_BROWSER_REQUIRED");
  await store.limit(`magic-email:${digest(email)}`, 5);
  const key = `customer-login:${input.requestKey}`;
  const old = await store.read<LoginLink>(key);
  const current = await store.read<Account>(accountKey(email));
  if (
    old.value &&
    (old.value.email !== email ||
      old.value.proof !== digest(input.proof) ||
      old.value.draftHash !== input.draftHash)
  )
    throw new Error("IDEMPOTENCY_CONFLICT");
  const link: LoginLink = old.value ?? {
    id: input.requestKey,
    email,
    proof: digest(input.proof),
    expiresAt: Date.now() + LOGIN_SECONDS * 1000,
    ...(input.draftHash ? { draftHash: input.draftHash } : {}),
    accountId: current.value?.id ?? null,
    binding: current.value
      ? customerCredentialBinding(current.value.credential)
      : null,
    allowCreate: Boolean(input.draftHash),
  };
  if (link.expiresAt <= Date.now()) throw new Error("LINK_INVALID");
  if (!old.value)
    await store.commit([
      { key, before: null, after: link, ttlSeconds: LOGIN_SECONDS },
    ]);
  // Generic login is intentionally indistinguishable for unknown addresses.
  if (!link.allowCreate && !current.value)
    return { status: "accepted" as const };
  const delivery = await deliverOnce(
    store,
    `magic-delivery:${link.id}`,
    email,
    "旅宿工作區｜你的登入連結",
    `請在剛才操作的同一個瀏覽器，於 15 分鐘內開啟下方連結：\n${customerOrigin()}/signin#${loginLinkToken(link)}\n\n不需要設定密碼。${link.draftHash ? "日曆預覽會保留，登入後仍需由你確認保存。" : "登入後可繼續使用自己的旅宿工作區。"}\n\n如果不是你要求登入，請忽略本信；不要把連結轉交他人。`,
    send,
    preview,
  );
  return { status: delivery.status };
}
export async function consumeEmailLogin(
  store: CustomerStore,
  token: unknown,
  proof: unknown,
  draftHash?: string,
  requestId?: string,
) {
  if (
    typeof token !== "string" ||
    token.length > 100 ||
    typeof proof !== "string" ||
    !/^[\w-]{43}$/.test(proof)
  )
    throw new Error("LOGIN_BROWSER_REQUIRED");
  const [id, mac, ...extra] = token.split(".");
  if (!/^[\w-]{36}$/.test(id) || !/^[\w-]{43}$/.test(mac ?? "") || extra.length)
    throw new Error("LINK_INVALID");
  const key = `customer-login:${id}`,
    saved = await store.read<LoginLink>(key),
    link = saved.value;
  if (
    !link ||
    link.expiresAt <= Date.now() ||
    link.proof !== digest(proof) ||
    (link.draftHash &&
      (link.draftHash !== draftHash || link.id !== requestId)) ||
    !timingSafeEqual(Buffer.from(mac), Buffer.from(secret(link)))
  )
    throw new Error("LINK_INVALID");
  const current = await store.read<Account>(accountKey(link.email));
  if (link.usedAccountId) {
    if (
      current.value?.id !== link.usedAccountId ||
      customerCredentialBinding(current.value.credential) !== link.usedBinding
    )
      throw new Error("LINK_INVALID");
    return { account: current.value, draftHash: link.draftHash };
  }
  if (
    (current.value?.id ?? null) !== link.accountId ||
    (current.value
      ? customerCredentialBinding(current.value.credential)
      : null) !== link.binding ||
    (!current.value && !link.allowCreate)
  )
    throw new Error("LINK_INVALID");
  const account: Account = {
    ...(current.value ?? {
      id: randomUUID(),
      email: link.email,
      workspaces: [],
      credential: newPasswordlessCredential(),
    }),
    ...(!current.value?.emailVerifiedAt
      ? { credential: newPasswordlessCredential() }
      : {}),
    emailVerifiedAt: current.value?.emailVerifiedAt ?? new Date().toISOString(),
  };
  const used = {
    ...link,
    usedAccountId: account.id,
    usedBinding: customerCredentialBinding(account.credential),
  };
  await store.commit([
    { key: accountKey(link.email), before: current.raw, after: account },
    {
      key,
      before: saved.raw,
      after: used,
      ttlSeconds: Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 1000)),
    },
  ]);
  const verified = (await store.read<Account>(accountKey(link.email))).value;
  if (
    !verified ||
    verified.id !== account.id ||
    customerCredentialBinding(verified.credential) !== used.usedBinding
  )
    throw new Error("WRITE_UNCONFIRMED");
  return { account: verified, draftHash: link.draftHash };
}
export const newLoginProof = () => randomBytes(32).toString("base64url");
