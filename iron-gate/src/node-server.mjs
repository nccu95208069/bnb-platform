import { createServer } from "node:http";
import { Readable } from "node:stream";
import { IronGateService } from "./service.ts";
import { createHandler } from "./http.ts";
import { PostgresPropertyRepository } from "./postgres-repository.mjs";
import { FinanceCommandService } from "./finance-commands.mjs";
import { loadHistoricalManifestFromEnvironment } from "./finance-historical-settlement.mjs";
import { PostgresCredentialDirectory } from "./postgres-auth.mjs";
import { createGrantAuthenticator } from "./authenticator.mjs";
import { assertRuntimeDatabase, validateDatabaseTransport } from "./runtime-safety.mjs";

/** Adapt the Fetch Request/Response handler to Node HTTP. The caller owns listen(), TLS, and shutdown. */
export function createNodeServer(handle) {
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (incoming, outgoing) => {
    try {
      const url = new URL(incoming.url ?? "/", "http://iron-gate.internal");
      const method = incoming.method ?? "GET";
      const options = { method, headers: incoming.headers };
      if (method !== "GET" && method !== "HEAD") {
        options.body = Readable.toWeb(incoming);
        options.duplex = "half";
      }
      const response = await handle(new Request(url, options));
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { "content-type": "application/json",
          "cache-control": "private, no-store" });
        outgoing.end('{"error":{"code":"INTERNAL_ERROR"}}');
      } else outgoing.destroy();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

/**
 * The runtime pool needs iron_gate_runtime only. OS credentials stay denied
 * unless verifyOsMember supplies fresh, independently verified membership.
 */
export function createPostgresIronGateServer(runtimePool, verifyOsMember = null,
  databaseUrl, verifyLineOperator = null, linePreviewSecret = null) {
  return createNodeServer(createPostgresIronGateHandler(runtimePool, verifyOsMember,
    databaseUrl, verifyLineOperator, linePreviewSecret));
}

/** Shared request handler for a separate service deployment or the loopback server. */
export function createPostgresIronGateHandler(runtimePool, verifyOsMember = null,
  databaseUrl, verifyLineOperator = null, linePreviewSecret = null, onLineChannelQueued = null) {
  validateDatabaseTransport(databaseUrl);
  // The checked URL must be the one used by pg. Separate host/SSL overrides
  // could otherwise make a safe-looking URL validate an unsafe pool.
  const poolOptions = runtimePool?.options;
  if (poolOptions?.connectionString !== databaseUrl ||
    ["host", "port", "database", "user", "password", "ssl"].some((key) =>
      Object.hasOwn(poolOptions, key))) throw Error("UNSAFE_DATABASE_TRANSPORT");
  // Runtime capability alone cannot cut over a property. The repository also
  // checks the property/source connector's effective cutover inside each write.
  const financeNativeRuntimeEnabled =
    process.env.IRON_GATE_FINANCE_NATIVE_LEDGER_ENABLED === 'true';
  const repository = new PostgresPropertyRepository(runtimePool,
    financeNativeRuntimeEnabled);
  const directory = new PostgresCredentialDirectory(runtimePool);
  const service = new IronGateService(repository, linePreviewSecret);
  const authenticate = createGrantAuthenticator(directory, repository, verifyOsMember,
    verifyLineOperator);
  const finance = new FinanceCommandService(runtimePool,
    process.env.IRON_GATE_FINANCE_PREVIEW_SECRET,
    process.env.IRON_GATE_FINANCE_COMMANDS_ENABLED === 'true',
    loadHistoricalManifestFromEnvironment());
  const handle = createHandler(service, authenticate, onLineChannelQueued ?? undefined, finance);
  // Every deployment adapter, including a serverless one, must pass the same
  // database role and RLS check before it can authenticate or serve a request.
  let ready;
  return async (request) => {
    ready ??= assertRuntimeDatabase(runtimePool).catch((error) => {
      // A database outage can recover without a new serverless cold start.
      // A privileged role or unsafe schema stays closed for this instance.
      if (error?.message !== "UNSAFE_DATABASE_ROLE_OR_SCHEMA") ready = undefined;
      throw error;
    });
    try { await ready; }
    catch {
      return new Response('{"error":{"code":"SERVICE_UNAVAILABLE"}}', { status: 503,
        headers: { "content-type": "application/json; charset=utf-8",
          "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
    }
    return handle(request);
  };
}
