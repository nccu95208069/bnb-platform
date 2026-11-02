import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const HEADER = "x-iron-gate-os-proof";
const MAX_BODY = 64 * 1024;
const MAX_PROOF = 4096;
const MAX_LIFETIME_MS = 5000;
const CLOCK_SKEW_MS = 2000;

function secretBytes(secret) {
  const bytes = typeof secret === "string" ? Buffer.from(secret, "utf8") : Buffer.from(secret ?? []);
  if (bytes.length < 32) throw Error("OS_PROOF_SECRET_TOO_SHORT");
  return bytes;
}

async function requestBodyHash(request) {
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
      throw Error("OS_PROOF_BODY_TOO_LARGE");
    }
    hash.update(value);
  }
  return hash.digest("hex");
}

function requestIdentity(request) {
  const url = new URL(request.url);
  return { method: request.method, pathAndQuery: `${url.pathname}${url.search}`,
    idempotencyKey: request.headers.get("idempotency-key") };
}

function signature(secret, encoded) {
  return createHmac("sha256", secret).update(encoded).digest();
}

/**
 * Called only by a private OS gateway after reloading current workspace
 * membership from OS storage. It binds the proof to one exact HTTP request.
 */
export async function signOsMemberProof(secret, request, grant, member, nowMs = Date.now()) {
  const key = secretBytes(secret);
  if (grant?.origin !== "os" || member?.active !== true ||
    member.workspaceId !== grant.workspaceId ||
    !member.propertyIds?.includes(grant.propertyId) ||
    typeof member.subjectId !== "string" || !member.subjectId ||
    !Array.isArray(member.actions) || member.actions.some((item) => typeof item !== "string") ||
    !Array.isArray(member.fields) || member.fields.some((item) => typeof item !== "string") ||
    !Number.isSafeInteger(nowMs) || nowMs < 0) throw Error("INVALID_OS_MEMBER_PROOF");
  const claims = { v: 1, aud: "iron-gate-v1", credentialId: grant.credentialId, clientId: grant.clientId,
    workspaceId: grant.workspaceId, propertyId: grant.propertyId,
    subjectId: member.subjectId, actions: member.actions, fields: member.fields,
    issuedAtMs: nowMs, expiresAtMs: nowMs + MAX_LIFETIME_MS,
    ...requestIdentity(request), bodySha256: await requestBodyHash(request) };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const proof = `${encoded}.${signature(key, encoded).toString("base64url")}`;
  if (proof.length > MAX_PROOF) throw Error("OS_PROOF_TOO_LARGE");
  return proof;
}

/** Plug into createGrantAuthenticator(directory, repository, verifier). */
export function createOsMemberProofVerifier(secret, clock = Date.now) {
  const key = secretBytes(secret);
  return async (request, grant) => {
    try {
      if (grant?.origin !== "os") return null;
      const proof = request.headers.get(HEADER);
      if (!proof || proof.length > MAX_PROOF) return null;
      const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(proof);
      if (!parts) return null;
      const claimedSignature = Buffer.from(parts[2], "base64url");
      const expectedSignature = signature(key, parts[1]);
      if (claimedSignature.length !== expectedSignature.length ||
        !timingSafeEqual(claimedSignature, expectedSignature)) return null;
      const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (!claims || claims.v !== 1 || claims.aud !== "iron-gate-v1" ||
        claims.credentialId !== grant.credentialId ||
        claims.clientId !== grant.clientId || claims.workspaceId !== grant.workspaceId ||
        claims.propertyId !== grant.propertyId ||
        typeof claims.subjectId !== "string" || !claims.subjectId ||
        !Array.isArray(claims.actions) || !Array.isArray(claims.fields) ||
        claims.actions.some((item) => typeof item !== "string") ||
        claims.fields.some((item) => typeof item !== "string") ||
        !Number.isSafeInteger(claims.issuedAtMs) ||
        !Number.isSafeInteger(claims.expiresAtMs) ||
        claims.expiresAtMs <= claims.issuedAtMs ||
        claims.expiresAtMs - claims.issuedAtMs > MAX_LIFETIME_MS) return null;
      const now = clock();
      if (!Number.isSafeInteger(now) || claims.issuedAtMs > now + CLOCK_SKEW_MS ||
        claims.expiresAtMs <= now) return null;
      const identity = requestIdentity(request);
      if (claims.method !== identity.method || claims.pathAndQuery !== identity.pathAndQuery ||
        claims.idempotencyKey !== identity.idempotencyKey ||
        claims.bodySha256 !== await requestBodyHash(request)) return null;
      return { subjectId: claims.subjectId, workspaceId: claims.workspaceId,
        propertyIds: [claims.propertyId], actions: claims.actions, fields: claims.fields };
    } catch { return null; }
  };
}
