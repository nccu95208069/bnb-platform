import { createHash } from "node:crypto";

const actions = new Set(["booking:read", "booking:create", "booking:amend", "booking:cancel",
  "hold:write", "payment:write", "event:read", "occupancy:aggregate",
  "housekeeping:read", "source:write", "channel:verify"]);
const fields = new Set(["guest_name", "contact", "notes", "money"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
export const validCredentialId = (value) => typeof value === "string" && uuid.test(value);

export function validateGrantShape(grant) {
  if (!grant || !validCredentialId(grant.credentialId) || !validCredentialId(grant.workspaceId) ||
    !validCredentialId(grant.propertyId) || !Number.isSafeInteger(grant.authorityEpoch) ||
    grant.authorityEpoch < 0 || typeof grant.clientId !== "string" || !grant.clientId ||
    typeof grant.subjectId !== "string" || !grant.subjectId ||
    !Array.isArray(grant.actions) || grant.actions.some((action) => !actions.has(action)) ||
    !Array.isArray(grant.fields) || grant.fields.some((field) => !fields.has(field)))
    throw new Error("INVALID_CREDENTIAL_GRANT");
  if (!["os", "line", "website", "guest", "source", "channel", "service", "finance"].includes(grant.origin))
    throw new Error("INVALID_CREDENTIAL_ORIGIN");
  if (grant.origin === "guest" && (!validCredentialId(grant.bookingIdScope) ||
    grant.actions.some((action) => action !== "booking:read"))) throw new Error("INVALID_GUEST_SCOPE");
  if (grant.origin === "source" && (!grant.grantId || !grant.sourceSystem || !grant.sourceAccount ||
    grant.actions.some((action) => action !== "source:write"))) throw new Error("INVALID_SOURCE_SCOPE");
  if (grant.origin === "channel" && (!grant.grantId ||
    grant.actions.some((action) => action !== "channel:verify"))) throw new Error("INVALID_CHANNEL_SCOPE");
  if (grant.origin === "service" && (grant.fields.length || grant.actions.some((action) =>
    action !== "event:read" && action !== "booking:read" &&
    action !== "occupancy:aggregate" && action !== "housekeeping:read")))
    throw new Error("INVALID_SERVICE_SCOPE");
  if (grant.origin === "finance" && (grant.actions.some((action) =>
    action !== "event:read" && action !== "booking:read" && action !== "payment:write") ||
    grant.fields.some((field) => field !== "money"))) throw new Error("INVALID_FINANCE_SCOPE");
  if (grant.origin === "website" && !grant.bindingId) throw new Error("INVALID_WEBSITE_SCOPE");
  if (grant.origin === "os" && grant.actions.some((action) =>
    action === "source:write" || action === "channel:verify")) throw new Error("INVALID_OS_SCOPE");
  if (grant.grantId !== undefined && (typeof grant.grantId !== "string" || !grant.grantId))
    throw new Error("INVALID_CREDENTIAL_GRANT");
  if (grant.bindingId !== undefined && (typeof grant.bindingId !== "string" || !grant.bindingId))
    throw new Error("INVALID_CREDENTIAL_GRANT");
}

export function validateGrant(grant, expiresAt) {
  validateGrantShape(grant);
  const expiry = Date.parse(expiresAt);
  if (typeof expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt) ||
    !Number.isFinite(expiry) || new Date(expiry).toISOString() !== expiresAt ||
    expiry <= Date.now() || expiry > Date.now() + 30 * 86_400_000)
    throw new Error("INVALID_CREDENTIAL_EXPIRY");
}
