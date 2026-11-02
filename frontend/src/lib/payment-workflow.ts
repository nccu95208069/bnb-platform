export const PAYMENT_SANDBOX =
  process.env.NEXT_PUBLIC_PAYMENT_SANDBOX === "true";
export const WORKFLOW_BASE = "/api/payment-sandbox/workflow";
export type OrderQuery = {
  order_id?: string;
  room_code?: string;
  stay_date?: string;
  guest_name?: string;
};
export type PaymentInput = {
  amount: number;
  currency: "TWD";
  payment_type: "deposit" | "balance" | "payment";
  payment_method: "bank_transfer" | "cash" | "card";
  received_at: string;
  note: string;
};
export type MissionRequest = {
  goal: string;
  query: OrderQuery;
  payment: PaymentInput;
  idempotency_key: string;
};
export type CheckedOrder = {
  order_id: string;
  guest_name: string;
  room_code: string;
  check_in: string;
  check_out: string;
  version: number;
  total_amount: number;
  paid_amount: number;
  balance_due: number;
};
export type Mission = {
  mission_id: string;
  kind: string;
  goal: string;
  status: string;
  next_tool: string;
  blocked_by: string | null;
  parent_mission_id: string | null;
  order: CheckedOrder | null;
  write_result: Record<string, unknown> | null;
  request: Partial<MissionRequest>;
  result: {
    status?: string;
    reason?: string;
    confirmation_required?: boolean;
    [key: string]: unknown;
  };
  steps?: {
    id: string;
    tool_name: string;
    created_at: string;
    input: Record<string, unknown>;
    output: Record<string, unknown>;
  }[];
};
export const statusLabels: Record<string, string> = {
  queued: "準備繼續",
  waiting_user: "需要你處理",
  waiting_external: "等待來源恢復",
  paused: "需要重新核對",
  blocked: "已暫停・先處理異常",
  completed: "已完成並驗證",
  failed: "需要處理",
  canceled: "已取消",
};
export const toolLabels: Record<string, string> = {
  check_order: "核對訂單",
  update_order: "登記付款",
  verify_order: "驗證結果",
  done: "已完成",
  investigate: "調查異常",
  create_mission: "建立任務",
  confirm_payment: "確認付款",
  resume_mission: "恢復任務",
  open_investigation: "建立調查任務",
  unblock_mission: "解除阻擋",
  cancel_mission: "撤回未登記任務",
  clarify_mission: "補充查詢條件",
};
export const reasonLabels: Record<string, string> = {
  canceled: "此任務已撤回，沒有新增付款。可重新交辦正確內容。",
  incident_unresolved:
    "重新查核仍有異常，尚未解除阻擋。請確認來源修正是否完整。",
  data_integrity_conflict: "同房住宿資料存在衝突，需先完成調查。",
  needs_more_criteria: "有多筆可能的訂單，請補充訂單編號。",
  not_found: "沒有找到符合條件的訂單，請核對查詢內容。",
  validation_error: "付款金額或訂單狀態不符合規則，請核對。",
  version_conflict: "訂單內容已變更，繼續前會重新查核。",
  source_unavailable: "目前無法確認資料來源，請稍後重新核對。",
  verification_pending: "付款已保存，正在等待最後驗證。",
  partial_success: "付款已保存，最後驗證尚未完成，請繼續原任務。",
};
export function money(value: number) {
  return `NT$${value.toLocaleString("zh-TW")}`;
}
export async function paymentApi<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(WORKFLOW_BASE + path, {
    cache: "no-store",
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", "X-Payment-Sandbox": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.detail === "string"
        ? data.detail
        : "請確認輸入內容，金額須為正整數。",
    );
  return data;
}
export function missionOrderId(m: Mission) {
  return m.order?.order_id ?? m.request.query?.order_id;
}
