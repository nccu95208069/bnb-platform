import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { privateJson } from "./seed-sweetfun-shadow.mjs";
import { validateDatabaseTransport, assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { IronGateService } from "../src/service.ts";
import { createOwlNestWebProvider } from "../src/owlnest-web-provider.mjs";
import { checkedOwlNestConfig } from "../src/owlnest-web-readback.mjs";
import { recoverChannelClaim, releaseReviewedManualClaim } from "../src/channel-recovery.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Read-only OwlNest observation, then evidence-backed recovery or reviewed quarantine. No PUT. */
export async function recoverWithManifest(manifest) {
  if (!UUID.test(manifest?.propertyId ?? "") ||
    !UUID.test(manifest?.grantId ?? "") ||
    !UUID.test(manifest?.expectedClaimId ?? "") ||
    !Number.isSafeInteger(manifest?.expectedInventoryVersion) ||
    ![undefined, true].includes(manifest?.releaseReviewedManualClaim) ||
    typeof manifest?.databaseUrl !== "string" ||
    typeof manifest?.authorization !== "string" ||
    !/^Bearer [A-Za-z0-9._~+\/-]{20,}={0,2}$/.test(manifest.authorization))
    throw Error("CHANNEL_RECOVERY_MANIFEST_INVALID");
  validateDatabaseTransport(manifest.databaseUrl);
  checkedOwlNestConfig(manifest.propertyId,
    manifest.propertyConfigs?.[manifest.propertyId]);
  const pool = new Pool({ connectionString: manifest.databaseUrl, max: 1,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
  try {
    await assertRuntimeDatabase(pool);
    const repository = new PostgresPropertyRepository(pool);
    const state = await repository.read(manifest.propertyId);
    if (!state || state.version !== manifest.expectedInventoryVersion ||
      state.channel?.grantId !== manifest.grantId ||
      state.channelDispatch?.claimId !== manifest.expectedClaimId)
      throw Error("CHANNEL_RECOVERY_STATE_MOVED");
    const principal = { clientId: "channel-recovery", subjectId: "channel-recovery",
      origin: "channel", workspaceId: state.workspaceId,
      propertyIds: [state.propertyId], authorityEpoch: state.authorityEpoch,
      actions: ["channel:verify"], fields: [], grantId: manifest.grantId };
    const provider = createOwlNestWebProvider({
      propertyConfigs: manifest.propertyConfigs,
      getAuthorization: async () => manifest.authorization });
    if (manifest.releaseReviewedManualClaim === true)
      return releaseReviewedManualClaim({ repository, provider, principal,
        propertyId: state.propertyId, expectedClaimId: manifest.expectedClaimId,
        expectedInventoryVersion: manifest.expectedInventoryVersion,
        acknowledgeQuarantine: manifest.acknowledgeQuarantine,
        reviewReason: manifest.reviewReason });
    return recoverChannelClaim({ repository, service: new IronGateService(repository),
      provider, principal, propertyId: state.propertyId,
      expectedClaimId: manifest.expectedClaimId });
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 3) throw Error("PRIVATE_RECOVERY_MANIFEST_REQUIRED");
    const result = await recoverWithManifest(privateJson(process.argv[2]));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const safe = new Set(["CHANNEL_RECOVERY_MANIFEST_INVALID", "CHANNEL_RECOVERY_STATE_MOVED",
      "CHANNEL_RECOVERY_CLAIM_MOVED", "CHANNEL_RECOVERY_OPERATION_INVALID",
      "CHANNEL_RECOVERY_READBACK_INCOMPLETE", "UNSAFE_DATABASE_ROLE_OR_SCHEMA",
      "UNSAFE_DATABASE_TRANSPORT", "CHANNEL_REVIEW_RELEASE_INVALID",
      "CHANNEL_REVIEW_RELEASE_STATE_MOVED", "CHANNEL_REVIEW_RELEASE_READBACK_INCOMPLETE",
      "CHANNEL_REVIEW_RELEASE_STOCK_OPEN", "CHANNEL_REVIEW_RELEASE_LIMIT_REACHED"]);
    process.stderr.write((safe.has(error?.message) ? error.message :
      "CHANNEL_RECOVERY_FAILED") + "\n");
    process.exitCode = 1;
  }
}
