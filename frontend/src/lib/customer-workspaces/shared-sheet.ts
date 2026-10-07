import { createSign, randomUUID } from "node:crypto";
import { spreadsheetId, type SourceSnapshot } from "./customer-google.ts";
import { importAccess } from "./sheet-import.ts";
import type { CustomerStore } from "./store.ts";

type ReaderCredential = { client_email: string; private_key: string };
type Tab = { id: number; title: string; rows: number; columns: number };
export type SharedSheetMetadata = {
  spreadsheetId: string;
  title: string;
  tabs: Tab[];
};
// Deliberately separate from the credentials used by the existing live properties.
function credential(): ReaderCredential {
  try {
    const value = JSON.parse(
      process.env.CUSTOMER_SHEET_READER_CREDENTIALS || "",
    );
    if (
      !/^[^\s@]+@[^\s@]+\.gserviceaccount\.com$/.test(value.client_email) ||
      typeof value.private_key !== "string" ||
      !value.private_key.includes("PRIVATE KEY")
    )
      throw Error();
    return value;
  } catch {
    throw new Error("SHEET_READER_UNAVAILABLE");
  }
}
export function sharedSheetEmail() {
  try {
    return credential().client_email;
  } catch {
    return null;
  }
}
async function token() {
  const c = credential(),
    now = Math.floor(Date.now() / 1000);
  const b64 = (v: object) =>
    Buffer.from(JSON.stringify(v)).toString("base64url");
  const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
    iss: c.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 600,
  })}`;
  const assertion = `${unsigned}.${createSign("RSA-SHA256").update(unsigned).sign(c.private_key, "base64url")}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!r.ok) throw new Error("SHEET_READER_UNAVAILABLE");
  const data = await r.json();
  if (typeof data.access_token !== "string")
    throw new Error("SHEET_READER_UNAVAILABLE");
  return data.access_token as string;
}
async function get(url: string, access: string) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${access}` },
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok && ![403, 404].includes(r.status))
    throw new Error("SHEET_READ_FAILED");
  const length = Number(r.headers.get("content-length") || 0);
  if (length > 1000000 || !r.body) throw new Error("IMPORT_SIZE");
  const reader = r.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 1000000) {
      await reader.cancel();
      throw new Error("IMPORT_SIZE");
    }
    chunks.push(value);
  }
  const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!r.ok) {
    const reasons = (data.error?.details ?? []).map(
      (detail: { reason?: string }) => detail.reason,
    );
    // Disabled APIs and insufficient application scopes are setup problems,
    // not a customer's failure to share their spreadsheet.
    if (
      reasons.some((reason: string) =>
        [
          "SERVICE_DISABLED",
          "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
          "CONSUMER_INVALID",
        ].includes(reason),
      )
    )
      throw new Error("SHEET_READER_UNAVAILABLE");
    throw new Error("SHEET_NOT_SHARED");
  }
  return data;
}
async function metadata(
  id: string,
  access: string,
): Promise<SharedSheetMetadata> {
  const data = await get(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}?fields=properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    access,
  );
  const tabs = (data.sheets ?? []).map(
    (s: {
      properties: {
        sheetId: number;
        title: string;
        gridProperties: { rowCount: number; columnCount: number };
      };
    }) => ({
      id: s.properties.sheetId,
      title: s.properties.title,
      rows: s.properties.gridProperties.rowCount,
      columns: s.properties.gridProperties.columnCount,
    }),
  );
  if (!tabs.length) throw new Error("SHEET_READ_FAILED");
  return {
    spreadsheetId: id,
    title: String(data.properties?.title ?? "試算表"),
    tabs,
  };
}
export async function checkSharedSheet(url: unknown) {
  const id = spreadsheetId(url);
  await metadata(id, await token());
  // Public checks disclose no titles, cells, owners or other customer data.
  return { readable: true as const, checkedAt: new Date().toISOString() };
}
export async function sharedTabs(url: unknown) {
  const id = spreadsheetId(url);
  return metadata(id, await token());
}
export async function sharedSource(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  url: unknown,
  sheetId: unknown,
) {
  const { workspace } = await importAccess(store, accountId, slug, propertyId);
  const id = spreadsheetId(url),
    access = await token(),
    meta = await metadata(id, access);
  const tab = meta.tabs.find((t) => t.id === sheetId);
  if (!tab) throw new Error("NOT_FOUND");
  // Check the entire used width/height, with bounded payloads. Never silently
  // import the first 500 rows of a larger populated source.
  if (tab.rows > 50000 || tab.columns > 1000) throw new Error("IMPORT_SIZE");
  const range = `'${tab.title.replaceAll("'", "''")}'!A1:${columnName(tab.columns)}${tab.rows}`;
  const data = await get(
    `https://sheets.googleapis.com/v4/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE&majorDimension=ROWS`,
    access,
  );
  const rows: string[][] = (data.values ?? []).map((r: unknown[]) =>
    r.map((c) => String(c ?? "")),
  );
  if (
    rows.length > 501 ||
    rows.some((r) => r.length > 52 || r.some((c) => c.length > 2000)) ||
    JSON.stringify(rows).length > 250000
  )
    throw new Error("IMPORT_SIZE");
  const snapshot: SourceSnapshot = {
    id: randomUUID(),
    accountId,
    workspaceId: workspace.id,
    propertyId,
    expiresAt: Date.now() + 3600000,
    source: {
      spreadsheetId: id,
      sheetId: tab.id,
      title: `${meta.title} / ${tab.title}`,
      rows,
    },
  };
  await store.commit([
    {
      key: `sheet-source:${snapshot.id}`,
      before: null,
      after: snapshot,
      ttlSeconds: 3600,
    },
  ]);
  return { id: snapshot.id, title: snapshot.source.title, rows };
}
function columnName(n: number) {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}
