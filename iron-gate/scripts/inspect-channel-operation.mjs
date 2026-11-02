import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { databaseUrlForVercel } from "../src/vercel-database.mjs";
import { assertRuntimeDatabase } from "../src/runtime-safety.mjs";
import { PostgresPropertyRepository } from "../src/postgres-repository.mjs";
import { createOwlNestWebReadback, checkedOwlNestConfig, owlNestDayNumber } from
  "../src/owlnest-web-readback.mjs";
import { createFreshChannelAuthorization } from "../api/channel-worker.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const cells = (items) => items.map(({ roomId, date, desired }) => ({ roomId, date, desired }))
  .sort((a, b) => a.roomId.localeCompare(b.roomId) || a.date.localeCompare(b.date));

export function validateInspection(manifest) {
  if (!UUID.test(manifest?.propertyId ?? "") || !UUID.test(manifest?.operationKey ?? "") ||
    !Number.isSafeInteger(manifest?.expectedInventoryVersion) || manifest.expectedInventoryVersion < 0 ||
    !(manifest.expectedClaimId === null || UUID.test(manifest.expectedClaimId ?? "")) ||
    !["sync_pending", "review_required", "sync_verified"].includes(manifest.expectedOperationState) ||
    !Array.isArray(manifest.expectedCells) || !manifest.expectedCells.length ||
    manifest.expectedCells.length > 4096 || manifest.expectedCells.some((cell) =>
      !UUID.test(cell?.roomId ?? "") || !["open", "closed"].includes(cell?.desired)))
    throw Error("CHANNEL_INSPECT_MANIFEST_INVALID");
  for (const cell of manifest.expectedCells) owlNestDayNumber(cell.date);
  if (new Set(manifest.expectedCells.map((cell) => `${cell.roomId}|${cell.date}`)).size !==
    manifest.expectedCells.length) throw Error("CHANNEL_INSPECT_MANIFEST_INVALID");
}

/** Inspect a pinned operation without recording evidence or changing its state.
 * The adapter has only observe; this entry point cannot issue provider writes.
 */
export async function inspectOperation(manifest, { repository, readback, grantId }) {
  validateInspection(manifest);
  const before = await repository.read(manifest.propertyId);
  const operation = before?.operations?.find((item) => item.key === manifest.operationKey);
  if (!before || before.propertyId !== manifest.propertyId ||
    before.version !== manifest.expectedInventoryVersion || before.readOnly !== false ||
    before.channel?.mode !== "owlnest" || before.channel.ready !== true ||
    before.channel.sourceReadbackEnabled !== true || before.channel.grantId !== grantId ||
    (before.channelDispatch?.claimId ?? null) !== manifest.expectedClaimId ||
    operation?.state !== manifest.expectedOperationState || !Array.isArray(operation.cells) ||
    JSON.stringify(cells(operation.cells)) !== JSON.stringify(cells(manifest.expectedCells)))
    throw Error("CHANNEL_INSPECT_STATE_MOVED");
  const observed = await readback.observe(manifest.propertyId, structuredClone(manifest.expectedCells));
  const after = await repository.read(manifest.propertyId);
  if (hash(after) !== hash(before)) throw Error("CHANNEL_INSPECT_STATE_MOVED");
  return { readOnly: true, propertyId: manifest.propertyId, operationKey: manifest.operationKey,
    inventoryVersion: before.version, stateHash: hash(before),
    operationState: operation.state, controlMode: operation.controlMode ?? "booking",
    observationCount: operation.observations?.length ?? 0,
    verifiedAt: operation.verifiedAt ?? null, providerVersion: operation.providerVersion ?? null,
    claim: before.channelDispatch ? { claimId: before.channelDispatch.claimId,
      operationKey: before.channelDispatch.operationKey, state: before.channelDispatch.state } : null,
    observed };
}

export async function inspectWithManifest(manifest) {
  validateInspection(manifest);
  const env = manifest.runtimeEnv;
  if (env?.VERCEL_ENV !== "production" ||
    env.IRON_GATE_PRODUCTION_CHANNEL_WORKER_ENABLED !== "true" ||
    env.IRON_GATE_CHANNEL_PROPERTY_ID !== manifest.propertyId ||
    !UUID.test(env.IRON_GATE_CHANNEL_GRANT_ID ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/.test(env.IRON_GATE_CHANNEL_AUTH_TOKEN ?? ""))
    throw Error("CHANNEL_INSPECT_CONFIG_INVALID");
  const authUrl = new URL(env.IRON_GATE_CHANNEL_AUTH_URL);
  const alertUrl = new URL(env.IRON_GATE_CHANNEL_ALERT_URL);
  if (authUrl.protocol !== "https:" || authUrl.origin !== alertUrl.origin ||
    authUrl.pathname !== "/internal/iron-gate-channel-auth" || authUrl.port ||
    authUrl.username || authUrl.password || authUrl.search || authUrl.hash ||
    env.IRON_GATE_CHANNEL_AUTH_TOKEN === env.CRON_SECRET ||
    env.IRON_GATE_CHANNEL_AUTH_TOKEN === env.IRON_GATE_CHANNEL_ALERT_TOKEN)
    throw Error("CHANNEL_INSPECT_CONFIG_INVALID");
  const configs = JSON.parse(env.IRON_GATE_CHANNEL_OWLNEST_CONFIG_JSON);
  checkedOwlNestConfig(manifest.propertyId, configs?.[manifest.propertyId]);
  const pool = new Pool({ connectionString: databaseUrlForVercel(env.IRON_GATE_PRODUCTION_DATABASE_URL),
    max: 1, connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
  try {
    await assertRuntimeDatabase(pool);
    return await inspectOperation(manifest, { repository: new PostgresPropertyRepository(pool),
      grantId: env.IRON_GATE_CHANNEL_GRANT_ID,
      readback: createOwlNestWebReadback({ propertyConfigs: configs,
        getAuthorization: createFreshChannelAuthorization({ url: authUrl,
          token: env.IRON_GATE_CHANNEL_AUTH_TOKEN, propertyId: manifest.propertyId }) }) });
  } finally { await pool.end(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw Error("CHANNEL_INSPECT_MANIFEST_INVALID");
    const chunks = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1_000_000) throw Error("CHANNEL_INSPECT_MANIFEST_INVALID");
      chunks.push(chunk);
    }
    const result = await inspectWithManifest(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    const safe = new Set(["CHANNEL_INSPECT_MANIFEST_INVALID", "CHANNEL_INSPECT_STATE_MOVED",
      "CHANNEL_INSPECT_CONFIG_INVALID", "UNSAFE_DATABASE_ROLE_OR_SCHEMA",
      "UNSAFE_DATABASE_TRANSPORT", "OWLNEST_AUTH_EXPIRED", "OWLNEST_READ_FAILED",
      "OWLNEST_RESPONSE_INCOMPLETE"]);
    process.stderr.write((safe.has(error?.message) ? error.message : "CHANNEL_INSPECT_FAILED") + "\n");
    process.exitCode = 1;
  }
}
