import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prepareSweetfunSourceLinks } from "./sweetfun-source-links.mjs";
import { checkPropertyIntegrity } from "./property-integrity.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha256 = /^[0-9a-f]{64}$/;
const sourceSystem = "sweetfun-calendar-sheet";
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function instant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value))
    return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

/** Prepare only the state transition. The caller must verify external freezes and
 * commit this with a property-row lock and an exact version/hash predicate. */
export function planSweetfunAuthorityActivation(state, occupancyRows, manifest) {
  const frozen = instant(manifest?.legacyFrozenAt);
  const drained = instant(manifest?.gmailDrainedAt);
  const captured = instant(state?.sweetfunImport?.capturedAt);
  const authorized = instant(manifest?.authorizedAt);
  if (!state || !manifest || state.propertyId !== manifest.propertyId ||
    state.workspaceId !== manifest.workspaceId || state.readOnly !== true ||
    state.authorityEpoch !== 0 || state.version !== manifest.expectedVersion ||
    state.sweetfunImport?.sourceHash !== manifest.expectedSourceHash ||
    !sha256.test(manifest.expectedSourceHash ?? "") ||
    state.sweetfunImport?.sourceId !== manifest.sourceAccount ||
    manifest.sourceSystem !== sourceSystem || !uuid.test(manifest.grantId ?? "") ||
    !Number.isSafeInteger(manifest.cutoverTimestampMs) ||
    manifest.cutoverTimestampMs <= 0 ||
    !Number.isSafeInteger(state.version) || state.version < 1 ||
    !Number.isFinite(frozen) || !Number.isFinite(drained) ||
    !Number.isFinite(captured) || !Number.isFinite(authorized) ||
    frozen > drained || drained > captured || captured > authorized ||
    manifest.cutoverTimestampMs > drained ||
    state.channel?.mode !== "none" || state.channel?.ready !== false ||
    state.channel?.websiteSalesEnabled !== false ||
    state.sweetfunImport?.uncontainedReviewRows !== 0 ||
    state.sweetfunImport?.quarantined?.length !== 0 ||
    state.sourceGrants?.length !== 0 || state.operations?.length !== 0 ||
    state.receipts?.length !== 0 || state.fences?.length !== 0 ||
    state.manualBlocks?.length !== 0 || state.bookings?.length === 0 ||
    state.bookings?.some((booking) => booking.paymentEvents?.length) ||
    !Array.isArray(state.sourceLinks) || !state.sourceLinks.length ||
    !checkPropertyIntegrity(state, occupancyRows).ok)
    throw Error("SWEETFUN_AUTHORITY_PREFLIGHT_FAILED");

  const unlinked = structuredClone(state);
  unlinked.sourceLinks = [];
  const recomputed = prepareSweetfunSourceLinks(unlinked, sourceSystem,
    manifest.sourceAccount);
  if (!isDeepStrictEqual(state.sourceLinks, recomputed.state.sourceLinks) ||
    recomputed.summary.activeLinks !== state.bookings.filter((booking) =>
      booking.status === "confirmed").length ||
    state.sourceLinks.some((link) => link.diverged ||
      link.sourceSystem !== sourceSystem ||
      link.sourceAccount !== manifest.sourceAccount))
    throw Error("SWEETFUN_AUTHORITY_LINKS_INCOMPLETE");

  const next = structuredClone(state);
  next.authorityEpoch = 1;
  next.version++;
  next.readOnly = false;
  next.sourceGrants = [{ grantId: manifest.grantId,
    sourceSystem, sourceAccount: manifest.sourceAccount, active: true }];
  next.sweetfunAuthority = {
    activatedAt: manifest.authorizedAt,
    activatedVersion: next.version,
    sourceHash: manifest.expectedSourceHash,
    sourceStateHash: digest({ bookings: state.bookings, sourceLinks: state.sourceLinks,
      occupancyRows }),
    cutoverTimestampMs: manifest.cutoverTimestampMs,
    legacyFrozenAt: manifest.legacyFrozenAt,
    gmailDrainedAt: manifest.gmailDrainedAt,
  };
  return { state: next, summary: { sourceHash: manifest.expectedSourceHash,
    authorityEpoch: 1, inventoryVersion: next.version,
    activeLinks: recomputed.summary.activeLinks,
    cancelledLinks: recomputed.summary.cancelledLinks } };
}

/** Only before the first new write. Epoch 2 invalidates every epoch-1 token. */
export function planSweetfunNoWriteRollback(state, occupancyRows, manifest) {
  const authority = state?.sweetfunAuthority;
  if (!state || state.propertyId !== manifest?.propertyId ||
    state.workspaceId !== manifest.workspaceId || state.readOnly !== false ||
    state.authorityEpoch !== 1 || !authority ||
    state.version !== authority.activatedVersion ||
    authority.sourceHash !== manifest.expectedSourceHash ||
    state.sourceGrants?.length !== 1 ||
    state.sourceGrants[0].grantId !== manifest.grantId ||
    state.sourceGrants[0].active !== true ||
    state.operations?.length !== 0 || state.receipts?.length !== 0 ||
    !checkPropertyIntegrity(state, occupancyRows).ok ||
    digest({ bookings: state.bookings, sourceLinks: state.sourceLinks,
      occupancyRows }) !== authority.sourceStateHash ||
    !Number.isFinite(instant(manifest.rolledBackAt)) ||
    instant(manifest.rolledBackAt) < instant(authority.activatedAt))
    throw Error("SWEETFUN_NO_WRITE_ROLLBACK_UNSAFE");
  const next = structuredClone(state);
  next.authorityEpoch = 2;
  next.version++;
  next.readOnly = true;
  next.sourceGrants[0].active = false;
  next.sweetfunAuthority.rolledBackAt = manifest.rolledBackAt;
  return { state: next, summary: { readOnly: true, authorityEpoch: 2,
    inventoryVersion: next.version, sourceHash: authority.sourceHash } };
}
