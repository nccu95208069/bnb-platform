import { createServer } from "node:http";
import { Readable } from "node:stream";
import { IronGateService } from "./service.ts";
import { createHandler } from "./http.ts";
import { PostgresPropertyRepository } from "./postgres-repository.mjs";
import { PostgresCredentialDirectory } from "./postgres-auth.mjs";
import { createGrantAuthenticator } from "./authenticator.mjs";

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
export function createPostgresIronGateServer(runtimePool, verifyOsMember = null) {
  return createNodeServer(createPostgresIronGateHandler(runtimePool, verifyOsMember));
}

/** Shared request handler for a separate service deployment or the loopback server. */
export function createPostgresIronGateHandler(runtimePool, verifyOsMember = null) {
  const repository = new PostgresPropertyRepository(runtimePool);
  const directory = new PostgresCredentialDirectory(runtimePool);
  const service = new IronGateService(repository);
  const authenticate = createGrantAuthenticator(directory, repository, verifyOsMember);
  return createHandler(service, authenticate);
}
