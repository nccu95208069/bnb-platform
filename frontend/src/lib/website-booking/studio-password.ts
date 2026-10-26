import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accountKey, digest, SESSION_SECONDS, sessionFor } from "../customer-workspaces/auth.ts";
import { customerCredentialBinding, customerPasswordMatches } from "../customer-workspaces/identity.ts";
import type { Account } from "../customer-workspaces/types.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import { createPasswordCredential, credentialMatches } from "../owner-password.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { deliverOnce, type CustomerMail } from "../customer-intake/delivery.ts";
import type { WebsiteClient } from "./types.ts";
import { fields, requireEnabled, uuid } from "./config.ts";

const LIFETIME = 900;
const linkKey = (id: string) => `studio-password:link:${id}`;
const jobKey = (id: string) => `studio-password:mail:${id}`;
const queueKey = "studio-password:mail-index:v1";
const latestKey = (clientId: string, email: string) => `studio-password:latest:${digest(JSON.stringify([clientId, email]))}`;
type Link = {
  id: string; clientId: string; origin: string; email: string; purpose: "setup" | "reset";
  proofHash: string; nonce: string; expiresAt: number; returnTo: string;
  accountId: string | null; binding: string | null; eligible: boolean; usedAt?: number;
};
type MailJob = { id: string; linkId: string; kind: "link" | "changed"; email: string; at: number; expiresAt: number; origin: string };
type QueueEntry = { id: string; expiresAt: number };
export type DeferStudioMail = (work: () => Promise<void>) => void;

function emailValue(value: unknown) {
  const email = normalizedEmail(value);
  if (email.length > 254 || !validEmail(email) || /[\r\n]/.test(email)) throw Error("INVALID_INPUT");
  return email;
}
export function studioPasswordReturnPath(value: unknown) {
  if (value === "/auth/link-account") return value;
  if (value === undefined) return "/build/";
  if (typeof value !== "string" || value.length > 2000 || !/^\/(?:build|studio)(?:\/|\?|#|$)/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) throw Error("INVALID_INPUT");
  const url = new URL(value, "https://studio.invalid");
  if (url.origin !== "https://studio.invalid" || !/^\/(?:build|studio)(?:\/|$)/.test(url.pathname)) throw Error("INVALID_INPUT");
  return url.pathname + url.search + url.hash;
}
function signature(link: Link) {
  const key = process.env.CUSTOMER_SESSION_SECRET;
  if (!key || key.length < 32) throw Error("FEATURE_UNAVAILABLE");
  return createHmac("sha256", key).update(JSON.stringify([
    "studio-password:v1", link.id, link.nonce, link.clientId, link.origin,
    link.email, link.purpose, link.expiresAt, link.accountId, link.binding, link.returnTo,
  ])).digest("base64url");
}
const tokenFor = (link: Link) => `sp1.${link.id}.${signature(link)}`;
const queueEntries = (value: QueueEntry[] | null, now = Date.now()) => {
  if (value && (!Array.isArray(value) || value.length > 500 || value.some(row => !row || typeof row.id !== "string" || !Number.isFinite(row.expiresAt)))) throw Error("STORE_UNAVAILABLE");
  return (value ?? []).filter(row => row.expiresAt > now);
};
async function queuePlan(store: CustomerStore, job: MailJob) {
  const queue = await store.read<QueueEntry[]>(queueKey), entries = queueEntries(queue.value);
  if (entries.some(row => row.id === job.id)) throw Error("VERSION_CONFLICT");
  if (entries.length >= 500) throw Error("RATE_LIMITED");
  return [
    { key: jobKey(job.id), before: null, after: job, ttlSeconds: Math.max(1, Math.ceil((job.expiresAt - Date.now()) / 1000)) },
    { key: queueKey, before: queue.raw, after: [...entries, { id: job.id, expiresAt: job.expiresAt }], ttlSeconds: 2 * 86400 },
  ] satisfies Change[];
}
async function removeQueued(store: CustomerStore, id: string) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const queue = await store.read<QueueEntry[]>(queueKey), entries = queueEntries(queue.value);
    try { await store.commit([{ key: queueKey, before: queue.raw, after: entries.filter(row => row.id !== id), ttlSeconds: 2 * 86400 }]); return; }
    catch (error) { if (!(error instanceof Error) || error.message !== "VERSION_CONFLICT" || attempt === 3) throw error; }
  }
}

// Provider work runs after the HTTP response. Known and unknown accounts use
// the same durable request path and response, without a mail-time side channel.
export async function deliverStudioPasswordMail(store: CustomerStore, id: string, send: CustomerMail) {
  const job = (await store.read<MailJob>(jobKey(id))).value;
  if (!job || job.id !== id || job.expiresAt <= Date.now()) { await removeQueued(store, id); return; }
  let subject: string, text: string;
  if (job.kind === "link") {
    const link = (await store.read<Link>(linkKey(job.linkId))).value;
    const current = link ? (await store.read<Account>(accountKey(link.email))).value : null;
    const latest = link ? (await store.read<string>(latestKey(link.clientId, link.email))).value : null;
    if (!link || !link.eligible || link.usedAt || link.expiresAt <= Date.now() || latest !== link.id ||
        (current?.id ?? null) !== link.accountId || (current ? customerCredentialBinding(current.credential) : null) !== link.binding) {
      await removeQueued(store, id); return;
    }
    subject = link.purpose === "setup" ? "STAYFORM｜設定你的登入密碼" : "STAYFORM｜重新設定密碼";
    text = `你剛剛要求${link.purpose === "setup" ? "設定" : "重新設定"} STAYFORM 登入密碼。\n\n請在 15 分鐘內開啟以下連結，自行設定密碼：\n${link.origin}/auth/reset-password#${tokenFor(link)}\n\n本連結只能使用一次。完成後請使用本信箱與新密碼登入；其他裝置需重新登入。\n如果不是你提出申請，請忽略本信，不要轉交連結。`;
  } else {
    subject = "STAYFORM｜登入密碼已變更";
    text = `你的 STAYFORM 登入密碼已於 ${new Date(job.at).toISOString()} 變更。\n其他裝置的舊登入已失效，請以新密碼重新登入。\n${job.origin}/auth/login\n\n若這不是你的操作，請立即使用「忘記密碼」重新設定，並檢查信箱安全。這封信不含密碼。`;
  }
  const result = await deliverOnce(store, `studio-password:delivery:${job.id}`, job.email, subject, text, send);
  // An uncertain provider result must not cause another send of the same job.
  if (result.status !== "accepted") console.warn(JSON.stringify({ event: "studio_password_mail_unconfirmed", kind: job.kind }));
  await removeQueued(store, id);
}
export async function runStudioPasswordMail(store: CustomerStore, send: CustomerMail) {
  const queue = await store.read<QueueEntry[]>(queueKey), entries = queueEntries(queue.value);
  let processed = 0;
  for (const entry of entries.slice(0, 20)) { await deliverStudioPasswordMail(store, entry.id, send); processed++; }
  return { processed };
}
function dispatch(store: CustomerStore, id: string, send: CustomerMail, defer?: DeferStudioMail) {
  const work = async () => {
    try { await deliverStudioPasswordMail(store, id, send); }
    catch { console.warn(JSON.stringify({ event: "studio_password_mail_pending" })); }
  };
  if (defer) { defer(work); return Promise.resolve(); }
  return work();
}

async function requestPassword(store: CustomerStore, client: WebsiteClient, input: Record<string, unknown>, send: CustomerMail, defer?: DeferStudioMail) {
  fields(input, ["action", "origin", "email", "purpose", "requestKey", "proof", "returnTo"]);
  const email = emailValue(input.email), id = uuid(input.requestKey), returnTo = studioPasswordReturnPath(input.returnTo);
  if (input.purpose !== "setup" && input.purpose !== "reset") throw Error("INVALID_INPUT");
  if (typeof input.proof !== "string" || !/^[\w-]{43}$/.test(input.proof)) throw Error("LOGIN_BROWSER_REQUIRED");
  await store.limit(`studio-password:request:${client.id}`, 100);
  await store.limit(`studio-password:email:${digest(email)}`, 5);
  const proofHash = digest(input.proof);
  for (let attempt = 0; attempt < 4; attempt++) {
    const saved = await store.read<Link>(linkKey(id));
    if (saved.value) {
      const old = saved.value;
      if (old.clientId !== client.id || old.origin !== client.editor_origin || old.email !== email || old.purpose !== input.purpose || old.proofHash !== proofHash || old.returnTo !== returnTo) throw Error("IDEMPOTENCY_CONFLICT");
      // Never reveal account eligibility or provider delivery through this reply.
      await dispatch(store, id, send, defer);
      return { status: "accepted", requestKey: id, expiresAt: old.expiresAt };
    }
    const current = (await store.read<Account>(accountKey(email))).value;
    const link: Link = { id, clientId: client.id, origin: client.editor_origin, email, purpose: input.purpose,
      proofHash, nonce: randomUUID(), expiresAt: Date.now() + LIFETIME * 1000, returnTo,
      accountId: current?.id ?? null, binding: current ? customerCredentialBinding(current.credential) : null,
      eligible: input.purpose === "setup" || Boolean(current) };
    const latest = await store.read<string>(latestKey(client.id, email));
    const job: MailJob = { id, linkId: id, kind: "link", email, at: Date.now(), expiresAt: link.expiresAt, origin: client.editor_origin };
    try {
      await store.commit([
        { key: linkKey(id), before: null, after: link, ttlSeconds: LIFETIME },
        { key: latestKey(client.id, email), before: latest.raw, after: id, ttlSeconds: LIFETIME },
        ...await queuePlan(store, job),
      ]);
      await dispatch(store, id, send, defer);
      return { status: "accepted", requestKey: id, expiresAt: link.expiresAt };
    } catch (error) { if (!(error instanceof Error) || error.message !== "VERSION_CONFLICT" || attempt === 3) throw error; }
  }
  throw Error("WRITE_UNCONFIRMED");
}

async function checkedLink(store: CustomerStore, client: WebsiteClient, token: unknown) {
  if (typeof token !== "string" || !/^sp1\.[a-f0-9-]{36}\.[\w-]{43}$/.test(token)) throw Error("PASSWORD_LINK_INVALID");
  const [, id, provided] = token.split("."), saved = await store.read<Link>(linkKey(id)), link = saved.value;
  if (!link || link.usedAt || !link.eligible || link.clientId !== client.id || link.origin !== client.editor_origin || link.expiresAt <= Date.now() ||
      !timingSafeEqual(Buffer.from(provided), Buffer.from(signature(link)))) throw Error("PASSWORD_LINK_INVALID");
  const latest = await store.read<string>(latestKey(client.id, link.email));
  const account = await store.read<Account>(accountKey(link.email));
  if (latest.value !== link.id || (account.value?.id ?? null) !== link.accountId ||
      (account.value ? customerCredentialBinding(account.value.credential) : null) !== link.binding) throw Error("PASSWORD_LINK_INVALID");
  return { saved, link, latest, account };
}

export async function studioPasswordOperation(store: CustomerStore, client: WebsiteClient, input: Record<string, unknown>, send: CustomerMail, defer?: DeferStudioMail) {
  requireEnabled();
  if (!client.allow_new_sites || input.origin !== client.editor_origin) throw Error("FORBIDDEN");
  if (input.action === "password-login") {
    fields(input, ["action", "origin", "email", "password"]);
    const email = emailValue(input.email);
    if (typeof input.password !== "string" || input.password.length > 128) throw Error("STUDIO_LOGIN_INVALID");
    await store.limit(`studio-password:login:${client.id}`, 300);
    await store.limit(`identity:${digest(email)}`, 15);
    const account = (await store.read<Account>(accountKey(email))).value;
    const passwordAccount = account?.credential.kind === "password";
    const matches = passwordAccount ? await customerPasswordMatches(input.password, account.credential) :
      await credentialMatches(input.password, { schema: 1, kind: "password", salt: "0".repeat(32), hash: "0".repeat(128), revision: "0".repeat(64) });
    if (!account || !passwordAccount || !matches || !account.emailVerifiedAt) throw Error("STUDIO_LOGIN_INVALID");
    return { id: account.id, email: account.email, session: sessionFor(account), expiresIn: SESSION_SECONDS };
  }
  if (input.action === "password-request") return requestPassword(store, client, input, send, defer);
  if (input.action === "password-inspect") {
    fields(input, ["action", "origin", "token"]);
    const { link } = await checkedLink(store, client, input.token);
    return { email: link.email, purpose: link.purpose, expiresAt: link.expiresAt, returnTo: link.returnTo };
  }
  if (input.action === "password-reset") {
    fields(input, ["action", "origin", "token", "password", "confirmation"]);
    const first = await checkedLink(store, client, input.token);
    await store.limit(`studio-password:consume:${first.link.id}`, 10);
    if (typeof input.password !== "string" || input.password.length < 15 || input.password.length > 128 || input.password !== input.confirmation) throw Error("STUDIO_PASSWORD_INVALID");
    const credential = await createPasswordCredential(input.password);
    // Re-read after expensive hashing; every authorization read participates in CAS.
    for (let attempt = 0; attempt < 4; attempt++) {
      const { saved, link, latest, account } = await checkedLink(store, client, input.token);
      const next: Account = { ...(account.value ?? { id: randomUUID(), email: link.email, workspaces: [] }), credential,
        emailVerifiedAt: account.value?.emailVerifiedAt ?? new Date().toISOString() };
      const at = Date.now(), notification: MailJob = { id: `${link.id}:changed`, linkId: link.id, kind: "changed", email: link.email, at, expiresAt: at + 86400_000, origin: client.editor_origin };
      try {
        await store.commit([
          { key: accountKey(link.email), before: account.raw, after: next },
          { key: linkKey(link.id), before: saved.raw, after: { ...link, usedAt: at }, ttlSeconds: LIFETIME },
          { key: latestKey(client.id, link.email), before: latest.raw, after: null, ttlSeconds: LIFETIME },
          ...await queuePlan(store, notification),
        ]);
        const verified = (await store.read<Account>(accountKey(link.email))).value;
        if (verified?.id !== next.id || customerCredentialBinding(verified.credential) !== customerCredentialBinding(credential)) throw Error("WRITE_UNCONFIRMED");
        await dispatch(store, notification.id, send, defer);
        // The email link never creates a session. Login must use the new password.
        return { status: "completed", returnTo: link.returnTo };
      } catch (error) { if (!(error instanceof Error) || error.message !== "VERSION_CONFLICT" || attempt === 3) throw error; }
    }
  }
  throw Error("INVALID_INPUT");
}
