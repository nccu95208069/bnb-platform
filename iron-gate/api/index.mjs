import { Pool } from "pg";
import { createPostgresIronGateHandler } from "../dist/node-server.mjs";
import { createOsMemberProofVerifier } from "../dist/os-member-proof.mjs";
import { validateDatabaseTransport } from "../dist/runtime-safety.mjs";

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
  return async (request) => {
    try {
      ready ??= (async () => {
        if (!env.IRON_GATE_DATABASE_URL || !env.IRON_GATE_OS_PROOF_SECRET)
          throw Error("MISSING_CONFIGURATION");
        validateDatabaseTransport(env.IRON_GATE_DATABASE_URL);
        const verifyOsMember = createOsMemberProofVerifier(env.IRON_GATE_OS_PROOF_SECRET);
        const pool = new Pool({ connectionString: env.IRON_GATE_DATABASE_URL,
          max: 2, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000 });
        return createPostgresIronGateHandler(pool, verifyOsMember,
          env.IRON_GATE_DATABASE_URL);
      })();
      return (await ready)(request);
    } catch {
      return unavailable();
    }
  };
}

export default { fetch: createVercelFetch() };
