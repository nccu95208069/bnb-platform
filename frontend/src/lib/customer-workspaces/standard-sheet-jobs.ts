import { after } from "next/server";
import type { CustomerStore } from "./store.ts";
import { loadWorkspace } from "./service.ts";
import {
  synchronizeStandardSheet,
  type StandardBinding,
} from "./standard-sheet-sync.ts";

export async function scheduleStandardSheetSync(
  store: CustomerStore,
  workspaceId: string,
) {
  // The durable workspace version is the outbox: an unexported version remains
  // pending even if the process exits before this best-effort worker runs.
  try {
    if (
      !(await store.read<StandardBinding>(`standard-sheet:${workspaceId}`))
        .value
    )
      return;
    after(async () => {
      try {
        await synchronizeStandardSheet(store, workspaceId);
      } catch {
        /* Sync persists its error; owner status and retry stay available. */
      }
    });
  } catch {
    // Booking/payment success must not be converted into a failure after commit.
    // Status still reports a stale exportedVersion until a successful retry.
  }
}

export async function scheduleStandardSheetForSlug(
  store: CustomerStore,
  accountId: string,
  slug: string,
) {
  try {
    await scheduleStandardSheetSync(
      store,
      (await loadWorkspace(store, accountId, slug)).workspace.id,
    );
  } catch {
    /* A post-commit lookup failure must not turn a saved operation into a failed one. */
  }
}
