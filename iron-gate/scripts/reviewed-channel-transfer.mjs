import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { databaseUrlForVercel } from "../src/vercel-database.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { IronGateService } from "../src/service.ts";
import { createOwlNestWebProvider } from "../src/owlnest-web-provider.mjs";
import { checkedOwlNestConfig } from "../src/owlnest-web-readback.mjs";
import { createFreshChannelAuthorization } from "../api/channel-worker.mjs";
import { transferReviewedChannelOperation } from "../src/channel-review-transfer.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Trusted stdin configuration is kept in memory; no credentials are printed or saved. */
export async function transferWithRuntime(manifest) {
  const env = manifest?.runtimeEnv, propertyId = manifest?.propertyId;
  if (!env || env.VERCEL_ENV !== "production" || env.IRON_GATE_PRODUCTION_ENABLED !== "true" ||
    env.IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED !== "true" ||
    !UUID.test(propertyId ?? "") || propertyId !== env.IRON_GATE_CHANNEL_PROPERTY_ID ||
    !UUID.test(env.IRON_GATE_CHANNEL_GRANT_ID ?? "") ||
    !UUID.test(manifest.targetOperationKey ?? "") || !UUID.test(manifest.expectedClaimId ?? "") ||
    !Number.isSafeInteger(manifest.expectedInventoryVersion) ||
    !SECRET.test(env.IRON_GATE_CHANNEL_AUTH_TOKEN ?? ""))
    throw Error("CHANNEL_REVIEW_TRANSFER_MANIFEST_INVALID");
  let authUrl, alertUrl, propertyConfigs;
  try {
    authUrl = new URL(env.IRON_GATE_CHANNEL_AUTH_URL);
    alertUrl = new URL(env.IRON_GATE_CHANNEL_ALERT_URL);
    propertyConfigs = JSON.parse(env.IRON_GATE_CHANNEL_OWLNEST_CONFIG_JSON);
  } catch { throw Error("CHANNEL_REVIEW_TRANSFER_MANIFEST_INVALID"); }
  if (authUrl.protocol !== "https:" || authUrl.origin !== alertUrl.origin ||
    authUrl.pathname !== "/internal/iron-gate-channel-auth" ||
    authUrl.username || authUrl.password || authUrl.search || authUrl.hash || authUrl.port)
    throw Error("CHANNEL_REVIEW_TRANSFER_MANIFEST_INVALID");
  checkedOwlNestConfig(propertyId, propertyConfigs?.[propertyId]);
  const databaseUrl = databaseUrlForVercel(env.IRON_GATE_PRODUCTION_DATABASE_URL);
  const pool = new Pool({connectionString: databaseUrl, max: 1,
    connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000});
  try {
    await assertRuntimeDatabase(pool);
    const repository = new PostgresPropertyRepository(pool);
    const state = await repository.read(propertyId);
    if (!state) throw Error("CHANNEL_REVIEW_TRANSFER_STATE_MOVED");
    const principal = {clientId: "channel-review-transfer", subjectId: "channel-review-transfer",
      origin: "channel", workspaceId: state.workspaceId, propertyIds: [propertyId],
      authorityEpoch: state.authorityEpoch, actions: ["channel:verify"], fields: [],
      grantId: env.IRON_GATE_CHANNEL_GRANT_ID};
    const getAuthorization = createFreshChannelAuthorization({url: authUrl,
      token: env.IRON_GATE_CHANNEL_AUTH_TOKEN, propertyId});
    const provider = createOwlNestWebProvider({propertyConfigs, getAuthorization});
    return await transferReviewedChannelOperation({repository, service: new IronGateService(repository),
      provider, principal, propertyId, targetOperationKey: manifest.targetOperationKey,
      expectedClaimId: manifest.expectedClaimId, expectedInventoryVersion: manifest.expectedInventoryVersion,
      expectedCells: manifest.expectedCells, reviewReason: manifest.reviewReason});
  } finally {await pool.end();}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw Error("CHANNEL_REVIEW_TRANSFER_STDIN_REQUIRED");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 262_144) throw Error("CHANNEL_REVIEW_TRANSFER_MANIFEST_INVALID");
    }
    const result = await transferWithRuntime(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.state !== "sync_verified") process.exitCode = 2;
  } catch (error) {
    const safe = /^CHANNEL_REVIEW_(TRANSFER_[A-Z_]+|BLOCKED)$/;
    process.stderr.write((safe.test(error?.message ?? "") ? error.message : "CHANNEL_REVIEW_TRANSFER_FAILED") + "\n");
    process.exitCode = 1;
  }
}
