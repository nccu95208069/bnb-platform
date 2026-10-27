import { Pool } from "pg";
import { createPostgresIronGateHandler } from "../dist/node-server.mjs";
import { createOsMemberProofVerifier } from "../dist/os-member-proof.mjs";
import { createLineOperatorProofVerifier } from "../dist/line-operator-proof.mjs";
import { waitUntil } from "@vercel/functions";
import { databaseUrlForVercel } from "../dist/vercel-database.mjs";
import { createChannelWorkerRunner } from "./channel-worker.mjs";
export { databaseUrlForVercel } from "../dist/vercel-database.mjs";

function unavailable() {
  return new Response('{"error":{"code":"SERVICE_UNAVAILABLE"}}', {
    status: 503,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

/** One warm invocation reuses a small pool; a failed setup stays closed. */
export function createVercelFetch(env = process.env) {
  let ready;
  const runChannel = createChannelWorkerRunner(env);
  return async (request) => {
    // Production and Preview each need their own explicit switch and secrets.
    // A deployment, including an accidental Production deployment, starts closed.
    const preview = env.VERCEL_ENV === "preview" &&
      env.IRON_GATE_PREVIEW_ENABLED === "true";
    const production = env.VERCEL_ENV === "production" &&
      env.IRON_GATE_PRODUCTION_ENABLED === "true";
    if (!preview && !production)
      return unavailable();
    try {
      ready ??= (async () => {
        const rawDatabaseUrl = production ? env.IRON_GATE_PRODUCTION_DATABASE_URL :
          env.IRON_GATE_DATABASE_URL;
        const proofSecret = production ? env.IRON_GATE_PRODUCTION_OS_PROOF_SECRET :
          env.IRON_GATE_OS_PROOF_SECRET;
        if (!rawDatabaseUrl || !proofSecret)
          throw Error("MISSING_CONFIGURATION");
        const databaseUrl = databaseUrlForVercel(rawDatabaseUrl);
        const verifyOsMember = createOsMemberProofVerifier(proofSecret);
        const lineProofSecret = production ? env.IRON_GATE_PRODUCTION_LINE_PROOF_SECRET :
          env.IRON_GATE_LINE_PROOF_SECRET;
        const verifyLineOperator = lineProofSecret ?
          createLineOperatorProofVerifier(lineProofSecret) : null;
        const pool = new Pool({ connectionString: databaseUrl,
          max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
        return createPostgresIronGateHandler(pool, verifyOsMember,
          databaseUrl, verifyLineOperator, lineProofSecret || null,
          ({ propertyId, operationKey }) => {
            waitUntil(runChannel({ propertyId, operationKey }).catch(() => {
              // No provider bodies or credentials. The committed job remains
              // available to cron if startup failed before it was claimed.
              console.error("line_channel_start_unavailable");
            }));
          });
      })();
      return (await ready)(request);
    } catch {
      return unavailable();
    }
  };
}

export default { fetch: createVercelFetch() };
