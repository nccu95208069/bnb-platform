import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { digest } from "./auth.ts";
import { importAccess } from "./sheet-import.ts";
import type { SheetSource } from "./sheet-import.ts";
import type { CustomerStore } from "./store.ts";
export const GOOGLE_STATE_COOKIE = "bnb_customer_google_state";
const scope = "https://www.googleapis.com/auth/spreadsheets.readonly";
type OAuthState = {
  accountId: string;
  slug: string;
  propertyId: string;
  workspaceId: string;
  nonceHash: string;
  verifier: string;
  expiresAt: number;
  used: boolean;
};
type Connection = { sealed: string; expiresAt: number };
export function googleConfig() {
  const clientId = process.env.CUSTOMER_GOOGLE_CLIENT_ID,
    clientSecret = process.env.CUSTOMER_GOOGLE_CLIENT_SECRET,
    redirectUri = process.env.CUSTOMER_GOOGLE_REDIRECT_URI,
    key = process.env.CUSTOMER_GOOGLE_TOKEN_KEY;
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !key ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key)
  )
    throw new Error("GOOGLE_UNAVAILABLE");
  const url = new URL(redirectUri);
  if (
    (url.protocol !== "https:" &&
      !(url.hostname === "localhost" && url.protocol === "http:")) ||
    url.pathname !== "/api/customer-google/callback" ||
    url.search ||
    url.hash
  )
    throw new Error("GOOGLE_UNAVAILABLE");
  return {
    clientId,
    clientSecret,
    redirectUri,
    key: Buffer.from(key, "base64"),
  };
}
export function googleReady() {
  try {
    googleConfig();
    return true;
  } catch {
    return false;
  }
}
function connectionKey(
  workspaceId: string,
  propertyId: string,
  accountId: string,
) {
  return `customer-google:${workspaceId}:${propertyId}:${accountId}`;
}
function seal(token: string, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", googleConfig().key, iv);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([
    iv,
    cipher.update(token),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function unseal(value: string, context: string) {
  const data = Buffer.from(value, "base64"),
    cipher = createDecipheriv(
      "aes-256-gcm",
      googleConfig().key,
      data.subarray(0, 12),
    );
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    cipher.update(data.subarray(12, -16)),
    cipher.final(),
  ]).toString();
}
export async function beginGoogle(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
) {
  const { workspace } = await importAccess(store, accountId, slug, propertyId),
    config = googleConfig();
  const state = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  const stateData: OAuthState = {
    accountId,
    slug,
    propertyId,
    workspaceId: workspace.id,
    nonceHash: digest(nonce),
    verifier,
    expiresAt: Date.now() + 600000,
    used: false,
  };
  await store.commit([
    {
      key: `google-state:${digest(state)}`,
      before: null,
      after: stateData,
      ttlSeconds: 600,
    },
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope,
    state,
    access_type: "online",
    prompt: "select_account consent",
    code_challenge: Buffer.from(digest(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), nonce };
}
export async function finishGoogle(
  store: CustomerStore,
  accountId: string,
  state: string,
  nonce: string,
  code: string,
) {
  if (!/^[\w-]{43}$/.test(state) || !nonce || !code || code.length > 4096)
    throw new Error("FORBIDDEN");
  const key = `google-state:${digest(state)}`,
    snapshot = await store.read<OAuthState>(key),
    data = snapshot.value;
  if (
    !data ||
    data.used ||
    data.expiresAt < Date.now() ||
    data.accountId !== accountId ||
    data.nonceHash !== digest(nonce)
  )
    throw new Error("FORBIDDEN");
  const { workspace } = await importAccess(
    store,
    accountId,
    data.slug,
    data.propertyId,
  );
  if (workspace.id !== data.workspaceId) throw new Error("FORBIDDEN");
  await store.commit([
    {
      key,
      before: snapshot.raw,
      after: { ...data, used: true },
      ttlSeconds: 600,
    },
  ]);
  const config = googleConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
      code_verifier: data.verifier,
    }),
    signal: AbortSignal.timeout(15000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("GOOGLE_CONNECT_FAILED");
  const token = await response.json();
  if (
    typeof token.access_token !== "string" ||
    typeof token.expires_in !== "number" ||
    token.expires_in < 60 ||
    typeof token.scope !== "string" ||
    !token.scope.split(" ").includes(scope)
  )
    throw new Error("GOOGLE_CONNECT_FAILED");
  const ttl = Math.min(3600, Math.floor(token.expires_in)) - 30;
  const ckey = connectionKey(workspace.id, data.propertyId, accountId),
    current = await store.read<Connection>(ckey);
  await store.commit([
    {
      key: ckey,
      before: current.raw,
      after: {
        sealed: seal(token.access_token, ckey),
        expiresAt: Date.now() + ttl * 1000,
      },
      ttlSeconds: ttl,
    },
  ]);
  return { slug: data.slug, propertyId: data.propertyId };
}
async function googleRead(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  path: string,
) {
  const { workspace } = await importAccess(store, accountId, slug, propertyId),
    key = connectionKey(workspace.id, propertyId, accountId);
  const connection = (await store.read<Connection>(key)).value;
  if (!connection || connection.expiresAt < Date.now())
    throw new Error("GOOGLE_CONNECT_REQUIRED");
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${path}`,
    {
      headers: { Authorization: `Bearer ${unseal(connection.sealed, key)}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status === 401) throw new Error("GOOGLE_CONNECT_REQUIRED");
  if (!response.ok) throw new Error("SHEET_UNAVAILABLE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("SHEET_UNAVAILABLE");
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 1000000) {
      await reader.cancel();
      throw new Error("IMPORT_SIZE");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
export function spreadsheetId(value: unknown) {
  if (typeof value !== "string") throw new Error("INVALID_INPUT");
  let id = value.trim();
  if (id.startsWith("https://")) {
    const url = new URL(id);
    if (url.hostname !== "docs.google.com") throw new Error("INVALID_INPUT");
    id = /^\/spreadsheets\/d\/([\w-]+)(?:\/|$)/.exec(url.pathname)?.[1] ?? "";
  }
  if (!/^[\w-]{20,150}$/.test(id)) throw new Error("INVALID_INPUT");
  return id;
}
export async function sheetTabs(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  url: unknown,
) {
  const id = spreadsheetId(url),
    data = await googleRead(
      store,
      accountId,
      slug,
      propertyId,
      `${id}?fields=properties(title),sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))`,
    );
  const tabs = (data.sheets ?? []).map(
    (s: {
      properties: { sheetId: number; title: string; gridProperties?: unknown };
    }) => ({ id: s.properties.sheetId, title: s.properties.title }),
  );
  return {
    spreadsheetId: id,
    title: String(data.properties?.title ?? "試算表"),
    tabs,
  };
}
export type SourceSnapshot = {
  id: string;
  accountId: string;
  workspaceId: string;
  propertyId: string;
  expiresAt: number;
  source: SheetSource;
};
export async function readSheet(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  id: unknown,
  sheetId: unknown,
) {
  if (!Number.isInteger(sheetId)) throw new Error("INVALID_INPUT");
  const meta = await sheetTabs(store, accountId, slug, propertyId, id),
    tab = meta.tabs.find((t: { id: number }) => t.id === sheetId);
  if (!tab) throw new Error("NOT_FOUND");
  const range = `'${String(tab.title).replaceAll("'", "''")}'!A:BA`;
  const data = await googleRead(
    store,
    accountId,
    slug,
    propertyId,
    `${meta.spreadsheetId}/values/${encodeURIComponent(range)}?valueRenderOption=FORMATTED_VALUE`,
  );
  const rows: string[][] = (data.values ?? []).map((r: unknown[]) =>
    r.map((c) => String(c ?? "")),
  );
  if (
    rows.length > 501 ||
    rows.some((r) => r.length > 52) ||
    JSON.stringify(rows).length > 250000 ||
    rows.some((r) => r.some((c) => c.length > 2000))
  )
    throw new Error("IMPORT_SIZE");
  const { workspace } = await importAccess(store, accountId, slug, propertyId);
  const snapshot: SourceSnapshot = {
    id: randomUUID(),
    accountId,
    workspaceId: workspace.id,
    propertyId,
    expiresAt: Date.now() + 3600000,
    source: {
      spreadsheetId: meta.spreadsheetId,
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
export async function sourceFor(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  id: unknown,
) {
  const { workspace } = await importAccess(store, accountId, slug, propertyId);
  if (typeof id !== "string" || !/^[\w-]{36}$/.test(id))
    throw new Error("INVALID_INPUT");
  const snapshot = (await store.read<SourceSnapshot>(`sheet-source:${id}`))
    .value;
  if (
    !snapshot ||
    snapshot.accountId !== accountId ||
    snapshot.workspaceId !== workspace.id ||
    snapshot.propertyId !== propertyId
  )
    throw new Error("NOT_FOUND");
  if (snapshot.expiresAt < Date.now()) throw new Error("IMPORT_EXPIRED");
  return snapshot.source;
}
