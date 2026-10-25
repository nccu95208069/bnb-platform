import { createHash } from "node:crypto";
import { checkPropertyIntegrity } from "./property-integrity.mjs";
import { verifyOfflandShadow } from "./offland-shadow.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_SYSTEM = "offland-calendar-sheet";

function instant(value) {
  if (typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return NaN;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** The caller must prove each external writer is stopped and pass the final
 * private snapshot. This function never mutates the caller's state. */
export function planOfflandAuthorityActivation(state, occupancy, snapshot, config, manifest) {
  const captured = instant(state?.offlandImport?.capturedAt);
  const finalCaptured = instant(manifest?.finalCapturedAt);
  const authorized = instant(manifest?.authorizedAt);
  const freezeTimes = ["legacyFrozenAt", "appsScriptFrozenAt",
    "humanEditsFrozenAt", "osWritesFrozenAt", "lineDrainedAt", "gmailDrainedAt"]
    .map((key) => instant(manifest?.[key]));
  if (!state || !manifest || !config ||
    state.propertyId !== manifest.propertyId || state.workspaceId !== manifest.workspaceId ||
    state.propertyId !== config.propertyId || state.workspaceId !== config.workspaceId ||
    state.readOnly !== true || state.authorityEpoch !== 0 ||
    !Number.isSafeInteger(state.version) || state.version < 1 ||
    state.version !== manifest.expectedVersion ||
    state.offlandImport?.sourceHash !== manifest.expectedSourceHash ||
    config.expectedSourceHash !== manifest.expectedSourceHash ||
    !SHA256.test(manifest.expectedSourceHash ?? "") ||
    state.offlandImport?.sourceId !== manifest.sourceAccount ||
    config.sourceId !== manifest.sourceAccount ||
    manifest.sourceSystem !== SOURCE_SYSTEM || !UUID.test(manifest.grantId ?? "") ||
    !Number.isSafeInteger(manifest.cutoverTimestampMs) ||
    manifest.cutoverTimestampMs <= 0 ||
    !Number.isFinite(captured) || !Number.isFinite(finalCaptured) ||
    !Number.isFinite(authorized) ||
    typeof manifest.finalSourceCopyId !== "string" ||
    !manifest.finalSourceCopyId ||
    manifest.finalSourceCopyId === manifest.sourceAccount ||
    manifest.finalSourceCopyId === state.offlandImport.sourceCopyId ||
    manifest.finalSourceCopyCreatedAt !== manifest.finalCapturedAt ||
    captured >= finalCaptured || finalCaptured > authorized ||
    freezeTimes.some((ms) => !Number.isFinite(ms) || ms > finalCaptured) ||
    manifest.cutoverTimestampMs > Math.min(...freezeTimes) ||
    state.channel?.mode !== "none" || state.channel?.ready !== false ||
    state.channel?.websiteSalesEnabled !== false ||
    state.offlandImport?.flaggedGroups !== 0 ||
    state.offlandImport?.paymentEventsCreated !== 0 ||
    state.sourceGrants?.length !== 0 || state.operations?.length !== 0 ||
    state.receipts?.length !== 0 || state.manualBlocks?.length !== 0 ||
    state.fences?.length !== 0 || !state.bookings?.length ||
    state.bookings.some((booking) => booking.status !== "confirmed" ||
      booking.paymentEvents?.length) ||
    !Array.isArray(state.sourceLinks) ||
    state.sourceLinks.length !== state.bookings.length ||
    !checkPropertyIntegrity(state, occupancy).ok ||
    !verifyOfflandShadow(snapshot, config, state).matches)
    throw Error("OFFLAND_AUTHORITY_PREFLIGHT_FAILED");

  const next = structuredClone(state);
  next.authorityEpoch = 1;
  next.version++;
  next.readOnly = false;
  next.sourceGrants = [{ grantId: manifest.grantId, sourceSystem: SOURCE_SYSTEM,
    sourceAccount: manifest.sourceAccount, active: true }];
  next.offlandAuthority = {
    activatedAt: manifest.authorizedAt,
    activatedVersion: next.version,
    sourceHash: manifest.expectedSourceHash,
    sourceStateHash: digest({ bookings: state.bookings,
      sourceLinks: state.sourceLinks, occupancy }),
    finalSourceCopyId: manifest.finalSourceCopyId,
    finalCapturedAt: manifest.finalCapturedAt,
    cutoverTimestampMs: manifest.cutoverTimestampMs,
    legacyFrozenAt: manifest.legacyFrozenAt,
    appsScriptFrozenAt: manifest.appsScriptFrozenAt,
    humanEditsFrozenAt: manifest.humanEditsFrozenAt,
    osWritesFrozenAt: manifest.osWritesFrozenAt,
    lineDrainedAt: manifest.lineDrainedAt,
    gmailDrainedAt: manifest.gmailDrainedAt,
  };
  return { state: next, summary: { sourceHash: manifest.expectedSourceHash,
    authorityEpoch: 1, inventoryVersion: next.version,
    activeLinks: state.sourceLinks.length, occupiedVillaNights: occupancy.length } };
}

/** Only safe before the first Iron Gate write. Epoch 2 invalidates epoch-1 grants. */
export function planOfflandNoWriteRollback(state, occupancy, manifest) {
  const authority = state?.offlandAuthority;
  if (!state || !manifest || state.propertyId !== manifest.propertyId ||
    state.workspaceId !== manifest.workspaceId || state.readOnly !== false ||
    state.authorityEpoch !== 1 || !authority ||
    state.version !== authority.activatedVersion ||
    authority.sourceHash !== manifest.expectedSourceHash ||
    state.sourceGrants?.length !== 1 ||
    state.sourceGrants[0].grantId !== manifest.grantId ||
    state.sourceGrants[0].active !== true ||
    state.operations?.length !== 0 || state.receipts?.length !== 0 ||
    !checkPropertyIntegrity(state, occupancy).ok ||
    digest({ bookings: state.bookings, sourceLinks: state.sourceLinks,
      occupancy }) !== authority.sourceStateHash ||
    !Number.isFinite(instant(manifest.rolledBackAt)) ||
    instant(manifest.rolledBackAt) < instant(authority.activatedAt))
    throw Error("OFFLAND_NO_WRITE_ROLLBACK_UNSAFE");
  const next = structuredClone(state);
  next.authorityEpoch = 2;
  next.version++;
  next.readOnly = true;
  next.sourceGrants[0].active = false;
  next.offlandAuthority.rolledBackAt = manifest.rolledBackAt;
  return { state: next, summary: { readOnly: true, authorityEpoch: 2,
    inventoryVersion: next.version, sourceHash: authority.sourceHash } };
}
