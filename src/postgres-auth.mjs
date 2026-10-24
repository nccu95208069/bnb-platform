import { randomBytes } from "node:crypto";
import { tokenHash, validateGrant, validCredentialId } from "./credential-grant.mjs";

/**
 * Runtime pool needs only EXECUTE on lookup_credential. An optional, separate
 * administrative pool is required to issue or revoke credentials.
 */
export class PostgresCredentialDirectory {
  #runtimePool;
  #adminPool;
  constructor(runtimePool, adminPool = null) {
    this.#runtimePool = runtimePool;
    this.#adminPool = adminPool;
  }

  async issue(grant, expiresAt) {
    if (!this.#adminPool) throw new Error("CREDENTIAL_ADMIN_CONNECTION_REQUIRED");
    validateGrant(grant, expiresAt);
    const token = randomBytes(32).toString("base64url");
    await this.#adminPool.query(`INSERT INTO iron_gate.credentials
      (token_hash, credential_id, property_id, grant_json, expires_at)
      VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
      [tokenHash(token), grant.credentialId, grant.propertyId, JSON.stringify(grant), expiresAt]);
    return token;
  }

  async lookup(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const result = await this.#runtimePool.query(
      "SELECT iron_gate.lookup_credential($1) AS grant", [tokenHash(token)]);
    return result.rows[0]?.grant ?? null;
  }

  async revoke(credentialId) {
    if (!this.#adminPool) throw new Error("CREDENTIAL_ADMIN_CONNECTION_REQUIRED");
    if (!validCredentialId(credentialId)) throw new Error("INVALID_CREDENTIAL_ID");
    const result = await this.#adminPool.query(
      "UPDATE iron_gate.credentials SET active = false WHERE credential_id = $1 AND active = true",
      [credentialId]);
    return result.rowCount === 1;
  }
}
