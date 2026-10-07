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
    "住宿日期",
    "住宿日",
    "日期",
    "staydate",
    "night",
    "date",
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
    "每晚房價",
    "每晚價格",
    "每晚房費",
    "單晚房費",
    "每房每晚",
    "房晚金額",
    "每列金額",
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
    "累計已付",
    "已付金額",
    "已付訂金",
    "訂金",
  ],
  platform: ["平台", "預訂平台", "訂房平台", "通路", "channel", "platform"],
  bookedAt: ["訂房日期", "預訂日期", "下單日期", "bookingdate", "bookedat"],
  notes: ["備註", "訂單備註", "特殊需求", "notes", "requests"],
  status: ["狀態", "訂單狀態", "訂房狀態", "status", "bookingstatus"],
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
  granularity: Mapping["granularity"];
  amountBasis: Mapping["amountBasis"];
  grid?: Mapping["grid"];
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
    proposed.checkOut < 0 &&
    rows
      .slice(0, 5)
      .some(
        (row) =>
          row.filter((cell) =>
            /^(?:\d{4}[-/])?\d{1,2}[-/]\d{1,2}$/.test(cell.trim()),
          ).length >= 1,
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
      ? "看起來是含入住、退房與房間的表。相同訂單編號的多房、多段日期會合併預覽，不需要改原表。"
      : layout === "grid"
        ? "看起來是日期橫排的房況格。請確認日期包含年份、房間對應，以及每個有內容的格子屬於哪張訂單。"
        : layout === "nightly"
          ? "看起來是一晚一列的表。系統會按來源訂單編號合併多晚、多房，不需要在原表新增退房欄。"
          : "目前無法確認表格結構。你可以手動對應欄位，或請專人協助。",
  ];
  for (const key of columns)
    if ((best?.matches[key]?.length ?? 0) > 1)
      messages.push(
        `有多個「${headers[best.matches[key][0]]}」候選欄，已保留未選狀態，請自行確認。`,
      );
  if (best && candidates[1]?.score === best.score && best.score > 0)
    messages.push("表中可能有重複標題或多個區塊，請確認真正的標題列。");
  const amountHeader = normalize(headers[proposed.total] ?? "");
  const amountBasis: Mapping["amountBasis"] =
    proposed.total < 0
      ? "none"
      : amountHeader === "每房每晚"
        ? "room-night"
        : ["房晚金額", "每列金額"].includes(amountHeader)
          ? "line"
          : ["每晚房價", "每晚價格", "每晚房費", "單晚房費"].includes(
                amountHeader,
              )
            ? "night"
            : [
                  "總額",
                  "訂單總額",
                  "房費總額",
                  "總房費",
                  "total",
                  "totalamount",
                ].includes(amountHeader)
              ? "order"
              : "none";
  const dateColumns = headers.flatMap((header, column) =>
    /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(header.trim()) ? [column] : [],
  );
  const externalIds = rows
    .slice((best?.index ?? 0) + 1)
    .map((row) => (row[proposed.externalId] ?? "").trim())
    .filter(Boolean);
  const repeated = new Set(externalIds).size !== externalIds.length;
  if (layout === "grid" && !dateColumns.length)
    messages.push(
      "目前日期欄沒有完整年份。請先由專人確認日期範圍，不會套用今年或猜測年份。",
    );
  return {
    headerRow: (best?.index ?? 0) + 1,
    columns:
      layout === "grid"
        ? {
            checkIn: -1,
            checkOut: -1,
            rooms: proposed.rooms,
            guestName: -1,
            externalId: -1,
            total: -1,
            received: -1,
            status: -1,
          }
        : proposed,
    roomMap,
    layout,
    messages,
    granularity:
      layout === "grid"
        ? "grid"
        : layout === "nightly"
          ? "night"
          : repeated
            ? "stay"
            : "order",
    amountBasis: layout === "grid" ? "none" : amountBasis,
    ...(layout === "grid"
      ? {
          grid: {
            dateColumns,
            cellMeaning: "guest-name" as const,
            orderIds: {},
          },
        }
      : {}),
    questions:
      proposed.total >= 0 && amountBasis === "none" && layout !== "grid"
        ? ["請在下方指定房費欄記的是整筆訂單總額、每列金額，還是每晚房費。"]
        : [],
  };
}
