import { createChannelWorker } from "./channel-worker.mjs";
import { validateReviewedTransfer, assertReviewedTransferNotExpired } from "./channel-dispatch-claim.mjs";
import { reviewClaimScope, validReviewCells, sameReviewCells, channelReviewBlock } from
  "./channel-dispatch-state.ts";

/** Operator-only legacy isolation and exact existing-job execution. No old-job PUT. */
export async function transferReviewedChannelOperation({repository, service, provider, principal,
  propertyId, targetOperationKey, expectedClaimId, expectedInventoryVersion, expectedCells,
  reviewReason, expiresAt, onReview = async () => {}}) {
  if (!repository?.read || !repository?.transact || !provider?.observe || !provider?.setNight ||
    !service?.channelOperation || principal?.origin !== "channel" || !principal.grantId ||
    !principal.actions?.includes("channel:verify") || !principal.propertyIds?.includes(propertyId) ||
    !Number.isSafeInteger(expectedInventoryVersion) || typeof expectedClaimId !== "string" ||
    typeof reviewReason !== "string" || reviewReason.trim().length < 8 || reviewReason.length > 256)
    throw Error("CHANNEL_REVIEW_TRANSFER_INVALID");
  assertReviewedTransferNotExpired(expiresAt);
  const state = await repository.read(propertyId);
  const scope = state && reviewClaimScope(state, state.channelDispatch);
  const target = state?.operations.find(item => item.key === targetOperationKey);
  if (!state || !scope || state.readOnly !== false || state.channel?.mode !== "owlnest" ||
    state.channel.ready !== true || state.channel.sourceReadbackEnabled !== true ||
    state.channel.grantId !== principal.grantId || state.workspaceId !== principal.workspaceId ||
    state.authorityEpoch !== principal.authorityEpoch || state.version !== expectedInventoryVersion ||
    state.channelDispatch.claimId !== expectedClaimId || !target || target.state !== "sync_pending" ||
    target.controlMode !== "provider_only" || target.bookingId !== null || target.bookingVersion !== 0 ||
    !validReviewCells(state, target.cells) || !validReviewCells(state, expectedCells) ||
    !sameReviewCells(target.cells, expectedCells)) throw Error("CHANNEL_REVIEW_TRANSFER_STATE_MOVED");
  if (channelReviewBlock(state, target.cells, true)) throw Error("CHANNEL_REVIEW_BLOCKED");
  // The evidence comes from the configured provider here, never from a manifest.
  // Open old nights remain protected; observing them does not authorize retrying them.
  const observation = await provider.observe(propertyId, scope);
  const isolation = {expectedClaimId, expectedInventoryVersion, expectedCells,
    expectedAuthorityEpoch: principal.authorityEpoch, expectedWorkspaceId: principal.workspaceId,
    expectedGrantId: principal.grantId, reviewReason, observation, expiresAt};
  validateReviewedTransfer(state, targetOperationKey, isolation);
  const worker = createChannelWorker({repository, service, provider, onReview});
  const result = await worker.runOne(principal, propertyId, targetOperationKey, isolation);
  if (result.state === "sync_pending") throw Error("CHANNEL_REVIEW_TRANSFER_STATE_MOVED");
  return result;
}
