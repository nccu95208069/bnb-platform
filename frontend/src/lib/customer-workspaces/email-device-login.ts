import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import { customerCredentialBinding, newPasswordlessCredential } from "./identity.ts";
import { LOGIN_SECONDS } from "./passwordless.ts";
import { customerReturnPath } from "./return-path.ts";
import { customerOrigin } from "./site-url.ts";
import type { CustomerStore } from "./store.ts";
import type { Account } from "./types.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { deliverOnce, type CustomerMail } from "../customer-intake/delivery.ts";

type DeviceLogin = {
  id: string; email: string; proof: string; expiresAt: number;
  accountId: string | null; binding: string | null; allowCreate: boolean;
  studioClientId?: string; studioOrigin?: string;
  draftHash?: string; websiteConnectionId?: string; returnPath?: string;
  consumerProof?: string; originApproved?: boolean;
  usedAccountId?: string; usedBinding?: string;
  version?: 3; codeSeed?: string;
};
type RequestInput = {
  email: unknown; requestKey: unknown; proof: unknown;
  studio?: { clientId: string; origin: string };
  draftHash?: string; websiteConnectionId?: string; returnPath?: string;
  codeInEmail?: boolean;
};
export type DeviceLoginResult = {
  account: Account; draftHash?: string; websiteConnectionId?: string;
  returnPath: string | null; originalDevice: boolean; requestKey: string;
};
const proofPattern = /^[\w-]{43}$/;
const idPattern = /^[\w-]{36}$/;
const keyFor = (id: string) => `customer-device-login:${id}`;
function mac(link: DeviceLogin, purpose: string) {
  const key = process.env.CUSTOMER_SESSION_SECRET;
  if (!key || key.length < 32) throw Error("FEATURE_UNAVAILABLE");
  return createHmac("sha256", key).update(JSON.stringify([
    `customer-device-login:v${link.version ?? 2}`, purpose, link.id, link.email, link.proof,
    link.expiresAt, link.studioClientId ?? null, link.studioOrigin ?? null,
    link.draftHash ?? null, link.websiteConnectionId ?? null, link.returnPath ?? null,
    ...(link.version === 3 ? [link.codeSeed] : []),
  ])).digest();
}
function pairingCode(link: DeviceLogin) {
  return String(mac(link, "pairing").readUInt32BE(0) % 1000000).padStart(6, "0");
}
function tokenFor(link: DeviceLogin) {
  return `v${link.version ?? 2}.${link.id}.${mac(link, "email").toString("base64url")}`;
}
const latestKey = (link: DeviceLogin) => `customer-email-code-latest:${digest(JSON.stringify([link.email, link.proof, link.studioClientId ?? null]))}`;
async function requireLatest(store: CustomerStore, link: DeviceLogin) {
  if (link.version !== 3) return null;
  const latest = await store.read<string>(latestKey(link));
  if (latest.value !== link.id) throw Error("LINK_INVALID");
  return latest;
}
function validProof(proof: unknown): asserts proof is string {
  if (typeof proof !== "string" || !proofPattern.test(proof)) throw Error("LOGIN_BROWSER_REQUIRED");
}
function scope(link: DeviceLogin, studioClientId?: string) {
  if ((link.studioClientId ?? null) !== (studioClientId ?? null)) throw Error("LINK_INVALID");
}
async function readToken(store: CustomerStore, token: unknown, studioClientId?: string) {
  if (typeof token !== "string" || token.length > 120) throw Error("LINK_INVALID");
  const [version, id, signature, ...extra] = token.split(".");
  if (!["v2", "v3"].includes(version) || !idPattern.test(id ?? "") || !proofPattern.test(signature ?? "") || extra.length) throw Error("LINK_INVALID");
  const saved = await store.read<DeviceLogin>(keyFor(id)), link = saved.value;
  if (!link || link.expiresAt <= Date.now()) throw Error("LINK_INVALID");
  if (version !== `v${link.version ?? 2}`) throw Error("LINK_INVALID");
  const latest = await requireLatest(store, link);
  scope(link, studioClientId);
  if (!timingSafeEqual(Buffer.from(signature), Buffer.from(mac(link, "email").toString("base64url")))) throw Error("LINK_INVALID");
  return { saved, link, latest };
}
async function accountFor(store: CustomerStore, link: DeviceLogin) {
  const current = await store.read<Account>(accountKey(link.email));
  const id = link.usedAccountId ?? link.accountId;
  const binding = link.usedAccountId ? link.usedBinding : link.binding;
  if ((current.value?.id ?? null) !== id ||
      (current.value ? customerCredentialBinding(current.value.credential) : null) !== binding ||
      (!current.value && !link.allowCreate)) throw Error("LINK_INVALID");
  return current;
}
function result(link: DeviceLogin, account: Account, proof: string): DeviceLoginResult {
  return { account, draftHash: link.draftHash, websiteConnectionId: link.websiteConnectionId,
    returnPath: customerReturnPath(link.returnPath ?? null), originalDevice: link.proof === digest(proof), requestKey: link.id };
}

export async function requestDeviceEmailLogin(store: CustomerStore, input: RequestInput, send: CustomerMail, preview = false) {
  const email = normalizedEmail(input.email);
  validProof(input.proof);
  if (!validEmail(email) || /[\r\n]/.test(email) || typeof input.requestKey !== "string" || !idPattern.test(input.requestKey)) throw Error("INVALID_INPUT");
  const returnPath = customerReturnPath(input.returnPath ?? null) ?? undefined;
  if (input.returnPath !== undefined && (!returnPath || input.draftHash || input.websiteConnectionId)) throw Error("INVALID_INPUT");
  if (input.studio && (input.draftHash || input.websiteConnectionId || input.returnPath ||
      !/^[A-Za-z0-9_-]{1,100}$/.test(input.studio.clientId) ||
      new URL(input.studio.origin).protocol !== "https:" || new URL(input.studio.origin).origin !== input.studio.origin)) throw Error("INVALID_INPUT");
  await store.limit(`magic-email:${digest(email)}`, 5);
  const key = keyFor(input.requestKey), old = await store.read<DeviceLogin>(key);
  const current = await store.read<Account>(accountKey(email));
  if (old.value && (old.value.email !== email || old.value.proof !== digest(input.proof) ||
      old.value.studioClientId !== input.studio?.clientId || old.value.studioOrigin !== input.studio?.origin ||
      old.value.draftHash !== input.draftHash || old.value.websiteConnectionId !== input.websiteConnectionId ||
      old.value.returnPath !== returnPath || (old.value.version === 3) !== Boolean(input.codeInEmail))) throw Error("IDEMPOTENCY_CONFLICT");
  const link: DeviceLogin = old.value ?? {
    id: input.requestKey, email, proof: digest(input.proof), expiresAt: Date.now() + LOGIN_SECONDS * 1000,
    accountId: current.value?.id ?? null,
    binding: current.value ? customerCredentialBinding(current.value.credential) : null,
    allowCreate: Boolean(input.studio || input.draftHash || input.websiteConnectionId),
    ...(input.studio ? { studioClientId: input.studio.clientId, studioOrigin: input.studio.origin } : {}),
    ...(input.draftHash ? { draftHash: input.draftHash } : {}),
    ...(input.websiteConnectionId ? { websiteConnectionId: input.websiteConnectionId } : {}),
    ...(returnPath ? { returnPath } : {}),
    ...(input.codeInEmail ? { version: 3 as const, codeSeed: randomUUID() } : {}),
  };
  if (link.expiresAt <= Date.now() || link.usedAccountId) throw Error("LINK_INVALID");
  if (!old.value) {
    const latest = link.version === 3 ? await store.read<string>(latestKey(link)) : null;
    await store.commit([{ key, before: null, after: link, ttlSeconds: LOGIN_SECONDS },
      ...(latest ? [{ key: latestKey(link), before: latest.raw, after: link.id, ttlSeconds: LOGIN_SECONDS }] : [])]);
  }
  await requireLatest(store, link);
  const challenge: { requestKey: string; expiresAt: number; pairingCode?: string; codeRequired?: boolean } =
    { requestKey: link.id, expiresAt: link.expiresAt,
      ...(link.version === 3 ? { codeRequired: true } : { pairingCode: pairingCode(link) }) };
  // Preserve non-enumeration for the existing-customer entry point.
  if (!link.allowCreate && !current.value) return { status: "accepted" as const, ...challenge };
  const delivery = await deliverOnce(store, `device-magic-delivery:${link.id}`, email,
    input.studio ? (link.version === 3 ? "Stayform｜你的登入碼" : "Stayform｜你的建站登入連結") : (link.version === 3 ? "旅宿工作區｜你的登入碼" : "旅宿工作區｜你的登入連結"),
    link.version === 3
      ? `你的登入碼：${pairingCode(link)}\n\n登入信箱：${email}\n請在 15 分鐘內回到剛才的網頁輸入這 6 位數字。\n也可以在電腦或手機開啟下方連結，再輸入同一組登入碼：\n${input.studio ? input.studio.origin + "/auth/verify" : customerOrigin() + "/signin"}#${tokenFor(link)}\n\n若要一起登入原本申請的裝置，請在驗證頁明確選擇「登入兩台裝置」；只有你本人剛才提出申請時才選擇此項。原頁面關閉後，可在有效期限內用原瀏覽器重新開啟登入頁接續。${link.draftHash ? "日曆預覽保留在原裝置，驗證後仍需回去確認保存。" : ""}\n\n登入碼僅限本次申請，使用後即失效；重新寄送會更新登入碼。若不是你要求登入，請忽略本信，勿輸入或轉交登入碼與連結。`
      : `請在 15 分鐘內開啟下方連結，確認登入 ${email}：\n${input.studio ? input.studio.origin + "/auth/verify" : customerOrigin() + "/signin"}#${tokenFor(link)}\n\n可在電腦或手機開啟。若要同時登入原本申請的裝置，請在驗證頁輸入原裝置顯示的 6 位確認碼；也可以只登入開啟連結的裝置。${link.draftHash ? "日曆預覽保留在原裝置，驗證後仍需回去確認保存。" : ""}\n\n如果不是你要求登入，請忽略本信；不要把連結轉交他人。`, send, preview);
  return { status: delivery.status, ...challenge };
}

export async function inspectDeviceEmailLogin(store: CustomerStore, token: unknown, proof: unknown, studioClientId?: string) {
  validProof(proof);
  const { link } = await readToken(store, token, studioClientId);
  await accountFor(store, link);
  const hash = digest(proof), sameDevice = link.proof === hash;
  if (link.usedAccountId && link.consumerProof !== hash && !(sameDevice && link.originApproved)) throw Error("LINK_INVALID");
  return { email: link.email, sameDevice, expiresAt: link.expiresAt, ...(link.version === 3 ? { codeRequired: true } : {}) };
}

export async function consumeDeviceEmailLogin(store: CustomerStore, token: unknown, proof: unknown,
  mode: unknown = "current", code?: unknown, studioClientId?: string,
  validateContext?: (context: { id: string; email: string; draftHash?: string; websiteConnectionId?: string }) => Promise<void>): Promise<DeviceLoginResult> {
  validProof(proof);
  if (mode !== "current" && mode !== "both") throw Error("INVALID_INPUT");
  const { saved, link, latest } = await readToken(store, token, studioClientId);
  const hash = digest(proof), sameDevice = link.proof === hash;
  const current = await accountFor(store, link);
  if (validateContext) await validateContext(link);
  if (link.usedAccountId) {
    if (link.consumerProof !== hash && !(sameDevice && link.originApproved)) throw Error("LINK_INVALID");
    // A replay may recover a lost response, never expand the approved device set.
    if (mode === "both" && !link.originApproved) throw Error("LINK_INVALID");
    return result(link, current.value!, proof);
  }
  if (link.version === 3) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw Error("LOGIN_CODE_REQUIRED");
    await store.limit(`device-login-code:${link.id}`, 5);
    if (!timingSafeEqual(Buffer.from(code), Buffer.from(pairingCode(link)))) throw Error("LOGIN_CODE_INVALID");
  } else if (mode === "both" && !sameDevice) {
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) throw Error("LOGIN_PAIRING_REQUIRED");
    await store.limit(`device-login-code:${link.id}`, 5);
    if (!timingSafeEqual(Buffer.from(code), Buffer.from(pairingCode(link)))) throw Error("LOGIN_PAIRING_INVALID");
  }
  const account: Account = {
    ...(current.value ?? { id: randomUUID(), email: link.email, workspaces: [], credential: newPasswordlessCredential() }),
    ...(!current.value?.emailVerifiedAt ? { credential: newPasswordlessCredential() } : {}),
    emailVerifiedAt: current.value?.emailVerifiedAt ?? new Date().toISOString(),
  };
  const used: DeviceLogin = { ...link, usedAccountId: account.id, usedBinding: customerCredentialBinding(account.credential),
    consumerProof: hash, originApproved: sameDevice || mode === "both" };
  await store.commit([
    ...(latest ? [{ key: latestKey(link), before: latest.raw, after: link.id, ttlSeconds: Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 1000)) }] : []),
    { key: accountKey(link.email), before: current.raw, after: account },
    { key: keyFor(link.id), before: saved.raw, after: used, ttlSeconds: Math.max(1, Math.ceil((link.expiresAt - Date.now()) / 1000)) },
  ]);
  const verified = await accountFor(store, used);
  return result(used, verified.value!, proof);
}

// The six digits authenticate only this request in its original, proof-bound browser.
// A remote browser must use the unguessable email link as well as the code.
export async function consumeDeviceEmailCode(store: CustomerStore, requestKey: unknown, proof: unknown, code: unknown,
  studioClientId?: string,
  validateContext?: (context: { id: string; email: string; draftHash?: string; websiteConnectionId?: string }) => Promise<void>) {
  validProof(proof);
  if (typeof requestKey !== "string" || !idPattern.test(requestKey)) throw Error("LINK_INVALID");
  const link = (await store.read<DeviceLogin>(keyFor(requestKey))).value;
  if (!link || link.version !== 3 || link.proof !== digest(proof)) throw Error("LINK_INVALID");
  scope(link, studioClientId);
  return consumeDeviceEmailLogin(store, tokenFor(link), proof, "current", code, studioClientId, validateContext);
}

export async function pollDeviceEmailLogin(store: CustomerStore, requestKey: unknown, proof: unknown, studioClientId?: string) {
  validProof(proof);
  if (typeof requestKey !== "string" || !idPattern.test(requestKey)) throw Error("LINK_INVALID");
  const link = (await store.read<DeviceLogin>(keyFor(requestKey))).value;
  if (!link || link.expiresAt <= Date.now() || link.proof !== digest(proof)) throw Error("LINK_INVALID");
  await requireLatest(store, link);
  scope(link, studioClientId);
  await store.limit(`device-login-poll:${link.id}`, 200);
  if (!link.usedAccountId) return { status: "pending" as const };
  if (!link.originApproved) return { status: "other_device" as const };
  const current = await accountFor(store, link);
  return { status: "approved" as const, ...result(link, current.value!, proof) };
}
