import { Pool } from "pg";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPostgresIronGateHandler } from "../dist/node-server.mjs";
import { createOsMemberProofVerifier } from "../dist/os-member-proof.mjs";
import { createLineOperatorProofVerifier } from "../dist/line-operator-proof.mjs";
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

/** Bind remote connections to the bundled Supabase CA and hostname. */
export function databaseUrlForVercel(rawUrl) {
  validateDatabaseTransport(rawUrl);
  const url = new URL(rawUrl);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return rawUrl;
  if (["sslrootcert", "sslcert", "sslkey"].some((name) => url.searchParams.has(name)))
    throw Error("UNSAFE_DATABASE_TRANSPORT");
  const caPath = fileURLToPath(new URL("../certs/prod-ca-2021.crt", import.meta.url));
  const ca = readFileSync(caPath, "utf8");
  if (!ca.startsWith("-----BEGIN CERTIFICATE-----") ||
    !ca.includes("-----END CERTIFICATE-----")) throw Error("INVALID_DATABASE_CA");
  url.searchParams.set("sslrootcert", caPath);
  return url.toString();
}

/** One warm invocation reuses a small pool; a failed setup stays closed. */
export function createVercelFetch(env = process.env) {
  let ready;
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
          databaseUrl, verifyLineOperator);
      })();
      return (await ready)(request);
    } catch {
      return unavailable();
    }
  };
}

export default { fetch: createVercelFetch() };
