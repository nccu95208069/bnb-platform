import { channelReviewBlock, reviewClaimScope, validReviewCells, sameReviewCells, canAutomaticallyIsolate } from
  "./channel-dispatch-state.ts";

/** One active writer. Settled reviews retain exact room-night holds, never expire. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function auditReview(state, tx, operation, type, reason, at) {
  const booking = state.bookings.find(item => item.id === operation.bookingId) ?? null;
  tx.emit({eventId: crypto.randomUUID(), at, type, propertyId: state.propertyId,
    bookingId: booking?.id ?? null, bookingVersion: booking?.version ?? null,
    inventoryVersion: state.version});
  tx.audit({auditId: crypto.randomUUID(), at, type, workspaceId: state.workspaceId,
    propertyId: state.propertyId, bookingId: booking?.id ?? null, bookingVersion: booking?.version ?? null,
    bookingStatus: booking?.status ?? null, inventoryVersion: state.version, actorOrigin: "channel",
    actorClientId: "channel-dispatch", actorSubjectId: "channel-dispatch",
    actorGrantId: state.channel.grantId, requestKey: operation.key, reason});
}

/** Trusted operator transfer proof is checked again inside the acquisition transaction. */
export function validateReviewedTransfer(state, operationKey, isolation) {
  const claim = state.channelDispatch, scope = reviewClaimScope(state, claim);
  const operation = state.operations.find(item => item.key === operationKey);
  const observation = isolation?.observation;
  const observedAt = Date.parse(observation?.observedAt ?? "");
  if (!isolation || !Number.isSafeInteger(isolation.expectedInventoryVersion) ||
    state.version !== isolation.expectedInventoryVersion || !scope ||
    state.authorityEpoch !== isolation.expectedAuthorityEpoch ||
    state.workspaceId !== isolation.expectedWorkspaceId ||
    state.channel.grantId !== isolation.expectedGrantId ||
    claim.claimId !== isolation.expectedClaimId || claim.operationKey === operationKey ||
    !operation || operation.state !== "sync_pending" || operation.controlMode !== "provider_only" ||
    operation.bookingId !== null || operation.bookingVersion !== 0 ||
    !validReviewCells(state, operation.cells) || !validReviewCells(state, isolation.expectedCells) ||
    !sameReviewCells(operation.cells, isolation.expectedCells) ||
    typeof isolation.reviewReason !== "string" || isolation.reviewReason.trim().length < 8 ||
    isolation.reviewReason.length > 256 ||
    !observation || !Number.isFinite(observedAt) || observedAt < Date.now() - 300_000 ||
    observedAt > Date.now() + 60_000 || observedAt < Date.parse(claim.claimedAt) ||
    typeof observation.providerVersion !== "string" || !observation.providerVersion ||
    observation.providerVersion.length > 128 || !Array.isArray(observation.cells) ||
    observation.cells.length !== scope.length)
    throw Error("CHANNEL_REVIEW_TRANSFER_STATE_MOVED");
  const expected = new Set(scope.map(cell => `${cell.roomId}|${cell.date}`)), seen = new Set();
  for (const cell of observation.cells) {
    const key = `${cell?.roomId}|${cell?.date}`;
    if (!cell || Object.keys(cell).sort().join(",") !== "count,date,isLock,roomId" ||
      !expected.has(key) || seen.has(key) || !Number.isSafeInteger(cell.count) ||
      cell.count < 0 || cell.count > 100 || typeof cell.isLock !== "boolean")
      throw Error("CHANNEL_REVIEW_TRANSFER_READBACK_INVALID");
    seen.add(key);
  }
  if (channelReviewBlock(state, operation.cells, true)) throw Error("CHANNEL_REVIEW_BLOCKED");
}

export function createChannelDispatchClaim(repository) {
  if (typeof repository?.transact !== "function")
    throw Error("CHANNEL_CLAIM_REPOSITORY_REQUIRED");
  return {
    forOperation(operationKey, reviewIsolation = null) {
      if (!UUID.test(operationKey ?? "")) throw Error("CHANNEL_OPERATION_KEY_INVALID");
      return async (propertyId, work) => {
        if (!UUID.test(propertyId ?? "") || typeof work !== "function")
          throw Error("CHANNEL_CLAIM_INPUT_INVALID");
        const claimId = crypto.randomUUID();
        await repository.transact(propertyId, (state, tx) => {
          if (state.readOnly !== false || state.channel?.mode !== "owlnest" ||
            state.channel.ready !== true || state.channel.sourceReadbackEnabled !== true ||
            !state.channel.grantId)
            throw Error("CHANNEL_NOT_READY");
          if (state.channelDispatch?.state === "active") throw Error("CHANNEL_PROPERTY_CLAIMED");
          const operation = state.operations.find(item => item.key === operationKey);
          if (!operation || operation.state !== "sync_pending")
            throw Error("CHANNEL_OPERATION_NOT_DISPATCHABLE");
          if (reviewIsolation) validateReviewedTransfer(state, operationKey, reviewIsolation);
          if (channelReviewBlock(state, operation.cells, reviewIsolation !== null))
            throw Error("CHANNEL_REVIEW_BLOCKED");
          if (state.channelDispatch) {
            const prior = state.channelDispatch, scope = reviewClaimScope(state, prior);
            if (!scope || !canAutomaticallyIsolate(prior) && !reviewIsolation)
              throw Error("CHANNEL_REVIEW_BLOCKED");
            const at = new Date().toISOString();
            const reason = reviewIsolation?.reviewReason.trim() ?? "settled_provider_review_isolated";
            state.channelReviewHolds ??= [];
            state.channelReviewHolds.push({schemaVersion: 1, claim: structuredClone(prior),
              cells: structuredClone(scope), isolatedAt: at, reason,
              ...(reviewIsolation ? {observation: structuredClone(reviewIsolation.observation)} : {})});
            const reviewed = state.operations.find(item => item.key === prior.operationKey);
            auditReview(state, tx, reviewed, "channel.review_isolated", reason, at);
          }
          state.channelDispatch = { claimId, operationKey, state: "active",
            claimedAt: new Date().toISOString(), scopeVersion: 1 };
        });
        const finish = async (verified) => repository.transact(propertyId, (state, tx) => {
          const claim = state.channelDispatch;
          if (claim?.claimId !== claimId || claim.operationKey !== operationKey ||
            claim.state !== "active") throw Error("CHANNEL_CLAIM_MOVED");
          const operation = state.operations.find((item) => item.key === operationKey);
          if (verified && operation?.state === "sync_verified") {
            state.channelDispatch = null;
            return;
          }
          claim.state = "review_required";
          claim.settledAt = new Date().toISOString();
          // A caught failure has ended the worker. Persist an honest review state
          // so another room/date can run while this exact scope remains protected.
          if (operation?.state === "sync_pending") {
            operation.state = "review_required";
            const booking = state.bookings.find(item => item.id === operation.bookingId);
            if (booking?.channelOperationKey === operationKey) booking.channelSyncState = "review_required";
            if (operation.controlMode !== "provider_only") state.version++;
            auditReview(state, tx, operation, "channel.review_required", "dispatch_outcome_unknown",
              new Date().toISOString());
          }
        });
        try {
          const result = await work();
          await finish(result?.state === "sync_verified" &&
            result.operationKey === operationKey);
          return result;
        } catch (error) {
          // If the database is unavailable, the persisted active claim remains
          // held. A recovery job must never assume an expired timestamp is safe.
          await finish(false).catch(() => {});
          throw error;
        }
      };
    },
  };
}
