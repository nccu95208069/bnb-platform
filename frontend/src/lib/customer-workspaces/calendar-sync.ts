import {
  calendarPreviewFor,
  calendarReadiness,
  calendarSnapshotFor,
  commitCalendar,
  previewCalendar,
} from "./calendar-import.ts";
import { readGoogleCalendar } from "./calendar-google.ts";
import type { CalendarJobTarget } from "./calendar-jobs.ts";
import type { CalendarBinding } from "./calendar-types.ts";
import { loadWorkspace } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Workspace } from "./types.ts";

export async function verifyGoogleCalendarPreview(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
  previewId: unknown,
) {
  const { workspace } = await loadWorkspace(store, actor, slug);
  if (
    workspace.calendarBatches?.some(
      (b) =>
        b.id === previewId && b.actor === actor && b.propertyId === propertyId,
    )
  )
    return;
  const preview = await calendarPreviewFor(
      store,
      actor,
      slug,
      propertyId,
      previewId,
    ),
    source = await calendarSnapshotFor(
      store,
      actor,
      slug,
      propertyId,
      preview.snapshotId,
    );
  if (source.transport !== "google") return;
  const fresh = await readGoogleCalendar(store, actor, slug, propertyId, {
    kind: source.kind,
    calendarIds: source.calendars.map((c) => c.id),
    from: source.from,
    to: source.to,
    timezone: source.timezone,
    connectionId: source.connectionId,
  });
  if (fresh.contentHash !== source.contentHash)
    throw new Error("CALENDAR_SOURCE_CHANGED");
}
export async function refreshCalendarBinding(
  store: CustomerStore,
  actor: string,
  slug: string,
  propertyId: string,
  bindingId: unknown,
) {
  const { workspace } = await loadWorkspace(store, actor, slug);
  const binding = workspace.calendarSources?.find(
    (b) => b.id === bindingId && b.propertyId === propertyId,
  );
  if (!binding || binding.transport !== "google") throw new Error("NOT_FOUND");
  // Only the account that authorized Google may use that grant, including cron.
  if (actor !== binding.actor) throw new Error("CALENDAR_GRANT_OWNER");
  const source = await readGoogleCalendar(store, actor, slug, propertyId, {
    ...binding,
  });
  const mapping = {
    ...binding.mapping,
    overrides: Object.fromEntries(
      Object.entries(binding.mapping.overrides).filter(([key]) =>
        source.events.some((e) => e.key === key),
      ),
    ),
  };
  return {
    source,
    preview: await previewCalendar(
      store,
      actor,
      slug,
      propertyId,
      source.id,
      mapping,
      binding.id,
    ),
  };
}
async function recordError(
  store: CustomerStore,
  workspaceId: string,
  bindingId: string,
  error: unknown,
) {
  const saved = await store.read<Workspace>(`workspace:${workspaceId}`),
    workspace = saved.value;
  if (
    !workspace?.calendarSources?.some(
      (b) => b.id === bindingId && b.mode === "connected",
    )
  )
    return;
  const code =
    error instanceof Error &&
    [
      "CALENDAR_CONNECT_REQUIRED",
      "CALENDAR_GRANT_OWNER",
      "CALENDAR_SIZE",
      "VERSION_CONFLICT",
      "FORBIDDEN",
      "NOT_FOUND",
    ].includes(error.message)
      ? error.message
      : "CALENDAR_READ_FAILED";
  await store.commit([
    {
      key: `workspace:${workspaceId}`,
      before: saved.raw,
      after: {
        ...workspace,
        version: workspace.version + 1,
        calendarSources: workspace.calendarSources.map((b) =>
          b.id === bindingId ? { ...b, error: code } : b,
        ),
      },
    },
  ]);
}
export async function synchronizeCalendarWorkspace(
  store: CustomerStore,
  target: CalendarJobTarget,
  deadline: number,
) {
  const initial = (
    await store.read<Workspace>(`workspace:${target.workspaceId}`)
  ).value;
  if (!initial || initial.slug !== target.slug) return;
  for (const binding of initial.calendarSources?.filter(
    (b) => b.mode === "connected",
  ) ?? []) {
    if (Date.now() > deadline - 45000) break;
    try {
      const { source, preview } = await refreshCalendarBinding(
        store,
        binding.actor,
        target.slug,
        binding.propertyId,
        binding.id,
      );
      const { workspace, raw } = await loadWorkspace(
        store,
        binding.actor,
        target.slug,
      );
      if (workspace.version !== preview.version)
        throw new Error("VERSION_CONFLICT");
      const selected = preview.rows
        .filter((row) => {
          if (row.issues.length) return false;
          if (row.disposition === "ready") return true;
          if (row.disposition !== "changed" || !row.draft) return false;
          if (
            row.eventKeys.some(
              (key) => Object.keys(binding.mapping.overrides[key] ?? {}).length,
            )
          )
            return false;
          const old = [...workspace.bookings, ...(workspace.blocks ?? [])].find(
            (b) => b.id === row.existingId,
          );
          const evidence = old?.calendar?.financialEvidence;
          return Boolean(
            evidence &&
            evidence.total === row.draft.total &&
            evidence.paid === row.draft.paid,
          );
        })
        .map((r) => r.id);
      if (selected.length) {
        await commitCalendar(
          store,
          binding.actor,
          target.slug,
          binding.propertyId,
          {
            previewId: preview.id,
            selected,
            confirmed: true,
            confirmedCoverage: binding.coverageConfirmed,
            acceptChanges: true,
            mode: "connected",
          },
        );
      } else {
        const pending = preview.rows.filter(
          (r) =>
            r.issues.length ||
            r.disposition === "ready" ||
            r.disposition === "changed" ||
            (r.disposition === "cancelled" && r.existingId),
        );
        const nextBinding: CalendarBinding = {
          ...binding,
          mapping: preview.mapping,
          lastSuccessfulAt: new Date().toISOString(),
          pendingCount: pending.filter((r) => !r.issues.length).length,
          issueCount: pending.filter((r) => r.issues.length).length,
          pendingPreviewId: pending.length ? preview.id : undefined,
          error: undefined,
          from: source.from,
          to: source.to,
        };
        const sources = workspace.calendarSources!.map((b) =>
          b.id === binding.id ? nextBinding : b,
        );
        const readiness = calendarReadiness(
          workspace,
          binding.propertyId,
          sources,
          binding.coverageConfirmed,
        );
        const next: Workspace = {
          ...workspace,
          version: workspace.version + 1,
          calendarSources: sources,
          properties: workspace.properties.map((p) =>
            p.id === binding.propertyId
              ? { ...p, setup: { ...p.setup, mode: "calendar", ...readiness } }
              : p,
          ),
        };
        if (next.onboarding && next.properties[0].id === binding.propertyId)
          next.onboarding = {
            ...next.onboarding,
            readyAt: readiness.readyAt,
            unresolvedCount: readiness.unresolvedCount,
          };
        await store.commit([
          { key: `workspace:${workspace.id}`, before: raw, after: next },
        ]);
      }
    } catch (error) {
      try {
        await recordError(store, target.workspaceId, binding.id, error);
      } catch {
        /* CAS conflict leaves last-success time unchanged; stale guard still applies. */
      }
    }
  }
}
