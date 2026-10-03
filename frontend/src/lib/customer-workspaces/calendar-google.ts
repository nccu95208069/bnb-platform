import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { digest } from "./auth.ts";
import { mutationContext, withReceipt } from "./mutations.ts";
import { loadWorkspace } from "./service.ts";
import { calendarAccess, stageCalendar } from "./calendar-import.ts";
import {
  calendarDate,
  calendarKey,
  calendarRange,
  CALENDAR_EVENT_LIMIT,
} from "./calendar-source.ts";
import type { CalendarEvent, CalendarKind } from "./calendar-types.ts";
import type { CustomerStore } from "./store.ts";

export const CALENDAR_STATE_COOKIE = "bnb_calendar_state";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
  "https://www.googleapis.com/auth/calendar.events.readonly",
];
type State = {
  actor: string;
  slug: string;
  workspaceId: string;
  propertyId: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  used: boolean;
};
type Token = { access: string; refresh: string; expiresAt: number };
type Connection = {
  sealed: string;
  workspaceId: string;
  propertyId: string;
  actor: string;
};
export function calendarGoogleConfig() {
  const clientId = process.env.CUSTOMER_CALENDAR_CLIENT_ID,
    clientSecret = process.env.CUSTOMER_CALENDAR_CLIENT_SECRET,
    redirectUri = process.env.CUSTOMER_CALENDAR_REDIRECT_URI,
    key = process.env.CUSTOMER_CALENDAR_TOKEN_KEY;
  if (
    !clientId ||
    !clientSecret ||
    !redirectUri ||
    !key ||
    !/^[A-Za-z0-9+/]{43}=$/.test(key)
  )
    throw new Error("CALENDAR_GOOGLE_UNAVAILABLE");
  const url = new URL(redirectUri);
  if (
    (url.protocol !== "https:" &&
      !(url.hostname === "localhost" && url.protocol === "http:")) ||
    url.pathname !== "/api/customer-calendar/callback" ||
    url.search ||
    url.hash
  )
    throw new Error("CALENDAR_GOOGLE_UNAVAILABLE");
  return {
    clientId,
    clientSecret,
    redirectUri,
    key: Buffer.from(key, "base64"),
  };
}
export function calendarGoogleReady() {
  try {
    calendarGoogleConfig();
    return true;
  } catch {
    return false;
  }
}
export function calendarSyncReady() {
  return (
    calendarGoogleReady() &&
    process.env.CUSTOMER_CALENDAR_SYNC_ENABLED === "true" &&
    Boolean(process.env.CRON_SECRET)
  );
}
function connectionId(workspaceId: string, propertyId: string, actor: string) {
  return digest(JSON.stringify([workspaceId, propertyId, actor]));
}
function seal(token: Token, context: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", calendarGoogleConfig().key, iv);
  cipher.setAAD(Buffer.from(context));
  return Buffer.concat([
    iv,
    cipher.update(JSON.stringify(token)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
}
function unseal(value: string, context: string): Token {
  try {
    const data = Buffer.from(value, "base64"),
      cipher = createDecipheriv(
        "aes-256-gcm",
        calendarGoogleConfig().key,
        data.subarray(0, 12),
      );
    cipher.setAAD(Buffer.from(context));
    cipher.setAuthTag(data.subarray(-16));
    return JSON.parse(
      Buffer.concat([
        cipher.update(data.subarray(12, -16)),
        cipher.final(),
      ]).toString(),
    );
  } catch {
    throw new Error("CALENDAR_CONNECT_REQUIRED");
  }
}
async function json(
  response: Response,
  max = 3 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      response.status === 401 || response.status === 403
        ? "CALENDAR_CONNECT_REQUIRED"
        : "CALENDAR_READ_FAILED",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("CALENDAR_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel();
      throw new Error("CALENDAR_SIZE");
    }
    chunks.push(value);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!result || typeof result !== "object" || Array.isArray(result))
      throw new Error();
    return result;
  } catch {
    throw new Error("CALENDAR_READ_FAILED");
  }
}
async function exchange(fields: Record<string, string>) {
  const config = calendarGoogleConfig();
  return json(
    await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...fields,
      }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    }),
    20000,
  );
}
export async function beginCalendarGoogle(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
) {
  const { workspace } = await calendarAccess(store, actor, slug, propertyId),
    config = calendarGoogleConfig();
  const state = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await store.commit([
    {
      key: `calendar-oauth:${digest(state)}`,
      before: null,
      after: {
        actor,
        slug,
        propertyId,
        workspaceId: workspace.id,
        nonce: digest(nonce),
        verifier,
        expiresAt: Date.now() + 600000,
        used: false,
      } satisfies State,
      ttlSeconds: 600,
    },
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    state,
    access_type: "offline",
    prompt: "select_account consent",
    code_challenge: Buffer.from(digest(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), nonce };
}
export async function finishCalendarGoogle(
  store: CustomerStore,
  actor: string,
  state: string,
  nonce: string,
  code: string,
) {
  if (
    !/^[\w-]{43}$/.test(state) ||
    !/^[\w-]{43}$/.test(nonce) ||
    !code ||
    code.length > 4096
  )
    throw new Error("FORBIDDEN");
  const key = `calendar-oauth:${digest(state)}`,
    saved = await store.read<State>(key),
    data = saved.value;
  if (
    !data ||
    data.used ||
    data.actor !== actor ||
    data.nonce !== digest(nonce) ||
    data.expiresAt < Date.now()
  )
    throw new Error("FORBIDDEN");
  const { workspace } = await calendarAccess(
    store,
    actor,
    data.slug,
    data.propertyId,
  );
  if (workspace.id !== data.workspaceId) throw new Error("FORBIDDEN");
  await store.commit([
    { key, before: saved.raw, after: { ...data, used: true }, ttlSeconds: 600 },
  ]);
  const result = await exchange({
    code,
    grant_type: "authorization_code",
    code_verifier: data.verifier,
    redirect_uri: calendarGoogleConfig().redirectUri,
  });
  if (
    typeof result.access_token !== "string" ||
    typeof result.refresh_token !== "string" ||
    typeof result.expires_in !== "number" ||
    result.expires_in < 60 ||
    typeof result.scope !== "string" ||
    SCOPES.some((s) => !(result.scope as string).split(" ").includes(s))
  )
    throw new Error("CALENDAR_CONNECT_REQUIRED");
  const id = connectionId(workspace.id, data.propertyId, actor),
    ckey = `calendar-connection:${id}`,
    old = await store.read<Connection>(ckey);
  await store.commit([
    {
      key: ckey,
      before: old.raw,
      after: {
        workspaceId: workspace.id,
        propertyId: data.propertyId,
        actor,
        sealed: seal(
          {
            access: result.access_token,
            refresh: result.refresh_token,
            expiresAt:
              Date.now() + (Math.min(result.expires_in, 3600) - 30) * 1000,
          },
          ckey,
        ),
      } satisfies Connection,
    },
  ]);
  return { slug: data.slug, propertyId: data.propertyId };
}
async function tokenFor(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
  expected?: string,
) {
  const { workspace } = await calendarAccess(store, actor, slug, propertyId),
    id = connectionId(workspace.id, propertyId, actor);
  if (expected && id !== expected) throw new Error("CALENDAR_CONNECT_REQUIRED");
  const key = `calendar-connection:${id}`,
    saved = await store.read<Connection>(key),
    connection = saved.value;
  if (
    !connection ||
    connection.actor !== actor ||
    connection.workspaceId !== workspace.id ||
    connection.propertyId !== propertyId
  )
    throw new Error("CALENDAR_CONNECT_REQUIRED");
  let token = unseal(connection.sealed, key);
  if (token.expiresAt <= Date.now()) {
    const result = await exchange({
      grant_type: "refresh_token",
      refresh_token: token.refresh,
    });
    if (
      typeof result.access_token !== "string" ||
      typeof result.expires_in !== "number" ||
      result.expires_in < 60
    )
      throw new Error("CALENDAR_CONNECT_REQUIRED");
    if (
      typeof result.scope === "string" &&
      SCOPES.some((s) => !(result.scope as string).split(" ").includes(s))
    )
      throw new Error("CALENDAR_CONNECT_REQUIRED");
    token = {
      access: result.access_token,
      refresh:
        typeof result.refresh_token === "string"
          ? result.refresh_token
          : token.refresh,
      expiresAt: Date.now() + (Math.min(result.expires_in, 3600) - 30) * 1000,
    };
    await store.commit([
      {
        key,
        before: saved.raw,
        after: { ...connection, sealed: seal(token, key) },
      },
    ]);
  }
  return { id, access: token.access };
}
async function read(path: string, access: string) {
  return json(
    await fetch(`https://www.googleapis.com/calendar/v3/${path}`, {
      headers: { Authorization: `Bearer ${access}` },
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    }),
  );
}
type GoogleCalendar = { id: string; name: string };
async function list(access: string) {
  const calendars: GoogleCalendar[] = [];
  let next = "";
  const seen = new Set<string>();
  do {
    if (seen.has(next) || seen.size >= 10) throw new Error("CALENDAR_SIZE");
    seen.add(next);
    const query = new URLSearchParams({
      maxResults: "250",
      minAccessRole: "reader",
      fields: "items(id,summary,accessRole,deleted),nextPageToken",
      ...(next ? { pageToken: next } : {}),
    });
    const data = await read(`users/me/calendarList?${query}`, access);
    if (!Array.isArray(data.items) && data.items !== undefined)
      throw new Error("CALENDAR_READ_FAILED");
    for (const item of (data.items ?? []) as Record<string, unknown>[]) {
      if (
        item.deleted ||
        !["reader", "writer", "owner"].includes(String(item.accessRole))
      )
        continue;
      if (typeof item.id !== "string" || item.id.length > 500)
        throw new Error("CALENDAR_FORMAT");
      calendars.push({
        id: item.id,
        name: String(item.summary ?? item.id).slice(0, 200),
      });
      if (calendars.length > 500) throw new Error("CALENDAR_SIZE");
    }
    next = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
  } while (next);
  return calendars;
}
export async function listGoogleCalendars(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
) {
  return {
    calendars: await list(
      (await tokenFor(store, actor, slug, propertyId)).access,
    ),
  };
}
function googleTime(value: unknown) {
  if (!value || typeof value !== "object") return "";
  const v = value as Record<string, unknown>;
  if (typeof v.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.date))
    return v.date;
  if (
    typeof v.dateTime === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(v.dateTime) &&
    Number.isFinite(Date.parse(v.dateTime))
  )
    return new Date(v.dateTime).toISOString();
  return "";
}
export async function readGoogleCalendar(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
  input: {
    kind: CalendarKind;
    calendarIds: string[];
    from: string;
    to: string;
    timezone: string;
    connectionId?: string;
  },
) {
  const range = calendarRange(input.from, input.to, input.timezone);
  if (
    !Array.isArray(input.calendarIds) ||
    !input.calendarIds.length ||
    input.calendarIds.length > 30 ||
    input.calendarIds.some((id) => typeof id !== "string" || id.length > 500) ||
    new Set(input.calendarIds).size !== input.calendarIds.length
  )
    throw new Error("INVALID_INPUT");
  const token = await tokenFor(
      store,
      actor,
      slug,
      propertyId,
      input.connectionId,
    ),
    available = await list(token.access);
  const calendars = input.calendarIds.map((id) => {
    const c = available.find((c) => c.id === id);
    if (!c) throw new Error("CALENDAR_CONNECT_REQUIRED");
    return { ...c, count: 0 };
  });
  const events: CalendarEvent[] = [];
  const deadline = Date.now() + 40000;
  for (const calendar of calendars) {
    let next = "";
    const pages = new Set<string>();
    do {
      if (Date.now() > deadline || pages.has(next) || pages.size > 20)
        throw new Error("CALENDAR_SIZE");
      pages.add(next);
      const params = new URLSearchParams({
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "250",
        timeMin: new Date(Date.parse(range.from) - 2 * 86400000).toISOString(),
        timeMax: new Date(Date.parse(range.to) + 2 * 86400000).toISOString(),
        timeZone: range.timezone,
        fields:
          "items(id,iCalUID,summary,description,start,end,status,originalStartTime,recurringEventId,colorId,updated,sequence,eventType),nextPageToken",
        ...(next ? { pageToken: next } : {}),
      });
      const data = await read(
        `calendars/${encodeURIComponent(calendar.id)}/events?${params}`,
        token.access,
      );
      if (!Array.isArray(data.items) && data.items !== undefined)
        throw new Error("CALENDAR_READ_FAILED");
      for (const raw of (data.items ?? []) as Record<string, unknown>[]) {
        const start = googleTime(raw.start),
          end = googleTime(raw.end),
          recurrenceId = googleTime(raw.originalStartTime) || undefined;
        let issue: string | undefined;
        try {
          const a = calendarDate(start, range.timezone),
            b = calendarDate(end, range.timezone);
          if (a >= range.to || b < range.from || (b === range.from && a !== b))
            continue;
          if (end < start) issue = "活動結束早於開始";
        } catch {
          issue = "活動日期不完整，請核對 Google 日曆";
        }
        if (raw.eventType && raw.eventType !== "default")
          issue = "特殊日曆活動需人工核對，請在來源中改為一般住宿或封房活動";
        const uid = typeof raw.iCalUID === "string" ? raw.iCalUID : "",
          eventId = typeof raw.id === "string" ? raw.id : "";
        if (
          !uid ||
          !eventId ||
          uid.length > 500 ||
          eventId.length > 500 ||
          (raw.recurringEventId && !recurrenceId)
        )
          throw new Error("CALENDAR_FORMAT");
        const title = String(raw.summary ?? ""),
          description = String(raw.description ?? "");
        if (title.length > 500 || description.length > 8000)
          throw new Error("CALENDAR_SIZE");
        const event: CalendarEvent = {
          key: calendarKey(calendar.id, uid, recurrenceId),
          calendarId: calendar.id,
          uid,
          eventId,
          recurrenceId,
          title,
          description,
          start,
          end,
          allDay: start.length === 10,
          cancelled: raw.status === "cancelled",
          color: typeof raw.colorId === "string" ? raw.colorId : undefined,
          issue,
          version: digest(JSON.stringify(raw)),
        };
        if (events.some((e) => e.key === event.key))
          throw new Error("CALENDAR_DUPLICATE_SOURCE");
        events.push(event);
        calendar.count++;
        if (events.length > CALENDAR_EVENT_LIMIT)
          throw new Error("CALENDAR_SIZE");
      }
      next = typeof data.nextPageToken === "string" ? data.nextPageToken : "";
    } while (next);
  }
  return stageCalendar(store, actor, slug, propertyId, {
    kind: input.kind,
    transport: "google",
    connectionId: token.id,
    ...range,
    calendars,
    events,
  });
}

// Removes only this property's stored credentials. Provider-wide revocation can
// also revoke another property's grant, so it is left to the Google account UI.
export async function disconnectCalendarGoogle(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
  input: Record<string, unknown>,
) {
  await calendarAccess(store, actor, slug, propertyId);
  if (input.confirmed !== true) throw new Error("FORMAT_CONFIRMATION_REQUIRED");
  const context = await mutationContext(
    store,
    actor,
    slug,
    input,
    "calendar.disconnected",
    { propertyId },
    ["owner", "admin"],
  );
  const workspace = context.workspace;
  if (
    !context.member.allProperties &&
    !context.member.propertyIds.includes(propertyId)
  )
    throw new Error("NOT_FOUND");
  if (context.previous) return { disconnected: true };
  const hasSources = workspace.calendarSources?.some(
    (b) => b.propertyId === propertyId && b.transport === "google",
  );
  const ids = new Set([
    connectionId(workspace.id, propertyId, actor),
    ...(workspace.calendarSources ?? [])
      .filter((b) => b.propertyId === propertyId && b.connectionId)
      .map((b) => b.connectionId!),
  ]);
  const changes = await Promise.all(
    [...ids].map(async (id) => {
      const key = `calendar-connection:${id}`,
        saved = await store.read<Connection>(key);
      return { key, before: saved.raw, after: null };
    }),
  );
  const next = withReceipt(
    {
      ...workspace,
      calendarSources: workspace.calendarSources?.map((b) =>
        b.propertyId === propertyId && b.transport === "google"
          ? {
              ...b,
              mode: "migration",
              connectionId: undefined,
              coverageConfirmed: false,
              error: "CALENDAR_DISCONNECTED",
              pendingCount: Math.max(1, b.pendingCount),
            }
          : b,
      ),
      properties: workspace.properties.map((p) =>
        p.id === propertyId && hasSources
          ? {
              ...p,
              setup: {
                ...p.setup,
                mode: "calendar",
                readyAt: undefined,
                unresolvedCount: Math.max(1, p.setup?.unresolvedCount ?? 0),
              },
            }
          : p,
      ),
    },
    context,
    propertyId,
  );
  if (hasSources && next.onboarding && next.properties[0].id === propertyId)
    next.onboarding = {
      ...next.onboarding,
      readyAt: undefined,
      unresolvedCount: Math.max(1, next.onboarding.unresolvedCount ?? 0),
    };
  await store.commit([
    { key: `workspace:${workspace.id}`, before: context.raw, after: next },
    ...changes,
  ]);
  const verified = (await loadWorkspace(store, actor, slug)).workspace;
  if (
    !verified.operations?.some(
      (o) => o.key === context.key && o.hash === context.hash,
    ) ||
    (
      await Promise.all(
        [...ids].map((id) =>
          store.read<Connection>(`calendar-connection:${id}`),
        ),
      )
    ).some((saved) => saved.value)
  )
    throw new Error("WRITE_UNCONFIRMED");
  return { disconnected: true };
}

// Internal onboarding helpers. Credentials are staged inside the temporary
// preview namespace, then re-encrypted into the verified owner's final context.
export { SCOPES as CALENDAR_READ_SCOPES, exchange as exchangeCalendarCode };
export async function saveCalendarGrant(
  store: CustomerStore,
  actor: string,
  workspaceId: string,
  propertyId: string,
  token: Token,
) {
  const { id, change } = await calendarGrantChange(
    store,
    actor,
    workspaceId,
    propertyId,
    token,
  );
  await store.commit([change]);
  return id;
}
export async function calendarGrantChange(
  store: CustomerStore,
  actor: string,
  workspaceId: string,
  propertyId: string,
  token: Token,
) {
  const id = connectionId(workspaceId, propertyId, actor),
    key = `calendar-connection:${id}`;
  const old = await store.read<Connection>(key);
  return {
    id,
    change: {
      key,
      before: old.raw,
      after: {
        workspaceId,
        propertyId,
        actor,
        sealed: seal(token, key),
      } satisfies Connection,
    },
  };
}
export async function copyCalendarGrant(
  fromStore: CustomerStore,
  fromActor: string,
  fromWorkspace: string,
  fromProperty: string,
  toStore: CustomerStore,
  toActor: string,
  toWorkspace: string,
  toProperty: string,
) {
  const previousKey = `calendar-connection:${connectionId(fromWorkspace, fromProperty, fromActor)}`;
  const prior = (await fromStore.read<Connection>(previousKey)).value;
  if (
    !prior ||
    prior.actor !== fromActor ||
    prior.workspaceId !== fromWorkspace ||
    prior.propertyId !== fromProperty
  )
    throw new Error("CALENDAR_CONNECT_REQUIRED");
  const token = unseal(prior.sealed, previousKey),
    id = connectionId(toWorkspace, toProperty, toActor),
    key = `calendar-connection:${id}`;
  const existing = await toStore.read<Connection>(key);
  return {
    id,
    change: {
      key,
      before: existing.raw,
      after: {
        workspaceId: toWorkspace,
        propertyId: toProperty,
        actor: toActor,
        sealed: seal(token, key),
      } satisfies Connection,
    },
  };
}
