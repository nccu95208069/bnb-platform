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
      operation.controlMode === "provider_only" ? cell.count === 0 && cell.isLock :
        cell.count === 0 || cell.isLock :
      (operation.controlMode === "provider_only" ? cell.count === 1 : cell.count > 0) && !cell.isLock);
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

/**
 * Operator-only quarantine of a reviewed manual close. A complete fresh
 * observation is retained as evidence, but cannot prove which writer closed
 * a night. Keep the booking and its room-night fence under review while
 * allowing unrelated operations on this property to dispatch again.
 */
export async function releaseReviewedManualClaim({ repository, provider, principal,
  propertyId, expectedClaimId, expectedInventoryVersion, reviewReason,
  acknowledgeQuarantine }) {
  if (!repository?.read || !repository?.transact || !provider?.observe ||
    principal?.origin !== "channel" || !principal.grantId ||
    !principal.actions?.includes("channel:verify") ||
    typeof expectedClaimId !== "string" ||
    !Number.isSafeInteger(expectedInventoryVersion) || expectedInventoryVersion < 0 ||
    acknowledgeQuarantine !== true || typeof reviewReason !== "string" ||
    reviewReason.trim().length < 8 || reviewReason.length > 256)
    throw Error("CHANNEL_REVIEW_RELEASE_INVALID");
  const state = await repository.read(propertyId);
  const claim = state?.channelDispatch;
  const operation = state?.operations.find((item) => item.key === claim?.operationKey);
  const booking = state?.bookings.find((item) => item.id === operation?.bookingId);
  if (!state || state.version !== expectedInventoryVersion || state.readOnly !== false ||
    state.channel?.mode !== "owlnest" || state.channel.grantId !== principal.grantId ||
    principal.workspaceId !== state.workspaceId ||
    principal.authorityEpoch !== state.authorityEpoch ||
    !principal.propertyIds?.includes(propertyId) ||
    claim?.claimId !== expectedClaimId || claim.state !== "review_required" ||
    operation?.manualInitialClose !== true || operation.state !== "review_required" ||
    operation.cells?.some((cell) => cell.desired !== "closed") ||
    !booking || booking.channelOperationKey !== operation.key ||
    booking.channelSyncState !== "review_required" || !operation.cells?.length)
    throw Error("CHANNEL_REVIEW_RELEASE_STATE_MOVED");

  const observed = await provider.observe(propertyId, operation.cells);
  const expected = new Set(operation.cells.map((cell) => `${cell.roomId}|${cell.date}`));
  const seen = new Set();
  const observedAt = Date.parse(observed?.observedAt ?? "");
  if (expected.size !== operation.cells.length || !Array.isArray(observed?.cells) ||
    observed.cells.length !== expected.size ||
    typeof observed.providerVersion !== "string" ||
    !observed.providerVersion || observed.providerVersion.length > 128 ||
    !Number.isFinite(observedAt) || observedAt > Date.now() + 60_000 ||
    observedAt < Date.now() - 300_000 ||
    observedAt < Date.parse(claim.claimedAt) ||
    observedAt < Date.parse(operation.createdAt) ||
    !observed.cells.every((cell) => {
      const key = `${cell?.roomId}|${cell?.date}`;
      if (!expected.has(key) || seen.has(key) ||
        !Number.isSafeInteger(cell.count) || cell.count < 0 || cell.count > 100 ||
        typeof cell.isLock !== "boolean") return false;
      seen.add(key);
      return true;
    })) throw Error("CHANNEL_REVIEW_RELEASE_READBACK_INCOMPLETE");
  if (observed.cells.some((cell) => cell.count > 0 && !cell.isLock))
    throw Error("CHANNEL_REVIEW_RELEASE_STOCK_OPEN");

  return repository.transact(propertyId, (current, tx) => {
    const active = current.channelDispatch;
    const pending = current.operations.find((item) => item.key === operation.key);
    const reviewed = current.bookings.find((item) => item.id === pending?.bookingId);
    const matchingFences = current.fences.filter((item) => item.key === operation.key);
    const fence = matchingFences[0];
    const operationKeys = new Set(pending?.cells.map((cell) => `${cell.roomId}|${cell.date}`));
    const fenceKeys = new Set(fence?.cells.map((cell) => `${cell.roomId}|${cell.date}`));
    if (current.version !== expectedInventoryVersion ||
      current.readOnly !== false || current.channel?.mode !== "owlnest" ||
      current.channel.grantId !== principal.grantId ||
      current.workspaceId !== principal.workspaceId ||
      current.authorityEpoch !== principal.authorityEpoch ||
      active?.claimId !== expectedClaimId || active.operationKey !== operation.key ||
      active.state !== "review_required" || pending?.manualInitialClose !== true ||
      pending.state !== "review_required" ||
      pending.cells.some((cell) => cell.desired !== "closed") ||
      !reviewed || reviewed.channelOperationKey !== pending.key ||
      reviewed.channelSyncState !== "review_required" ||
      matchingFences.length !== 1 || operationKeys.size !== pending.cells.length ||
      fenceKeys.size !== operationKeys.size ||
      [...operationKeys].some((key) => !fenceKeys.has(key)) ||
      current.operations.some((item) => item.key !== pending.key &&
        item.state === "sync_pending" && item.cells.some((cell) =>
          operationKeys.has(`${cell.roomId}|${cell.date}`))))
      throw Error("CHANNEL_REVIEW_RELEASE_STATE_MOVED");
    pending.observations ??= [];
    if (pending.observations.length >= 1000)
      throw Error("CHANNEL_REVIEW_RELEASE_LIMIT_REACHED");
    pending.observations.push({ observedAt: observed.observedAt,
      providerVersion: observed.providerVersion,
      cells: structuredClone(observed.cells), exact: true, accepted: false });
    current.channelDispatch = null;
    current.version++;
    const at = new Date().toISOString();
    tx.emit({ eventId: crypto.randomUUID(), at, type: "channel.review_claim_released",
      propertyId, bookingId: reviewed.id, bookingVersion: reviewed.version,
      inventoryVersion: current.version });
    tx.audit({ auditId: crypto.randomUUID(), at,
      type: "channel.review_claim_released", workspaceId: current.workspaceId,
      propertyId, bookingId: reviewed.id, bookingVersion: reviewed.version,
      bookingStatus: reviewed.status, inventoryVersion: current.version,
      actorOrigin: principal.origin, actorClientId: principal.clientId,
      actorSubjectId: principal.subjectId, actorGrantId: principal.grantId,
      requestKey: pending.key, reason: reviewReason.trim() });
    return { state: "review_required", operationKey: pending.key,
      claimReleased: true, inventoryVersion: current.version };
  });
}
