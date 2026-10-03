import { digest } from "../customer-workspaces/auth.ts";
import { textValue } from "../customer-workspaces/service.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { INTAKE_RECIPIENT } from "./config.ts";
import type { IntakeAnswers, IntakeRecord, IntakeResult } from "./types.ts";
import {
  CALENDAR_KINDS,
  CALENDAR_LABELS,
  isCalendarKind,
} from "../customer-workspaces/calendar-types.ts";
export type Notify = (message: {
  to: typeof INTAKE_RECIPIENT;
  subject: string;
  text: string;
}) => Promise<string>;
const REQUEST_TTL = 90 * 86400;
function line(value: unknown, max: number, required = false) {
  const text = textValue(value, max, required);
  if (text && /[\r\n]/.test(text)) throw new Error("INVALID_INPUT");
  return text;
}
export function sheetLink(value: unknown) {
  const text = textValue(value, 500);
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("SHEET_LINK_INVALID");
  }
  const match = /^\/spreadsheets\/d\/([\w-]{20,150})(?:\/|$)/.exec(
    url.pathname,
  );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "docs.google.com" ||
    url.username ||
    url.password ||
    url.port ||
    !match
  )
    throw new Error("SHEET_LINK_INVALID");
  // Remove incidental sharing tokens, tracking and fragment data from the request.
  return `https://docs.google.com/spreadsheets/d/${match[1]}/edit`;
}
export function intakeAnswers(input: Record<string, unknown>): IntakeAnswers {
  if (
    !["join", "consultation"].includes(input.intent as string) ||
    !["sheet", "other", "unknown", ...CALENDAR_KINDS].includes(
      input.source as string,
    ) ||
    input.consent !== true ||
    (input.website != null && input.website !== "")
  )
    throw new Error("INVALID_INPUT");
  const kind = input.kind == null || input.kind === "" ? null : input.kind;
  if (kind !== null && !["villa", "rooms", "mixed"].includes(kind as string))
    throw new Error("INVALID_INPUT");
  if (!Array.isArray(input.rooms) || input.rooms.length > 100)
    throw new Error("INVALID_INPUT");
  const rooms = input.rooms.map((r) => line(r, 40, true)!);
  if (new Set(rooms).size !== rooms.length) throw new Error("INVALID_INPUT");
  const email = normalizedEmail(input.email);
  if (!validEmail(email) || /[\r\n]/.test(email))
    throw new Error("INVALID_INPUT");
  const providedLink =
    input.source === "sheet" ? textValue(input.sheetUrl, 500) : null;
  let sheetUrl: string | null = null;
  if (providedLink) {
    try {
      sheetUrl = sheetLink(providedLink);
    } catch (error) {
      if (input.intent === "join") throw error;
    }
  }
  const answers: IntakeAnswers = {
    intent: input.intent as IntakeAnswers["intent"],
    propertyName: line(input.propertyName, 80),
    kind: kind as IntakeAnswers["kind"],
    rooms,
    source: input.source as IntakeAnswers["source"],
    sourceDescription:
      input.source === "other" ? textValue(input.sourceDescription, 300) : null,
    sheetUrl,
    providedLink,
    sharingDeclared: input.source === "sheet" && input.sharingDeclared === true,
    contactName: line(input.contactName, 80, true)!,
    email,
    phone: line(input.phone, 60),
    note: textValue(input.note, 2000),
    consent: true,
  };
  if (
    answers.intent === "join" &&
    (!answers.propertyName ||
      !answers.kind ||
      !answers.rooms.length ||
      (!isCalendarKind(answers.source) &&
        (answers.source !== "sheet" ||
          !answers.sheetUrl ||
          !answers.sharingDeclared)))
  )
    throw new Error("JOIN_INCOMPLETE");
  return answers;
}
export function intakeMessage(record: IntakeRecord): Parameters<Notify>[0] {
  const a = record.answers,
    kind =
      a.kind === null
        ? "未填"
        : { villa: "包棟", rooms: "單房", mixed: "包棟與單房" }[a.kind];
  return {
    to: INTAKE_RECIPIENT,
    subject:
      a.intent === "consultation"
        ? "民宿 OS｜新的專人諮詢需求"
        : "民宿 OS｜新的加入申請",
    text: [
      a.intent === "consultation"
        ? "有民宿老闆提出專人諮詢需求。"
        : "有民宿老闆完成問卷，申請加入使用。",
      `申請編號：${record.id}`,
      `送出時間：${record.createdAt}`,
      "",
      `聯絡人：${a.contactName}`,
      `Email：${a.email}`,
      `電話／LINE：${a.phone || "未填"}`,
      "",
      `旅宿名稱：${a.propertyName || "未填"}`,
      `經營型態：${kind}`,
      `房間：${a.rooms.join("、") || "尚未提供"}`,
      `現有資料：${isCalendarKind(a.source) ? CALENDAR_LABELS[a.source] : a.source === "sheet" ? "Google Sheet" : a.source === "other" ? "其他資料" : "尚未確認"}`,
      `其他資料說明：${a.sourceDescription || "未填"}`,
      `Google Sheet：${a.sheetUrl || "未提供有效連結"}`,
      `使用者原始填寫連結（未核對）：${a.providedLink || "未填"}`,
      `分享聲明：${a.sharingDeclared ? "對方勾選已分享；系統尚未核對存取權限" : "尚未聲明分享"}`,
      "",
      `想諮詢的內容：\n${a.note || "未填"}`,
      "",
      "申請已保存，等待人工聯絡與核對；尚未建立或匯入任何正式訂單。",
      "查看申請與寄信狀態：https://sweetfun-os.vercel.app/onboarding-admin （需管理者登入）",
      "以上為使用者填寫內容，請先核對再提供服務。請依上方聯絡方式回覆。",
    ].join("\n"),
  };
}
function result(record: IntakeRecord): IntakeResult {
  return {
    id: record.id,
    saved: true,
    notification:
      record.notification.status === "accepted" ? "accepted" : "pending",
    status: "awaiting_review",
  };
}
export async function submitIntake(
  store: CustomerStore,
  input: Record<string, unknown>,
  notify: Notify,
) {
  if (
    typeof input.requestKey !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestKey,
    )
  )
    throw new Error("INVALID_INPUT");
  const answers = intakeAnswers(input),
    hash = digest(JSON.stringify(answers)),
    key = `intake:${input.requestKey}`;
  let snapshot = await store.read<IntakeRecord>(key);
  if (snapshot.value && snapshot.value.requestHash !== hash)
    throw new Error("IDEMPOTENCY_CONFLICT");
  if (!snapshot.value) {
    const record: IntakeRecord = {
      id: input.requestKey,
      requestHash: hash,
      createdAt: new Date().toISOString(),
      answers,
      status: "awaiting_review",
      sheetAccess: answers.sheetUrl ? "not_checked" : "not_provided",
      notification: { status: "pending" },
    };
    await store.commit([
      { key, before: null, after: record, ttlSeconds: REQUEST_TTL },
    ]);
    snapshot = await store.read<IntakeRecord>(key);
    if (snapshot.value?.requestHash !== hash)
      throw new Error("WRITE_UNCONFIRMED");
  }
  const record = snapshot.value;
  if (!record) throw new Error("WRITE_UNCONFIRMED");
  // Claim before sending. SMTP/Gmail has no durable idempotency key; an uncertain
  // delivery is never automatically sent again on a client retry.
  if (record.notification.status !== "pending") return result(record);
  const claimed: IntakeRecord = {
    ...record,
    notification: { status: "sending", attemptedAt: new Date().toISOString() },
  };
  await store.commit([
    { key, before: snapshot.raw, after: claimed, ttlSeconds: REQUEST_TTL },
  ]);
  const beforeSend = await store.read<IntakeRecord>(key);
  if (
    beforeSend.value?.notification.status !== "sending" ||
    beforeSend.value.requestHash !== hash
  )
    throw new Error("WRITE_UNCONFIRMED");
  let notification: IntakeRecord["notification"];
  try {
    const messageId = await notify(intakeMessage(claimed));
    if (!messageId) throw new Error("MAIL_FAILED");
    notification = { ...claimed.notification, status: "accepted", messageId };
  } catch {
    notification = { ...claimed.notification, status: "needs_attention" };
  }
  const completed = { ...claimed, notification };
  await store.commit([
    { key, before: beforeSend.raw, after: completed, ttlSeconds: REQUEST_TTL },
  ]);
  const verified = (await store.read<IntakeRecord>(key)).value;
  if (
    !verified ||
    verified.requestHash !== hash ||
    verified.notification.status !== notification.status
  )
    throw new Error("WRITE_UNCONFIRMED");
  return result(verified);
}
