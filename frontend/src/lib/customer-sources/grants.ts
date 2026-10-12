import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { accountKey, digest } from "../customer-workspaces/auth.ts";
import { loadWorkspace } from "../customer-workspaces/service.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Account, Workspace } from "../customer-workspaces/types.ts";
import { bindingKey, workspaceBindingsKey } from "../website-booking/connections.ts";
import type { WebsiteBinding } from "../website-booking/types.ts";

export const PROVIDERS = ["line", "gmail", "owlnest"] as const;
export type SourceProvider = (typeof PROVIDERS)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PKCE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const STATE = /^[A-Za-z0-9._~-]{16,256}$/;
const SOURCE_ACCOUNT = /^[^\x00-\x1f\x7f]{1,160}$/;
const LINE_SUBJECT = /^U[a-f0-9]{32}$/;
const LINE_ACCOUNT = /^line:U[a-f0-9]{32}$/;
const CODE_TTL_MS = 5 * 60000;
const RECOVERY_TTL_SECONDS = 86400;
export type SourceClient = {
  id: string;
  token_sha256: string;
  providers: SourceProvider[];
  redirect_uri: string;
  start_uri?: string;
};
export type SourceGrant = {
  id: string;
  clientId: string;
  provider: SourceProvider;
  ownerAccountId: string;
  ownerEmail: string;
  workspaceId: string;
  propertyId: string;
  slug: string;
  tokenHash: string;
  version: number;
  status: "awaiting_source" | "awaiting_owner" | "active" | "revoked";
  sourceAccount?: string;
  sourceLabel?: string;
  ownerSubject?: string;
  createdAt: string;
  approvedAt?: string;
  revokedAt?: string;
};
type SetupCode = {
  hash: string;
  codeChallenge: string;
  state: string;
  clientId: string;
  provider: SourceProvider;
  ownerAccountId: string;
  ownerEmail: string;
  workspaceId: string;
  propertyId: string;
  slug: string;
  expiresAt: string;
  consumed?: { grantId: string; requestKey: string };
};
const grantKey = (id: string) => `source:grant:${id}`;
const setupKey = (code: string) => `source:setup:${digest(code)}`;
const indexKey = (workspaceId: string) => `source:grants:${workspaceId}`;
const issueKey = (ownerId: string, requestKey: string) => `source:issue:${ownerId}:${requestKey}`;
const uuid = (value: unknown): string => {
  if (typeof value !== "string" || !UUID.test(value)) throw Error("INVALID_INPUT");
  return value;
};
const provider = (value: unknown): SourceProvider => {
  if (!PROVIDERS.includes(value as SourceProvider)) throw Error("INVALID_INPUT");
  return value as SourceProvider;
};
function exact(input: Record<string, unknown>, keys: string[]) {
  if (Object.keys(input).length !== keys.length || Object.keys(input).some(key => !keys.includes(key)))
    throw Error("INVALID_INPUT");
}
function secret() {
  const value = process.env.CUSTOMER_SOURCE_GRANT_SECRET;
  if (!value || value.length < 40) throw Error("SOURCES_UNAVAILABLE");
  return value;
}
export function sourceClients(): SourceClient[] {
  if (process.env.CUSTOMER_SOURCES_ENABLED !== "true") throw Error("SOURCES_UNAVAILABLE");
  secret();
  let list: unknown;
  try { list = JSON.parse(process.env.CUSTOMER_SOURCE_CLIENTS ?? "null"); }
  catch { throw Error("SOURCES_UNAVAILABLE"); }
  if (!Array.isArray(list) || list.length < 1 || list.length > 20) throw Error("SOURCES_UNAVAILABLE");
  const ids = new Set<string>(), tokens = new Set<string>();
  for (const raw of list) {
    const c = raw as SourceClient;
    let redirect: URL, start: URL | null;
    try { redirect = new URL(c.redirect_uri); start = c.start_uri ? new URL(c.start_uri) : null; }
    catch { throw Error("SOURCES_UNAVAILABLE"); }
    if (!c || typeof c !== "object" || !/^[A-Za-z0-9._:-]{3,80}$/.test(c.id) || ids.has(c.id) ||
      !/^[a-f0-9]{64}$/.test(c.token_sha256) || tokens.has(c.token_sha256) ||
      !Array.isArray(c.providers) || !c.providers.length || new Set(c.providers).size !== c.providers.length ||
      c.providers.some(p => !PROVIDERS.includes(p)) || redirect.protocol !== "https:" ||
      redirect.username || redirect.password || redirect.hash || redirect.search ||
      (start && (start.protocol !== "https:" || start.username || start.password || start.hash || start.search))) throw Error("SOURCES_UNAVAILABLE");
    ids.add(c.id); tokens.add(c.token_sha256);
  }
  return list as SourceClient[];
}
export function sourceClient(authorization: string | null) {
  const token = /^Bearer ([A-Za-z0-9._~+/-]{32,256})$/.exec(authorization ?? "")?.[1];
  if (!token) throw Error("UNAUTHORIZED");
  const hash = Buffer.from(digest(token), "hex");
  const client = sourceClients().find(c => timingSafeEqual(Buffer.from(c.token_sha256, "hex"), hash));
  if (!client) throw Error("UNAUTHORIZED");
  return client;
}
function mac(label: string) { return createHmac("sha256", secret()).update(label).digest("base64url"); }
function grantToken(grantId: string, requestKey: string) { return mac(`grant:v1:${grantId}:${requestKey}`); }
function activeOwner(workspace: Workspace, ownerAccountId: string, propertyId: string) {
  return workspace.properties.some(p => p.id === propertyId) &&
    workspace.members.some(m => m.accountId === ownerAccountId && m.active && m.role === "owner" &&
      (m.allProperties || m.propertyIds.includes(propertyId)));
}
export function grantOwnerActive(workspace: Workspace, grant: SourceGrant) {
  return workspace.slug === grant.slug && activeOwner(workspace, grant.ownerAccountId, grant.propertyId);
}
export function sourceReturnUrl(client: SourceClient, code: string, state: string) {
  const url = new URL(client.redirect_uri);
  url.searchParams.set("code", code);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function issueSourceCode(store: CustomerStore, account: Account, slug: string,
  input: Record<string, unknown>, now = new Date()) {
  exact(input, ["action", "propertyId", "clientId", "provider", "state", "codeChallenge", "requestKey", "version"]);
  if (input.action !== "issue" || !account.emailVerifiedAt || !STATE.test(String(input.state)) ||
    !PKCE.test(String(input.codeChallenge))) throw Error("INVALID_INPUT");
  const propertyId = uuid(input.propertyId), requestKey = uuid(input.requestKey), source = provider(input.provider);
  const client = sourceClients().find(c => c.id === input.clientId && c.providers.includes(source));
  if (!client) throw Error("FORBIDDEN");
  const { workspace, member } = await loadWorkspace(store, account.id, slug);
  if (member.role !== "owner" || !activeOwner(workspace, account.id, propertyId)) throw Error("FORBIDDEN");
  const params = JSON.stringify({ slug, propertyId, clientId: client.id, source, state: input.state, challenge: input.codeChallenge });
  const hash = digest(params), previous = await store.read<{ hash: string; code: string }>(issueKey(account.id, requestKey));
  if (previous.value) {
    if (previous.value.hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
    return { redirectUrl: sourceReturnUrl(client, previous.value.code, String(input.state)), expiresAt: (await store.read<SetupCode>(setupKey(previous.value.code))).value?.expiresAt ?? null };
  }
  if (input.version !== workspace.version) throw Error("VERSION_CONFLICT");
  await store.limit(`source-issue:${account.id}`, 30);
  const code = mac(`setup:v1:${account.id}:${requestKey}:${hash}`);
  const setup: SetupCode = { hash, codeChallenge: String(input.codeChallenge), state: String(input.state),
    clientId: client.id, provider: source, ownerAccountId: account.id, ownerEmail: account.email, workspaceId: workspace.id,
    propertyId, slug, expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString() };
  await store.commit([
    { key: setupKey(code), before: null, after: setup, ttlSeconds: RECOVERY_TTL_SECONDS },
    { key: issueKey(account.id, requestKey), before: null, after: { hash, code }, ttlSeconds: RECOVERY_TTL_SECONDS },
  ]);
  return { redirectUrl: sourceReturnUrl(client, code, setup.state), expiresAt: setup.expiresAt };
}

export async function exchangeSourceCode(store: CustomerStore, client: SourceClient,
  input: Record<string, unknown>, now = new Date()) {
  exact(input, ["action", "code", "codeVerifier", "requestKey"]);
  if (input.action !== "exchange" || typeof input.code !== "string" ||
    !PKCE.test(input.code) || !VERIFIER.test(String(input.codeVerifier))) throw Error("INVALID_INPUT");
  const requestKey = uuid(input.requestKey), code = input.code, saved = await store.read<SetupCode>(setupKey(code)), setup = saved.value;
  if (!setup || setup.clientId !== client.id || !client.providers.includes(setup.provider) ||
    !timingSafeEqual(Buffer.from(digest(String(input.codeVerifier)), "hex"),
      Buffer.from(setup.codeChallenge, "base64url"))) throw Error("UNAUTHORIZED");
  if (setup.consumed && setup.consumed.requestKey !== requestKey) throw Error("IDEMPOTENCY_CONFLICT");
  if (!setup.consumed && Date.parse(setup.expiresAt) <= now.getTime()) throw Error("CONNECTION_EXPIRED");
  const workspaceSnapshot = await store.read<Workspace>(`workspace:${setup.workspaceId}`), workspace = workspaceSnapshot.value;
  if (!workspace || workspace.slug !== setup.slug || !activeOwner(workspace, setup.ownerAccountId, setup.propertyId)) throw Error("FORBIDDEN");
  const owner = (await store.read<Account>(accountKey(setup.ownerEmail))).value;
  if (!owner?.emailVerifiedAt || owner.id !== setup.ownerAccountId) throw Error("FORBIDDEN");
  const grantId = setup.consumed?.grantId ?? randomUUID(), token = grantToken(grantId, requestKey);
  if (!setup.consumed) {
    const index = await store.read<string[]>(indexKey(setup.workspaceId)), ids = index.value ?? [];
    if (ids.length >= 30) throw Error("LIMIT_REACHED");
    const grant: SourceGrant = { id: grantId, clientId: client.id, provider: setup.provider,
      ownerAccountId: setup.ownerAccountId, ownerEmail: setup.ownerEmail, workspaceId: setup.workspaceId, propertyId: setup.propertyId,
      slug: setup.slug, tokenHash: digest(token), version: 1, status: "awaiting_source", createdAt: now.toISOString() };
    const siteIds = (await store.read<string[]>(workspaceBindingsKey(workspace.id))).value ?? [];
    const changes: Change[] = [
      { key: grantKey(grantId), before: null, after: grant },
      { key: indexKey(setup.workspaceId), before: index.raw, after: [...ids, grantId] },
      { key: setupKey(code), before: saved.raw, after: { ...setup, consumed: { grantId, requestKey } }, ttlSeconds: RECOVERY_TTL_SECONDS },
      { key: `workspace:${workspace.id}`, before: workspaceSnapshot.raw,
        after: { ...workspace, version: workspace.version + 1,
          sourceConnections: [...(workspace.sourceConnections ?? []).filter(c => !(c.propertyId === setup.propertyId && c.provider === setup.provider)),
            { propertyId: setup.propertyId, provider: setup.provider, grantId, status: "pending_verification" }],
          audit: [...workspace.audit, { at: now.toISOString(), actor: setup.ownerAccountId,
            action: "source.grant.exchanged", targetId: grantId }] } },
    ];
    for (const siteId of siteIds) {
      const site = await store.read<WebsiteBinding>(bindingKey(siteId));
      if (site.value?.propertyId === setup.propertyId && site.value.enabled)
        changes.push({ key: bindingKey(siteId), before: site.raw,
          after: { ...site.value, enabled: false, revision: site.value.revision + 1 } });
    }
    await store.commit(changes);
  }
  const grant = (await store.read<SourceGrant>(grantKey(grantId))).value;
  if (!grant || grant.clientId !== client.id || grant.tokenHash !== digest(token) || grant.status === "revoked") throw Error("WRITE_UNCONFIRMED");
  return { schemaVersion: 1, grantId, grantToken: token, grantVersion: grant.version, state: setup.state,
    accountId: grant.ownerAccountId, workspaceId: grant.workspaceId, propertyId: grant.propertyId,
    provider: grant.provider, status: grant.status };
}

export async function authorizedGrant(store: CustomerStore, id: unknown, authorization: string | null,
  expectedVersion?: unknown, requireActive = false) {
  const grantId = uuid(id), token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
  if (!token) throw Error("UNAUTHORIZED");
  const saved = await store.read<SourceGrant>(grantKey(grantId)), grant = saved.value;
  if (!grant || !timingSafeEqual(Buffer.from(grant.tokenHash, "hex"), Buffer.from(digest(token), "hex")) ||
    grant.status === "revoked") throw Error("UNAUTHORIZED");
  if (expectedVersion !== undefined && expectedVersion !== grant.version) throw Error("VERSION_CONFLICT");
  if (requireActive && grant.status !== "active") throw Error("FORBIDDEN");
  const client = sourceClients().find(c => c.id === grant.clientId && c.providers.includes(grant.provider));
  if (!client) throw Error("UNAUTHORIZED");
  const workspaceSnapshot = await store.read<Workspace>(`workspace:${grant.workspaceId}`), workspace = workspaceSnapshot.value;
  if (!workspace || !grantOwnerActive(workspace, grant)) throw Error("FORBIDDEN");
  return { saved, grant, workspace, workspaceSnapshot };
}

export async function proposeSourceAccount(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null) {
  if (input.action !== "propose") throw Error("INVALID_INPUT");
  uuid(input.requestKey);
  const { saved, grant, workspace, workspaceSnapshot } = await authorizedGrant(store, input.grantId, authorization, input.grantVersion);
  exact(input, ["action", "grantId", "grantVersion", "sourceAccount", "sourceLabel", "requestKey",
    ...(grant.provider === "line" ? ["ownerSubject"] : [])]);
  const sourceAccount = String(input.sourceAccount), sourceLabel = String(input.sourceLabel);
  if (!SOURCE_ACCOUNT.test(sourceAccount) || !SOURCE_ACCOUNT.test(sourceLabel) ||
    (grant.provider === "line" && (!LINE_ACCOUNT.test(sourceAccount) || !LINE_SUBJECT.test(String(input.ownerSubject)))))
    throw Error("INVALID_INPUT");
  if (grant.status === "awaiting_owner" && grant.sourceAccount === sourceAccount && grant.sourceLabel === sourceLabel &&
    grant.ownerSubject === input.ownerSubject)
    return publicGrant(grant);
  if (grant.status !== "awaiting_source") throw Error("VERSION_CONFLICT");
  const next: SourceGrant = { ...grant, sourceAccount, sourceLabel,
    ...(grant.provider === "line" ? { ownerSubject: String(input.ownerSubject) } : {}),
    status: "awaiting_owner", version: grant.version + 1 };
  await store.commit([{ key: grantKey(grant.id), before: saved.raw, after: next },
    { key: `workspace:${workspace.id}`, before: workspaceSnapshot.raw, after: workspace }]);
  return publicGrant(next);
}
export async function sourceGrantStatus(store: CustomerStore, id: unknown, authorization: string | null) {
  const { grant, workspace } = await authorizedGrant(store, id, authorization);
  const property = workspace.properties.find(p => p.id === grant.propertyId)!;
  return { schemaVersion: 1, grantId: grant.id, grantVersion: grant.version, status: grant.status,
    accountId: grant.ownerAccountId, workspaceId: workspace.id, workspaceVersion: workspace.version,
    propertyId: property.id, propertyName: property.name, provider: grant.provider, sourceAccount: grant.sourceAccount ?? null,
    sourceLabel: grant.sourceLabel ?? null, ownerSubject: grant.ownerSubject ?? null,
    rooms: property.rooms.map(r => ({ id: r.id, name: r.name })) };
}

export async function reportSourceRevoked(store: CustomerStore, input: Record<string, unknown>,
  authorization: string | null, now = new Date()) {
  exact(input, ["action", "grantId", "grantVersion", "requestKey"]);
  if (input.action !== "report_revoked") throw Error("INVALID_INPUT");
  const requestKey = uuid(input.requestKey), id = uuid(input.grantId);
  const revocationKey = `source:revocation:${id}:${requestKey}`;
  const earlier = await store.read<{ at: string; version: number }>(revocationKey);
  if (earlier.value) {
    const priorGrant = (await store.read<SourceGrant>(grantKey(id))).value;
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
    if (!priorGrant || priorGrant.status !== "revoked" || !token ||
      !timingSafeEqual(Buffer.from(priorGrant.tokenHash, "hex"), Buffer.from(digest(token), "hex")) ||
      priorGrant.version !== earlier.value.version || input.grantVersion !== earlier.value.version - 1)
      throw Error("UNAUTHORIZED");
    return { schemaVersion: 1, grantId: id, status: "revoked", grantVersion: earlier.value.version, verified: true };
  }
  const { saved, grant } = await authorizedGrant(store, input.grantId, authorization, input.grantVersion);
  const wsKey = `workspace:${grant.workspaceId}`, workspaceSnapshot = await store.read<Workspace>(wsKey), workspace = workspaceSnapshot.value;
  if (!workspace || !activeOwner(workspace, grant.ownerAccountId, grant.propertyId)) throw Error("FORBIDDEN");
  const siteIds = (await store.read<string[]>(workspaceBindingsKey(workspace.id))).value ?? [];
  const currentConnection = workspace.sourceConnections?.find(c => c.propertyId === grant.propertyId && c.provider === grant.provider);
  const nextConnections = !currentConnection || currentConnection.grantId === grant.id
    ? [...(workspace.sourceConnections ?? []).filter(c => !(c.propertyId === grant.propertyId && c.provider === grant.provider)),
        { propertyId: grant.propertyId, provider: grant.provider, grantId: grant.id, status: "revoked" as const }]
    : workspace.sourceConnections ?? [];
  const changes: Change[] = [
    { key: grantKey(grant.id), before: saved.raw, after: { ...grant, version: grant.version + 1, status: "revoked", revokedAt: now.toISOString() } },
    { key: wsKey, before: workspaceSnapshot.raw, after: { ...workspace, version: workspace.version + 1,
      sourceConnections: nextConnections,
      audit: [...workspace.audit, { at: now.toISOString(), actor: `source:${grant.clientId}`, action: "source.grant.revoked", targetId: grant.id }] } },
    { key: revocationKey, before: null, after: { at: now.toISOString(), version: grant.version + 1 } },
  ];
  for (const siteId of siteIds) {
    const site = await store.read<WebsiteBinding>(bindingKey(siteId));
    if (site.value?.propertyId === grant.propertyId && site.value.enabled)
      changes.push({ key: bindingKey(siteId), before: site.raw,
        after: { ...site.value, enabled: false, revision: site.value.revision + 1 } });
  }
  await store.commit(changes);
  return { schemaVersion: 1, grantId: grant.id, status: "revoked", grantVersion: grant.version + 1, verified: true };
}
function publicGrant(grant: SourceGrant) {
  return { id: grant.id, provider: grant.provider, propertyId: grant.propertyId, status: grant.status,
    version: grant.version, sourceAccount: grant.sourceAccount ?? null, sourceLabel: grant.sourceLabel ?? null,
    ownerSubject: grant.ownerSubject ?? null,
    createdAt: grant.createdAt, approvedAt: grant.approvedAt ?? null, revokedAt: grant.revokedAt ?? null };
}
export async function ownerSourceGrants(store: CustomerStore, accountId: string, slug: string) {
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  if (member.role !== "owner") throw Error("FORBIDDEN");
  const ids = (await store.read<string[]>(indexKey(workspace.id))).value ?? [];
  const grants = await Promise.all(ids.map(id => store.read<SourceGrant>(grantKey(id))));
  let clients: { id: string; providers: SourceProvider[]; startUrl: string | null }[] = [];
  try { clients = sourceClients().map(c => ({ id: c.id, providers: c.providers, startUrl: c.start_uri ?? null })); }
  catch { /* Existing grants must remain visible and revocable while new setup is off. */ }
  return { workspaceVersion: workspace.version, clients,
    fences: (workspace.integrationFences ?? []).filter(f => member.allProperties || member.propertyIds.includes(f.propertyId))
      .map(f => ({ id: f.id, propertyId: f.propertyId, mode: f.mode, state: f.state,
        checkIn: f.checkIn, checkOut: f.checkOut, roomIds: f.roomIds, createdAt: f.createdAt })),
    grants: grants.map(s => s.value).filter((g): g is SourceGrant =>
    !!g && g.workspaceId === workspace.id && activeOwner(workspace, accountId, g.propertyId) &&
    (member.allProperties || member.propertyIds.includes(g.propertyId))).map(publicGrant) };
}
export async function ownerSourceAction(store: CustomerStore, account: Account, slug: string,
  input: Record<string, unknown>, now = new Date()) {
  exact(input, ["action", "grantId", "grantVersion", "propertyId", "sourceAccount", "version", "requestKey"]);
  const action = input.action;
  if (action !== "approve" && action !== "revoke") throw Error("INVALID_INPUT");
  const id = uuid(input.grantId), propertyId = uuid(input.propertyId), requestKey = uuid(input.requestKey);
  const loaded = await loadWorkspace(store, account.id, slug), { workspace, member, raw } = loaded;
  if (member.role !== "owner" || !account.emailVerifiedAt || !activeOwner(workspace, account.id, propertyId)) throw Error("FORBIDDEN");
  const saved = await store.read<SourceGrant>(grantKey(id)), grant = saved.value;
  if (!grant || grant.workspaceId !== workspace.id || grant.propertyId !== propertyId ||
    (action === "approve" && grant.ownerAccountId !== account.id))
    throw Error("NOT_FOUND");
  const opKey = `source:owner-operation:${id}:${requestKey}`, opHash = digest(JSON.stringify(input));
  const prior = await store.read<{ hash: string }>(opKey);
  if (prior.value) {
    if (prior.value.hash !== opHash) throw Error("IDEMPOTENCY_CONFLICT");
    return ownerSourceGrants(store, account.id, slug);
  }
  if (workspace.version !== input.version || grant.version !== input.grantVersion) throw Error("VERSION_CONFLICT");
  if (action === "approve" && (grant.status !== "awaiting_owner" || grant.sourceAccount !== input.sourceAccount)) throw Error("FORBIDDEN");
  if (action === "revoke" && grant.status === "revoked") throw Error("VERSION_CONFLICT");
  const next: SourceGrant = { ...grant, version: grant.version + 1, status: action === "approve" ? "active" : "revoked",
    ...(action === "approve" ? { approvedAt: now.toISOString() } : { revokedAt: now.toISOString() }) };
  const ids = (await store.read<string[]>(indexKey(workspace.id))).value ?? [];
  const other = action === "approve" ? (await Promise.all(ids.filter(otherId => otherId !== id).map(otherId => store.read<SourceGrant>(grantKey(otherId)))))
    .filter(s => s.value?.provider === grant.provider && s.value.propertyId === propertyId && s.value.status === "active") : [];
  const currentConnection = workspace.sourceConnections?.find(c => c.propertyId === propertyId && c.provider === grant.provider);
  const nextConnections = action === "approve" || !currentConnection || currentConnection.grantId === id
    ? [...(workspace.sourceConnections ?? []).filter(c => !(c.propertyId === propertyId && c.provider === grant.provider)),
      { propertyId, provider: grant.provider, grantId: id,
        status: action === "approve" ? "pending_verification" as const : "revoked" as const }]
    : workspace.sourceConnections ?? [];
  const changes: Change[] = [{ key: grantKey(id), before: saved.raw, after: next },
    ...other.map(s => ({ key: grantKey(s.value!.id), before: s.raw, after: { ...s.value!, status: "revoked" as const, version: s.value!.version + 1, revokedAt: now.toISOString() } })),
    { key: `workspace:${workspace.id}`, before: raw, after: { ...workspace, version: workspace.version + 1,
      sourceConnections: nextConnections,
      audit: [...workspace.audit, { at: now.toISOString(), actor: account.id,
        action: action === "approve" ? "source.grant.approved" : "source.grant.revoked", targetId: id }] } },
    { key: opKey, before: null, after: { hash: opHash } }];
  {
    const siteIds = (await store.read<string[]>(workspaceBindingsKey(workspace.id))).value ?? [];
    for (const siteId of siteIds) {
      const site = await store.read<WebsiteBinding>(bindingKey(siteId));
      if (site.value?.propertyId === propertyId && site.value.enabled)
        changes.push({ key: bindingKey(siteId), before: site.raw,
          after: { ...site.value, enabled: false, revision: site.value.revision + 1 } });
    }
  }
  await store.commit(changes);
  return ownerSourceGrants(store, account.id, slug);
}
