import { randomUUID } from "node:crypto";
import type { Change, CustomerStore } from "./store.ts";
import type { Workspace } from "./types.ts";
const INDEX = "calendar-sync-index";
export type CalendarJobTarget = { workspaceId: string; slug: string };
type Job = { due: number; leaseUntil: number; lease: string };
// Registry and workspace binding are committed atomically, so a process exit
// cannot leave an enabled connection without durable scheduled work.
export async function calendarJobChanges(
  store: CustomerStore,
  workspace: Workspace,
): Promise<Change[]> {
  if (!workspace.calendarSources?.some((b) => b.mode === "connected"))
    return [];
  const index = await store.read<CalendarJobTarget[]>(INDEX),
    current = index.value ?? [];
  const changes: Change[] = [];
  if (!current.some((t) => t.workspaceId === workspace.id)) {
    if (current.length >= 500) throw new Error("LIMIT_REACHED");
    changes.push({
      key: INDEX,
      before: index.raw,
      after: [...current, { workspaceId: workspace.id, slug: workspace.slug }],
    });
  }
  const key = `calendar-job:${workspace.id}`,
    job = await store.read<Job>(key);
  if (!job.value)
    changes.push({
      key,
      before: job.raw,
      after: { due: Date.now(), leaseUntil: 0, lease: "" } satisfies Job,
    });
  return changes;
}
export async function runCalendarJobs(
  store: CustomerStore,
  run: (target: CalendarJobTarget, deadline: number) => Promise<void>,
) {
  const targets = (await store.read<CalendarJobTarget[]>(INDEX)).value ?? [],
    started = Date.now(),
    deadline = started + 230000;
  let processed = 0,
    failed = 0;
  // Sort by oldest due time so a failing workspace never starves others.
  const jobs = await Promise.all(
    targets.map(async (target) => ({
      target,
      saved: await store.read<Job>(`calendar-job:${target.workspaceId}`),
    })),
  );
  jobs.sort((a, b) => (a.saved.value?.due ?? 0) - (b.saved.value?.due ?? 0));
  let cursor = 0;
  async function worker() {
    for (;;) {
      if (cursor >= jobs.length || Date.now() > deadline - 45000) break;
      const { target, saved } = jobs[cursor++];
      if (
        saved.value &&
        (saved.value.due > Date.now() || saved.value.leaseUntil > Date.now())
      )
        continue;
      const key = `calendar-job:${target.workspaceId}`,
        lease = randomUUID();
      try {
        await store.commit([
          {
            key,
            before: saved.raw,
            after: {
              due: saved.value?.due ?? Date.now(),
              leaseUntil: Date.now() + 300000,
              lease,
            } satisfies Job,
          },
        ]);
      } catch {
        continue;
      }
      processed++;
      try {
        await run(target, deadline);
      } catch {
        failed++;
      } finally {
        const current = await store.read<Job>(key);
        if (current.value?.lease === lease)
          await store.commit([
            {
              key,
              before: current.raw,
              after: {
                due: Date.now() + 240000,
                leaseUntil: 0,
                lease: "",
              } satisfies Job,
            },
          ]);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  return { processed, failed };
}
