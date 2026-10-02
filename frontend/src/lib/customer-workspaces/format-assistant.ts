import type { Property } from "./types.ts";
import type { Mapping } from "./sheet-import.ts";
type Column = keyof Mapping["columns"];
const aliases: Record<Column, string[]> = {
  checkIn: [
    "入住",
    "入住日",
    "入住日期",
    "checkin",
    "checkindate",
    "arrival",
    "arrivaldate",
  ],
  checkOut: [
    "退房",
    "退房日",
    "退房日期",
    "checkout",
    "checkoutdate",
    "departure",
    "departuredate",
  ],
  rooms: ["房間", "房號", "房間包棟", "房型", "room", "rooms", "roomnumber"],
  guestName: [
    "姓名",
    "客人",
    "客人姓名",
    "旅客姓名",
    "訂房人",
    "guest",
    "guestname",
    "name",
  ],
  externalId: [
    "訂單編號",
    "訂單號",
    "來源訂單編號",
    "訂房編號",
    "orderid",
    "bookingid",
    "reservationid",
  ],
  total: [
    "房費",
    "總額",
    "訂單總額",
    "房費總額",
    "總房費",
    "住宿費",
    "total",
    "totalamount",
    "amount",
  ],
  received: [
    "旅宿實收",
    "累計旅宿實收",
    "累計實收",
    "已收款",
    "已付",
    "已付實收",
    "實收",
    "旅客已付",
    "received",
    "paid",
    "amountpaid",
  ],
};
const normalize = (value: string) =>
  value.toLowerCase().replace(/[\s_\-/／（）()：:]/g, "");
const columns = Object.keys(aliases) as Column[];
export type FormatSuggestion = {
  headerRow: number;
  columns: Mapping["columns"];
  roomMap: Record<string, string[]>;
  layout: "orders" | "nightly" | "grid" | "unknown";
  messages: string[];
  questions: string[];
};
// Suggestions use only explicit labels and exact room names. No guest cells are
// sent to a model, and guesses never bypass the deterministic import validator.
export function suggestFormat(
  rows: string[][],
  property: Property,
): FormatSuggestion {
  const candidates = rows
    .slice(0, 20)
    .map((row, index) => {
      const matches = Object.fromEntries(
        columns.map((key) => [
          key,
          row.flatMap((cell, i) =>
            aliases[key].includes(normalize(cell)) ? [i] : [],
          ),
        ]),
      ) as Record<Column, number[]>;
      return {
        index,
        matches,
        score: columns.reduce(
          (score, key) =>
            score +
            (matches[key].length === 1
              ? ["checkIn", "checkOut", "rooms"].includes(key)
                ? 3
                : 1
              : 0),
          0,
        ),
      };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const best = candidates[0];
  const proposed = Object.fromEntries(
    columns.map((key) => [
      key,
      best?.matches[key]?.length === 1 ? best.matches[key][0] : -1,
    ]),
  ) as Mapping["columns"];
  const headers = rows[best?.index ?? 0] ?? [];
  const grid =
    proposed.checkIn < 0 &&
    proposed.checkOut < 0 &&
    rows
      .slice(0, 5)
      .some(
        (row) =>
          row.filter((cell) =>
            /^(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}$/.test(cell.trim()),
          ).length >= 3,
      );
  const nightly =
    proposed.checkOut < 0 &&
    headers.some((cell) =>
      ["住宿日期", "住宿日", "日期", "staydate", "night", "date"].includes(
        normalize(cell),
      ),
    );
  const layout = grid
    ? "grid"
    : nightly
      ? "nightly"
      : proposed.checkIn >= 0 && proposed.checkOut >= 0 && proposed.rooms >= 0
        ? "orders"
        : "unknown";
  const roomMap: Record<string, string[]> = {};
  if (proposed.rooms >= 0) {
    const labels = [
      ...new Set(
        rows
          .slice((best?.index ?? 0) + 1)
          .map((row) => (row[proposed.rooms] ?? "").trim())
          .filter(Boolean),
      ),
    ];
    for (const label of labels) {
      const direct = property.rooms.filter(
        (r) => r.name.trim().toLowerCase() === label.toLowerCase(),
      );
      if (direct.length === 1) roomMap[label] = [direct[0].id];
      else if (["包棟", "整棟"].includes(label) && property.kind !== "rooms")
        roomMap[label] = [...property.villaRoomIds];
      else {
        const parts = label
          .split(/[,，、+]/)
          .map((p) => p.trim())
          .filter(Boolean);
        const matched = parts.map((part) =>
          property.rooms.filter(
            (r) => r.name.trim().toLowerCase() === part.toLowerCase(),
          ),
        );
        if (parts.length > 1 && matched.every((result) => result.length === 1))
          roomMap[label] = [...new Set(matched.map((result) => result[0].id))];
      }
    }
  }
  const messages = [
    layout === "orders"
      ? "看起來是含入住、退房與房間的訂單表。請核對下方建議，再確認每列是否代表一筆完整訂單。"
      : layout === "grid"
        ? "看起來是月曆格。日期橫向排列時不能直接當訂單表匯入，請使用人工協助整理副本。"
        : layout === "nightly"
          ? "看起來是一晚一列的表。需要先用訂單編號確認哪些列屬於同一筆訂房，再合併住宿區間及金額。"
          : "目前無法確認表格結構。你可以手動對應欄位，或請專人協助。",
  ];
  for (const key of columns)
    if ((best?.matches[key]?.length ?? 0) > 1)
      messages.push(
        `有多個「${headers[best.matches[key][0]]}」候選欄，已保留未選狀態，請自行確認。`,
      );
  if (best && candidates[1]?.score === best.score && best.score > 0)
    messages.push("表中可能有重複標題或多個區塊，請確認真正的標題列。");
  return {
    headerRow: (best?.index ?? 0) + 1,
    columns: proposed,
    roomMap,
    layout,
    messages,
    questions: [
      "一列是一筆完整訂單，還是一間房、一天住宿或一筆付款？",
      "房費是整筆訂單總額、每晚價格，還是只收取的訂金？",
      "已付金額是旅宿實際收到，還是旅客付給平台？",
    ],
  };
}
