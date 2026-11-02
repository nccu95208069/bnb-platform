import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const HEADER = "x-iron-gate-line-proof";
const MAX_BODY = 64 * 1024;
const MAX_PROOF = 4096;
const MAX_LIFETIME_MS = 15000;
const CLOCK_SKEW_MS = 2000;

function secretBytes(secret) {
  const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret ?? []);
  if (bytes.length < 32) throw Error("LINE_PROOF_SECRET_TOO_SHORT");
  return bytes;
}

async function bodyHash(request) {
  const body = request.clone().body;
  if (!body) return createHash("sha256").digest("hex");
  const reader = body.getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY) {
      await reader.cancel();
      throw Error("LINE_PROOF_BODY_TOO_LARGE");
    }
    hash.update(value);
  }
  return hash.digest("hex");
}

function identity(request) {
  const url = new URL(request.url);
  return { method: request.method, pathAndQuery: `${url.pathname}${url.search}`,
    idempotencyKey: request.headers.get("idempotency-key") };
}

function signature(secret, encoded) {
  return createHmac("sha256", secret).update(encoded).digest();
}

/** Called only after the LINE webhook signature, staff and group checks pass. */
export async function signLineOperatorProof(secret, request, grant, operator, nowMs = Date.now()) {
  const key = secretBytes(secret);
  if (grant?.origin !== "line" || typeof grant.lineGroupId !== "string" ||
    !grant.lineGroupId || operator?.active !== true ||
    operator.groupId !== grant.lineGroupId ||
    typeof operator.actorId !== "string" ||
    !grant.lineActorIds?.includes(operator.actorId) ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) throw Error("INVALID_LINE_OPERATOR_PROOF");
  const claims = { v: 1, aud: "iron-gate-line-v1",
    credentialId: grant.credentialId,
    workspaceId: grant.workspaceId, propertyId: grant.propertyId,
    grantId: grant.grantId, groupId: grant.lineGroupId, actorId: operator.actorId,
    issuedAtMs: nowMs, expiresAtMs: nowMs + MAX_LIFETIME_MS,
    ...identity(request), bodySha256: await bodyHash(request) };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const proof = `${encoded}.${signature(key, encoded).toString("base64url")}`;
  if (proof.length > MAX_PROOF) throw Error("LINE_PROOF_TOO_LARGE");
  return proof;
}

/** Separate from the OS verifier: LINE proof never grants OS membership. */
export function createLineOperatorProofVerifier(secret, clock = Date.now) {
  const key = secretBytes(secret);
  return async (request, grant) => {
    try {
      if (grant?.origin !== "line" || !grant.lineGroupId || !grant.grantId ||
        !Array.isArray(grant.lineActorIds)) return null;
      const proof = request.headers.get(HEADER);
      if (!proof || proof.length > MAX_PROOF) return null;
      const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(proof);
      if (!parts) return null;
      const actual = Buffer.from(parts[2], "base64url");
      const expected = signature(key, parts[1]);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (!claims || claims.v !== 1 || claims.aud !== "iron-gate-line-v1" ||
        claims.credentialId !== grant.credentialId ||
        claims.workspaceId !== grant.workspaceId || claims.propertyId !== grant.propertyId ||
        claims.grantId !== grant.grantId || claims.groupId !== grant.lineGroupId ||
        typeof claims.actorId !== "string" ||
        !grant.lineActorIds.includes(claims.actorId) ||
        !Number.isSafeInteger(claims.issuedAtMs) ||
        !Number.isSafeInteger(claims.expiresAtMs) ||
        claims.expiresAtMs <= claims.issuedAtMs ||
        claims.expiresAtMs - claims.issuedAtMs > MAX_LIFETIME_MS) return null;
      const now = clock();
      if (!Number.isSafeInteger(now) || claims.issuedAtMs > now + CLOCK_SKEW_MS ||
        claims.expiresAtMs <= now) return null;
      const requestIdentity = identity(request);
      if (claims.method !== requestIdentity.method ||
        claims.pathAndQuery !== requestIdentity.pathAndQuery ||
        claims.idempotencyKey !== requestIdentity.idempotencyKey ||
        claims.bodySha256 !== await bodyHash(request)) return null;
      return { subjectId: claims.actorId, workspaceId: grant.workspaceId,
        propertyIds: [grant.propertyId], actions: grant.actions, fields: grant.fields,
        groupId: claims.groupId };
    } catch { return null; }
  };
}
