import { randomBytes, randomUUID } from "node:crypto";
import { accountKey, digest } from "./auth.ts";
import { customerCredentialBinding } from "./identity.ts";
import {
  calendarPreviewFor,
  calendarSnapshotFor,
  calendarStatus,
  commitCalendar,
} from "./calendar-import.ts";
import { verifyGoogleCalendarPreview } from "./calendar-sync.ts";
import { copyCalendarGrant } from "./calendar-google.ts";
import { textValue, loadWorkspace } from "./service.ts";
import {
  isCalendarKind,
  type CalendarKind,
  type CalendarPreview,
  type CalendarSnapshot,
} from "./calendar-types.ts";
import type { Account, Property, Workspace } from "./types.ts";
import type { Change, CustomerStore, Snapshot } from "./store.ts";
export const ONBOARDING_COOKIE = "bnb_calendar_preview";
export const PREVIEW_SECONDS = 3600;
export type PreparedCalendar = {
  previewId: string;
  selected: string[];
  confirmed: true;
  confirmedCoverage: boolean;
  mode: "migration" | "connected";
  acceptChanges: false;
};
export type CalendarOnboardingDraft = {
  id: string;
  actor: string;
  workspaceId: string;
  slug: string;
  propertyId: string;
  kind: CalendarKind;
  hash: string;
  expiresAt: number;
  sourceId?: string;
  previewId?: string;
  prepared?: PreparedCalendar;
  claimEmail?: string;
  loginRequestId?: string;
  googleAccountId?: string;
  googleIdentity?: { sub: string; email: string; authoritative: boolean };
  completed?: { accountId: string; url: string; batchId: string; slug: string };
};
export const draftKey = (hash: string) => `calendar-onboarding:${hash}`;
export function draftHash(cookie?: string) {
  if (!cookie || !/^[\w-]{43}$/.test(cookie))
    throw new Error("CALENDAR_PREVIEW_REQUIRED");
  return digest(cookie);
}
export async function draftForHash(store: CustomerStore, hash: string) {
  if (!/^[a-f0-9]{64}$/.test(hash))
    throw new Error("CALENDAR_PREVIEW_REQUIRED");
  const saved = await store.read<CalendarOnboardingDraft>(draftKey(hash));
  if (!saved.value || saved.value.expiresAt <= Date.now())
    throw new Error("CALENDAR_PREVIEW_REQUIRED");
  return { ...saved, value: saved.value };
}
// Every preview key has a fixed lifetime and a secret-cookie-derived namespace.
// The wrapper cannot reach real accounts, slugs, workspaces or grant records.
export class CalendarPreviewStore implements CustomerStore {
  private store: CustomerStore;
  readonly hash: string;
  private expiresAt: number;
  constructor(store: CustomerStore, hash: string, expiresAt: number) {
    this.store = store;
    this.hash = hash;
    this.expiresAt = expiresAt;
  }
  private prefix(key: string) {
    return `calendar-preview-store:${this.hash}:${key}`;
  }
  private ttl() {
    const seconds = Math.ceil((this.expiresAt - Date.now()) / 1000);
    if (seconds <= 0) throw new Error("CALENDAR_PREVIEW_REQUIRED");
    return seconds;
  }
  async read<T>(key: string) {
    this.ttl();
    return this.store.read<T>(this.prefix(key));
  }
  async commit(changes: Change[]) {
    const ttl = this.ttl();
    await this.store.commit(
      changes.map((c) => ({
        ...c,
        key: this.prefix(c.key),
        ttlSeconds: Math.min(ttl, c.ttlSeconds ?? ttl),
      })),
    );
  }
  async commitWithDraft(
    changes: Change[],
    before: Snapshot<CalendarOnboardingDraft>,
    patch: Partial<CalendarOnboardingDraft>,
  ) {
    const ttl = this.ttl();
    if (!before.value || before.value.completed || before.value.prepared)
      throw new Error("CALENDAR_PREVIEW_LOCKED");
    await this.store.commit([
      ...changes.map((c) => ({
        ...c,
        key: this.prefix(c.key),
        ttlSeconds: Math.min(ttl, c.ttlSeconds ?? ttl),
      })),
      {
        key: draftKey(this.hash),
        before: before.raw,
        after: { ...before.value, ...patch },
        ttlSeconds: ttl,
      },
    ]);
  }
  async limit(key: string, max: number) {
    this.ttl();
    return this.store.limit(`preview:${this.hash}:${key}`, max);
  }
}
export function previewContext(
  store: CustomerStore,
  hash: string,
  draft: CalendarOnboardingDraft,
) {
  const scoped = new CalendarPreviewStore(store, hash, draft.expiresAt);
  return {
    scoped,
    args: [scoped, draft.actor, draft.slug, draft.propertyId] as const,
  };
}
export async function startCalendarOnboarding(
  store: CustomerStore,
  input: Record<string, unknown>,
  cookie?: string,
) {
  const name = textValue(input.name, 80, true)!,
    kind = input.kind;
  if (
    !isCalendarKind(input.calendarKind) ||
    !["rooms", "villa", "mixed"].includes(String(kind)) ||
    !Array.isArray(input.rooms) ||
    !input.rooms.length ||
    input.rooms.length > 100
  )
    throw new Error("INVALID_INPUT");
  const rooms = input.rooms.map((r) => textValue(r, 40, true)!);
  if (new Set(rooms).size !== rooms.length) throw new Error("INVALID_INPUT");
  const hashInput = digest(
    JSON.stringify({ name, kind, rooms, calendarKind: input.calendarKind }),
  );
  if (cookie && /^[\w-]{43}$/.test(cookie)) {
    const old = (
      await store.read<CalendarOnboardingDraft>(draftKey(digest(cookie)))
    ).value;
    if (
      old &&
      old.expiresAt > Date.now() &&
      old.hash === hashInput &&
      !old.completed
    )
      return { cookie, draft: old };
  }
  const value = randomBytes(32).toString("base64url"),
    hash = digest(value),
    id = randomUUID();
  const property: Property = {
    id: randomUUID(),
    name,
    kind: kind as Property["kind"],
    rooms: rooms.map((name) => ({ id: randomUUID(), name })),
    villaRoomIds: [],
    sourceMode: "native",
    setup: {
      mode: "calendar",
      calendarKind: input.calendarKind,
      unresolvedCount: 1,
    },
  };
  if (kind !== "rooms") property.villaRoomIds = property.rooms.map((r) => r.id);
  const draft: CalendarOnboardingDraft = {
    id,
    actor: randomUUID(),
    workspaceId: randomUUID(),
    slug: `stay-${id.replaceAll("-", "")}`,
    propertyId: property.id,
    kind: input.calendarKind,
    hash: hashInput,
    expiresAt: Date.now() + PREVIEW_SECONDS * 1000,
  };
  const workspace: Workspace = {
    id: draft.workspaceId,
    slug: draft.slug,
    name,
    version: 1,
    members: [
      {
        accountId: draft.actor,
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    properties: [property],
    bookings: [],
    audit: [],
  };
  await store.commit([
    {
      key: draftKey(hash),
      before: null,
      after: draft,
      ttlSeconds: PREVIEW_SECONDS,
    },
    {
      key: `calendar-preview-store:${hash}:workspace:${workspace.id}`,
      before: null,
      after: workspace,
      ttlSeconds: PREVIEW_SECONDS,
    },
    {
      key: `calendar-preview-store:${hash}:slug:${workspace.slug}`,
      before: null,
      after: workspace.id,
      ttlSeconds: PREVIEW_SECONDS,
    },
  ]);
  const verified = await draftForHash(store, hash);
  if (verified.value.id !== id) throw new Error("WRITE_UNCONFIRMED");
  return { cookie: value, draft };
}
export async function updateCalendarDraft(
  store: CustomerStore,
  hash: string,
  before: Snapshot<CalendarOnboardingDraft>,
  changes: Partial<CalendarOnboardingDraft>,
) {
  if (!before.value || before.value.completed)
    throw new Error("CALENDAR_PREVIEW_LOCKED");
  const next = { ...before.value, ...changes };
  if (next.expiresAt <= Date.now())
    throw new Error("CALENDAR_PREVIEW_REQUIRED");
  await store.commit([
    {
      key: draftKey(hash),
      before: before.raw,
      after: next,
      ttlSeconds: Math.ceil((next.expiresAt - Date.now()) / 1000),
    },
  ]);
  return next;
}
export async function calendarOnboardingView(
  store: CustomerStore,
  hash: string,
  account?: Account,
) {
  const { value: draft } = await draftForHash(store, hash),
    { scoped, args } = previewContext(store, hash, draft);
  const workspace = (await loadWorkspace(scoped, draft.actor, draft.slug))
    .workspace;
  const source = draft.sourceId
    ? await calendarSnapshotFor(...args, draft.sourceId)
    : null;
  const preview = draft.previewId
    ? await calendarPreviewFor(...args, draft.previewId)
    : null;
  return {
    property: workspace.properties[0],
    kind: draft.kind,
    status: await calendarStatus(...args),
    source,
    preview,
    prepared: draft.prepared ?? null,
    expiresAt: draft.expiresAt,
    account:
      account?.emailVerifiedAt &&
      (!draft.claimEmail || draft.claimEmail === account.email) &&
      (!draft.googleAccountId || draft.googleAccountId === account.id)
        ? { id: account.id, email: account.email }
        : null,
    googleEmail: draft.googleIdentity
      ? (draft.claimEmail ?? draft.googleIdentity.email)
      : null,
    completed:
      draft.completed && account?.id === draft.completed.accountId
        ? draft.completed.url
        : null,
  };
}
export async function prepareCalendarSave(
  store: CustomerStore,
  hash: string,
  input: Record<string, unknown>,
) {
  const saved = await draftForHash(store, hash),
    draft = saved.value;
  const { args } = previewContext(store, hash, draft);
  if (draft.completed) throw new Error("CALENDAR_PREVIEW_LOCKED");
  if (
    input.previewId !== draft.previewId ||
    input.confirmed !== true ||
    typeof input.confirmedCoverage !== "boolean" ||
    !["migration", "connected"].includes(String(input.mode)) ||
    !Array.isArray(input.selected) ||
    input.selected.length > 2000 ||
    input.selected.some((v) => typeof v !== "string")
  )
    throw new Error("FORMAT_CONFIRMATION_REQUIRED");
  const preview = await calendarPreviewFor(...args, input.previewId),
    source = await calendarSnapshotFor(...args, preview.snapshotId);
  const selected = [...new Set(input.selected as string[])].sort();
  if (
    selected.some((id) => {
      const row = preview.rows.find((r) => r.id === id);
      return !row || row.issues.length || row.disposition !== "ready";
    })
  )
    throw new Error("INVALID_INPUT");
  if (
    input.mode === "connected" &&
    (source.transport !== "google" ||
      process.env.CUSTOMER_CALENDAR_SYNC_ENABLED !== "true" ||
      !process.env.CRON_SECRET)
  )
    throw new Error("CALENDAR_SYNC_UNAVAILABLE");
  const prepared: PreparedCalendar = {
    previewId: preview.id,
    selected,
    confirmed: true,
    confirmedCoverage: input.confirmedCoverage,
    mode: input.mode as PreparedCalendar["mode"],
    acceptChanges: false,
  };
  if (draft.prepared) {
    if (JSON.stringify(draft.prepared) !== JSON.stringify(prepared))
      throw new Error("CALENDAR_PREVIEW_LOCKED");
    return prepared;
  }
  await updateCalendarDraft(store, hash, saved, { prepared });
  return prepared;
}
// Run the existing import transaction against a local overlay, then atomically
// publish workspace + bookings + account ownership + preview completion once.
class ImportTransaction implements CustomerStore {
  private values = new Map<string, Snapshot<unknown>>();
  private pending = new Map<string, Change>();
  private store: CustomerStore;
  constructor(store: CustomerStore) {
    this.store = store;
  }
  seed(key: string, value: unknown) {
    this.values.set(key, { value, raw: JSON.stringify(value) });
  }
  async read<T>(key: string): Promise<Snapshot<T>> {
    return (this.values.get(key) ??
      (await this.store.read<T>(key))) as Snapshot<T>;
  }
  async commit(changes: Change[]) {
    for (const c of changes)
      if ((await this.read(c.key)).raw !== c.before)
        throw new Error("VERSION_CONFLICT");
    for (const c of changes) {
      const original = this.pending.has(c.key)
        ? this.pending.get(c.key)!.before
        : c.key.startsWith("workspace:")
          ? null
          : c.before;
      this.pending.set(c.key, { ...c, before: original });
      this.seed(c.key, c.after);
    }
  }
  async limit(key: string, max: number) {
    return this.store.limit(key, max);
  }
  changes() {
    return [...this.pending.values()];
  }
}
export async function finishCalendarOnboarding(
  store: CustomerStore,
  hash: string,
  account: Account,
  expectedAccountId: unknown,
) {
  const saved = await draftForHash(store, hash),
    draft = saved.value;
  if (
    expectedAccountId !== account.id ||
    !account.emailVerifiedAt ||
    (draft.claimEmail && draft.claimEmail !== account.email) ||
    (draft.googleAccountId && draft.googleAccountId !== account.id)
  )
    throw new Error("CALENDAR_ACCOUNT_CHANGED");
  if (draft.completed) {
    if (draft.completed.accountId !== account.id) throw new Error("FORBIDDEN");
    const existing = (
      await loadWorkspace(store, account.id, draft.completed.slug)
    ).workspace;
    if (
      !existing.calendarBatches?.some((b) => b.id === draft.completed!.batchId)
    )
      throw new Error("WRITE_UNCONFIRMED");
    return draft.completed;
  }
  if (!draft.prepared || draft.prepared.previewId !== draft.previewId)
    throw new Error("FORMAT_CONFIRMATION_REQUIRED");
  const currentAccount = await store.read<Account>(accountKey(account.email));
  if (
    !currentAccount.value ||
    currentAccount.value.id !== account.id ||
    customerCredentialBinding(currentAccount.value.credential) !==
      customerCredentialBinding(account.credential)
  )
    throw new Error("UNAUTHORIZED");
  if (currentAccount.value.workspaces.length >= 10)
    throw new Error("LIMIT_REACHED");
  const { scoped, args } = previewContext(store, hash, draft);
  await verifyGoogleCalendarPreview(...args, draft.prepared.previewId);
  const oldWorkspace = (await loadWorkspace(scoped, draft.actor, draft.slug))
    .workspace;
  const oldPreview = await calendarPreviewFor(
      ...args,
      draft.prepared.previewId,
    ),
    oldSource = await calendarSnapshotFor(...args, oldPreview.snapshotId);
  if (oldWorkspace.version !== oldPreview.version)
    throw new Error("VERSION_CONFLICT");
  const workspace: Workspace = {
    ...oldWorkspace,
    members: [
      {
        accountId: account.id,
        email: account.email,
        role: "owner",
        active: true,
        allProperties: true,
        propertyIds: [],
      },
    ],
    audit: [
      {
        at: new Date().toISOString(),
        actor: account.id,
        action: "workspace.created",
        targetId: oldWorkspace.id,
      },
    ],
  };
  const transaction = new ImportTransaction(store);
  transaction.seed(`workspace:${workspace.id}`, workspace);
  transaction.seed(`slug:${workspace.slug}`, workspace.id);
  let connection: Change | undefined;
  const source: CalendarSnapshot = { ...oldSource, actor: account.id };
  if (source.transport === "google") {
    const copied = await copyCalendarGrant(
      scoped,
      draft.actor,
      workspace.id,
      draft.propertyId,
      store,
      account.id,
      workspace.id,
      draft.propertyId,
    );
    source.connectionId = copied.id;
    connection = copied.change;
  }
  const preview: CalendarPreview = { ...oldPreview, actor: account.id };
  transaction.seed(`calendar-snapshot:${source.id}`, source);
  transaction.seed(`calendar-preview:${preview.id}`, preview);
  const batch = await commitCalendar(
    transaction,
    account.id,
    workspace.slug,
    draft.propertyId,
    draft.prepared,
  );
  const creationHash = digest(
    JSON.stringify({ draft: draft.hash, command: draft.prepared }),
  );
  const reference = {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    creationKey: `calendar-${draft.id}`,
    creationHash,
  };
  const completed = {
    accountId: account.id,
    url: `/w/${workspace.slug}/calendar`,
    slug: workspace.slug,
    batchId: batch.id,
  };
  await store.commit([
    ...transaction.changes(),
    // Keep unresolved rows available in the new workspace for the remainder of
    // the preview lifetime, with the authenticated owner rather than guest actor.
    {
      key: `calendar-snapshot:${source.id}`,
      before: null,
      after: source,
      ttlSeconds: Math.max(
        1,
        Math.ceil((source.expiresAt - Date.now()) / 1000),
      ),
    },
    {
      key: `calendar-preview:${preview.id}`,
      before: null,
      after: preview,
      ttlSeconds: Math.max(
        1,
        Math.ceil((preview.expiresAt - Date.now()) / 1000),
      ),
    },
    ...(connection ? [connection] : []),
    { key: `slug:${workspace.slug}`, before: null, after: workspace.id },
    {
      key: accountKey(account.email),
      before: currentAccount.raw,
      after: {
        ...currentAccount.value,
        workspaces: [...currentAccount.value.workspaces, reference],
      },
    },
    {
      key: draftKey(hash),
      before: saved.raw,
      after: { ...draft, completed },
      ttlSeconds: Math.max(1, Math.ceil((draft.expiresAt - Date.now()) / 1000)),
    },
  ]);
  const verified = (await loadWorkspace(store, account.id, workspace.slug))
    .workspace;
  const owner = (await store.read<Account>(accountKey(account.email))).value;
  if (
    !verified.calendarBatches?.some(
      (b) => b.id === batch.id && b.requestHash === batch.requestHash,
    ) ||
    !owner?.workspaces.some(
      (w) => w.id === workspace.id && w.creationHash === creationHash,
    )
  )
    throw new Error("WRITE_UNCONFIRMED");
  return completed;
}
