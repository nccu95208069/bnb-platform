import { createSign } from "node:crypto";

const SHEET_ID = "1ZU1aJ4mLgysBz1UM84GLzljuWly8saF0p1HaNmAIBWc";
const TAB_ID = 1097364331;
const TAB_NAME = "工作表1";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";
type Credential = { client_email: string; private_key: string };
const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function accessToken(): Promise<string> {
  const encoded = process.env.SHEET_MONITOR_GOOGLE_CREDENTIALS;
  if (!encoded) throw new Error("MONITOR_GOOGLE_CONFIG");
  let credential: Credential;
  try { credential = JSON.parse(encoded); } catch { throw new Error("MONITOR_GOOGLE_CONFIG"); }
  if (!credential.client_email || !credential.private_key) throw new Error("MONITOR_GOOGLE_CONFIG");
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: credential.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 600 })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(credential.private_key, "base64url");
  const response = await fetch(TOKEN_URL, { method: "POST", signal: AbortSignal.timeout(8_000), cache: "no-store",
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }) });
  if (!response.ok) throw new Error("MONITOR_GOOGLE_AUTH");
  const result = await response.json();
  if (typeof result.access_token !== "string") throw new Error("MONITOR_GOOGLE_AUTH");
  return result.access_token;
}

// Only this explicitly selected spreadsheet/tab may be read. No client-supplied URLs,
// ranges, credential delegation or Sheet mutations are accepted by the monitor.
export async function readOperationalSheet(): Promise<unknown[][]> {
  const token = await accessToken();
  async function get(path: string) {
    const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${path}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "MONITOR_GOOGLE_AUTH" : "MONITOR_GOOGLE_READ");
    return response.json();
  }
  const metadata = await get("?fields=properties(timeZone),sheets(properties(sheetId,title,gridProperties))");
  const sheet = metadata.sheets?.find((s: { properties: { sheetId: number } }) => s.properties.sheetId === TAB_ID)?.properties;
  if (!sheet || sheet.title !== TAB_NAME || metadata.properties?.timeZone !== "Asia/Taipei") throw new Error("SHEET_IDENTITY_MISMATCH");
  const rowCount = sheet.gridProperties.rowCount;
  if (!Number.isInteger(rowCount) || rowCount < 2 || rowCount > 50_000 || sheet.gridProperties.columnCount < 12) throw new Error("SHEET_GRID_UNSUPPORTED");
  // One complete bounded read, including the J identity/date index for moved/deleted
  // rows. Do not truncate by a guessed last row or assume the Sheet is date-sorted.
  const range = encodeURIComponent(`'${TAB_NAME}'!A1:L${rowCount}`);
  const values = await get(`/values/${range}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`);
  if (!Array.isArray(values.values) || values.majorDimension !== "ROWS") throw new Error("SHEET_INCOMPLETE_READ");
  return values.values;
}
