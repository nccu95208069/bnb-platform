/**
 * Fail-closed per-property claim stored in the canonical property transaction.
 * There is deliberately no TTL takeover: a crashed worker or unknown OwlNest
 * outcome stays claimed until a separate, evidence-backed recovery procedure.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createChannelDispatchClaim(repository) {
  if (typeof repository?.transact !== "function")
    throw Error("CHANNEL_CLAIM_REPOSITORY_REQUIRED");
  return {
    forOperation(operationKey) {
      if (!UUID.test(operationKey ?? "")) throw Error("CHANNEL_OPERATION_KEY_INVALID");
      return async (propertyId, work) => {
        if (!UUID.test(propertyId ?? "") || typeof work !== "function")
          throw Error("CHANNEL_CLAIM_INPUT_INVALID");
        const claimId = crypto.randomUUID();
        await repository.transact(propertyId, (state) => {
          if (state.readOnly !== false || state.channel?.mode !== "owlnest" ||
            state.channel.ready !== true || state.channel.sourceReadbackEnabled !== true ||
            !state.channel.grantId)
            throw Error("CHANNEL_NOT_READY");
          if (state.channelDispatch) throw Error("CHANNEL_PROPERTY_CLAIMED");
          if (!state.operations.some((item) => item.key === operationKey &&
            item.state === "sync_pending")) throw Error("CHANNEL_OPERATION_NOT_DISPATCHABLE");
          state.channelDispatch = { claimId, operationKey, state: "active",
            claimedAt: new Date().toISOString() };
        });
        const finish = async (verified) => repository.transact(propertyId, (state) => {
          const claim = state.channelDispatch;
          if (claim?.claimId !== claimId || claim.operationKey !== operationKey ||
            claim.state !== "active") throw Error("CHANNEL_CLAIM_MOVED");
          const operation = state.operations.find((item) => item.key === operationKey);
          if (verified && operation?.state === "sync_verified") {
            state.channelDispatch = null;
            return;
          }
          claim.state = "review_required";
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
