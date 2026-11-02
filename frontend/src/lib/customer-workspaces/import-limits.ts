// 3,000 data rows plus a header. Bound bytes as well as rows so a sparse or
// unusually wide spreadsheet cannot exhaust a serverless request or response.
export const IMPORT_MAX_ROWS = 3001;
export const IMPORT_MAX_COLUMNS = 52;
export const IMPORT_MAX_CELL_LENGTH = 2000;
export const IMPORT_MAX_JSON_BYTES = 3_000_000;
export const IMPORT_MAX_GOOGLE_BYTES = 4_000_000;

export function importRowsTooLarge(rows: unknown): boolean {
  return !Array.isArray(rows) || rows.length > IMPORT_MAX_ROWS ||
    rows.some((row) => !Array.isArray(row) || row.length > IMPORT_MAX_COLUMNS ||
      row.some((cell) => typeof cell !== "string" || cell.length > IMPORT_MAX_CELL_LENGTH)) ||
    Buffer.byteLength(JSON.stringify(rows), "utf8") > IMPORT_MAX_JSON_BYTES;
}
