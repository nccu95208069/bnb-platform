/**
 * Manual recovery after a crashed/uncertain channel dispatch. This path only
 * observes OwlNest. It never reissues a provider PUT or expires a claim.
 */
export async function recoverChannelClaim({ repository, service, provider,
  principal, propertyId, expectedClaimId }) {
  if (principal?.origin !== "channel" || !principal.grantId ||
    !repository?.read || !repository?.transact ||
    !service?.channelOperation || !service?.recordChannelReadback ||
    !provider?.observe || typeof expectedClaimId !== "string")
    throw Error("CHANNEL_RECOVERY_NOT_CONFIGURED");
  const state = await repository.read(propertyId);
  const claim = state?.channelDispatch;
  if (!state || state.readOnly !== false || state.channel?.mode !== "owlnest" ||
    state.channel.grantId !== principal.grantId ||
    principal.workspaceId !== state.workspaceId ||
    principal.authorityEpoch !== state.authorityEpoch ||
    claim?.claimId !== expectedClaimId ||
    !["active", "review_required"].includes(claim.state))
    throw Error("CHANNEL_RECOVERY_CLAIM_MOVED");
  const operation = await service.channelOperation(principal, propertyId, claim.operationKey);
  if (operation.key !== claim.operationKey ||
    !["sync_pending", "review_required", "sync_verified"].includes(operation.state) ||
    !Array.isArray(operation.cells) || !operation.cells.length)
    throw Error("CHANNEL_RECOVERY_OPERATION_INVALID");
  // An interrupted manual close cannot be proven by final stock alone. A
  // pre-existing or independently closed night must never become "verified".
  if (operation.manualInitialClose === true && operation.state !== "sync_verified") {
    await repository.transact(propertyId, (current, tx) => {
      const active = current.channelDispatch;
      const pending = current.operations.find((item) => item.key === operation.key);
      const booking = current.bookings.find((item) => item.id === pending?.bookingId);
      if (active?.claimId !== expectedClaimId || active.operationKey !== operation.key ||
        !["active", "review_required"].includes(active.state) ||
        pending?.manualInitialClose !== true ||
        !["sync_pending", "review_required"].includes(pending.state) ||
        !booking || booking.channelOperationKey !== operation.key)
        throw Error("CHANNEL_RECOVERY_CLAIM_MOVED");
      if (pending.state === "sync_pending" || active.state === "active") {
        pending.state = "review_required";
        booking.channelSyncState = "review_required";
        active.state = "review_required";
        current.version++;
        const at = new Date().toISOString();
        tx.emit({ eventId: crypto.randomUUID(), at, type: "channel.review_required",
          propertyId, bookingId: booking.id, bookingVersion: booking.version,
          inventoryVersion: current.version });
        tx.audit({ auditId: crypto.randomUUID(), at, type: "channel.review_required",
          workspaceId: current.workspaceId, propertyId, bookingId: booking.id,
          bookingVersion: booking.version, bookingStatus: booking.status,
          inventoryVersion: current.version, actorOrigin: principal.origin,
          actorClientId: principal.clientId, actorSubjectId: principal.subjectId,
          actorGrantId: principal.grantId, requestKey: operation.key,
          reason: "MANUAL_CLOSE_RECOVERY_UNPROVABLE" });
      }
    });
    return { state: "review_required", operationKey: operation.key };
  }
  const observed = await provider.observe(propertyId, operation.cells);
  const wanted = new Map(operation.cells.map((cell) =>
    [cell.roomId + "|" + cell.date, cell.desired]));
  const seen = new Set();
  const complete = Array.isArray(observed?.cells) &&
    observed.cells.length === wanted.size &&
    observed.cells.every((cell) => {
      const key = cell?.roomId + "|" + cell?.date;
      if (!wanted.has(key) || seen.has(key) ||
        !Number.isSafeInteger(cell.count) || cell.count < 0 ||
        typeof cell.isLock !== "boolean") return false;
      seen.add(key);
      return true;
    });
  if (!complete) throw Error("CHANNEL_RECOVERY_READBACK_INCOMPLETE");
  const matches = observed.cells.every((cell) =>
    wanted.get(cell.roomId + "|" + cell.date) === "closed" ?
      cell.count === 0 || cell.isLock : cell.count > 0 && !cell.isLock);
  if (!matches) {
    if (operation.state !== "sync_verified")
      await service.recordChannelReadback(principal, { propertyId,
        operationKey: operation.key, providerVersion: observed.providerVersion,
        observedAt: observed.observedAt, cells: observed.cells });
    return { state: "review_required", operationKey: operation.key };
  }
  if (operation.state !== "sync_verified") {
    const result = await service.recordChannelReadback(principal, { propertyId,
      operationKey: operation.key, providerVersion: observed.providerVersion,
      observedAt: observed.observedAt, cells: observed.cells });
    if (result.state !== "sync_verified") return {
      state: "review_required", operationKey: operation.key };
  }
  await repository.transact(propertyId, (current) => {
    const active = current.channelDispatch;
    const completed = current.operations.find((item) => item.key === operation.key);
    const booking = completed?.bookingId === null ? null :
      current.bookings.find((item) => item.id === completed?.bookingId);
    if (active?.claimId !== expectedClaimId || active.operationKey !== operation.key ||
      completed?.state !== "sync_verified" ||
      (completed.bookingId !== null &&
        (booking?.channelOperationKey !== operation.key ||
          booking.channelSyncState !== "verified")) ||
      current.fences.some((fence) => fence.key === operation.key))
      throw Error("CHANNEL_RECOVERY_CLAIM_MOVED");
    current.channelDispatch = null;
  });
  return { state: "sync_verified", operationKey: operation.key };
}
