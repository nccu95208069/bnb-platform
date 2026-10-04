import { createSign } from "node:crypto";
import { spreadsheetId } from "../customer-workspaces/customer-google.ts";
import { tablesFromMatrices } from "./parser.ts";
function credential() {
  try {
    const v = JSON.parse(process.env.CUSTOMER_SHEET_READER_CREDENTIALS || "");
    if (
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(v.client_email) ||
      !v.private_key?.includes("PRIVATE KEY")
    )
      throw Error();
    return v as { client_email: string; private_key: string };
  } catch {
    throw Error("SHEET_READER_UNAVAILABLE");
  }
}
export function readerEmail() {
  try {
    return credential().client_email;
  } catch {
    return null;
  }
}
async function json(r: Response) {
  if (!r.ok)
    throw Error(
      [403, 404].includes(r.status) ? "SHEET_NOT_SHARED" : "SHEET_READ_FAILED",
    );
  if (!r.body) throw Error("SHEET_READ_FAILED");
  let size = 0;
  const chunks: Uint8Array[] = [];
  for (const reader = r.body.getReader(); ;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8_000_000) {
      await reader.cancel();
      throw Error("HEALTH_SIZE");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function readGoogle(url: string) {
  const id = spreadsheetId(url),
    c = credential(),
    now = Math.floor(Date.now() / 1000),
    b64 = (v: object) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: c.client_email, scope: "https://www.googleapis.com/auth/spreadsheets.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 600 })}`;
  const token = await json(
    await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(c.private_key, "base64url")}`,
      }),
      signal: AbortSignal.timeout(10000),
      cache: "no-store",
    }),
  );
  const get = (path: string) =>
    fetch(`https://sheets.googleapis.com/v4/spreadsheets/${id}${path}`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    }).then(json);
  const meta = await get(
    "?fields=properties(title),sheets(properties(sheetId,title,gridProperties))",
  );
  if (!Array.isArray(meta.sheets) || meta.sheets.length > 12)
    throw Error("HEALTH_SIZE");
  const query = new URLSearchParams({
    valueRenderOption: "FORMATTED_VALUE",
    majorDimension: "ROWS",
  });
  for (const s of meta.sheets) {
    const p = s.properties;
    if (p.gridProperties.rowCount > 50000 || p.gridProperties.columnCount > 64)
      throw Error("HEALTH_SIZE");
    query.append(
      "ranges",
      `'${String(p.title).replaceAll("'", "''")}'!A1:BL${p.gridProperties.rowCount}`,
    );
  }
  const data = await get(`/values:batchGet?${query}`);
  if (data.valueRanges?.length !== meta.sheets.length)
    throw Error("SHEET_READ_FAILED");
  const tables = tablesFromMatrices(
    meta.sheets.map((s: { properties: { title: string } }, i: number) => ({
      title: s.properties.title,
      matrix: data.valueRanges[i].values ?? [],
    })),
  );
  return {
    title: String(meta.properties?.title || "Google Sheet").slice(0, 100),
    tables,
  };
}
