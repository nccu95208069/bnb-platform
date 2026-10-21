import { isDeepStrictEqual } from "node:util";
import { annotateSweetfunDisappearances, diffSweetfunSnapshots, verifySweetfunDiff } from
  "./sweetfun-sheet-delta.mjs";
import { prepareSweetfunShadow } from "./sweetfun-shadow.mjs";
import { checkPropertyIntegrity } from "./property-integrity.mjs";
import { nightsFor } from "./service.ts";

function sourceRows(state) {
  return [...state.bookings.flatMap((booking) => booking.sweetfunSnapshot?.rows ?? []),
    ...(state.sweetfunImport?.quarantined ?? []).flatMap((group) => group.rows ?? [])]
    .map((row) => ({ rowNumber: row.rowNumber, values: row.values, notes: row.notes }))
    .sort((a, b) => a.rowNumber - b.rowNumber);
}

function occupied(state) {
  return state.bookings.flatMap((booking) => nightsFor(booking.stays, state.roomIds)
    .map((cell) => ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
}

/**
 * Plan one add-only revision of a private, read-only Sweetfun shadow. Changed,
 * moved, and vanished source rows need a separate decision and cannot pass here.
 * Both states contain private source data and must remain in restricted memory.
 */
export function planSweetfunAdditiveShadow(currentState, nextSnapshot, nextConfig) {
  if (!currentState?.readOnly || currentState.authorityEpoch !== 0 ||
    currentState.channel?.ready || currentState.channel?.websiteSalesEnabled ||
    currentState.bookings?.some((booking) => booking.paymentEvents?.length) ||
    currentState.sourceGrants?.length || currentState.operations?.length ||
    currentState.sourceLinks?.length || currentState.receipts?.length ||
    currentState.manualBlocks?.length ||
    !Array.isArray(currentState.bookings) ||
    nextConfig?.sourceId !== currentState.sweetfunImport?.sourceId ||
    nextConfig?.sourceCopyId === nextConfig?.sourceId ||
    nextConfig?.capturedAt !== nextConfig?.sourceCopyCreatedAt ||
    nextConfig?.workspaceId !== currentState.workspaceId ||
    nextConfig?.propertyId !== currentState.propertyId ||
    nextConfig?.authorityEpoch !== 0 ||
    nextConfig?.inventoryVersion !== currentState.version + 1 ||
    !isDeepStrictEqual(nextConfig?.cancellationTombstones ?? [],
      currentState.sweetfunImport?.cancellationTombstones ?? []))
    throw Error("UNSAFE_SWEETFUN_SHADOW_ADVANCE");
  const oldSnapshot = { headers: currentState.sweetfunImport.headers,
    rows: sourceRows(currentState) };
  const delta = diffSweetfunSnapshots(oldSnapshot, nextSnapshot);
  if (!verifySweetfunDiff(oldSnapshot, nextSnapshot, delta).matches ||
    delta.beforeHash !== currentState.sweetfunImport.sourceHash ||
    delta.afterHash !== nextConfig.expectedSourceHash || !delta.summary.complete ||
    delta.summary.appeared < 1 || delta.summary.disappeared ||
    delta.summary.changed || delta.summary.moved)
    throw Error("SWEETFUN_SHADOW_NON_ADDITIVE_SOURCE");
  const next = prepareSweetfunShadow(nextSnapshot, nextConfig);
  if (JSON.stringify(currentState.roomIds) !== JSON.stringify(next.state.roomIds) ||
    next.state.readOnly !== true || next.state.bookings.some((booking) =>
      booking.paymentEvents?.length) || !checkPropertyIntegrity(next.state, occupied(next.state)).ok)
    throw Error("UNSAFE_SWEETFUN_SHADOW_ADVANCE");
  const oldBookings = new Map(currentState.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking.id]));
  const newBookings = new Map(next.state.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking.id]));
  if (oldBookings.size !== currentState.bookings.length ||
    [...oldBookings].some(([key, id]) => newBookings.get(key) !== id))
    throw Error("SWEETFUN_SHADOW_BOOKING_ID_DRIFT");
  const oldCells = new Map(occupied(currentState).map((row) =>
    [`${row.room_id}:${row.night}`, row.booking_id]));
  const nextCells = occupied(next.state);
  if (nextCells.length !== new Set(nextCells.map((row) =>
    `${row.room_id}:${row.night}`)).size ||
    [...oldCells].some(([key, id]) => !nextCells.some((row) =>
      `${row.room_id}:${row.night}` === key && row.booking_id === id)))
    throw Error("SWEETFUN_SHADOW_OCCUPANCY_DRIFT");
  const addedOccupancy = nextCells.filter((row) =>
    !oldCells.has(`${row.room_id}:${row.night}`));
  if (addedOccupancy.length !== delta.summary.appeared)
    throw Error("SWEETFUN_SHADOW_ADDITIVE_COVERAGE_MISMATCH");
  return { state: next.state, addedOccupancy,
    summary: { beforeHash: delta.beforeHash, afterHash: delta.afterHash,
      addedRows: delta.summary.appeared,
      addedBookings: next.state.bookings.length - currentState.bookings.length,
      addedRoomNights: addedOccupancy.length,
      paymentEventsCreated: 0, canCutover: false } };
}

/**
 * Plan one owner-attested, single-booking cancellation in a read-only shadow.
 * The complete private source copy, prior state, owner decision, and persistent
 * UUID map must agree before the old occupied night may be removed. Concurrent
 * changes to the plain order-note column K can be copied through; any other
 * changed source field still requires separate review.
 */
export function planSweetfunCancellationShadow(currentState, nextSnapshot,
  nextConfig, ownerDecision) {
  if (!currentState?.readOnly || currentState.authorityEpoch !== 0 ||
    currentState.channel?.ready || currentState.channel?.websiteSalesEnabled ||
    currentState.bookings?.some((booking) => booking.paymentEvents?.length) ||
    currentState.sourceGrants?.length || currentState.operations?.length ||
    currentState.sourceLinks?.length || currentState.receipts?.length ||
    currentState.manualBlocks?.length ||
    !Array.isArray(currentState.bookings) ||
    nextConfig?.sourceId !== currentState.sweetfunImport?.sourceId ||
    nextConfig?.sourceCopyId === nextConfig?.sourceId ||
    nextConfig?.capturedAt !== nextConfig?.sourceCopyCreatedAt ||
    nextConfig?.workspaceId !== currentState.workspaceId ||
    nextConfig?.propertyId !== currentState.propertyId ||
    nextConfig?.authorityEpoch !== 0 ||
    nextConfig?.inventoryVersion !== currentState.version + 1)
    throw Error("UNSAFE_SWEETFUN_SHADOW_CANCELLATION");
  const oldSnapshot = { headers: currentState.sweetfunImport.headers,
    rows: sourceRows(currentState) };
  const delta = diffSweetfunSnapshots(oldSnapshot, nextSnapshot);
  const sourceNoteChanges = delta.changes.filter((change) =>
    change.changedColumns.length || change.changedNoteColumns.length);
  if (!verifySweetfunDiff(oldSnapshot, nextSnapshot, delta).matches ||
    delta.beforeHash !== currentState.sweetfunImport.sourceHash ||
    delta.afterHash !== nextConfig.expectedSourceHash || !delta.summary.complete ||
    delta.summary.appeared || delta.summary.disappeared < 1 ||
    sourceNoteChanges.length !== delta.summary.changed ||
    sourceNoteChanges.some((change) => change.kind !== "existing" ||
      change.changedNoteColumns.length ||
      change.changedColumns.some((column) => column !== 10)))
    throw Error("SWEETFUN_SHADOW_CANCELLATION_SOURCE_DRIFT");
  const annotation = annotateSweetfunDisappearances(delta, [ownerDecision]);
  const priorTombstones = currentState.sweetfunImport.cancellationTombstones ?? [];
  if (annotation.unresolved.length ||
    annotation.tombstones.length !== delta.summary.disappeared ||
    !isDeepStrictEqual(nextConfig.cancellationTombstones,
      [...priorTombstones, ...annotation.tombstones]))
    throw Error("SWEETFUN_SHADOW_CANCELLATION_DECISION_DRIFT");
  const vanishedIds = new Set(annotation.tombstones.map((item) => item.sourceId));
  const removed = currentState.bookings.filter((booking) =>
    booking.sweetfunSnapshot?.rows?.some((row) => vanishedIds.has(row.values?.[9])));
  if (removed.length !== 1 || removed[0].status !== "confirmed" ||
    removed[0].sweetfunSnapshot.rows.length !== vanishedIds.size ||
    removed[0].sweetfunSnapshot.rows.some((row) => !vanishedIds.has(row.values?.[9])) ||
    occupied({ ...currentState, bookings: removed }).length !== vanishedIds.size)
    throw Error("SWEETFUN_SHADOW_CANCELLATION_BOOKING_CONFLICT");
  const next = prepareSweetfunShadow(nextSnapshot, nextConfig);
  if (!isDeepStrictEqual(currentState.roomIds, next.state.roomIds) ||
    next.state.readOnly !== true || next.state.bookings.some((booking) =>
      booking.paymentEvents?.length) || !checkPropertyIntegrity(next.state,
        occupied(next.state)).ok)
    throw Error("UNSAFE_SWEETFUN_SHADOW_CANCELLATION");
  const oldBookings = new Map(currentState.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking.id]));
  const newBookings = new Map(next.state.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking.id]));
  if (oldBookings.size !== currentState.bookings.length ||
    newBookings.size !== currentState.bookings.length - 1 ||
    newBookings.has(removed[0].sweetfunSnapshot.groupKey) ||
    [...oldBookings].some(([key, id]) =>
      key !== removed[0].sweetfunSnapshot.groupKey && newBookings.get(key) !== id))
    throw Error("SWEETFUN_SHADOW_BOOKING_ID_DRIFT");
  const oldCells = occupied(currentState);
  const nextCells = occupied(next.state);
  const remaining = new Map(nextCells.map((cell) =>
    [`${cell.room_id}:${cell.night}`, cell.booking_id]));
  const removedCells = oldCells.filter((cell) =>
    !remaining.has(`${cell.room_id}:${cell.night}`));
  if (removedCells.length !== vanishedIds.size ||
    removedCells.some((cell) => cell.booking_id !== removed[0].id) ||
    oldCells.length !== nextCells.length + vanishedIds.size ||
    remaining.size !== nextCells.length ||
    oldCells.some((cell) => cell.booking_id !== removed[0].id &&
      remaining.get(`${cell.room_id}:${cell.night}`) !== cell.booking_id))
    throw Error("SWEETFUN_SHADOW_CANCELLATION_OCCUPANCY_DRIFT");
  return { state: next.state, removedOccupancy: removedCells,
    summary: { beforeHash: delta.beforeHash, afterHash: delta.afterHash,
      removedRows: vanishedIds.size, removedBookings: 1,
      removedRoomNights: removedCells.length,
      sourceNoteRowsChanged: sourceNoteChanges.length,
      ownerConfirmedCancelled: vanishedIds.size, writerReceiptVerified: false,
      paymentEventsCreated: 0, canCutover: false } };
}
