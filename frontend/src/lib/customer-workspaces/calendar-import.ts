import { randomUUID } from "node:crypto";
import { calendarJobChanges } from "./calendar-jobs.ts";
import { digest } from "./auth.ts";
import { importAccess } from "./sheet-import.ts";
import {
  bookingsOverlap,
  financeSummary,
  propertyReadiness,
} from "./domain.ts";
import { loadWorkspace } from "./service.ts";
import {
  calendarFiles,
  parseCalendarFiles,
  calendarRange,
  calendarContentHash,
} from "./calendar-source.ts";
import { normalizeCalendar } from "./calendar-normalizer.ts";
import {
  isCalendarKind,
  type CalendarKind,
  type CalendarSnapshot,
  type CalendarPreview,
  type CalendarBatch,
  type CalendarBinding,
  type CalendarReference,
  type InventoryBlock,
  type CalendarPreviewRow,
} from "./calendar-types.ts";
import type { CustomerStore } from "./store.ts";
import type { Booking, Workspace } from "./types.ts";

export async function calendarAccess(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: unknown,
) {
  const context = await importAccess(store, accountId, slug, propertyId);
  const { workspace, property } = context;
  if (
    property.setup?.sheetUrl ||
    (workspace.properties[0]?.id === property.id &&
      workspace.onboarding?.sheetUrl)
  )
    throw new Error("SOURCE_LOCKED");
  return context;
}
export async function stageCalendar(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  input: Omit<
    CalendarSnapshot,
    | "id"
    | "workspaceId"
    | "propertyId"
    | "actor"
    | "createdAt"
    | "expiresAt"
    | "contentHash"
  >,
) {
  const { workspace } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (!isCalendarKind(input.kind)) throw new Error("INVALID_INPUT");
  calendarRange(input.from, input.to, input.timezone);
  const snapshot: CalendarSnapshot = {
    ...input,
    id: randomUUID(),
    workspaceId: workspace.id,
    propertyId,
    actor: accountId,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + 3600000,
    contentHash: calendarContentHash(input.events, input.calendars),
  };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 6 * 1024 * 1024)
    throw new Error("CALENDAR_SIZE");
  await store.commit([
    {
      key: `calendar-snapshot:${snapshot.id}`,
      before: null,
      after: snapshot,
      ttlSeconds: 3600,
    },
  ]);
  return snapshot;
}
export async function uploadCalendar(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  buffer: Buffer,
  filename: string,
  input: { kind: CalendarKind; from: string; to: string; timezone: string },
) {
  await calendarAccess(store, accountId, slug, propertyId);
  const range = calendarRange(input.from, input.to, input.timezone);
  const source = parseCalendarFiles(
    await calendarFiles(buffer, filename),
    range,
  );
  return stageCalendar(store, accountId, slug, propertyId, {
    ...source,
    ...range,
    kind: input.kind,
    transport: "file",
  });
}
export async function calendarSnapshotFor(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  id: unknown,
) {
  const { workspace } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (typeof id !== "string" || !/^[\w-]{36}$/.test(id))
    throw new Error("INVALID_INPUT");
  const source = (await store.read<CalendarSnapshot>(`calendar-snapshot:${id}`))
    .value;
  if (
    !source ||
    source.workspaceId !== workspace.id ||
    source.propertyId !== propertyId ||
    source.actor !== accountId
  )
    throw new Error("NOT_FOUND");
  if (source.expiresAt < Date.now()) throw new Error("CALENDAR_EXPIRED");
  return source;
}
export async function previewCalendar(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  snapshotId: unknown,
  mappingInput: unknown,
  bindingId?: unknown,
) {
  const { workspace, property } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  const source = await calendarSnapshotFor(
    store,
    accountId,
    slug,
    propertyId,
    snapshotId,
  );
  const binding = bindingId
    ? workspace.calendarSources?.find(
        (b) => b.id === bindingId && b.propertyId === propertyId,
      )
    : undefined;
  if (bindingId && !binding) throw new Error("NOT_FOUND");
  const { mapping, rows } = normalizeCalendar(source, mappingInput, property);
  if (
    !binding &&
    workspace.calendarSources?.some(
      (b) =>
        b.propertyId === propertyId &&
        b.calendarIds.some((id) => mapping.calendarIds.includes(id)),
    )
  )
    throw new Error("CALENDAR_SOURCE_EXISTS");
  if (
    binding &&
    binding.transport === source.transport &&
    (binding.calendarIds.length !== mapping.calendarIds.length ||
      binding.calendarIds.some((id) => !mapping.calendarIds.includes(id)))
  )
    throw new Error("CALENDAR_SOURCE_CHANGED");
  if (
    binding &&
    binding.transport !== source.transport &&
    (binding.calendarIds.length !== 1 || mapping.calendarIds.length !== 1)
  )
    throw new Error("CALENDAR_RELINK_REQUIRED");
  const records = [
    ...workspace.bookings.filter(
      (b) => b.propertyId === propertyId && b.calendar,
    ),
    ...(workspace.blocks ?? []).filter((b) => b.propertyId === propertyId),
  ];
  // A multi-event order can be cancelled only when all its activities are
  // explicitly cancelled together; a partial cancellation stays quarantined.
  for (const old of records.filter(
    (r) => r.calendar?.bindingId === binding?.id,
  )) {
    const cancelled = rows.filter(
      (r) =>
        r.disposition === "cancelled" &&
        r.eventKeys.some((key) => old.calendar!.eventKeys.includes(key)),
    );
    if (
      cancelled.length > 1 &&
      old.calendar!.eventKeys.every((key) =>
        cancelled.some((r) => r.eventKeys.includes(key)),
      )
    ) {
      const combined = {
        ...cancelled[0],
        id: digest(JSON.stringify(old.calendar!.eventKeys.slice().sort())),
        eventKeys: cancelled.flatMap((r) => r.eventKeys).sort(),
        titles: cancelled.flatMap((r) => r.titles),
      };
      rows.splice(
        0,
        rows.length,
        ...rows.filter((r) => !cancelled.includes(r)),
        combined,
      );
    }
  }
  const matchedIds = new Set<string>();
  for (const row of rows) {
    const events = source.events.filter((e) => row.eventKeys.includes(e.key));
    const matches = records.filter(
      (r) =>
        r.calendar &&
        r.calendar.bindingId === binding?.id &&
        (r.calendar.eventKeys.some((key) => row.eventKeys.includes(key)) ||
          (binding?.transport !== source.transport &&
            r.calendar.references.some((ref) =>
              events.some(
                (e) =>
                  ref.uid === e.uid &&
                  (ref.recurrenceId ?? "") === (e.recurrenceId ?? ""),
              ),
            ))),
    );
    if (matches.length > 1 || (matches[0] && matchedIds.has(matches[0].id))) {
      row.issues.push("來源分組與已匯入訂單不同，請核對整張訂單，不能拆開更新");
      row.disposition = "issue";
      continue;
    }
    const old = matches[0];
    if (old) {
      row.existingId = old.id;
      matchedIds.add(old.id);
      const sourceRefs = events
        .map((e) => `${e.uid}:${e.recurrenceId ?? ""}`)
        .sort();
      const oldRefs = old
        .calendar!.references.map((e) => `${e.uid}:${e.recurrenceId ?? ""}`)
        .sort();
      if (JSON.stringify(sourceRefs) !== JSON.stringify(oldRefs))
        row.issues.push("來源分組變更，請先核對整張訂單的所有活動");
      if (
        row.disposition === "cancelled" &&
        (old.status === "cancelled" || old.status === "released")
      ) {
        row.disposition = "existing";
        continue;
      }
      if (row.disposition === "ignored") {
        row.issues.push("已匯入活動不能直接排除，請先核對並取消或釋放既有記錄");
        row.disposition = "issue";
      } else if (row.disposition !== "cancelled") {
        if (old.status === "cancelled" || old.status === "released") {
          row.issues.push(
            "此來源已取消或撤銷，請核對既有記錄，不能自動重新建立",
          );
          row.disposition = "issue";
        } else if (
          row.draft &&
          "payments" in old !== (row.draft.kind === "booking")
        ) {
          row.issues.push("既有訂單與封房類型不同，請先核對");
          row.disposition = "issue";
        } else
          row.disposition =
            row.fingerprint === old.calendar!.fingerprint
              ? "existing"
              : row.draft
                ? "changed"
                : "issue";
      }
    } else if (
      row.draft &&
      records.some((r) =>
        r.calendar?.references.some((ref) =>
          events.some(
            (e) =>
              e.uid === ref.uid &&
              (e.recurrenceId ?? "") === (ref.recurrenceId ?? ""),
          ),
        ),
      )
    ) {
      row.issues.push("可能已由另一個日曆來源匯入，請選擇更新既有來源後再核對");
      row.disposition = "issue";
    }
    if (!row.draft) continue;
    const active = [
      ...workspace.bookings.filter(
        (b) => b.propertyId === propertyId && b.status === "confirmed",
      ),
      ...(workspace.blocks ?? []).filter(
        (b) => b.propertyId === propertyId && b.status === "active",
      ),
    ];
    if (
      active.some(
        (b) => b.id !== row.existingId && bookingsOverlap(b, row.draft!),
      )
    )
      row.issues.push("與目前訂房或封房衝突");
    if (
      rows.some(
        (other) =>
          other !== row &&
          other.draft &&
          bookingsOverlap(other.draft, row.draft!),
      )
    )
      row.issues.push("來源內有重疊占房，請核對活動副本或訂單分組");
  }
  // A missing event stays occupied until a human resolves the source difference.
  if (binding)
    for (const old of records.filter(
      (r) =>
        r.calendar?.bindingId === binding.id &&
        (r.status === "confirmed" || r.status === "active") &&
        !matchedIds.has(r.id),
    )) {
      if (old.checkIn < source.to && old.checkOut > source.from)
        rows.push({
          id: digest(`missing:${old.id}`),
          eventKeys: old.calendar!.eventKeys,
          titles: ["既有活動未出現在本次來源"],
          draft: null,
          issues: [],
          disposition: "cancelled",
          fingerprint: "",
          existingId: old.id,
        });
    }
  const preview: CalendarPreview = {
    id: randomUUID(),
    snapshotId: source.id,
    bindingId: binding?.id ?? randomUUID(),
    workspaceId: workspace.id,
    propertyId,
    actor: accountId,
    version: workspace.version,
    createdAt: new Date().toISOString(),
    expiresAt: Math.min(source.expiresAt, Date.now() + 3600000),
    mapping,
    rows,
  };
  await store.commit([
    {
      key: `calendar-preview:${preview.id}`,
      before: null,
      after: preview,
      ttlSeconds: 3600,
    },
  ]);
  return preview;
}
export async function calendarPreviewFor(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  id: unknown,
) {
  const { workspace } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (typeof id !== "string" || !/^[\w-]{36}$/.test(id))
    throw new Error("INVALID_INPUT");
  const preview = (await store.read<CalendarPreview>(`calendar-preview:${id}`))
    .value;
  if (
    !preview ||
    preview.actor !== accountId ||
    preview.workspaceId !== workspace.id ||
    preview.propertyId !== propertyId
  )
    throw new Error("NOT_FOUND");
  if (preview.expiresAt < Date.now()) throw new Error("CALENDAR_EXPIRED");
  return preview;
}
export function calendarReadiness(
  workspace: Workspace,
  propertyId: string,
  sources: CalendarBinding[],
  confirmedCoverage: boolean,
) {
  const bindings = sources.filter((b) => b.propertyId === propertyId);
  if (!bindings.length) return { unresolvedCount: 1, readyAt: undefined };
  const coverageFrom = bindings.reduce(
    (s, b) => (s > b.from ? s : b.from),
    bindings[0].from,
  );
  const coverageTo = bindings.reduce(
    (s, b) => (s < b.to ? s : b.to),
    bindings[0].to,
  );
  const unresolvedCount =
    bindings.reduce(
      (n, b) =>
        n + b.pendingCount + b.issueCount + (b.coverageConfirmed ? 0 : 1),
      0,
    ) + (!confirmedCoverage || coverageFrom >= coverageTo ? 1 : 0);
  return {
    coverageFrom,
    coverageTo,
    unresolvedCount,
    ...(unresolvedCount === 0
      ? { readyAt: new Date().toISOString() }
      : { readyAt: undefined }),
  };
}
export async function commitCalendar(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  input: Record<string, unknown>,
) {
  const { workspace, raw, property } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  if (
    typeof input.previewId !== "string" ||
    !Array.isArray(input.selected) ||
    input.selected.length > 2000 ||
    input.selected.some((id) => typeof id !== "string") ||
    input.confirmed !== true ||
    typeof input.confirmedCoverage !== "boolean"
  )
    throw new Error("FORMAT_CONFIRMATION_REQUIRED");
  if (!["migration", "connected"].includes(String(input.mode)))
    throw new Error("INVALID_INPUT");
  const selection = [...new Set(input.selected as string[])].sort();
  const requestHash = digest(
    JSON.stringify({
      selection,
      coverage: input.confirmedCoverage,
      acceptChanges: input.acceptChanges === true,
      mode: input.mode,
    }),
  );
  const previous = workspace.calendarBatches?.find(
    (b) =>
      b.id === input.previewId &&
      b.actor === accountId &&
      b.propertyId === propertyId,
  );
  if (previous) {
    if (previous.requestHash !== requestHash)
      throw new Error("IDEMPOTENCY_CONFLICT");
    return previous;
  }
  const preview = await calendarPreviewFor(
    store,
    accountId,
    slug,
    propertyId,
    input.previewId,
  );
  if (preview.version !== workspace.version)
    throw new Error("VERSION_CONFLICT");
  const source = await calendarSnapshotFor(
    store,
    accountId,
    slug,
    propertyId,
    preview.snapshotId,
  );
  const rows = selection.map((id) => preview.rows.find((r) => r.id === id));
  if (
    rows.some(
      (r) =>
        !r ||
        r.issues.length ||
        !["ready", "changed", "cancelled"].includes(r.disposition) ||
        (r.disposition === "cancelled" && !r.existingId),
    )
  )
    throw new Error("INVALID_INPUT");
  if (
    rows.some((r) => r!.disposition !== "ready") &&
    input.acceptChanges !== true
  )
    throw new Error("CALENDAR_CHANGES_CONFIRM");
  const oldBinding = workspace.calendarSources?.find(
    (b) => b.id === preview.bindingId,
  );
  const mode = input.mode;
  if (
    !["migration", "connected"].includes(String(mode)) ||
    (mode === "connected" && source.transport !== "google")
  )
    throw new Error("INVALID_INPUT");
  if (
    mode === "connected" &&
    (!source.connectionId ||
      process.env.CUSTOMER_CALENDAR_SYNC_ENABLED !== "true" ||
      !process.env.CRON_SECRET)
  )
    throw new Error("CALENDAR_SYNC_UNAVAILABLE");
  const at = new Date().toISOString(),
    bookings = structuredClone(workspace.bookings),
    blocks = structuredClone(workspace.blocks ?? []);
  const bookingIds: string[] = [],
    blockIds: string[] = [];
  function reference(row: CalendarPreviewRow): CalendarReference {
    return {
      bindingId: preview.bindingId,
      batchId: preview.id,
      eventKeys: row.eventKeys,
      references: source.events
        .filter((e) => row.eventKeys.includes(e.key))
        .map((e) => ({
          calendarId: e.calendarId,
          uid: e.uid,
          ...(e.eventId ? { eventId: e.eventId } : {}),
          ...(e.recurrenceId ? { recurrenceId: e.recurrenceId } : {}),
        })),
      fingerprint: row.fingerprint,
      externalId: row.draft?.externalId ?? null,
      sourceVersion: source.contentHash,
      ...(row.draft
        ? {
            financialEvidence: { total: row.draft.total, paid: row.draft.paid },
          }
        : {}),
    };
  }
  // Preserve identity when a reviewed file source is replaced by Google OAuth.
  if (oldBinding && oldBinding.transport !== source.transport)
    for (const row of preview.rows.filter(
      (r) => r.disposition === "existing" && !r.issues.length,
    )) {
      const old = [...bookings, ...blocks].find((b) => b.id === row.existingId);
      if (old) {
        old.calendar = { ...reference(row), batchId: old.calendar!.batchId };
        old.version++;
      }
    }
  for (const row of rows as CalendarPreviewRow[]) {
    const booking = bookings.find((b) => b.id === row.existingId),
      block = blocks.find((b) => b.id === row.existingId);
    if (row.disposition === "cancelled") {
      if (booking) {
        const finance = financeSummary(booking);
        if (finance.received !== 0)
          throw new Error("CANCELLATION_REQUIRES_SETTLEMENT");
        booking.status = "cancelled";
        booking.version++;
        bookingIds.push(booking.id);
      } else if (block) {
        block.status = "released";
        block.version++;
        blockIds.push(block.id);
      } else throw new Error("NOT_FOUND");
      continue;
    }
    const draft = row.draft!;
    if (
      [
        ...bookings.filter((b) => b.status === "confirmed"),
        ...blocks.filter((b) => b.status === "active"),
      ].some(
        (b) =>
          b.propertyId === propertyId &&
          b.id !== row.existingId &&
          bookingsOverlap(b, draft),
      )
    )
      throw new Error("ROOM_CONFLICT");
    const occupancy = {
      checkIn: draft.checkIn,
      checkOut: draft.checkOut,
      roomIds: draft.roomIds,
      stays: draft.stays,
    };
    if (draft.kind === "block") {
      if (booking) throw new Error("INVALID_INPUT");
      const next: InventoryBlock = {
        ...occupancy,
        id: block?.id ?? randomUUID(),
        version: (block?.version ?? 0) + 1,
        propertyId,
        reason: draft.reason ?? "日曆封房",
        status: "active",
        createdAt: block?.createdAt ?? at,
        calendar: reference(row),
      };
      if (block) Object.assign(block, next);
      else blocks.push(next);
      blockIds.push(next.id);
    } else {
      if (block) throw new Error("INVALID_INPUT");
      const next: Booking = booking
        ? {
            ...booking,
            ...occupancy,
            guestName: draft.guestName,
            version: booking.version + 1,
            calendar: reference(row),
          }
        : {
            ...occupancy,
            id: randomUUID(),
            version: 1,
            propertyId,
            guestName: draft.guestName,
            total: draft.total,
            payments: [],
            importedFinance: {
              currency: "TWD",
              amountBasis: "order",
              sourceAmount: draft.total,
              receivedMeaning: "source",
              propertyReceived: null,
              guestPaid: null,
              sourcePaid: draft.paid,
            },
            contact: null,
            notes: null,
            status: "confirmed",
            guestNotified: false,
            createdAt: at,
            actor: accountId,
            entry: "calendar",
            calendar: reference(row),
            requestKey: `calendar-${preview.id}-${row.id}`,
            requestHash: row.fingerprint,
          };
      // Source updates never manufacture or overwrite accepted money/receipt records.
      if (booking) Object.assign(booking, next);
      else bookings.push(next);
      bookingIds.push(next.id);
    }
  }
  if (
    bookings.length > 5000 ||
    blocks.length > 5000 ||
    (workspace.calendarBatches?.length ?? 0) >= 1000
  )
    throw new Error("LIMIT_REACHED");
  const unresolved = preview.rows.filter(
    (r) =>
      r.issues.length ||
      (!selection.includes(r.id) &&
        (r.disposition === "ready" ||
          r.disposition === "changed" ||
          (r.disposition === "cancelled" && r.existingId))),
  );
  const binding: CalendarBinding = {
    id: preview.bindingId,
    propertyId,
    actor:
      source.transport === "google"
        ? accountId
        : (oldBinding?.actor ?? accountId),
    kind: source.kind,
    transport: source.transport,
    name: source.calendars
      .filter((c) => preview.mapping.calendarIds.includes(c.id))
      .map((c) => c.name)
      .join("、")
      .slice(0, 200),
    calendarIds: preview.mapping.calendarIds,
    from: source.from,
    to: source.to,
    timezone: source.timezone,
    mapping: preview.mapping,
    ...(source.connectionId ? { connectionId: source.connectionId } : {}),
    mode: mode as CalendarBinding["mode"],
    lastSuccessfulAt: at,
    coverageConfirmed: input.confirmedCoverage,
    pendingCount: unresolved.filter((r) => !r.issues.length).length,
    issueCount: unresolved.filter((r) => r.issues.length).length,
    ...(unresolved.length ? { pendingPreviewId: preview.id } : {}),
  };
  const sources = [
    ...(workspace.calendarSources ?? []).filter((b) => b.id !== binding.id),
    binding,
  ];
  if (sources.filter((b) => b.propertyId === propertyId).length > 10)
    throw new Error("LIMIT_REACHED");
  const readiness = calendarReadiness(
    workspace,
    propertyId,
    sources,
    input.confirmedCoverage,
  );
  const batch: CalendarBatch = {
    id: preview.id,
    actor: accountId,
    propertyId,
    bindingId: binding.id,
    createdAt: at,
    requestHash,
    bookingIds,
    blockIds,
    unresolvedCount: readiness.unresolvedCount,
  };
  const next: Workspace = {
    ...workspace,
    version: workspace.version + 1,
    bookings,
    blocks,
    calendarSources: sources,
    calendarBatches: [...(workspace.calendarBatches ?? []), batch],
    properties: workspace.properties.map((p) =>
      p.id === propertyId
        ? {
            ...p,
            setup: {
              ...property.setup,
              mode: "calendar",
              calendarKind: source.kind,
              ...readiness,
            },
          }
        : p,
    ),
    audit: [
      ...workspace.audit,
      { at, actor: accountId, action: "calendar.imported", targetId: batch.id },
    ].slice(-1000),
  };
  if (workspace.onboarding && workspace.properties[0]?.id === propertyId)
    next.onboarding = {
      ...workspace.onboarding,
      readyAt: readiness.readyAt,
      unresolvedCount: readiness.unresolvedCount,
    };
  await store.commit([
    { key: `workspace:${workspace.id}`, before: raw, after: next },
    ...(await calendarJobChanges(store, next)),
  ]);
  const verified = (await loadWorkspace(store, accountId, slug)).workspace;
  const saved = verified.calendarBatches?.find((b) => b.id === batch.id);
  if (
    !saved ||
    saved.requestHash !== requestHash ||
    bookingIds.some((id) => {
      const expected = bookings.find((b) => b.id === id),
        actual = verified.bookings.find((b) => b.id === id);
      return (
        !actual ||
        !expected ||
        actual.version < expected.version ||
        (actual.version === expected.version &&
          JSON.stringify(actual) !== JSON.stringify(expected))
      );
    }) ||
    blockIds.some((id) => {
      const expected = blocks.find((b) => b.id === id),
        actual = verified.blocks?.find((b) => b.id === id);
      return (
        !actual ||
        !expected ||
        actual.version < expected.version ||
        (actual.version === expected.version &&
          JSON.stringify(actual) !== JSON.stringify(expected))
      );
    })
  )
    throw new Error("WRITE_UNCONFIRMED");
  return saved;
}

export async function calendarStatus(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
) {
  const { workspace, property } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  return {
    version: workspace.version,
    readiness: propertyReadiness(workspace, property),
    sources: (workspace.calendarSources ?? []).filter(
      (b) => b.propertyId === propertyId,
    ),
    batches: (workspace.calendarBatches ?? [])
      .filter((b) => b.propertyId === propertyId)
      .slice(-20),
  };
}
export async function undoCalendar(
  store: CustomerStore,
  accountId: string,
  slug: string,
  propertyId: string,
  input: Record<string, unknown>,
) {
  const { workspace, raw } = await calendarAccess(
    store,
    accountId,
    slug,
    propertyId,
  );
  const batch = workspace.calendarBatches?.find(
    (b) => b.id === input.batchId && b.propertyId === propertyId,
  );
  if (!batch) throw new Error("NOT_FOUND");
  if (batch.undo) return batch.undo;
  if (input.version !== workspace.version) throw new Error("VERSION_CONFLICT");
  const removed: string[] = [],
    skipped: string[] = [];
  const bookings = workspace.bookings.map((b) => {
    if (!batch.bookingIds.includes(b.id)) return b;
    if (
      b.calendar?.batchId !== batch.id ||
      b.version !== 1 ||
      b.payments.length ||
      b.openingReceived ||
      b.status !== "confirmed"
    ) {
      skipped.push(b.id);
      return b;
    }
    removed.push(b.id);
    return { ...b, status: "cancelled" as const, version: b.version + 1 };
  });
  const blocks = (workspace.blocks ?? []).map((b) => {
    if (!batch.blockIds.includes(b.id)) return b;
    if (
      b.calendar.batchId !== batch.id ||
      b.version !== 1 ||
      b.status !== "active"
    ) {
      skipped.push(b.id);
      return b;
    }
    removed.push(b.id);
    return { ...b, status: "released" as const, version: b.version + 1 };
  });
  const undo = { removed, skipped },
    at = new Date().toISOString();
  const next: Workspace = {
    ...workspace,
    version: workspace.version + 1,
    bookings,
    blocks,
    calendarBatches: workspace.calendarBatches!.map((b) =>
      b.id === batch.id ? { ...b, undo } : b,
    ),
    properties: workspace.properties.map((p) =>
      p.id === propertyId
        ? {
            ...p,
            setup: {
              ...p.setup,
              mode: "calendar",
              readyAt: undefined,
              unresolvedCount:
                (p.setup?.unresolvedCount ?? 0) + removed.length || 1,
            },
          }
        : p,
    ),
    audit: [
      ...workspace.audit,
      {
        at,
        actor: accountId,
        action: "calendar.import-undone",
        targetId: batch.id,
      },
    ].slice(-1000),
  };
  if (next.onboarding && next.properties[0].id === propertyId)
    next.onboarding = {
      ...next.onboarding,
      readyAt: undefined,
      unresolvedCount: 1,
    };
  await store.commit([
    { key: `workspace:${workspace.id}`, before: raw, after: next },
    ...(await calendarJobChanges(store, next)),
  ]);
  const verified = (
    await loadWorkspace(store, accountId, slug)
  ).workspace.calendarBatches?.find((b) => b.id === batch.id)?.undo;
  if (!verified || JSON.stringify(verified) !== JSON.stringify(undo))
    throw new Error("WRITE_UNCONFIRMED");
  return undo;
}
