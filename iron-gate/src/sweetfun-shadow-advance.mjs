import { isDeepStrictEqual } from "node:util";
import { annotateSweetfunDisappearances, diffSweetfunSnapshots, verifySweetfunDiff } from
  "./sweetfun-sheet-delta.mjs";
import { prepareSweetfunShadow, verifySweetfunShadow } from "./sweetfun-shadow.mjs";
import { checkPropertyIntegrity } from "./property-integrity.mjs";
import { nightsFor } from "./service.ts";

function sourceRows(state) {
  return [...state.bookings.flatMap((booking) => booking.sweetfunSnapshot?.rows ?? []),
    ...(state.sweetfunImport?.quarantined ?? []).flatMap((group) => group.rows ?? [])]
    .map((row) => ({ rowNumber: row.rowNumber, values: row.values, notes: row.notes }))
    .sort((a, b) => a.rowNumber - b.rowNumber);
}

function occupied(state) {
  return state.bookings.filter((booking) => booking.status !== "cancelled")
    .flatMap((booking) => nightsFor(booking.stays, state.roomIds)
    .map((cell) => ({ room_id: cell.roomId, night: cell.date, booking_id: booking.id })));
}

/** Correct a retained, single-row source booking after an exact owner attestation. */
export function planSweetfunRetainedCancellation(currentState, snapshot, config, decision) {
  const prior = currentState?.sweetfunImport?.retainedCancellationDecisions ?? [];
  if (!currentState?.readOnly || currentState.authorityEpoch !== 0 ||
    currentState.channel?.ready || currentState.channel?.websiteSalesEnabled ||
    currentState.bookings?.some((booking) => booking.paymentEvents?.length) ||
    currentState.sourceGrants?.length || currentState.operations?.length ||
    currentState.sourceLinks?.length || currentState.receipts?.length ||
    currentState.manualBlocks?.length || !Array.isArray(currentState.bookings) ||
    config?.sourceId !== currentState.sweetfunImport?.sourceId ||
    config?.sourceCopyId === config?.sourceId ||
    config?.capturedAt !== currentState.sweetfunImport?.capturedAt ||
    config?.capturedAt !== config?.sourceCopyCreatedAt ||
    config?.workspaceId !== currentState.workspaceId ||
    config?.propertyId !== currentState.propertyId ||
    config?.authorityEpoch !== 0 || config?.inventoryVersion !== currentState.version + 1 ||
    config?.expectedSourceHash !== currentState.sweetfunImport?.sourceHash ||
    !isDeepStrictEqual(config?.cancellationTombstones ?? [],
      currentState.sweetfunImport?.cancellationTombstones ?? []) ||
    !isDeepStrictEqual(config?.retainedCancellationDecisions,
      [...prior, decision]) || decision?.sourceHash !== config.expectedSourceHash ||
    decision?.outcome !== "cancelled" || decision?.evidenceType !== "owner_attestation" ||
    typeof decision?.evidenceRef !== "string" || !decision.evidenceRef.trim())
    throw Error("UNSAFE_SWEETFUN_RETAINED_CANCELLATION");
  const beforeConfig = { ...config, inventoryVersion: currentState.version,
    retainedCancellationDecisions: prior };
  if (!verifySweetfunShadow(snapshot, beforeConfig, currentState).matches)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_SOURCE_DRIFT");
  const cancelled = currentState.bookings.filter((booking) =>
    booking.sweetfunSnapshot?.rows?.some((row) =>
      row.values?.[9] === decision.sourceId && row.rowNumber === decision.rowNumber));
  if (cancelled.length !== 1 || cancelled[0].status !== "confirmed" ||
    cancelled[0].sweetfunSnapshot.rows.length !== 1)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_BOOKING_CONFLICT");
  const next = prepareSweetfunShadow(snapshot, config);
  const target = next.state.bookings.find((booking) => booking.id === cancelled[0].id);
  const beforeOthers = currentState.bookings.filter((booking) => booking.id !== cancelled[0].id);
  const afterOthers = next.state.bookings.filter((booking) => booking.id !== cancelled[0].id);
  if (!target || target.status !== "cancelled" ||
    !isDeepStrictEqual(beforeOthers, afterOthers) ||
    next.state.bookings.length !== currentState.bookings.length ||
    !isDeepStrictEqual(target.stays, cancelled[0].stays) ||
    !checkPropertyIntegrity(next.state, occupied(next.state)).ok)
    throw Error("SWEETFUN_RETAINED_CANCELLATION_BOOKING_CONFLICT");
  const removedOccupancy = occupied({ ...currentState, bookings: cancelled });
  const beforeCells = occupied(currentState), afterCells = occupied(next.state);
  if (removedOccupancy.length !== 1 || beforeCells.length !== afterCells.length + 1 ||
    afterCells.some((cell) => !beforeCells.some((old) =>
      isDeepStrictEqual(old, cell))))
    throw Error("SWEETFUN_RETAINED_CANCELLATION_OCCUPANCY_DRIFT");
  return { state: next.state, removedOccupancy,
    summary: { sourceHash: config.expectedSourceHash, cancelledBookings: 1,
      removedRoomNights: 1, retainedSourceRows: 1,
      paymentEventsCreated: 0, canCutover: false } };
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
      currentState.sweetfunImport?.cancellationTombstones ?? []) ||
    !isDeepStrictEqual(nextConfig?.retainedCancellationDecisions ?? [],
      currentState.sweetfunImport?.retainedCancellationDecisions ?? []))
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
    [booking.sweetfunSnapshot?.groupKey, booking]));
  const newBookings = new Map(next.state.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking]));
  if (oldBookings.size !== currentState.bookings.length ||
    [...oldBookings].some(([key, booking]) =>
      newBookings.get(key)?.id !== booking.id ||
      newBookings.get(key)?.status !== booking.status ||
      !isDeepStrictEqual(newBookings.get(key)?.stays, booking.stays)))
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
    nextConfig?.inventoryVersion !== currentState.version + 1 ||
    !isDeepStrictEqual(nextConfig?.retainedCancellationDecisions ?? [],
      currentState.sweetfunImport?.retainedCancellationDecisions ?? []))
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
    [booking.sweetfunSnapshot?.groupKey, booking]));
  const newBookings = new Map(next.state.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking]));
  if (oldBookings.size !== currentState.bookings.length ||
    newBookings.size !== currentState.bookings.length - 1 ||
    newBookings.has(removed[0].sweetfunSnapshot.groupKey) ||
    [...oldBookings].some(([key, booking]) =>
      key !== removed[0].sweetfunSnapshot.groupKey &&
      (newBookings.get(key)?.id !== booking.id ||
        newBookings.get(key)?.status !== booking.status ||
        !isDeepStrictEqual(newBookings.get(key)?.stays, booking.stays))))
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

/**
 * Reconcile one fixed source copy containing whole-order additions and
 * owner-attested whole-order cancellations. This is still a read-only shadow:
 * no source credential, payment, provider write, or authority change is made.
 */
export function planSweetfunMixedShadow(currentState, nextSnapshot,
  nextConfig, ownerDecisions) {
  if (!currentState?.readOnly || currentState.authorityEpoch !== 0 ||
    currentState.channel?.ready || currentState.channel?.websiteSalesEnabled ||
    currentState.bookings?.some((booking) => booking.paymentEvents?.length) ||
    currentState.sourceGrants?.length || currentState.operations?.length ||
    currentState.sourceLinks?.length || currentState.receipts?.length ||
    currentState.manualBlocks?.length || !Array.isArray(currentState.bookings) ||
    nextConfig?.sourceId !== currentState.sweetfunImport?.sourceId ||
    nextConfig?.sourceCopyId === nextConfig?.sourceId ||
    nextConfig?.capturedAt !== nextConfig?.sourceCopyCreatedAt ||
    nextConfig?.workspaceId !== currentState.workspaceId ||
    nextConfig?.propertyId !== currentState.propertyId ||
    nextConfig?.authorityEpoch !== 0 ||
    nextConfig?.inventoryVersion !== currentState.version + 1 ||
    !isDeepStrictEqual(nextConfig?.retainedCancellationDecisions ?? [],
      currentState.sweetfunImport?.retainedCancellationDecisions ?? []))
    throw Error("UNSAFE_SWEETFUN_SHADOW_MIXED_ADVANCE");
  const oldSnapshot = { headers: currentState.sweetfunImport.headers,
    rows: sourceRows(currentState) };
  const delta = diffSweetfunSnapshots(oldSnapshot, nextSnapshot);
  const sourceNoteChanges = delta.changes.filter((change) =>
    change.changedColumns.length || change.changedNoteColumns.length);
  if (!verifySweetfunDiff(oldSnapshot, nextSnapshot, delta).matches ||
    delta.beforeHash !== currentState.sweetfunImport.sourceHash ||
    delta.afterHash !== nextConfig.expectedSourceHash || !delta.summary.complete ||
    !delta.summary.appeared || !delta.summary.disappeared ||
    sourceNoteChanges.length !== delta.summary.changed ||
    sourceNoteChanges.some((change) => change.kind !== "existing" ||
      change.changedNoteColumns.length ||
      change.changedColumns.some((column) => column !== 10)))
    throw Error("SWEETFUN_SHADOW_MIXED_SOURCE_DRIFT");
  const annotation = annotateSweetfunDisappearances(delta, ownerDecisions);
  const priorTombstones = currentState.sweetfunImport.cancellationTombstones ?? [];
  if (annotation.unresolved.length ||
    annotation.tombstones.length !== delta.summary.disappeared ||
    !isDeepStrictEqual(nextConfig.cancellationTombstones,
      [...priorTombstones, ...annotation.tombstones]))
    throw Error("SWEETFUN_SHADOW_MIXED_DECISION_DRIFT");
  const disappeared = new Set(annotation.tombstones.map((item) => item.sourceId));
  const appeared = new Set(delta.changes.filter((change) =>
    change.kind === "appeared").map((change) => change.sourceId));
  const next = prepareSweetfunShadow(nextSnapshot, nextConfig);
  if (!isDeepStrictEqual(currentState.roomIds, next.state.roomIds) ||
    next.state.readOnly !== true || next.state.bookings.some((booking) =>
      booking.paymentEvents?.length) ||
    !checkPropertyIntegrity(next.state, occupied(next.state)).ok)
    throw Error("UNSAFE_SWEETFUN_SHADOW_MIXED_ADVANCE");
  const oldBookings = new Map(currentState.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking]));
  const newBookings = new Map(next.state.bookings.map((booking) =>
    [booking.sweetfunSnapshot?.groupKey, booking]));
  if (oldBookings.size !== currentState.bookings.length ||
    newBookings.size !== next.state.bookings.length ||
    [...oldBookings.keys(), ...newBookings.keys()].some((key) =>
      typeof key !== "string" || !key))
    throw Error("SWEETFUN_SHADOW_MIXED_BOOKING_DRIFT");
  const removed = [...oldBookings].filter(([key]) => !newBookings.has(key))
    .map(([, booking]) => booking);
  const added = [...newBookings].filter(([key]) => !oldBookings.has(key))
    .map(([, booking]) => booking);
  const sourceIds = (bookings) => bookings.flatMap((booking) =>
    booking.sweetfunSnapshot?.rows?.map((row) => row.values?.[9]) ?? []);
  const removedIds = sourceIds(removed), addedIds = sourceIds(added);
  if (!removed.length || !added.length ||
    removed.some((booking) => booking.status !== "confirmed") ||
    removedIds.length !== disappeared.size ||
    new Set(removedIds).size !== disappeared.size ||
    removedIds.some((id) => !disappeared.has(id)) ||
    addedIds.length !== appeared.size ||
    new Set(addedIds).size !== appeared.size ||
    addedIds.some((id) => !appeared.has(id)) ||
    [...oldBookings].some(([key, booking]) => {
      const surviving = newBookings.get(key);
      return surviving && (surviving.id !== booking.id ||
        surviving.status !== booking.status ||
        !isDeepStrictEqual(surviving.stays, booking.stays));
    }) || added.some((booking) => currentState.bookings.some((old) =>
      old.id === booking.id)))
    throw Error("SWEETFUN_SHADOW_MIXED_BOOKING_DRIFT");
  const quarantineIds = (state) => (state.sweetfunImport?.quarantined ?? [])
    .flatMap((group) => group.rows?.map((row) => row.values?.[9]) ?? []).sort();
  if (!isDeepStrictEqual(quarantineIds(currentState), quarantineIds(next.state)))
    throw Error("SWEETFUN_SHADOW_MIXED_QUARANTINE_DRIFT");
  const oldCells = occupied(currentState), nextCells = occupied(next.state);
  const key = (cell) => `${cell.room_id}:${cell.night}`;
  const before = new Map(oldCells.map((cell) => [key(cell), cell]));
  const after = new Map(nextCells.map((cell) => [key(cell), cell]));
  const removedCells = oldCells.filter((cell) => !after.has(key(cell)));
  const addedCells = nextCells.filter((cell) => !before.has(key(cell)));
  const removedBookingIds = new Set(removed.map((booking) => booking.id));
  const addedBookingIds = new Set(added.map((booking) => booking.id));
  if (before.size !== oldCells.length || after.size !== nextCells.length ||
    [...before].some(([cellKey, cell]) => after.has(cellKey) &&
      after.get(cellKey).booking_id !== cell.booking_id) ||
    removedCells.length !== disappeared.size ||
    addedCells.length !== appeared.size ||
    removedCells.some((cell) => !removedBookingIds.has(cell.booking_id)) ||
    addedCells.some((cell) => !addedBookingIds.has(cell.booking_id)) ||
    oldCells.some((cell) => !removedBookingIds.has(cell.booking_id) &&
      after.get(key(cell))?.booking_id !== cell.booking_id) ||
    nextCells.some((cell) => !addedBookingIds.has(cell.booking_id) &&
      before.get(key(cell))?.booking_id !== cell.booking_id))
    throw Error("SWEETFUN_SHADOW_MIXED_OCCUPANCY_DRIFT");
  return { state: next.state, removedOccupancy: removedCells,
    addedOccupancy: addedCells,
    summary: { beforeHash: delta.beforeHash, afterHash: delta.afterHash,
      addedRows: appeared.size, addedBookings: added.length,
      addedRoomNights: addedCells.length, removedRows: disappeared.size,
      removedBookings: removed.length, removedRoomNights: removedCells.length,
      sourceNoteRowsChanged: sourceNoteChanges.length,
      ownerConfirmedCancelled: disappeared.size, writerReceiptVerified: false,
      paymentEventsCreated: 0, canCutover: false } };
}
