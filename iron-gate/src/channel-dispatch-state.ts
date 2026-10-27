import type { ChannelDispatchClaim, ChannelOperation, DesiredCell, Night, PropertyState } from "./types.ts";

export type ReviewBlockingReason = "reviewed_operation_overlap" | "review_scope_unavailable" |
  "review_isolation_required";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const key = (cell: Night) => `${cell.roomId}|${cell.date}`;
const fullKey = (cell: DesiredCell) => `${key(cell)}|${cell.desired}`;
const validTimestamp = (value: unknown) => typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));

/** Review boundaries must be complete and canonical; malformed scope blocks the property. */
export function validReviewCells(state: PropertyState, cells: unknown): cells is DesiredCell[] {
  return Array.isArray(cells) && cells.length > 0 && cells.length <= 4096 &&
    cells.every(cell => cell && Object.keys(cell).sort().join(",") === "date,desired,roomId" &&
      UUID.test(cell.roomId) && state.roomIds.includes(cell.roomId) &&
      typeof cell.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(cell.date) &&
      Number.isFinite(Date.parse(`${cell.date}T00:00:00Z`)) &&
      new Date(`${cell.date}T00:00:00Z`).toISOString().slice(0, 10) === cell.date &&
      ["open", "closed"].includes(cell.desired)) &&
    new Set(cells.map(key)).size === cells.length;
}

export function reviewClaimScope(state: PropertyState,
  claim: ChannelDispatchClaim | null | undefined): DesiredCell[] | null {
  if (!claim || !UUID.test(claim.claimId) || !UUID.test(claim.operationKey) ||
    claim.state !== "review_required" || !validTimestamp(claim.claimedAt) ||
    claim.scopeVersion !== undefined && claim.scopeVersion !== 1) return null;
  const operations = state.operations.filter(operation => operation.key === claim.operationKey);
  if (operations.length !== 1 || operations[0].state !== "review_required" ||
    !validReviewCells(state, operations[0].cells)) return null;
  return operations[0].cells;
}

export function sameReviewCells(left: DesiredCell[], right: DesiredCell[]): boolean {
  const expected = right.map(fullKey).sort();
  return left.length === expected.length && left.map(fullKey).sort().every((value, index) =>
    value === expected[index]);
}

export function canAutomaticallyIsolate(claim: ChannelDispatchClaim): boolean {
  return claim.scopeVersion === 1 && claim.state === "review_required" &&
    validTimestamp(claim.settledAt) && Date.parse(claim.settledAt!) >= Date.parse(claim.claimedAt);
}

/** Read-only decision shared by admission, status, queue selection and atomic acquisition. */
export function channelReviewBlock(state: PropertyState, cells: Night[],
  allowLegacyIsolation = false): ReviewBlockingReason | null {
  const wanted = new Set(cells.map(key));
  const holds = state.channelReviewHolds ?? [];
  if (!Array.isArray(holds)) return "review_scope_unavailable";
  const seenClaims = new Set<string>(), seenOperations = new Set<string>();
  let overlap = false;
  for (const hold of holds) {
    const scope = reviewClaimScope(state, hold?.claim);
    if (hold?.schemaVersion !== 1 || !scope || !validReviewCells(state, hold.cells) ||
      !sameReviewCells(scope, hold.cells) || !validTimestamp(hold.isolatedAt) ||
      typeof hold.reason !== "string" || !hold.reason ||
      seenClaims.has(hold.claim.claimId) || seenOperations.has(hold.claim.operationKey))
      return "review_scope_unavailable";
    seenClaims.add(hold.claim.claimId); seenOperations.add(hold.claim.operationKey);
    overlap ||= scope.some(cell => wanted.has(key(cell)));
  }
  const claim = state.channelDispatch;
  if (claim?.state === "review_required") {
    const scope = reviewClaimScope(state, claim);
    if (!scope || seenClaims.has(claim.claimId) || seenOperations.has(claim.operationKey))
      return "review_scope_unavailable";
    overlap ||= scope.some(cell => wanted.has(key(cell)));
    if (overlap) return "reviewed_operation_overlap";
    if (!canAutomaticallyIsolate(claim) && !allowLegacyIsolation) return "review_isolation_required";
  } else if (claim && claim.state !== "active") return "review_scope_unavailable";
  return overlap ? "reviewed_operation_overlap" : null;
}

export function channelDispatchStatus(state: PropertyState, operation: ChannelOperation) {
  if (operation.state !== "sync_pending") return {};
  const blockingReason = channelReviewBlock(state, operation.cells);
  const dispatchStatus = blockingReason ? "blocked_by_review" :
    state.channelDispatch?.state === "active" && state.channelDispatch.operationKey === operation.key ?
      "running" : "queued";
  return {dispatchStatus, blockingReason, queuedAt: operation.createdAt};
}
