import { randomUUID } from "node:crypto";
import { bookingsOverlap } from "./domain.ts";
import { digest } from "./auth.ts";
import { loadWorkspace } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Booking } from "./types.ts";
import {
  normalizeSheet,
  importFingerprint,
  NORMALIZATION_VERSION,
} from "./sheet-normalizer.ts";
import type {
  Mapping,
  SheetSource,
  NormalizedOrder,
} from "./sheet-normalizer.ts";
export type { Mapping, SheetSource } from "./sheet-normalizer.ts";
export type PreviewRow = NormalizedOrder;
export type ImportPreview = {
  id: string;
  accountId: string;
  workspaceId: string;
  propertyId: string;
  coverageFrom?: string;
  version: number;
  expiresAt: number;
  sourceKey: string;
  sourceTitle: string;
  sourceHash: string;
  mapping?: Mapping;
  source: {
    spreadsheetId: string;
    sheetId: number;
    headerRow: number;
    columns: Record<string, number>;
  };
  rows: PreviewRow[];
};
export async function importAccess(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: unknown,
) {
  const loaded = await loadWorkspace(store, accountId, slug);
  if (!["owner", "admin"].includes(loaded.member.role))
    throw new Error("FORBIDDEN");
  const property = loaded.workspace.properties.find(
    (p) =>
      p.id === propertyId &&
      (loaded.member.allProperties || loaded.member.propertyIds.includes(p.id)),
  );
  if (!property) throw new Error("NOT_FOUND");
  if (property.sourceMode !== "native") throw new Error("INVALID_INPUT");
  return { ...loaded, property };
}
export function overlaps(
  a: Pick<Booking, "roomIds" | "checkIn" | "checkOut" | "stays">,
  b: Pick<Booking, "roomIds" | "checkIn" | "checkOut" | "stays">,
) {
  return bookingsOverlap(a, b);
}
export async function previewImport(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  source: SheetSource,
  mapping: Mapping,
) {
  const { workspace, property } = await importAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  const sourceKey = digest(`${source.spreadsheetId}:${source.sheetId}`);
  const active = workspace.bookings.filter(
    (b) => b.propertyId === propertyId && b.status !== "cancelled",
  );
  const prior = workspace.bookings.filter(
    (b) => b.propertyId === propertyId && b.imported,
  );
  const rows = normalizeSheet(source, mapping, property);
  for (const row of rows) {
    if (!row.draft) continue;
    const draft = row.draft;
    if (draft.checkOut <= mapping.from) row.issues.push("已在選定範圍之前退房");
    if (
      prior.some(
        (b) =>
          b.imported?.fingerprint === row.fingerprint ||
          (draft.externalId &&
            b.imported?.sourceKey === sourceKey &&
            b.imported?.externalId === draft.externalId),
      )
    )
      row.issues.push("已匯入，或相同來源訂單有變更；請核對既有訂單");
    if (active.some((b) => overlaps(b, draft)))
      row.issues.push("與現有訂房衝突");
    if (
      rows.some(
        (other) =>
          other !== row &&
          other.draft &&
          (other.fingerprint === row.fingerprint ||
            overlaps(other.draft, draft)),
      )
    )
      row.issues.push("來源內有重複或重疊訂房，請核對整組資料");
  }
  const preview: ImportPreview = {
    id: randomUUID(),
    accountId,
    workspaceId: workspace.id,
    propertyId,
    coverageFrom: mapping.from,
    version: workspace.version,
    expiresAt: Date.now() + 3600000,
    sourceKey,
    sourceTitle: source.title,
    sourceHash: digest(JSON.stringify(source.rows)),
    mapping,
    source: {
      spreadsheetId: source.spreadsheetId,
      sheetId: source.sheetId,
      headerRow: mapping.headerRow,
      columns: mapping.columns,
    },
    rows,
  };
  await store.commit([
    {
      key: `import-preview:${preview.id}`,
      before: null,
      after: preview,
      ttlSeconds: 3600,
    },
  ]);
  return preview;
}
export async function commitImport(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  previewId: unknown,
  selected: unknown,
  confirmedEmpty = false,
) {
  const { raw, workspace } = await importAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (
    typeof previewId !== "string" ||
    !/^[\w-]{36}$/.test(previewId) ||
    !Array.isArray(selected) ||
    selected.length > 500 ||
    selected.some((n) => !Number.isInteger(n))
  )
    throw new Error("INVALID_INPUT");
  const selection = [...new Set(selected as number[])].sort((a, b) => a - b);
  if (!selection.length && !confirmedEmpty)
    throw new Error("FORMAT_CONFIRMATION_REQUIRED");
  const selectionHash = digest(JSON.stringify(selection));
  const existing = workspace.importBatches?.find(
    (b) =>
      b.id === previewId &&
      b.actor === accountId &&
      b.propertyId === propertyId,
  );
  if (existing) {
    if (existing.selectionHash !== selectionHash)
      throw new Error("IDEMPOTENCY_CONFLICT");
    return existing;
  }
  const preview = (
    await store.read<ImportPreview>(`import-preview:${previewId}`)
  ).value;
  if (
    !preview ||
    preview.accountId !== accountId ||
    preview.workspaceId !== workspace.id ||
    preview.propertyId !== propertyId
  )
    throw new Error("NOT_FOUND");
  if (preview.expiresAt < Date.now()) throw new Error("IMPORT_EXPIRED");
  if (
    !selection.length &&
    !preview.rows.every((row) => row.issues.includes("已在選定範圍之前退房"))
  )
    throw new Error("INVALID_INPUT");
  if (preview.version !== workspace.version)
    throw new Error("VERSION_CONFLICT");
  const rows = selection.map((n) => preview.rows.find((r) => r.row === n));
  if (rows.some((r) => !r?.draft || r.issues.length))
    throw new Error("INVALID_INPUT");
  if (workspace.bookings.length + rows.length > 5000)
    throw new Error("LIMIT_REACHED");
  const at = new Date().toISOString();
  const bookings: Booking[] = rows.map((r) => {
    const { externalId, ...draft } = r!.draft!;
    return {
      ...draft,
      id: randomUUID(),
      version: 1,
      propertyId,
      payments: [],
      contact: null,
      notes: null,
      status: "confirmed",
      guestNotified: false,
      createdAt: at,
      actor: accountId,
      entry: "sheet",
      requestKey: `${previewId}:${r!.row}`,
      requestHash: r!.fingerprint,
      imported: {
        batchId: previewId,
        sourceKey: preview.sourceKey,
        fingerprint: r!.fingerprint,
        externalId,
        row: r!.sourceRows?.[0] ?? r!.row,
        sourceRows: r!.sourceRows,
        references: r!.references,
        normalizationVersion: NORMALIZATION_VERSION,
      },
    };
  });
  // Check again at the final write, then CAS prevents concurrent inventory changes.
  if (
    bookings.some(
      (b, i) =>
        workspace.bookings.some(
          (old) =>
            old.propertyId === propertyId &&
            old.status !== "cancelled" &&
            overlaps(old, b),
        ) || bookings.slice(0, i).some((other) => overlaps(other, b)),
    )
  )
    throw new Error("ROOM_CONFLICT");
  const batch = {
    id: previewId,
    actor: accountId,
    propertyId,
    createdAt: at,
    sourceTitle: preview.sourceTitle,
    source: preview.source,
    selectionHash,
    bookingIds: bookings.map((b) => b.id),
  };
  const unresolvedCount = preview.rows.filter(
    (row) =>
      !row.issues.includes("已在選定範圍之前退房") &&
      ![...workspace.bookings, ...bookings].some(
        (b) =>
          b.status !== "cancelled" &&
          b.propertyId === propertyId &&
          b.imported?.sourceKey === preview.sourceKey &&
          b.imported.fingerprint === row.fingerprint,
      ),
  ).length;
  await store.commit([
    {
      key: `workspace:${workspace.id}`,
      before: raw,
      after: {
        ...workspace,
        version: workspace.version + 1,
        bookings: [...workspace.bookings, ...bookings],
        properties: workspace.properties.map((p) =>
          p.id === propertyId
            ? {
                ...p,
                setup: {
                  ...(p.setup ?? { mode: "sheet" }),
                  readyAt: p.setup?.readyAt ?? at,
                  unresolvedCount,
                  ...(preview.coverageFrom
                    ? { coverageFrom: preview.coverageFrom }
                    : {}),
                },
              }
            : p,
        ),
        ...(workspace.onboarding && workspace.properties[0]?.id === propertyId
          ? {
              onboarding: {
                ...workspace.onboarding,
                readyAt: workspace.onboarding.readyAt ?? at,
                unresolvedCount,
              },
            }
          : {}),
        importBatches: [...(workspace.importBatches ?? []), batch],
        audit: [
          ...workspace.audit,
          {
            at,
            actor: accountId,
            action: "sheet.imported",
            targetId: batch.id,
          },
        ],
      },
    },
  ]);
  const verified = (await loadWorkspace(store, accountId, slug)).workspace;
  if (
    !verified.importBatches?.some((b) => b.id === batch.id) ||
    !bookings.every((b) =>
      verified.bookings.some(
        (saved) => saved.id === b.id && saved.requestHash === b.requestHash,
      ),
    )
  )
    throw new Error("WRITE_UNCONFIRMED");
  return batch;
}
export async function undoImport(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  batchId: unknown,
  version: unknown,
) {
  const { raw, workspace } = await importAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  const batch = workspace.importBatches?.find(
    (b) => b.id === batchId && b.propertyId === propertyId,
  );
  if (!batch) throw new Error("NOT_FOUND");
  if (!batch.bookingIds.length) throw new Error("INVALID_INPUT");
  if (batch.undo) return batch.undo;
  if (workspace.version !== version) throw new Error("VERSION_CONFLICT");
  const undo = { cancelled: [] as string[], skipped: [] as string[] };
  const bookings = workspace.bookings.map((b) => {
    if (!batch.bookingIds.includes(b.id)) return b;
    const unchanged =
      importFingerprint({
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        roomIds: b.roomIds,
        guestName: b.guestName,
        externalId: b.imported?.externalId ?? null,
        total: b.total,
        importedFinance: b.importedFinance,
        ...(b.stays ? { stays: b.stays } : {}),
        ...(b.nightlyPrices ? { nightlyPrices: b.nightlyPrices } : {}),
      }) === b.imported?.fingerprint;
    if (
      b.version !== 1 ||
      !unchanged ||
      b.payments.length ||
      b.notes ||
      b.contact ||
      b.status !== "confirmed" ||
      b.imported?.batchId !== batch.id
    ) {
      undo.skipped.push(b.id);
      return b;
    }
    undo.cancelled.push(b.id);
    return { ...b, status: "cancelled" as const, version: b.version + 1 };
  });
  await store.commit([
    {
      key: `workspace:${workspace.id}`,
      before: raw,
      after: {
        ...workspace,
        version: workspace.version + 1,
        bookings,
        properties: workspace.properties.map((p) =>
          p.id === propertyId
            ? {
                ...p,
                setup: {
                  ...(p.setup ?? { mode: "sheet" }),
                  unresolvedCount:
                    (p.setup?.unresolvedCount ?? 0) + undo.cancelled.length,
                },
              }
            : p,
        ),
        ...(workspace.onboarding && workspace.properties[0]?.id === propertyId
          ? {
              onboarding: {
                ...workspace.onboarding,
                unresolvedCount:
                  (workspace.onboarding.unresolvedCount ?? 0) +
                  undo.cancelled.length,
              },
            }
          : {}),
        importBatches: workspace.importBatches!.map((b) =>
          b.id === batch.id ? { ...b, undo } : b,
        ),
        audit: [
          ...workspace.audit,
          {
            at: new Date().toISOString(),
            actor: accountId,
            action: "sheet.undo",
            targetId: batch.id,
          },
        ],
      },
    },
  ]);
  const verified = (await loadWorkspace(store, accountId, slug)).workspace;
  const saved = verified.importBatches?.find((b) => b.id === batch.id);
  if (
    !saved?.undo ||
    !undo.cancelled.every((id) =>
      verified.bookings.some((b) => b.id === id && b.status === "cancelled"),
    )
  )
    throw new Error("WRITE_UNCONFIRMED");
  return saved.undo;
}
