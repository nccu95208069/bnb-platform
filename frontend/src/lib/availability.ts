import { paymentApi } from "./payment-workflow";
export type InventoryState =
  | "available"
  | "sold"
  | "held"
  | "blocked"
  | "maintenance"
  | "unknown"
  | "conflict"
  | "past";
export type Channel = "direct" | "airbnb" | "booking" | "agoda" | "owljourney";
export const channelLabels: Record<Channel, string> = {
  direct: "官網",
  airbnb: "Airbnb",
  booking: "Booking",
  agoda: "Agoda",
  owljourney: "揪你",
};
export const inventoryLabels: Record<InventoryState, string> = {
  available: "可售",
  sold: "已售",
  held: "暫留",
  blocked: "封房",
  maintenance: "維修",
  unknown: "待確認",
  conflict: "訂單衝突",
  past: "已過期",
};
export const policyLabels: Record<string, string> = {
  tiered: "可進調價預演",
  holdout: "對照組・保護中",
  pm_skip: "人工保留價格",
  pre_horizon: "超出 90 天模型範圍",
  price_missing: "待補價格",
  inventory_unavailable: "目前不可售",
  sold: "已有訂單",
  conflict: "訂單衝突",
  minimum_stay: "未達最少住宿晚數",
};
export type NightPrice = {
  current_price: number | null;
  base_price: number | null;
  suggested_price: number | null;
  guest_pay_price: number | null;
  currency: string;
  channel: Channel;
  policy: string;
  eligible: boolean;
  exclusion: string | null;
  baseline_version: string;
  price_version: string;
  plan_version: string;
  limits: string;
  observed_at: string;
  source: string;
  suggestion_source: string;
};
export type RoomNight = {
  date: string;
  room: string;
  state: InventoryState;
  reason: string;
  sellable_units: number | null;
  minimum_nights: number;
  max_guests: number;
  inventory_observed_at: string;
  freshness: string;
  pricing?: NightPrice;
};
export type AvailabilityQuery = {
  start: string;
  end: string;
  rooms: string[];
  channel: Channel;
  demo_cycle: 1 | 2;
};
export type AvailabilityResult = {
  status: string;
  mode: string;
  snapshot_id: string;
  asof: string;
  query: AvailabilityQuery;
  property_id: string;
  rooms: string[];
  cells: RoomNight[];
  counts: Record<InventoryState, number>;
  price_hidden: boolean;
  continuous_windows: { room: string; start: string; end: string }[];
  source_notice: string;
};
export type PriceQuote = {
  room: string;
  status: string;
  total: number | null;
  minimum_nights: number;
  reason: string | null;
  start: string;
  end: string;
  nights: RoomNight[];
  message: string;
  channel: Channel;
};
export type PricingPreview = {
  status: string;
  snapshot_id: string;
  query: AvailabilityQuery;
  proposed: RoomNight[];
  excluded: { date: string; room: string; reason: string }[];
  published: false;
  notice: string;
};
export function priceText(value: number | null | undefined) {
  return value == null ? "待補價" : "$" + value.toLocaleString("zh-TW");
}
export function availabilityError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return (
    (
      {
        availability_version_conflict:
          "房況或價格版本已變更，請更新後重新預演。",
        no_eligible_price_cells: "此範圍沒有可交辦的調價格；請查看排除原因。",
        pricing_permission_denied: "這個角色不能交辦調價。",
        permission_denied: "你沒有查看或操作這個範圍的權限。",
        availability_adapter_not_configured: "尚未接上可用的房況來源。",
        idempotency_conflict: "這筆交辦的內容與原請求不同，請先查看任務中心。",
      } as Record<string, string>
    )[message] ??
    (message || "目前無法完成操作，請稍後重試。")
  );
}
export const availabilityApi = {
  check: (query: AvailabilityQuery) =>
    paymentApi<AvailabilityResult>("/tools/check_availability", query),
  price: (query: AvailabilityQuery & { room: string }) =>
    paymentApi<PriceQuote>("/tools/get_price", query),
  preview: (query: AvailabilityQuery & { expected_snapshot: string }) =>
    paymentApi<PricingPreview>("/tools/preview_pricing", query),
};
