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
    const before = await inspect();
    const unsatisfied = before.cells.filter((cell) => !matches(cell));
    for (const cell of unsatisfied) {
      const target = desired.get(`${cell.roomId}|${cell.date}`);
      try {
        await provider.setNight(propertyId, { roomId: cell.roomId, date: cell.date,
          desired: target, operationKey });
      } catch {
        // An unknown write outcome must be resolved by observation. Do not
        // issue the same write again or continue changing other nights.
        break;
      }
    }
    let after = unsatisfied.length ? await inspect() : before;
    // OwlNest acknowledges a stock PUT before its calendar GET always reflects
    // the new cell. Wait only for fresh observations; never issue a second PUT.
    if (unsatisfied.length && !after.cells.every(matches)) {
      for (const delay of [3000, 5000, 8000, 12000]) {
        await wait(delay);
        after = await inspect();
        if (after.cells.every(matches)) break;
      }
    }
    return recordReadback({ propertyId, operationKey, providerVersion: after.providerVersion,
      observedAt: after.observedAt, cells: after.cells });
  });
}
