/** One property/building. Booking formats are confirmed separately. */
export type ReceptionKind = "villa" | "rooms" | "mixed";
export type StayKind = Exclude<ReceptionKind, "mixed">;
export const receptionChoices = [
  { value: "villa", label: "包棟", detail: "整棟一次只接待一組客人" },
  { value: "rooms", label: "散客（分房出租）", detail: "不同房間可接待不同組客人" },
  { value: "mixed", label: "兩者都有", detail: "有時包棟，也接受分房訂房" },
] as const;
export const isReceptionKind = (v: unknown): v is ReceptionKind => v === "villa" || v === "rooms" || v === "mixed";
export function sourceStayKind(value: string): StayKind | null {
  const v = value.trim().toLowerCase().replace(/[ _-]/g, "");
  if (["包棟", "整棟", "全棟", "包棟訂單", "villa", "wholehouse", "entirehome"].includes(v)) return "villa";
  if (["散客", "分房", "單房", "分房出租", "房間", "rooms", "room", "individual"].includes(v)) return "rooms";
  return null;
}
export const nightLabel = (kind?: ReceptionKind | null) => kind === "villa" ? "包棟晚數" : "房晚";
export function analysisCopy(text: string, kind?: ReceptionKind | null): string {
  if (kind !== "villa") return text;
  return text.replaceAll("晚／房次", "晚／組").replaceAll("平均房晚價格", "平均每晚包棟價格").replaceAll("房晚", "包棟晚數")
    .replaceAll("房次", "組入住").replaceAll("房型", "包棟方案").replaceAll("房價", "包棟價格");
}
