import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const equal = isDeepStrictEqual;
const digest = (domain, value) => createHash("sha256")
  .update(domain).update("\0").update(value).digest("hex");
const snapshot = (value) => value && typeof value === "object"
  ? JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["history", "audit", "request_hash", "ledger_year"].includes(key)))))
  : null;
const changedFields = (before, after) => [...new Set([
  ...Object.keys(before ?? {}), ...Object.keys(after ?? {})])]
  .filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
const fail = () => { throw Error("OS_WRITER_DELTA_UNVERIFIED"); };

function parsed(raw) {
  try { return typeof raw === "string" ? JSON.parse(raw) : raw; }
  catch { return fail(); }
}

/** Verify one complete OS finance operation between two fixed Redis observations. */
export function verifySweetfunOsFinanceDelta(beforeRaw, afterRaw, property, year) {
  const before = parsed(beforeRaw), after = parsed(afterRaw);
  if (property !== "sweetfun" || !Number.isInteger(year) || year < 2020 || year > 2100 ||
    !Number.isSafeInteger(before?.version) || !Number.isSafeInteger(after?.version) ||
    after.version !== before.version + 1 ||
    !Array.isArray(before?.operations) || !Array.isArray(after?.operations) ||
    after.operations.length !== before.operations.length + 1 ||
    !equal(after.operations.slice(0, -1), before.operations)) fail();
  const operation = after.operations.at(-1), event = operation?.event;
  if (typeof operation?.id !== "string" || !operation.id ||
    before.operations.some((item) => item.id === operation.id) ||
    typeof operation.hash !== "string" || !operation.hash ||
    event?.schema_version !== 1 || event?.completeness !== "complete" ||
    event?.result !== "succeeded" || event?.source !== "finance" ||
    event?.property_id !== property || event?.request_id !== operation.id ||
    event?.id !== operation.id || event?.version_before !== before.version ||
    event?.version_after !== after.version || event?.actor_id !== operation.actor ||
    event?.at !== operation.at || !Number.isFinite(Date.parse(event.at))) fail();

  const target = event.target_type;
  const field = ({ entry: "entries", recurring_expense: "recurring",
    payout_rule: "payout_rules", payment_account: "payment_accounts" })[target];
  const actions = { entry: new Set(["income_created", "expense_created", "income_voided",
    "expense_voided", "expense_updated"]), recurring_expense: new Set([
    "recurring_created", "recurring_stopped"]), payout_rule: new Set([
    "payout_rule_updated"]), payment_account: new Set(["payment_account_created"]) };
  if (!field || !actions[target].has(event.action) ||
    typeof event.target_id !== "string" || !event.target_id ||
    (target !== "payout_rule" && operation.entry_id !== event.target_id) ||
    (target === "payout_rule" && !["ctrip", "owljourney"].includes(event.target_id))) fail();
  for (const other of ["entries", "recurring", "payout_rules", "payment_accounts"]) {
    if (other !== field && !equal(before[other] ?? [], after[other] ?? [])) fail();
  }
  const oldList = before[field] ?? [], newList = after[field] ?? [];
  if (!Array.isArray(oldList) || !Array.isArray(newList)) fail();
  const idOf = (item) => target === "payout_rule" ? item?.platform : item?.id;
  const oldTarget = oldList.filter((item) => idOf(item) === event.target_id);
  const newTarget = newList.filter((item) => idOf(item) === event.target_id);
  if (oldTarget.length > 1 || newTarget.length !== 1 ||
    !equal(oldList.filter((item) => idOf(item) !== event.target_id),
      newList.filter((item) => idOf(item) !== event.target_id))) fail();
  const create = ["income_created", "expense_created", "recurring_created",
    "payment_account_created"].includes(event.action);
  if ((create && oldTarget.length !== 0) ||
    (!create && target !== "payout_rule" && oldTarget.length !== 1) ||
    (create && newList.length !== oldList.length + 1) ||
    (!create && newList.length !== oldList.length + (oldTarget.length ? 0 : 1)) ||
    !equal(event.before, snapshot(oldTarget[0])) ||
    !equal(event.after, snapshot(newTarget[0])) ||
    !equal(event.changed_fields, changedFields(event.before, event.after))) fail();
  return { origin: "os_finance", action: event.action,
    requestHash: digest("sweetfun-os-request-v1", operation.id),
    targetHash: digest("sweetfun-os-target-v1", event.target_id),
    versionBefore: before.version, versionAfter: after.version,
    property, year };
}

const emptyLedger = { version: 0, receipts: [] };

/** Verify the initial receipt and mission CAS as one observed OS operation. */
export function verifySweetfunOsReceiptAppend(beforeRaw, afterRaw, missionRaw,
  property, orderId) {
  const before = beforeRaw == null ? emptyLedger : parsed(beforeRaw);
  const after = parsed(afterRaw), mission = parsed(missionRaw);
  if (property !== "sweetfun" || typeof orderId !== "string" || !orderId ||
    !Number.isSafeInteger(before?.version) || !Number.isSafeInteger(after?.version) ||
    after.version !== before.version + 1 ||
    !Array.isArray(before.receipts) || !Array.isArray(after.receipts) ||
    after.receipts.length !== before.receipts.length + 1 ||
    !equal(after.receipts.slice(0, -1), before.receipts)) fail();
  const receipt = after.receipts.at(-1), audit = receipt?.audit;
  if (typeof receipt?.id !== "string" || !receipt.id ||
    before.receipts.some((item) => item.id === receipt.id ||
      item.request_id === receipt.request_id) ||
    typeof receipt.request_id !== "string" || !receipt.request_id ||
    typeof receipt.request_hash !== "string" || !receipt.request_hash ||
    audit?.schema_version !== 1 || audit?.completeness !== "complete" ||
    audit?.result !== "succeeded" || audit?.source !== "calendar" ||
    audit?.property_id !== property || audit?.request_id !== receipt.request_id ||
    audit?.id !== receipt.request_id || audit?.target_type !== "receipt" ||
    audit?.target_id !== receipt.id || audit?.version_before !== before.version ||
    audit?.version_after !== after.version || audit?.actor_id !== receipt.actor ||
    audit?.at !== receipt.created_at ||
    audit?.action !== (receipt.status_only === true ?
      "calendar_payment_confirmed" : "calendar_payment_recorded") ||
    !Number.isFinite(Date.parse(audit.at)) ||
    mission?.id !== receipt.mission_id || mission?.receipt_id !== receipt.id ||
    mission?.actor !== receipt.actor ||
    !["verification_pending", "completed"].includes(mission.status) ||
    (receipt.sheet_sync ? mission.status !== "verification_pending" :
      mission.status !== "completed")) fail();
  const auditReceipt = { ...receipt };
  delete auditReceipt.sheet_sync;
  if (!equal(audit.before, null) ||
    !equal(audit.after, { ...snapshot(auditReceipt), order_id: orderId }) ||
    !equal(audit.changed_fields, changedFields(null, audit.after)) ||
    (receipt.status_only === true && receipt.amount !== 0)) fail();
  return { origin: "os_receipt", action: audit.action,
    requestHash: digest("sweetfun-os-request-v1", receipt.request_id),
    receiptHash: digest("sweetfun-os-target-v1", receipt.id),
    versionBefore: before.version, versionAfter: after.version,
    sheetPending: Boolean(receipt.sheet_sync), property };
}

/** Verify a pending receipt is completed only after the Sheet sync readback. */
export function verifySweetfunOsSheetSync(beforeRaw, afterRaw, missionRaw,
  property, receiptId) {
  const before = parsed(beforeRaw), after = parsed(afterRaw), mission = parsed(missionRaw);
  if (property !== "sweetfun" || typeof receiptId !== "string" || !receiptId ||
    !Number.isSafeInteger(before?.version) || after?.version !== before.version + 1 ||
    !Array.isArray(before.receipts) || !Array.isArray(after.receipts) ||
    before.receipts.length !== after.receipts.length) fail();
  const oldReceipt = before.receipts.find((item) => item.id === receiptId);
  const newReceipt = after.receipts.find((item) => item.id === receiptId);
  if (!oldReceipt || !newReceipt ||
    !equal(before.receipts.filter((item) => item.id !== receiptId),
      after.receipts.filter((item) => item.id !== receiptId)) ||
    !equal({ ...oldReceipt, sheet_sync: undefined },
      { ...newReceipt, sheet_sync: undefined }) ||
    oldReceipt.sheet_sync?.state !== "pending" ||
    newReceipt.sheet_sync?.state !== "verified" ||
    !Number.isFinite(Date.parse(newReceipt.sheet_sync.verified_at)) ||
    newReceipt.sheet_sync.failure !== undefined ||
    !equal({ ...oldReceipt.sheet_sync, state: undefined,
      verified_at: undefined, failure: undefined },
    { ...newReceipt.sheet_sync, state: undefined,
      verified_at: undefined, failure: undefined }) ||
    mission?.id !== newReceipt.mission_id ||
    mission?.receipt_id !== receiptId || mission?.status !== "completed" ||
    mission?.sheet_write !== true ||
    !Array.isArray(mission.steps) ||
    !mission.steps.includes("verify_main_sheet")) fail();
  return { origin: "os_sheet_sync", action: "verified",
    receiptHash: digest("sweetfun-os-target-v1", receiptId),
    versionBefore: before.version, versionAfter: after.version, property };
}
