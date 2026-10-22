import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { createPostgresIronGateServer } from "./node-server.mjs";
import { createOsMemberProofVerifier } from "./os-member-proof.mjs";
import { createLineOperatorProofVerifier } from "./line-operator-proof.mjs";
import { validateDatabaseTransport, assertRuntimeDatabase } from "./runtime-safety.mjs";

export { validateDatabaseTransport } from "./runtime-safety.mjs";

function port(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw Error("INVALID_BIND_PORT");
  return number;
}

/**
 * Private process entrypoint. A same-host gateway terminates TLS and forwards
 * requests to this loopback listener; no public bind is supported here.
 */
export async function startPrivateServer(env = process.env) {
  if (!env.IRON_GATE_DATABASE_URL) throw Error("DATABASE_URL_REQUIRED");
  if (!env.IRON_GATE_OS_PROOF_SECRET) throw Error("OS_PROOF_SECRET_REQUIRED");
  validateDatabaseTransport(env.IRON_GATE_DATABASE_URL);
  const verifier = createOsMemberProofVerifier(env.IRON_GATE_OS_PROOF_SECRET);
  const lineVerifier = env.IRON_GATE_LINE_PROOF_SECRET ?
    createLineOperatorProofVerifier(env.IRON_GATE_LINE_PROOF_SECRET) : null;
  const bindPort = port(env.IRON_GATE_PORT ?? "8787");
  const pool = new Pool({ connectionString: env.IRON_GATE_DATABASE_URL,
    max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000 });
  try {
    await assertRuntimeDatabase(pool);
    const server = createPostgresIronGateServer(pool, verifier, env.IRON_GATE_DATABASE_URL,
      lineVerifier);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => { server.off("listening", onListening); reject(error); };
        const onListening = () => { server.off("error", onError); resolve(); };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(bindPort, "127.0.0.1");
      });
    } catch (error) {
      throw error;
    }
    return { server, pool, address: server.address(), async close() {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await pool.end();
    } };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const running = await startPrivateServer();
    process.stdout.write(`Iron Gate listening privately on 127.0.0.1:${running.address.port}\n`);
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      running.close().catch(() => { process.exitCode = 1; });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    running.server.on("error", () => { process.exitCode = 1; shutdown(); });
  } catch (error) {
    const safe = new Set(["DATABASE_URL_REQUIRED", "OS_PROOF_SECRET_REQUIRED",
      "OS_PROOF_SECRET_TOO_SHORT", "LINE_PROOF_SECRET_TOO_SHORT", "INVALID_BIND_PORT", "UNSAFE_DATABASE_TRANSPORT",
      "UNSAFE_DATABASE_ROLE_OR_SCHEMA"]);
    const code = safe.has(error?.message) ? error.message : "STARTUP_FAILED";
    process.stderr.write(`Iron Gate startup failed: ${code}\n`);
    process.exitCode = 1;
  }
}
