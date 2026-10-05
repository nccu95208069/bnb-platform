import XLSX from "xlsx";
import yauzl from "yauzl";
import type { Field, Mapping, Table } from "./types.ts";
export const MAX_BYTES = 3_000_000,
  MAX_ROWS = 10000,
  MAX_COLS = 64;
export const aliases: Record<Field, string[]> = {
  checkIn: [
    "入住日期",
    "入住日",
    "入住",
    "住宿日期",
    "日期",
    "checkin",
    "arrival",
    "arrivaldate",
    "staydate",
  ],
  checkOut: [
    "退房日期",
    "退房日",
    "退房",
    "checkout",
    "departure",
    "departuredate",
  ],
  booked: [
    "預訂日期",
    "預定日期",
    "下訂日",
    "訂房日期",
    "預訂日",
    "建立日期",
    "bookingdate",
    "bookedon",
    "createddate",
    "reservationdate",
  ],
  room: [
    "房號",
    "房間",
    "房型",
    "房名",
    "room",
    "roomtype",
    "roomnumber",
    "unit",
  ],
  roomCount: ["房數", "間數", "rooms", "roomcount", "numberofrooms"],
  nights: ["晚數", "住宿晚數", "nights", "los"],
  amount: [
    "金額",
    "房費",
    "房價",
    "總額",
    "總金額",
    "訂單金額",
    "每晚房費",
    "總房費",
    "訂金",
    "平台撥款",
    "amount",
    "total",
    "price",
    "rate",
    "payout",
    "revenue",
  ],
  channel: [
    "平台",
    "來源",
    "通路",
    "預訂平台",
    "預定平台",
    "channel",
    "source",
    "platform",
    "ota",
  ],
  status: ["狀態", "訂單狀態", "取消狀態", "status"],
  orderId: [
    "訂單編號",
    "訂單id",
    "預訂編號",
    "bookingid",
    "orderid",
    "reservationid",
  ],
  currency: ["幣別", "貨幣", "currency"],
  property: ["館別", "民宿", "旅宿", "property", "propertyname"],
};
export const norm = (s: string) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s_\-（）()]/g, "");
const pii =
  /姓名|電話|手機|住客|客人|證件|護照|地址|信箱|備註|guest|phone|mobile|email|passport|address|comment|remark|note|contact/i;
export function mapHeaders(headers: string[]): Mapping {
  const m: Mapping = {};
  for (const [field, names] of Object.entries(aliases)) {
    const hits = headers
      .map((h, i) => (names.includes(norm(h)) ? i : -1))
      .filter((i) => i >= 0);
    if (hits.length === 1 && !pii.test(headers[hits[0]]))
      m[field as Field] = hits[0];
  }
  return m;
}
export function maskHeader(h: string) {
  return pii.test(h)
    ? "[個資欄位]"
    : h
        .replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, "[已隱去]")
        .replace(/\+?\d[\d -]{7,}/g, "[已隱去]")
        .slice(0, 60);
}
function cell(v: unknown): string {
  if (v instanceof Date)
    return Number.isFinite(v.getTime()) ? v.toISOString().slice(0, 10) : "";
  if (v === null || v === undefined) return "";
  return String(v).normalize("NFKC").trim().slice(0, 1000);
}
export function tablesFromMatrices(
  sheets: { title: string; matrix: unknown[][] }[],
): Table[] {
  if (!sheets.length || sheets.length > 12) throw Error("HEALTH_SIZE");
  let count = 0;
  return sheets
    .map((sheet, index) => {
      if (
        sheet.matrix.length > MAX_ROWS + 20 ||
        sheet.matrix.some((r) => r.length > MAX_COLS)
      )
        throw Error("HEALTH_SIZE");
      let headerRow = -1,
        best = 1,
        mapping: Mapping = {};
      for (let i = 0; i < Math.min(20, sheet.matrix.length); i++) {
        const candidate = mapHeaders(sheet.matrix[i].map(cell)),
          score = Object.keys(candidate).length;
        if (score > best) {
          best = score;
          headerRow = i;
          mapping = candidate;
        }
      }
      if (headerRow < 0) return null;
      const headers = sheet.matrix[headerRow].map(cell);
      const allowed = new Set(Object.values(mapping));
      const rows = sheet.matrix
        .slice(headerRow + 1)
        .map((r, i) => ({
          row: headerRow + i + 2,
          cells: headers.map((_, j) => (allowed.has(j) ? cell(r[j]) : "")),
        }))
        .filter((r) => r.cells.some(Boolean));
      count += rows.length;
      // Unknown columns never leave the parser. AI receives redacted column headings, not raw values.
      return {
        id: String(index),
        title: sheet.title.slice(0, 100),
        headers: headers.map(maskHeader),
        mapping,
        rows,
        headerRow: headerRow + 1,
      };
    })
    .filter((t): t is Table => t !== null)
    .map((t) => {
      if (count > MAX_ROWS) throw Error("HEALTH_SIZE");
      return t;
    });
}
async function zipGuard(bytes: Buffer) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(Error("HEALTH_FORMAT"));
        return;
      }
      let size = 0,
        entries = 0;
      const fail = () => {
        zip.close();
        reject(Error("HEALTH_SIZE"));
      };
      zip.on("error", () => {
        zip.close();
        reject(Error("HEALTH_FORMAT"));
      });
      zip.on("entry", (entry) => {
        size += entry.uncompressedSize;
        if (
          ++entries > 1500 ||
          size > 16_000_000 ||
          entry.generalPurposeBitFlag & 1 ||
          /vbaProject\.bin$/i.test(entry.fileName)
        ) {
          fail();
          return;
        }
        zip.readEntry();
      });
      zip.on("end", resolve);
      zip.readEntry();
    });
  });
}
export async function parseFile(bytes: Buffer, name: string): Promise<Table[]> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error("HEALTH_SIZE");
  const ext = name.toLowerCase().split(".").pop();
  if (!["csv", "xlsx", "xls"].includes(ext || "")) throw Error("HEALTH_FORMAT");
  if (ext === "xlsx") {
    if (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4b50)
      throw Error("HEALTH_FORMAT");
    await zipGuard(bytes);
  }
  if (
    ext === "xls" &&
    bytes.subarray(0, 8).toString("hex") !== "d0cf11e0a1b11ae1"
  )
    throw Error("HEALTH_FORMAT");
  let wb: XLSX.WorkBook;
  try {
    if (ext === "csv") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("big5", { fatal: true }).decode(bytes);
      }
      wb = XLSX.read(text, { type: "string", raw: true, cellDates: false });
    } else
      wb = XLSX.read(bytes, {
        type: "buffer",
        cellDates: true,
        cellFormula: false,
        cellHTML: false,
        bookVBA: false,
      });
  } catch {
    throw Error("HEALTH_FORMAT");
  }
  if (wb.SheetNames.length > 12) throw Error("HEALTH_SIZE");
  return tablesFromMatrices(
    wb.SheetNames.map((title) => {
      const ws = wb.Sheets[title];
      if (ws["!ref"]) {
        const range = XLSX.utils.decode_range(ws["!ref"]);
        if (range.e.r > MAX_ROWS + 20 || range.e.c >= MAX_COLS)
          throw Error("HEALTH_SIZE");
      }
      const matrix = XLSX.utils.sheet_to_json<unknown[]>(ws, {
        header: 1,
        raw: true,
        defval: "",
        blankrows: true,
      });
      return { title, matrix };
    }),
  );
}
