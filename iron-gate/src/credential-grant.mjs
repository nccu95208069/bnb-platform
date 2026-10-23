import { createHash } from "node:crypto";

const actions = new Set(["booking:read", "booking:create", "booking:amend", "booking:cancel", "booking:manage_all", "inventory:write",
  "hold:write", "payment:write", "finance:ledger", "event:read", "occupancy:aggregate",
  "housekeeping:read", "source:write", "channel:verify"]);
const fields = new Set(["guest_name", "contact", "notes", "money", "payment_status"]);
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
  if (grant.origin !== "line" && grant.actions.some((action) =>
    ["booking:manage_all", "inventory:write"].includes(action)))
    throw new Error("INVALID_CREDENTIAL_GRANT");
  if (grant.origin === "guest" && (!validCredentialId(grant.bookingIdScope) ||
    grant.actions.some((action) => action !== "booking:read"))) throw new Error("INVALID_GUEST_SCOPE");
  if (grant.origin === "source" && (!grant.grantId || !grant.sourceSystem || !grant.sourceAccount ||
    grant.actions.some((action) => action !== "source:write"))) throw new Error("INVALID_SOURCE_SCOPE");
  if (grant.origin === "channel" && (!grant.grantId ||
    grant.actions.some((action) => action !== "channel:verify"))) throw new Error("INVALID_CHANNEL_SCOPE");
  // Every LINE capability requires an explicit marker on its dedicated grant.
  if (grant.origin === "line" && (!validCredentialId(grant.grantId) ||
    typeof grant.lineGroupId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(grant.lineGroupId) ||
    !Array.isArray(grant.lineActorIds) || grant.lineActorIds.length < 1 ||
    grant.lineActorIds.length > 32 ||
    grant.lineActorIds.some((actor) => typeof actor !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(actor)) ||
    new Set(grant.lineActorIds).size !== grant.lineActorIds.length ||
    grant.actions.some((action) => action !== "booking:read" &&
      !(action === "booking:create" && grant.lineCreateEnabled === true) &&
      !(["booking:amend", "booking:cancel", "booking:manage_all"].includes(action) &&
        grant.lineManageAllEnabled === true) &&
      !(action === "inventory:write" && grant.lineInventoryEnabled === true)) ||
    (grant.actions.includes("booking:create") &&
      !grant.actions.includes("booking:read")) ||
    (grant.lineCreateEnabled === true &&
      !grant.actions.includes("booking:create")) ||
    (grant.lineManageAllEnabled === true &&
      ["booking:read", "booking:amend", "booking:cancel", "booking:manage_all"].some(
        (action) => !grant.actions.includes(action))) ||
    (grant.lineInventoryEnabled === true &&
      (!grant.lineManageAllEnabled || !grant.actions.includes("inventory:write"))) ||
    grant.fields.some((field) => !["guest_name", "contact", "notes", "money"].includes(field))))
    throw new Error("INVALID_LINE_SCOPE");
  if (grant.origin === "service" && (grant.fields.length || grant.actions.some((action) =>
    action !== "event:read" && action !== "booking:read" &&
    action !== "occupancy:aggregate" && action !== "housekeeping:read")))
    throw new Error("INVALID_SERVICE_SCOPE");
  if (grant.origin === "finance" && (grant.actions.some((action) =>
    action !== "event:read" && action !== "booking:read" && action !== "payment:write" &&
    action !== "finance:ledger") ||
    grant.fields.some((field) => field !== "money"))) throw new Error("INVALID_FINANCE_SCOPE");
  if (grant.origin !== "os" && grant.fields.includes("payment_status"))
    throw new Error("INVALID_PAYMENT_STATUS_SCOPE");
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
