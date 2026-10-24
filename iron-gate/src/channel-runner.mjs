/**
 * Provider-neutral one-shot operation runner. It never treats a provider write
 * acknowledgement as proof: a fresh, complete observation is required.
 * The caller must supply a durable per-property lease and a provider adapter
 * whose setNight is an absolute, idempotent state change.
 */
export async function reconcileChannelOperation({ propertyId, operationKey,
  withPropertyLease, loadOperation, recordReadback, provider,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (typeof withPropertyLease !== "function" || typeof loadOperation !== "function" ||
    typeof recordReadback !== "function" || typeof provider?.observe !== "function" ||
    typeof provider?.setNight !== "function" || typeof wait !== "function")
    throw Error("CHANNEL_RUNNER_NOT_CONFIGURED");
  return withPropertyLease(propertyId, async () => {
    const operation = await loadOperation(propertyId, operationKey);
    if (!operation || operation.key !== operationKey || operation.state !== "sync_pending" ||
      !Array.isArray(operation.cells) || operation.cells.length < 1 || operation.cells.length > 4096)
      throw Error("CHANNEL_OPERATION_NOT_DISPATCHABLE");
    const requested = operation.cells.map((cell) => ({ roomId: cell.roomId,
      date: cell.date, desired: cell.desired }));
    const desired = new Map(requested.map((cell) => [`${cell.roomId}|${cell.date}`, cell.desired]));
    if (desired.size !== requested.length ||
      requested.some((cell) => !["open", "closed"].includes(cell.desired)))
      throw Error("CHANNEL_OPERATION_INVALID");
    const inspect = async () => {
      const snapshot = await provider.observe(propertyId, requested);
      if (!snapshot || typeof snapshot.observedAt !== "string" ||
        typeof snapshot.providerVersion !== "string" || !snapshot.providerVersion ||
        !Array.isArray(snapshot.cells) || snapshot.cells.length !== requested.length)
        throw Error("PROVIDER_SNAPSHOT_INCOMPLETE");
      const seen = new Set();
      for (const cell of snapshot.cells) {
        const key = `${cell?.roomId}|${cell?.date}`;
        if (!desired.has(key) || seen.has(key) || !Number.isSafeInteger(cell.count) ||
          cell.count < 0 || cell.count > 100 || typeof cell.isLock !== "boolean")
          throw Error("PROVIDER_SNAPSHOT_INVALID");
        seen.add(key);
      }
      return snapshot;
    };
    const matches = (cell) => desired.get(`${cell.roomId}|${cell.date}`) === "closed"
      ? cell.count === 0 || cell.isLock : cell.count > 0 && !cell.isLock;
    let after = await inspect();
    // A move must never reopen old nights until every new night has been
    // observed closed. The operation fence remains in place throughout both
    // phases, including when a provider write has an unknown outcome.
    for (const target of ["closed", "open"]) {
      if (target === "open" && after.cells.some((cell) =>
        desired.get(`${cell.roomId}|${cell.date}`) === "closed" && !matches(cell))) break;
      const unsatisfied = after.cells.filter((cell) =>
        desired.get(`${cell.roomId}|${cell.date}`) === target && !matches(cell));
      let unknown = false;
      for (const cell of unsatisfied) {
        try {
          await provider.setNight(propertyId, { roomId: cell.roomId, date: cell.date,
            desired: target, operationKey });
        } catch {
          // Never issue another PUT after an unknown outcome. Re-observe the
          // whole operation and leave any unresolved nights under review.
          unknown = true;
          break;
        }
      }
      if (unsatisfied.length) {
        after = await inspect();
        // OwlNest may acknowledge a PUT before its calendar GET reflects it.
        for (const delay of [3000, 5000, 8000, 12000]) {
          if (after.cells.filter((cell) =>
            desired.get(`${cell.roomId}|${cell.date}`) === target).every(matches)) break;
          await wait(delay);
          after = await inspect();
        }
      }
      if (unknown || after.cells.some((cell) =>
        desired.get(`${cell.roomId}|${cell.date}`) === target && !matches(cell))) break;
    }
    return recordReadback({ propertyId, operationKey, providerVersion: after.providerVersion,
      observedAt: after.observedAt, cells: after.cells });
  });
}
