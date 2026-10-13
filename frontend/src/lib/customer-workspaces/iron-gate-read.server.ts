import { signCurrentIronGateMembership } from "./iron-gate-proof.server.ts";
import type { CustomerStore } from "./store.ts";

type ReadGrant = {
  credentialId: string;
  clientId: string;
  workspaceId: string;
  propertyId: string;
  origin: "os";
  token: string;
};

export type IronGateReadConfig = {
  baseUrl: string;
  proofSecret: string;
  grants: ReadGrant[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RESPONSE_FIELDS = new Set(["id", "workspaceId", "propertyId", "version", "status",
  "channelSyncState", "stays", "createdAt", "source", "guestName", "contact", "notes",
  "totalCents", "currency", "paymentSummary", "hold"]);

function configuredBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || url.protocol === "http:" && url.hostname === "127.0.0.1"))
    throw new Error("IRON_GATE_READ_CONFIG_INVALID");
  return url.origin;
}

/** Parse only server-side configuration. No URL, credential, or grant comes from a browser request. */
export function ironGateReadConfig(env: NodeJS.ProcessEnv = process.env): IronGateReadConfig {
  try {
    if (env.IRON_GATE_SHADOW_ENABLED !== "true") throw new Error();
    const baseUrl = configuredBaseUrl(env.IRON_GATE_BASE_URL ?? "");
    const proofSecret = env.IRON_GATE_OS_PROOF_SECRET ?? "";
    const grants = JSON.parse(env.IRON_GATE_OS_READ_GRANTS ?? "null") as unknown;
    if (Buffer.byteLength(proofSecret, "utf8") < 32 || !Array.isArray(grants) || grants.length < 1 ||
      grants.length > 1000) throw new Error();
    const seen = new Set<string>();
    for (const item of grants) {
      if (!item || typeof item !== "object") throw new Error();
      const grant = item as Record<string, unknown>;
      if (Object.keys(grant).some((key) => !["credentialId", "clientId", "workspaceId",
        "propertyId", "origin", "token"].includes(key)) ||
        !UUID.test(String(grant.credentialId)) || !UUID.test(String(grant.workspaceId)) ||
        !UUID.test(String(grant.propertyId)) || grant.origin !== "os" ||
        typeof grant.clientId !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(grant.clientId) ||
        typeof grant.token !== "string" || !TOKEN.test(grant.token)) throw new Error();
      const key = String(grant.propertyId);
      if (seen.has(key)) throw new Error();
      seen.add(key);
    }
    return { baseUrl, proofSecret, grants: grants as ReadGrant[] };
  } catch { throw new Error("IRON_GATE_READ_CONFIG_INVALID"); }
}

/**
 * An authenticated OS server may read one booking through Iron Gate. The
 * current workspace membership is reloaded and signed for this exact GET.
 */
export async function readIronGateBooking(
  store: CustomerStore, accountId: string, slug: string,
  propertyId: string, bookingId: string, config: IronGateReadConfig,
  send: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  if (!UUID.test(propertyId) || !UUID.test(bookingId)) throw new Error("INVALID_INPUT");
  const baseUrl = configuredBaseUrl(config.baseUrl);
  const grant = config.grants.find((item) => item.propertyId === propertyId);
  if (!grant) throw new Error("NOT_FOUND");
  const url = `${baseUrl}/v1/properties/${propertyId}/bookings/${bookingId}`;
  const unsigned = new Request(url, { method: "GET" });
  const proof = await signCurrentIronGateMembership(store, accountId, slug, unsigned,
    grant, config.proofSecret);
  const claims = JSON.parse(Buffer.from(proof.split(".")[0], "base64url").toString("utf8")) as {
    fields: string[]; workspaceId: string;
  };
  let response: Response;
  try {
    response = await send(url, { method: "GET", headers: {
      authorization: `Bearer ${grant.token}`, "x-iron-gate-os-proof": proof,
    }, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(3000) });
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (response.status === 404) throw new Error("NOT_FOUND");
  if (!response.ok) throw new Error("IRON_GATE_READ_FAILED");
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (!Number.isSafeInteger(declared) || declared > 64 * 1024) throw new Error("IRON_GATE_READ_FAILED");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IRON_GATE_READ_FAILED");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) {
        await reader.cancel();
        throw new Error("IRON_GATE_READ_FAILED");
      }
      chunks.push(value);
    }
  } catch { throw new Error("IRON_GATE_READ_FAILED"); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("IRON_GATE_READ_FAILED"); }
  if (!raw || Array.isArray(raw) || typeof raw !== "object") throw new Error("IRON_GATE_READ_FAILED");
  const booking = raw as Record<string, unknown>;
  if (booking.id !== bookingId || booking.propertyId !== propertyId ||
    booking.workspaceId !== claims.workspaceId ||
    Object.keys(booking).some((key) => !RESPONSE_FIELDS.has(key)) ||
    !claims.fields.includes("guest_name") && "guestName" in booking ||
    !claims.fields.includes("contact") && "contact" in booking ||
    !claims.fields.includes("notes") && "notes" in booking ||
    !claims.fields.includes("money") &&
      ["totalCents", "currency", "paymentSummary"].some((key) => key in booking))
    throw new Error("IRON_GATE_READ_FAILED");
  return booking;
}
