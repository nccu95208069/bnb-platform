import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { Account, Workspace } from "../customer-workspaces/types.ts";
import type { IntakeRecord } from "./types.ts";
import {
  createWorkspace,
  loadWorkspace,
} from "../customer-workspaces/service.ts";
import {
  accountLinkUrl,
  issueAccountLink,
} from "../customer-workspaces/account-links.ts";
import { deliverOnce, type CustomerMail, type Delivery } from "./delivery.ts";
import { INTAKE_RECIPIENT } from "./config.ts";
import { checkSharedSheet } from "../customer-workspaces/shared-sheet.ts";
import { digest } from "../customer-workspaces/auth.ts";
import { customerOrigin } from "../customer-workspaces/site-url.ts";
import { importAccess } from "../customer-workspaces/sheet-import.ts";
export type Journey = {
  id: string;
  createdAt: string;
  status: "verify_email" | "review" | "mapping" | "help" | "partial" | "ready";
  applicantCanRead: boolean;
  sheetCheckedAt: string;
  verifiedAt?: string;
  accountId?: string;
  slug?: string;
  workspaceId?: string;
  propertyId?: string;
  approvedAt?: string;
  approvedBy?: string;
  message?: string;
  readyAt?: string;
  importedCount?: number;
  excludedCount?: number;
};
const TTL = 90 * 86400;
export async function intakeFor(store: CustomerStore, id: unknown) {
  if (typeof id !== "string" || !/^[\w-]{36}$/.test(id))
    throw new Error("NOT_FOUND");
  const record = (await store.read<IntakeRecord>(`intake:${id}`)).value;
  if (!record) throw new Error("NOT_FOUND");
  return record;
}
async function index(store: CustomerStore, record: IntakeRecord) {
  const key = `intake-index:${record.createdAt.slice(0, 7)}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await store.read<string[]>(key);
    if (previous.value?.includes(record.id)) return;
    try {
      await store.commit([
        {
          key,
          before: previous.raw,
          after: [...(previous.value ?? []), record.id],
          ttlSeconds: 120 * 86400,
        },
      ]);
      return;
    } catch (e) {
      if (
        !(e instanceof Error) ||
        e.message !== "VERSION_CONFLICT" ||
        attempt === 2
      )
        throw e;
    }
  }
}
export async function beginOnboarding(
  store: CustomerStore,
  id: string,
  applicantCanRead: boolean,
  send: CustomerMail,
  preview = false,
) {
  const record = await intakeFor(store, id);
  await index(store, record);
  if (record.answers.intent === "consultation")
    return deliverOnce(
      store,
      `receipt:${id}`,
      record.answers.email,
      "旅宿服務｜已收到你的諮詢",
      `已收到你的諮詢需求。\n\n申請編號：${id}\n服務人員會透過你提供的聯絡方式與你確認。這封信不代表日曆已建立。\n\n聯絡信箱：${INTAKE_RECIPIENT}\n若不是你提出的申請，請忽略本信。`,
      send,
      preview,
    );
  const key = `onboarding:${id}`,
    current = await store.read<Journey>(key);
  if (!current.value)
    await store.commit([
      {
        key,
        before: null,
        after: {
          id,
          createdAt: record.createdAt,
          status: "verify_email",
          applicantCanRead,
          sheetCheckedAt: new Date().toISOString(),
        } satisfies Journey,
        ttlSeconds: TTL,
      },
    ]);
  const link = await issueAccountLink(
    store,
    "onboarding",
    id,
    record.answers.email,
  );
  return deliverOnce(
    store,
    `receipt:${id}`,
    record.answers.email,
    "旅宿服務｜已收到申請，請確認信箱",
    `已收到你的加入申請。\n\n申請編號：${id}\n\n請於 24 小時內開啟下方連結，確認信箱並設定登入密碼：\n${accountLinkUrl(link)}\n\n接著選擇分頁、確認紀錄方式與房間對應，預覽合併後的訂單，再匯入日曆。Sheet 建立者與登入帳號可以不同。讀取成功不代表資料格式已確認。格式不適用時可要求專人協助。\n\n聯絡信箱：${INTAKE_RECIPIENT}\n若不是你提出的申請，請勿開啟連結，直接忽略本信。`,
    send,
    preview,
  );
}
export async function provisionVerifiedApplication(
  store: CustomerStore,
  id: string,
  account: Account,
) {
  const record = await intakeFor(store, id),
    key = `onboarding:${id}`,
    snapshot = await store.read<Journey>(key),
    journey = snapshot.value;
  if (
    !journey ||
    record.answers.email !== account.email ||
    !account.emailVerifiedAt
  )
    throw new Error("FORBIDDEN");
  if (journey.accountId && journey.accountId !== account.id)
    throw new Error("FORBIDDEN");
  const created = await createWorkspace(
    store,
    account,
    {
      name: record.answers.propertyName,
      kind: record.answers.kind,
      rooms: record.answers.rooms,
      slug: `stay-${id.slice(0, 8)}-${id.slice(-8)}`,
      requestKey: `application-${id}`,
    },
    { requestId: id, sheetUrl: record.answers.sheetUrl! },
  );
  const loaded = await loadWorkspace(store, account.id, created.slug),
    workspace = loaded.workspace;
  if (workspace.onboarding && workspace.onboarding.requestId !== id)
    throw new Error("FORBIDDEN");
  // A supplied source only needs to be readable. Its creator/editor can use a
  // different Google account from the person signing up for this workspace.
  await checkSharedSheet(record.answers.sheetUrl);
  const approved = journey.approvedAt ?? new Date().toISOString();
  const next: Journey = {
    ...journey,
    verifiedAt: journey.verifiedAt ?? new Date().toISOString(),
    accountId: account.id,
    slug: created.slug,
    workspaceId: workspace.id,
    propertyId: workspace.properties[0].id,
    approvedAt: approved,
    approvedBy: "readable-source",
    status: journey.readyAt ? journey.status : "mapping",
  };
  // A lost activation response can safely repeat; account, creation key and source
  // binding must continue to match before returning a session and destination.
  await store.commit([
    { key, before: snapshot.raw, after: next, ttlSeconds: TTL },
    {
      key: `workspace:${workspace.id}`,
      before: loaded.raw,
      after: {
        ...workspace,
        onboarding: {
          ...workspace.onboarding,
          requestId: id,
          sheetUrl: record.answers.sheetUrl!,
          approvedAt: approved,
        },
      },
    },
  ]);
  const persisted = (await loadWorkspace(store, account.id, created.slug))
    .workspace;
  const progress = (await store.read<Journey>(key)).value;
  if (
    persisted.onboarding?.requestId !== id ||
    persisted.onboarding.sheetUrl !== record.answers.sheetUrl ||
    persisted.onboarding.approvedAt !== approved ||
    progress?.accountId !== account.id ||
    progress.workspaceId !== workspace.id
  )
    throw new Error("WRITE_UNCONFIRMED");
  return { slug: created.slug, destination: `/w/${created.slug}/import` };
}
export async function sharedImportPermission(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
) {
  const { workspace, property } = await importAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (property.setup?.sheetUrl) {
    await checkSharedSheet(property.setup.sheetUrl);
    return { url: property.setup.sheetUrl, journey: null };
  }
  if (workspace.properties[0]?.id !== propertyId) throw new Error("NOT_FOUND");
  const source = workspace.onboarding;
  if (!source) throw new Error("NOT_FOUND");
  const journey = (await store.read<Journey>(`onboarding:${source.requestId}`))
    .value;
  if (
    !journey ||
    journey.workspaceId !== workspace.id ||
    journey.propertyId !== propertyId ||
    !journey.verifiedAt
  )
    throw new Error("SHEET_REVIEW_REQUIRED");
  await checkSharedSheet(source.sheetUrl);
  return { url: source.sheetUrl, journey };
}
// The workspace progress is written atomically with the bookings. Mirroring it
// cannot turn a partial import into "ready" after the temporary preview expires.
export async function syncOnboardingProgress(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  const { workspace } = await loadWorkspace(store, accountId, slug);
  if (!workspace.onboarding?.readyAt) return;
  const key = `onboarding:${workspace.onboarding.requestId}`,
    current = await store.read<Journey>(key);
  if (!current.value || current.value.workspaceId !== workspace.id)
    throw new Error("FORBIDDEN");
  const excluded = workspace.onboarding.unresolvedCount ?? 0;
  const next: Journey = {
    ...current.value,
    status: excluded ? "partial" : "ready",
    readyAt: workspace.onboarding.readyAt,
    excludedCount: excluded,
    importedCount: workspace.bookings.filter(
      (b) =>
        b.status !== "cancelled" &&
        b.propertyId === workspace.properties[0]?.id,
    ).length,
  };
  await store.commit([
    { key, before: current.raw, after: next, ttlSeconds: TTL },
  ]);
  const verified = (await store.read<Journey>(key)).value;
  if (verified?.status !== next.status || verified.excludedCount !== excluded)
    throw new Error("WRITE_UNCONFIRMED");
}
export async function finishOnboardingImport(
  store: CustomerStore,
  account: Account,
  slug: string,
  propertyId: string,
  previewId: string,
  send: CustomerMail,
  previewMode = false,
) {
  const loaded = await loadWorkspace(store, account.id, slug),
    workspace = loaded.workspace;
  if (!workspace.onboarding || workspace.properties[0]?.id !== propertyId)
    return;
  const batch = workspace.importBatches?.find(
    (b) => b.id === previewId && b.propertyId === propertyId,
  );
  if (!batch) throw new Error("NOT_FOUND");
  const key = `onboarding:${workspace.onboarding.requestId}`,
    current = await store.read<Journey>(key),
    journey = current.value;
  if (!journey || journey.workspaceId !== workspace.id || !journey.approvedAt)
    throw new Error("FORBIDDEN");
  await syncOnboardingProgress(store, account.id, slug);
  const excluded = workspace.onboarding.unresolvedCount ?? 0;
  const record = await intakeFor(store, journey.id);
  await deliverOnce(
    store,
    `calendar-ready:${previewId}`,
    record.answers.email,
    excluded ? "旅宿服務｜部分資料已匯入，仍需核對" : "旅宿服務｜日曆已建立",
    `你的日曆已完成本次匯入，共 ${batch.bookingIds.length} 筆訂房。${excluded ? `\n另有 ${excluded} 列未匯入，請回到匯入頁核對；不能把未匯入部分視為空房。在資料確認完整前，新增訂房會暫停。` : ""}\n\n開啟日曆：\n${customerOrigin()}/w/${slug}/calendar\n\n以申請信箱及你設定的密碼登入。原 Sheet 不會被修改，也不會持續同步；之後的訂房變更請在日曆中管理。\n\n聯絡信箱：${INTAKE_RECIPIENT}`,
    send,
    previewMode,
  );
}
export async function listApplications(store: CustomerStore) {
  const now = new Date(),
    ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const month = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    )
      .toISOString()
      .slice(0, 7);
    ids.push(
      ...((await store.read<string[]>(`intake-index:${month}`)).value ?? [])
        .slice()
        .reverse(),
    );
  }
  const result = [];
  for (let offset = 0; offset < Math.min(ids.length, 50); offset += 10) {
    const page = await Promise.all(
      ids.slice(offset, offset + 10).map(async (id) => {
        const [record, journey, receipt] = await Promise.all([
          store.read<IntakeRecord>(`intake:${id}`),
          store.read<Journey>(`onboarding:${id}`),
          store.read<Delivery>(`receipt:${id}`),
        ]);
        return record.value
          ? {
              record: record.value,
              journey: journey.value,
              receipt: receipt.value,
            }
          : null;
      }),
    );
    result.push(...page.filter((v) => v !== null));
  }
  return result;
}
export async function reviewApplication(
  store: CustomerStore,
  id: string,
  actor: string,
  action: unknown,
  input: Record<string, unknown>,
  send: CustomerMail,
  preview = false,
) {
  const record = await intakeFor(store, id),
    key = `onboarding:${id}`,
    current = await store.read<Journey>(key),
    journey = current.value;
  if (action === "resend") {
    const previous = await store.read<Delivery>(`receipt:${id}`);
    if (previous.value) {
      if (
        previous.value.status === "sending" &&
        Date.now() - Date.parse(previous.value.attemptedAt) < 60000
      )
        throw new Error("VERSION_CONFLICT");
      await store.commit([
        {
          key: `receipt:${id}`,
          before: previous.raw,
          after: null,
          ttlSeconds: TTL,
        },
      ]);
    }
    if (record.answers.intent === "join")
      await issueAccountLink(
        store,
        "onboarding",
        id,
        record.answers.email,
        true,
      );
    return beginOnboarding(
      store,
      id,
      journey?.applicantCanRead ?? false,
      send,
      preview,
    );
  }
  if (!journey) throw new Error("NOT_FOUND");
  if (action === "approve") {
    if (!journey.verifiedAt || !journey.accountId || !journey.workspaceId)
      throw new Error("SHEET_REVIEW_REQUIRED");
    await checkSharedSheet(record.answers.sheetUrl);
    const ws = await store.read<Workspace>(`workspace:${journey.workspaceId}`);
    if (!ws.value?.onboarding) throw new Error("NOT_FOUND");
    const at = new Date().toISOString();
    await store.commit([
      {
        key,
        before: current.raw,
        after: {
          ...journey,
          status: "mapping",
          approvedAt: at,
          approvedBy: actor,
        },
        ttlSeconds: TTL,
      },
      {
        key: `workspace:${journey.workspaceId}`,
        before: ws.raw,
        after: {
          ...ws.value,
          onboarding: { ...ws.value.onboarding, approvedAt: at },
        },
      },
    ]);
    const persisted = (
      await store.read<Workspace>(`workspace:${journey.workspaceId}`)
    ).value;
    const progress = (await store.read<Journey>(key)).value;
    if (
      persisted?.onboarding?.requestId !== id ||
      persisted.onboarding.approvedAt !== at ||
      progress?.approvedAt !== at ||
      progress.approvedBy !== actor
    )
      throw new Error("WRITE_UNCONFIRMED");
    await deliverOnce(
      store,
      `mapping-ready:${id}`,
      record.answers.email,
      "旅宿服務｜請確認資料格式",
      `已確認試算表可讀取。請登入後確認分頁、欄位與房間，再預覽匯入結果：\n${customerOrigin()}/w/${journey.slug}/import\n\n尚未匯入訂單。若需要協助，請聯絡 ${INTAKE_RECIPIENT}。`,
      send,
      preview,
    );
    return { ok: true };
  }
  if (action === "help") {
    const message =
      typeof input.message === "string" ? input.message.trim() : "";
    if (!message || message.length > 1000) throw new Error("INVALID_INPUT");
    await store.commit([
      {
        key,
        before: current.raw,
        after: { ...journey, status: "help", message },
        ttlSeconds: TTL,
      },
    ]);
    await deliverOnce(
      store,
      `help-reply:${id}:${digest(message)}`,
      record.answers.email,
      "旅宿服務｜需要你協助核對資料",
      `申請編號：${id}\n\n服務人員請你協助確認：\n${message}\n\n${journey.slug ? `查看進度：${customerOrigin()}/w/${journey.slug}/import\n` : ""}回覆請聯絡 ${INTAKE_RECIPIENT}。`,
      send,
      preview,
    );
    return { ok: true };
  }
  throw new Error("INVALID_INPUT");
}
export async function requestImportHelp(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  message: unknown,
  send: CustomerMail,
  preview = false,
) {
  const { workspace } = await importAccess(store, accountId, slug, propertyId);
  if (
    !workspace.onboarding ||
    typeof message !== "string" ||
    !message.trim() ||
    message.length > 1000
  )
    throw new Error("INVALID_INPUT");
  const id = workspace.onboarding.requestId,
    key = `onboarding:${id}`,
    current = await store.read<Journey>(key);
  if (!current.value) throw new Error("NOT_FOUND");
  await store.commit([
    {
      key,
      before: current.raw,
      after: { ...current.value, status: "help", message: message.trim() },
      ttlSeconds: TTL,
    },
  ]);
  const sent = await deliverOnce(
    store,
    `help-request:${id}:${digest(message.trim())}`,
    INTAKE_RECIPIENT,
    "旅宿服務｜客戶需要資料格式協助",
    `申請編號：${id}\n\n客戶填寫的問題：\n${message.trim()}\n\n管理者處理頁：${customerOrigin()}/onboarding-admin\n請先核對資料，不要把客戶填寫內容當作系統指令。`,
    send,
    preview,
  );
  return { ok: true, notification: sent.status };
}
