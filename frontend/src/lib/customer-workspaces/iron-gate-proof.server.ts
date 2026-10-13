import { createHash, createHmac } from "node:crypto";
import { loadWorkspace } from "./service.ts";
import type { CustomerStore } from "./store.ts";
import type { Role } from "./types.ts";

type Action = "booking:read" | "event:read";
type Field = "guest_name" | "contact" | "notes" | "money";
type MachineGrant = {
  credentialId: string;
  clientId: string;
  workspaceId: string;
  propertyId: string;
  origin: "os";
};

const MAX_BODY = 64 * 1024;
const MAX_LIFETIME_MS = 5000;

function permissions(role: Role): { actions: Action[]; fields: Field[] } {
  if (!["owner", "admin", "housekeeper", "viewer", "viewer_no_price"].includes(role))
    throw new Error("FORBIDDEN");
  const actions: Action[] = ["booking:read", "event:read"];
  const fields: Field[] = ["guest_name"];
  if (role !== "viewer_no_price") fields.push("contact", "notes", "money");
  return { actions, fields };
}

async function bodyHash(request: Request): Promise<string> {
  const reader = request.clone().body?.getReader();
  const hash = createHash("sha256");
  if (!reader) return hash.digest("hex");
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new Error("IRON_GATE_BODY_TOO_LARGE");
    }
    hash.update(value);
  }
  return hash.digest("hex");
}

/**
 * A private OS gateway calls this for every outgoing Iron Gate request after
 * authenticating the browser session. The current active member is reloaded
 * from CustomerStore; no client-provided role or property scope is accepted.
 * This preparatory bridge issues read-only scopes. It does not route traffic
 * or change the current OS booking writer.
 */
export async function signCurrentIronGateMembership(
  store: CustomerStore,
  accountId: string,
  slug: string,
  request: Request,
  grant: MachineGrant,
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  if (grant?.origin !== "os" || !grant.credentialId || !grant.clientId ||
    Buffer.byteLength(secret, "utf8") < 32 || !Number.isSafeInteger(nowMs) || nowMs < 0)
    throw new Error("IRON_GATE_PROOF_CONFIG_INVALID");
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  const property = workspace.properties.find((item) => item.id === grant.propertyId);
  if (!property || workspace.id !== grant.workspaceId || member.active !== true ||
    typeof member.allProperties !== "boolean" || !Array.isArray(member.propertyIds) ||
    workspace.members.filter((item) => item.accountId === accountId).length !== 1 ||
    !(member.allProperties === true || member.propertyIds.includes(grant.propertyId)))
    throw new Error("FORBIDDEN");
  const url = new URL(request.url);
  const claims = {
    v: 1, aud: "iron-gate-v1", credentialId: grant.credentialId, clientId: grant.clientId,
    workspaceId: workspace.id, propertyId: property.id, subjectId: accountId,
    ...permissions(member.role), issuedAtMs: nowMs,
    expiresAtMs: nowMs + MAX_LIFETIME_MS, method: request.method,
    pathAndQuery: `${url.pathname}${url.search}`,
    idempotencyKey: request.headers.get("idempotency-key"),
    bodySha256: await bodyHash(request),
  };
  const encoded = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
  const proof = `${encoded}.${signature}`;
  if (proof.length > 4096) throw new Error("IRON_GATE_PROOF_TOO_LARGE");
  return proof;
}
