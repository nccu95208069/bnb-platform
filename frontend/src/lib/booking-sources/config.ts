export type SheetProperty = {
  id: string;
  name: string;
  sourceLabel: string;
  rooms: { number: string; id: string }[];
};
export type SheetSourceDefinition = {
  key: string;
  sourceId: string;
  property: SheetProperty;
  spreadsheetId: string;
  sheetId: number;
  sheetTitle: string;
  snapshotFile: string;
  credentialEnv: string;
  headerAliases?: Record<string, string>;
  roomAliases?: Record<string, string>;
  parentOrderOptional?: boolean;
  lastColumn?: string;
  formattedTwd?: boolean;
};
export const SWEETFUN_SOURCE: SheetSourceDefinition = {
  key: "sweetfun", sourceId: "sweetfun-operations-sheet-v1",
  property: { id: "sweetfun", name: "水芳 Sweetfun", sourceLabel: "Sweetfun 訂房表",
    rooms: ["101", "102", "201", "202", "301", "302"].map(number => ({ number, id: `sweetfun-${number}` })) },
  spreadsheetId: "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc", sheetId: 1097364331,
  sheetTitle: "工作表1", lastColumn: "N", snapshotFile: "source-snapshot.json", credentialEnv: "SHEET_MONITOR_GOOGLE_CREDENTIALS",
};
export const OFFLAND_SOURCE: SheetSourceDefinition = {
  key: "offland", sourceId: "offland-operations-sheet-v1",
  property: { id: "offland", name: "遺忘無際 Offland", sourceLabel: "OFFLAND 訂房表", rooms: [{ number: "包棟", id: "offland-villa" }] },
  spreadsheetId: "1jBJq1xWmM7xKpUxFjsLYQc7EbLAWmcMjQK0SBbaORuc", sheetId: 475170922,
  sheetTitle: "工作表1", snapshotFile: "offland-source-snapshot.json", credentialEnv: "SHEET_MONITOR_GOOGLE_CREDENTIALS",
  // Verified in src/sheets/offland_updater.py: column O stores order_id despite
  // the live header saying 刷卡狀態. It must never become proof of a card payment.
  headerAliases: { "房間": "房型", "用戶名稱": "預定人姓名", "刷卡狀態": "訂單編號" },
  roomAliases: { OFFLAND: "包棟", "OFFLAND(連住)": "包棟" }, lastColumn: "O", formattedTwd: true,
};
// Exact metadata and headers for both sources verified through authorized read-only reads.
const SOURCES: Record<string, SheetSourceDefinition> = { sweetfun: SWEETFUN_SOURCE, offland: OFFLAND_SOURCE };
export function sourceDefinition(key: string): SheetSourceDefinition {
  const source = Object.hasOwn(SOURCES, key) ? SOURCES[key] : undefined;
  if (!source) throw new Error("MONITOR_SOURCE_NOT_CONFIGURED");
  return source;
}
export function activeSources(): SheetSourceDefinition[] {
  const keys = [...new Set((process.env.BOOKING_SHEET_SOURCES || "sweetfun").split(",").map(k => k.trim()).filter(Boolean))];
  return keys.map(sourceDefinition);
}
