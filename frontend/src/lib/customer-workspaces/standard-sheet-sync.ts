import { randomUUID } from "node:crypto";
import { loadWorkspace } from "./service.ts";
import { spreadsheetId } from "./customer-google.ts";
import type { CustomerStore } from "./store.ts";
import type { Workspace } from "./types.ts";
import {
  STANDARD_SHEET_MARKER,
  LEGACY_COLUMN_COUNTS,
  V3_COLUMN_COUNTS,
  STANDARD_SHEET_TABS,
  STANDARD_SHEET_VERSION,
} from "./standard-sheet-schema.ts";
import {
  buildStandardWorkbook,
  standardContentHash,
  standardHash,
  type StandardWorkbook,
} from "./standard-sheet.ts";
import {
  GoogleStandardSheetGateway,
  type StandardSheetGateway,
  type StandardSnapshot,
} from "./standard-sheet-google.ts";

export type StandardBinding = {
  workspaceId: string;
  spreadsheetId: string;
  url: string;
  linkedAt: string;
  linkedBy: string;
  exportedVersion?: number;
  exportedHash?: string;
  generation?: string;
  synchronizedAt?: string;
  lastError?: string;
  attemptedAt?: string;
  pendingExport?: {
    version: number;
    generation: string;
    contentHash: string;
    generatedAt: string;
  };
};
type Lease = { token: string; expiresAt: number };
const bindingKey = (id: string) => `standard-sheet:${id}`;
function metadata(snapshot: StandardSnapshot) {
  const entries = snapshot.tables.meta.slice(1);
  const meta = Object.fromEntries(
    entries.map(([key, value]) => [String(key), value]),
  );
  if (
    new Set(entries.map(([key]) => key)).size !== entries.length ||
    meta.format !== STANDARD_SHEET_MARKER ||
    ![1, 2, 3, STANDARD_SHEET_VERSION].includes(Number(meta.schema_version))
  )
    throw new Error("STANDARD_LAYOUT_CHANGED");
  if (
    (meta.schema_version === 1 &&
      (snapshot.tables.calendarSources?.length ||
        snapshot.tables.blocks?.length)) ||
    (Number(meta.schema_version) >= 2 &&
      (!snapshot.tables.calendarSources?.length ||
        !snapshot.tables.blocks?.length))
  )
    throw new Error("STANDARD_LAYOUT_CHANGED");
  for (const tab of STANDARD_SHEET_TABS) {
    if (!snapshot.tables[tab.key]?.length) continue;
    const count =
      Number(meta.schema_version) < 3
        ? (LEGACY_COLUMN_COUNTS[tab.key] ?? tab.columns.length)
        : Number(meta.schema_version) === 3 ? (V3_COLUMN_COUNTS[tab.key] ?? tab.columns.length) : tab.columns.length;
    if (snapshot.tables[tab.key][0].length !== count)
      throw new Error("STANDARD_LAYOUT_CHANGED");
  }
  if (standardContentHash(snapshot.tables) !== meta.content_hash)
    throw new Error("STANDARD_EXTERNAL_CHANGE");
  return meta;
}
function sourceIds(workspace: Workspace) {
  const values = new Set(
    workspace.importBatches?.map((b) => b.source.spreadsheetId) ?? [],
  );
  for (const url of [
    workspace.onboarding?.sheetUrl,
    ...workspace.properties.map((p) => p.setup?.sheetUrl),
  ])
    if (url) values.add(spreadsheetId(url));
  return values;
}
function targetAllowed(workspace: Workspace, id: string) {
  if (sourceIds(workspace).has(id))
    throw new Error("STANDARD_SOURCE_IS_TARGET");
  if (process.env.CUSTOMER_STANDARD_SHEET_TEMPLATE_ID === id)
    throw new Error("STANDARD_MASTER_TEMPLATE");
}
async function ownerWorkspace(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  const loaded = await loadWorkspace(store, accountId, slug);
  if (loaded.member.role !== "owner" || !loaded.member.allProperties)
    throw new Error("FORBIDDEN");
  return loaded.workspace;
}
export async function standardSheetStatus(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  const workspace = await ownerWorkspace(store, accountId, slug);
  const binding = (await store.read<StandardBinding>(bindingKey(workspace.id)))
    .value;
  if (!binding)
    return { state: "unlinked" as const, workspaceVersion: workspace.version };
  if (binding.workspaceId !== workspace.id)
    throw new Error("STANDARD_TARGET_CONFLICT");
  return {
    state: binding.lastError
      ? ("error" as const)
      : binding.exportedVersion === workspace.version
        ? ("synced" as const)
        : ("pending" as const),
    url: binding.url,
    workspaceVersion: workspace.version,
    exportedVersion: binding.exportedVersion,
    synchronizedAt: binding.synchronizedAt,
    error: binding.lastError,
  };
}
async function lease(store: CustomerStore, workspaceId: string) {
  const key = `standard-lock:${workspaceId}`,
    current = await store.read<Lease>(key);
  if (current.value && current.value.expiresAt > Date.now())
    throw new Error("STANDARD_SYNC_BUSY");
  const value: Lease = { token: randomUUID(), expiresAt: Date.now() + 180000 };
  await store.commit([
    { key, before: current.raw, after: value, ttlSeconds: 240 },
  ]);
  return {
    async check() {
      const saved = (await store.read<Lease>(key)).value;
      if (saved?.token !== value.token || saved.expiresAt < Date.now() + 40000)
        throw new Error("STANDARD_SYNC_BUSY");
    },
    async release() {
      const saved = await store.read<Lease>(key);
      if (saved.value?.token === value.token)
        await store.commit([
          { key, before: saved.raw, after: null, ttlSeconds: 1 },
        ]);
    },
  };
}
async function bind(
  store: CustomerStore,
  accountId: string,
  workspace: Workspace,
  id: string,
  gateway: StandardSheetGateway,
) {
  targetAllowed(workspace, id);
  const key = bindingKey(workspace.id),
    current = await store.read<StandardBinding>(key);
  if (current.value) {
    if (
      current.value.spreadsheetId !== id ||
      current.value.workspaceId !== workspace.id
    )
      throw new Error("STANDARD_TARGET_CONFLICT");
    return current.value;
  }
  const target = await gateway.read(id),
    meta = metadata(target);
  // New target files are blank copies of our template, not arbitrary Sheets.
  if (
    meta.workspace_id ||
    ["orders", "nights", "payments", "sources"].some(
      (key) => target.tables[key as keyof typeof target.tables].length > 1,
    )
  )
    throw new Error("STANDARD_TARGET_NOT_EMPTY");
  const claimKey = `standard-target:${id}`,
    claim = await store.read<{ workspaceId: string }>(claimKey);
  if (claim.value && claim.value.workspaceId !== workspace.id)
    throw new Error("STANDARD_TARGET_CONFLICT");
  const next: StandardBinding = {
    workspaceId: workspace.id,
    spreadsheetId: id,
    url: target.url,
    linkedAt: new Date().toISOString(),
    linkedBy: accountId,
  };
  await store.commit([
    { key, before: current.raw, after: next },
    { key: claimKey, before: claim.raw, after: { workspaceId: workspace.id } },
  ]);
  const saved = (await store.read<StandardBinding>(key)).value;
  if (saved?.spreadsheetId !== id || saved.workspaceId !== workspace.id)
    throw new Error("WRITE_UNCONFIRMED");
  return saved;
}
export async function bindStandardSheet(
  store: CustomerStore,
  accountId: string,
  slug: string,
  url: unknown,
  gateway: StandardSheetGateway = new GoogleStandardSheetGateway(),
) {
  const workspace = await ownerWorkspace(store, accountId, slug),
    id = spreadsheetId(url);
  const lock = await lease(store, workspace.id);
  try {
    return await bind(store, accountId, workspace, id, gateway);
  } finally {
    await lock.release();
  }
}
export async function createStandardSheet(
  store: CustomerStore,
  accountId: string,
  slug: string,
  gateway: StandardSheetGateway = new GoogleStandardSheetGateway(),
) {
  const workspace = await ownerWorkspace(store, accountId, slug);
  const lock = await lease(store, workspace.id);
  try {
    const existing = (
      await store.read<StandardBinding>(bindingKey(workspace.id))
    ).value;
    if (existing) return existing;
    if (!gateway.create) throw new Error("STANDARD_SETUP_REQUIRED");
    const key = `standard-create:${workspace.id}`;
    const previous = await store.read<{
      spreadsheetId?: string;
      attemptedAt: string;
    }>(key);
    let id = previous.value?.spreadsheetId;
    if (!id) {
      await store.commit([
        {
          key,
          before: previous.raw,
          after: {
            attemptedAt:
              previous.value?.attemptedAt ?? new Date().toISOString(),
          },
        },
      ]);
      try {
        id = await gateway.create(workspace.id, workspace.name, {
          lookupOnly: Boolean(previous.value),
        });
      } catch (error) {
        if (
          !previous.value &&
          error instanceof Error &&
          error.message !== "STANDARD_CREATE_UNCERTAIN"
        ) {
          const saved = await store.read(key);
          await store.commit([{ key, before: saved.raw, after: null }]);
        }
        throw error;
      }
      const saved = await store.read(key);
      await store.commit([
        {
          key,
          before: saved.raw,
          after: {
            attemptedAt:
              previous.value?.attemptedAt ?? new Date().toISOString(),
            spreadsheetId: id,
          },
        },
      ]);
    }
    return await bind(store, accountId, workspace, id, gateway);
  } finally {
    await lock.release();
  }
}
function assertSnapshot(
  snapshot: StandardSnapshot,
  workspace: Workspace,
  binding: StandardBinding,
) {
  const meta = metadata(snapshot);
  if (
    snapshot.spreadsheetId !== binding.spreadsheetId ||
    (meta.workspace_id && meta.workspace_id !== workspace.id)
  )
    throw new Error("STANDARD_TARGET_CONFLICT");
  const pending = binding.pendingExport;
  const planned =
    pending &&
    meta.workspace_id === workspace.id &&
    meta.generation === pending.generation &&
    meta.content_hash === pending.contentHash &&
    meta.workspace_version === pending.version &&
    pending.version <= workspace.version;
  const saved =
    binding.generation &&
    meta.generation === binding.generation &&
    meta.content_hash === binding.exportedHash &&
    meta.workspace_version === binding.exportedVersion;
  const empty =
    !meta.workspace_id &&
    [
      "orders",
      "nights",
      "payments",
      "sources",
      "calendarSources",
      "blocks",
    ].every(
      (key) =>
        (snapshot.tables[key as keyof typeof snapshot.tables]?.length ?? 0) <=
        1,
    );
  if (!planned && !saved && !(empty && !binding.generation))
    throw new Error("STANDARD_EXTERNAL_CHANGE");
  return meta;
}
function equalTables(
  a: StandardWorkbook["tables"],
  b: StandardWorkbook["tables"],
) {
  const clean = (tables: StandardWorkbook["tables"]) =>
    STANDARD_SHEET_TABS.map((t) => [
      t.key,
      (tables[t.key] ?? []).map((row) => row.map((c) => (c === "" ? null : c))),
    ]);
  return standardHash(clean(a)) === standardHash(clean(b));
}
// Internal worker: caller has already validated the workspace mutation. It
// returns no workbook cells to that caller and never widens their read scope.
export async function synchronizeStandardSheet(
  store: CustomerStore,
  workspaceId: string,
  gateway: StandardSheetGateway = new GoogleStandardSheetGateway(),
) {
  if (!(await store.read<StandardBinding>(bindingKey(workspaceId))).value)
    return { state: "unlinked" as const };
  const lock = await lease(store, workspaceId);
  try {
    let result: { state: "synced" | "pending"; version: number } | null = null;
    // Coalesce a concurrent booking edit once; any later change remains visibly
    // pending by comparing exportedVersion with the durable workspace version.
    for (let attempt = 0; attempt < 2; attempt++) {
      const ws = await store.read<Workspace>(`workspace:${workspaceId}`),
        workspace = ws.value;
      let current = await store.read<StandardBinding>(bindingKey(workspaceId));
      const binding = current.value;
      if (
        !workspace ||
        workspace.id !== workspaceId ||
        !binding ||
        binding.workspaceId !== workspaceId
      )
        throw new Error("STANDARD_TARGET_CONFLICT");
      targetAllowed(workspace, binding.spreadsheetId);
      const snapshot = await gateway.read(binding.spreadsheetId);
      const meta = assertSnapshot(snapshot, workspace, binding);
      const book = buildStandardWorkbook(workspace, {
        generatedAt:
          meta.workspace_version === workspace.version
            ? String(meta.generated_at)
            : new Date().toISOString(),
      });
      await lock.check();
      if (!equalTables(snapshot.tables, book.tables)) {
        const pendingExport = {
          version: book.workspaceVersion,
          generation: book.generation,
          contentHash: book.contentHash,
          generatedAt: book.generatedAt,
        };
        await store.commit([
          {
            key: bindingKey(workspaceId),
            before: current.raw,
            after: { ...binding, pendingExport },
          },
        ]);
        current = await store.read<StandardBinding>(bindingKey(workspaceId));
        if (current.value?.pendingExport?.generation !== book.generation)
          throw new Error("WRITE_UNCONFIRMED");
        await lock.check();
        await gateway.write(snapshot, book);
      }
      const verified = await gateway.read(binding.spreadsheetId);
      if (!equalTables(verified.tables, book.tables))
        throw new Error("STANDARD_WRITE_UNCONFIRMED");
      await store.commit([
        {
          key: bindingKey(workspaceId),
          before: current.raw,
          after: {
            ...binding,
            exportedVersion: workspace.version,
            exportedHash: book.contentHash,
            generation: book.generation,
            synchronizedAt: new Date().toISOString(),
            attemptedAt: new Date().toISOString(),
            lastError: undefined,
            pendingExport: undefined,
          } satisfies StandardBinding,
        },
      ]);
      const latest = (await store.read<Workspace>(`workspace:${workspaceId}`))
        .value;
      result = {
        state: latest?.version === workspace.version ? "synced" : "pending",
        version: workspace.version,
      };
      if (result.state === "synced") return result;
    }
    return result!;
  } catch (error) {
    const code =
      error instanceof Error && error.message.startsWith("STANDARD_")
        ? error.message
        : "STANDARD_WRITE_UNCONFIRMED";
    const current = await store.read<StandardBinding>(bindingKey(workspaceId));
    if (current.value) {
      try {
        await store.commit([
          {
            key: bindingKey(workspaceId),
            before: current.raw,
            after: {
              ...current.value,
              lastError: code,
              attemptedAt: new Date().toISOString(),
            },
          },
        ]);
      } catch {
        /* Existing version mismatch still leaves the projection pending. */
      }
    }
    throw new Error(code);
  } finally {
    await lock.release();
  }
}
export async function syncStandardSheet(
  store: CustomerStore,
  accountId: string,
  slug: string,
  gateway: StandardSheetGateway = new GoogleStandardSheetGateway(),
) {
  const workspace = await ownerWorkspace(store, accountId, slug);
  await synchronizeStandardSheet(store, workspace.id, gateway);
  return standardSheetStatus(store, accountId, slug);
}
export async function standardWorkbookForOwner(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  return buildStandardWorkbook(await ownerWorkspace(store, accountId, slug));
}
