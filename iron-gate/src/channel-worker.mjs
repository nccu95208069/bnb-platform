import { createChannelDispatchClaim } from "./channel-dispatch-claim.mjs";
import { reconcileChannelOperation } from "./channel-runner.mjs";
import { createOwlNestWebProvider } from "./owlnest-web-provider.mjs";

/**
 * One bounded, PII-free worker invocation. Scheduling, secret retrieval and
 * alert delivery are injected by a separately reviewed deployment adapter.
 */
export function createChannelWorker({ repository, service, propertyConfigs,
  getAuthorization, onReview, provider = null }) {
  if (typeof repository?.read !== "function" ||
    typeof repository?.transact !== "function" ||
    typeof service?.pendingChannelOperations !== "function" ||
    typeof service?.channelOperation !== "function" ||
    typeof service?.recordChannelReadback !== "function" ||
    typeof onReview !== "function") throw Error("CHANNEL_WORKER_NOT_CONFIGURED");
  const adapter = provider ?? createOwlNestWebProvider({ propertyConfigs, getAuthorization });
  const claims = createChannelDispatchClaim(repository);
  return {
    async runOne(principal, propertyId) {
      if (principal?.origin !== "channel" || !principal.grantId)
        throw Error("CHANNEL_WORKER_PRINCIPAL_INVALID");
      const state = await repository.read(propertyId);
      if (!state || state.readOnly !== false || state.channel?.mode !== "owlnest" ||
        state.channel.ready !== true || state.channel.sourceReadbackEnabled !== true ||
        state.channel.grantId !== principal.grantId)
        throw Error("CHANNEL_WORKER_PROPERTY_NOT_READY");
      const page = await service.pendingChannelOperations(principal, propertyId, 1);
      if (page.propertyId !== propertyId || !Array.isArray(page.operations) ||
        page.operations.length > 1) throw Error("CHANNEL_WORKER_INVALID_PAGE");
      if (page.operations.length === 0) return { state: "idle", propertyId };
      const operationKey = page.operations[0]?.key;
      if (typeof operationKey !== "string") throw Error("CHANNEL_WORKER_INVALID_PAGE");
      // A failed owner login has not reached OwlNest. Check it before the
      // durable dispatch claim, so a transient auth outage cannot strand a
      // pending operation in manual recovery.
      if (!provider) await getAuthorization(propertyId);
      let result;
      try {
        result = await reconcileChannelOperation({ propertyId, operationKey,
          withPropertyLease: claims.forOperation(operationKey),
          loadOperation: (id, key) => service.channelOperation(principal, id, key),
          recordReadback: (input) => service.recordChannelReadback(principal, input),
          provider: adapter });
      } catch (error) {
        // Claim remains in review/active. A notification failure must not
        // trigger another provider write or erase the original error.
        await onReview({ propertyId, operationKey, status: "dispatch_unknown" })
          .catch(() => {});
        throw error;
      }
      if (result?.operationKey !== operationKey ||
        !["sync_verified", "review_required"].includes(result.state))
        throw Error("CHANNEL_WORKER_INVALID_RESULT");
      if (result.state === "review_required")
        await onReview({ propertyId, operationKey, status: "review_required" });
      return { state: result.state, propertyId, operationKey };
    },
  };
}
