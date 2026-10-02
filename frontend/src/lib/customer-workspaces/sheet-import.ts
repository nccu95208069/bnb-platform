import { randomUUID } from "node:crypto";
import { digest } from "./auth.ts";
import { dateValue, loadWorkspace, textValue } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Booking } from "./types.ts";
export type SheetSource = {
  spreadsheetId: string;
  sheetId: number;
  title: string;
  rows: string[][];
};
export type Mapping = {
  headerRow: number;
  columns: {
    checkIn: number;
    checkOut: number;
    rooms: number;
    guestName: number;
    externalId: number;
    total: number;
    received: number;
  };
  roomMap: Record<string, string[]>;
  granularity: "order";
  amountBasis: "order" | "night" | "none";
  receivedMeaning: "property" | "guest" | "none";
  currency: "TWD";
  from: string;
};
type Draft = Pick<
  Booking,
  "guestName" | "checkIn" | "checkOut" | "roomIds" | "total" | "importedFinance"
> & { externalId: string | null };
export type PreviewRow = {
  row: number;
  draft: Draft | null;
  issues: string[];
  fingerprint: string;
};
export type ImportPreview = {
  id: string;
  accountId: string;
  workspaceId: string;
  propertyId: string;
  version: number;
  expiresAt: number;
  sourceKey: string;
  sourceTitle: string;
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
function amount(value: string) {
  if (!value.trim()) return null;
  // No currencies, formulas, parentheses, implicit negatives or ambiguous grouping.
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value.trim()))
    throw new Error("金額格式不明，請先整理來源");
  const n = Number(value.replaceAll(",", ""));
  if (n > 100000000) throw new Error("金額超出範圍");
  return n;
}
function sheetDate(value: string) {
  const m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value.trim());
  if (!m) throw new Error("日期需包含西元年，例如 2026-10-02");
  try {
    return dateValue(
      `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`,
    );
  } catch {
    throw new Error("日期不存在或超出範圍");
  }
}
export function overlaps(
  a: Pick<Booking, "roomIds" | "checkIn" | "checkOut">,
  b: Pick<Booking, "roomIds" | "checkIn" | "checkOut">,
) {
  return (
    a.checkIn < b.checkOut &&
    b.checkIn < a.checkOut &&
    a.roomIds.some((id) => b.roomIds.includes(id))
  );
}
function validateMapping(m: Mapping) {
  if (
    !m ||
    m.granularity !== "order" ||
    m.currency !== "TWD" ||
    !["order", "night", "none"].includes(m.amountBasis) ||
    !["property", "guest", "none"].includes(m.receivedMeaning) ||
    !Number.isInteger(m.headerRow) ||
    m.headerRow < 1 ||
    m.headerRow > 20 ||
    !m.columns ||
    !m.roomMap ||
    typeof m.roomMap !== "object" ||
    Array.isArray(m.roomMap)
  )
    throw new Error("INVALID_INPUT");
  dateValue(m.from);
  const required = ["checkIn", "checkOut", "rooms"];
  const used: number[] = [];
  for (const key of [
    "checkIn",
    "checkOut",
    "rooms",
    "guestName",
    "externalId",
    "total",
    "received",
  ] as const) {
    const index = m.columns[key];
    if (
      !Number.isInteger(index) ||
      index < -1 ||
      index > 51 ||
      (required.includes(key) && index < 0)
    )
      throw new Error("INVALID_INPUT");
    if (index >= 0) used.push(index);
  }
  if (
    new Set(used).size !== used.length ||
    (m.amountBasis === "none") !== (m.columns.total === -1) ||
    (m.receivedMeaning === "none") !== (m.columns.received === -1)
  )
    throw new Error("INVALID_INPUT");
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
  validateMapping(mapping);
  if (source.rows.length > 501 || source.rows.length <= mapping.headerRow)
    throw new Error("IMPORT_SIZE");
  const sourceKey = digest(`${source.spreadsheetId}:${source.sheetId}`);
  const active = workspace.bookings.filter(
    (b) => b.propertyId === propertyId && b.status !== "cancelled",
  );
  const prior = workspace.bookings.filter(
    (b) => b.propertyId === propertyId && b.imported,
  );
  const cell = (r: string[], index: number) =>
    index < 0 ? "" : (r[index] ?? "").trim();
  const rows: PreviewRow[] = source.rows
    .slice(mapping.headerRow)
    .flatMap((r, index) => {
      if (r.every((c) => !c.trim())) return [];
      const result: PreviewRow = {
        row: mapping.headerRow + index + 1,
        draft: null,
        issues: [],
        fingerprint: "",
      };
      try {
        const c = mapping.columns,
          checkIn = sheetDate(cell(r, c.checkIn)),
          checkOut = sheetDate(cell(r, c.checkOut));
        const nights = (Date.parse(checkOut) - Date.parse(checkIn)) / 86400000;
        if (nights < 1 || nights > 366)
          throw new Error("退房日期需晚於入住，最長 366 晚");
        const label = cell(r, c.rooms);
        const roomIds = mapping.roomMap[label];
        if (
          !Array.isArray(roomIds) ||
          !roomIds.length ||
          roomIds.some((id) => !property.rooms.some((room) => room.id === id))
        )
          throw new Error("房間尚未對應");
        if (
          property.kind === "villa" &&
          property.villaRoomIds.some((id) => !roomIds.includes(id))
        )
          throw new Error("包棟旅宿需包含全部實體房間");
        const total = amount(cell(r, c.total)),
          received = amount(cell(r, c.received));
        const draft: Draft = {
          checkIn,
          checkOut,
          roomIds: [...new Set(roomIds)].sort(),
          guestName: textValue(cell(r, c.guestName), 100),
          externalId: textValue(cell(r, c.externalId), 200),
          total:
            total === null
              ? null
              : Math.round(
                  total * (mapping.amountBasis === "night" ? nights : 1) * 100,
                ) / 100,
          importedFinance: {
            currency: "TWD",
            amountBasis: mapping.amountBasis,
            sourceAmount: total,
            receivedMeaning: mapping.receivedMeaning,
            propertyReceived:
              mapping.receivedMeaning === "property" ? received : null,
            guestPaid: mapping.receivedMeaning === "guest" ? received : null,
          },
        };
        if (draft.total !== null && draft.total > 100000000)
          throw new Error("金額超出範圍");
        result.draft = draft;
        result.fingerprint = digest(JSON.stringify(draft));
        if (checkOut <= mapping.from)
          result.issues.push("已在選定範圍之前退房");
        if (
          prior.some(
            (b) =>
              b.imported?.fingerprint === result.fingerprint ||
              (draft.externalId &&
                b.imported?.sourceKey === sourceKey &&
                b.imported?.externalId === draft.externalId),
          )
        )
          result.issues.push("已匯入，或相同來源訂單有變更；請核對既有訂單");
        if (active.some((b) => overlaps(b, draft)))
          result.issues.push("與現有訂房衝突");
      } catch (e) {
        result.issues.push(
          e instanceof Error && e.message !== "INVALID_INPUT"
            ? e.message
            : "欄位內容超出限制",
        );
      }
      return [result];
    });
  // Block all rows in ambiguous groups, including rows outside the date filter.
  const externalCounts = new Map<string, number>();
  for (const r of source.rows.slice(mapping.headerRow)) {
    const externalId = cell(r, mapping.columns.externalId);
    if (externalId)
      externalCounts.set(externalId, (externalCounts.get(externalId) ?? 0) + 1);
  }
  for (const row of rows) {
    if (!row.draft) continue;
    const draft = row.draft;
    if (draft.externalId && (externalCounts.get(draft.externalId) ?? 0) > 1)
      row.issues.push("同一訂單編號有多列，請先合併成一筆完整訂單");
    if (
      rows.some(
        (other) =>
          other !== row &&
          other.draft &&
          (other.fingerprint === row.fingerprint ||
            overlaps(other.draft, draft)),
      )
    )
      row.issues.push("來源內有重複或重疊訂房，請先整理");
  }
  const preview: ImportPreview = {
    id: randomUUID(),
    accountId,
    workspaceId: workspace.id,
    propertyId,
    version: workspace.version,
    expiresAt: Date.now() + 3600000,
    sourceKey,
    sourceTitle: source.title,
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
    !selected.length ||
    selected.length > 500 ||
    selected.some((n) => !Number.isInteger(n))
  )
    throw new Error("INVALID_INPUT");
  const selection = [...new Set(selected as number[])].sort((a, b) => a - b);
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
        row: r!.row,
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
  await store.commit([
    {
      key: `workspace:${workspace.id}`,
      before: raw,
      after: {
        ...workspace,
        version: workspace.version + 1,
        bookings: [...workspace.bookings, ...bookings],
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
  if (batch.undo) return batch.undo;
  if (workspace.version !== version) throw new Error("VERSION_CONFLICT");
  const undo = { cancelled: [] as string[], skipped: [] as string[] };
  const bookings = workspace.bookings.map((b) => {
    if (!batch.bookingIds.includes(b.id)) return b;
    const unchanged =
      digest(
        JSON.stringify({
          checkIn: b.checkIn,
          checkOut: b.checkOut,
          roomIds: b.roomIds,
          guestName: b.guestName,
          externalId: b.imported?.externalId ?? null,
          total: b.total,
          importedFinance: b.importedFinance,
        }),
      ) === b.imported?.fingerprint;
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
