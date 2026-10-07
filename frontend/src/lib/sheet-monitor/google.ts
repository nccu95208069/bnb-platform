import { createSign } from "node:crypto";

import { SWEETFUN_SOURCE, type SheetSourceDefinition } from "../booking-sources/config.ts";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
type Credential = { client_email: string; private_key: string };
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

export class SourceReadError extends Error {
  httpStatus: number;
  constructor(code: string, status: number) { super(code); this.httpStatus = status; }
}
const signalFor = (milliseconds: number, signal?: AbortSignal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);

export async function accessToken(source: SheetSourceDefinition, write = false, signal?: AbortSignal): Promise<string> {
  const encoded = process.env[source.credentialEnv];
  if (!encoded) throw new Error("MONITOR_GOOGLE_CONFIG");
  let credential: Credential;
  try { credential = JSON.parse(encoded); } catch { throw new Error("MONITOR_GOOGLE_CONFIG"); }
  if (!credential.client_email || !credential.private_key) throw new Error("MONITOR_GOOGLE_CONFIG");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: credential.client_email, scope: write ? SCOPE.replace('.readonly', '') : SCOPE, aud: TOKEN_URL, iat: now, exp: now + 600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credential.private_key, "base64url");
  const response = await fetch(TOKEN_URL, { method: "POST", signal: signalFor(8_000, signal), cache: "no-store",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }) });
  if (!response.ok) throw new SourceReadError("MONITOR_GOOGLE_AUTH", response.status);
  const result = await response.json();
  if (typeof result.access_token !== "string") throw new Error("MONITOR_GOOGLE_AUTH");
  return result.access_token;
}

// Only this explicitly selected spreadsheet/tab may be read. No client-supplied URLs,
// ranges, credential delegation or Sheet mutations are accepted by the monitor.
export async function readOperationalSheet(source: SheetSourceDefinition = SWEETFUN_SOURCE, signal?: AbortSignal): Promise<unknown[][]> {
  const token = await accessToken(source, false, signal);
  async function get(path: string) {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${source.spreadsheetId}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: signalFor(12_000, signal) });
    if (!response.ok) throw new SourceReadError(response.status === 401 || response.status === 403 ? "MONITOR_GOOGLE_AUTH" : "MONITOR_GOOGLE_READ", response.status);
    return response.json();
  }
  const metadata = await get("?fields=properties(timeZone),sheets(properties(sheetId,title,gridProperties))");
  const sheet = metadata.sheets?.find((s: { properties: { sheetId: number } }) => s.properties.sheetId === source.sheetId)?.properties;
  if (!sheet || sheet.title !== source.sheetTitle || metadata.properties?.timeZone !== "Asia/Taipei") throw new Error("SHEET_IDENTITY_MISMATCH");
  const rowCount = sheet.gridProperties.rowCount;
  const lastColumn = source.lastColumn ?? "L";
  if (!Number.isInteger(rowCount) || rowCount < 2 || rowCount > 50_000 || sheet.gridProperties.columnCount < (lastColumn === "O" ? 15 : lastColumn === "N" ? 14 : 12)) throw new Error("SHEET_GRID_UNSUPPORTED");
  // One complete bounded read, including the J identity/date index for moved/deleted
  // rows. Do not truncate by a guessed last row or assume the Sheet is date-sorted.
  const range = encodeURIComponent(`'${source.sheetTitle.replaceAll("'", "''")}'!A1:${lastColumn}${rowCount}`);
  const values = await get(`/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  if (!Array.isArray(values.values) || values.majorDimension !== "ROWS") throw new Error("SHEET_INCOMPLETE_READ");
  return values.values;
}
