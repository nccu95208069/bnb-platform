import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { resolve } from "node:path";
import { tokenHash, validateGrant, validCredentialId } from "./credential-grant.mjs";
export { createGrantAuthenticator } from "./authenticator.mjs";

/** Only a token digest is stored; raw tokens are returned once to the provisioner. */
export class SqliteCredentialDirectory {
  #db;
  constructor(filename) {
    if (filename === ":memory:") throw new Error("DURABLE_CREDENTIAL_DATABASE_REQUIRED");
    this.#db = new DatabaseSync(resolve(filename));
    chmodSync(resolve(filename), 0o600);
    this.#db.exec("PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        token_hash TEXT PRIMARY KEY,
        credential_id TEXT NOT NULL UNIQUE,
        grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
        expires_at TEXT NOT NULL,
        active INTEGER NOT NULL CHECK(active IN (0, 1))
      );
    `);
  }

  issue(grant, expiresAt) {
    validateGrant(grant, expiresAt);
    const token = randomBytes(32).toString("base64url");
    this.#db.prepare("INSERT INTO credentials(token_hash, credential_id, grant_json, expires_at, active) VALUES (?, ?, ?, ?, 1)")
      .run(tokenHash(token), grant.credentialId, JSON.stringify(grant), expiresAt);
    return token;
  }

  lookup(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const row = this.#db.prepare(
      "SELECT grant_json, expires_at FROM credentials WHERE token_hash = ? AND active = 1"
    ).get(tokenHash(token));
    if (!row || Date.parse(row.expires_at) <= Date.now()) return null;
    return JSON.parse(row.grant_json);
  }

  revoke(credentialId) {
    if (!validCredentialId(credentialId)) throw new Error("INVALID_CREDENTIAL_ID");
    return this.#db.prepare("UPDATE credentials SET active = 0 WHERE credential_id = ?").run(credentialId).changes === 1;
  }

  close() { this.#db.close(); }
}
