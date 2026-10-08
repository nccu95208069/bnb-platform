import { randomUUID } from "node:crypto";
import { accountKey, digest } from "../customer-workspaces/auth.ts";
import { propertyReadiness } from "../customer-workspaces/domain.ts";
import { customerOrigin } from "../customer-workspaces/site-url.ts";
import { loadWorkspace, validSlug } from "../customer-workspaces/service.ts";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Account, Property, Workspace } from "../customer-workspaces/types.ts";
import { amount, bindingToken, email, fields, integer, permittedSite, plain, record, requireEnabled, uuid, validateConfiguration } from "./config.ts";
import type { RoomOffer, WebsiteBinding, WebsiteClient, WebsiteConnection } from "./types.ts";

export const connectionKey = (id: string) => `website:connection:${id}`;
export const bindingKey = (id: string) => `website:binding:${id}`;
const siteKey = (client: string, site: string) => `website:site:${digest(JSON.stringify([client, site]))}`;
type Site = { bindingId: string; ownerAccountId: string; ownerEmail: string };
export async function connectionFor(store: CustomerStore, id: unknown, now = new Date()) {
  const saved = await store.read<WebsiteConnection>(connectionKey(uuid(id)));
  if (!saved.value) throw Error("CONNECTION_EXPIRED");
  if (saved.value.state === "awaiting_owner" && Date.parse(saved.value.expiresAt) <= now.getTime()) throw Error("CONNECTION_EXPIRED");
  return { ...saved, value: saved.value };
}
export function calendarUrl(binding: Pick<WebsiteBinding, "slug">) { return `${customerOrigin()}/w/${binding.slug}/calendar`; }
export async function connectionStatus(store: CustomerStore, client: WebsiteClient, input: Record<string, unknown>, now = new Date()) {
  fields(input, ["schemaVersion", "action", "siteId", "connectionId"]);
  if (input.schemaVersion !== 1 || input.action !== "status") throw Error("INVALID_INPUT");
  const site = permittedSite(client, input.siteId), saved = await connectionFor(store, input.connectionId, now), c = saved.value;
  if (c.clientId !== client.id || c.siteId !== site) throw Error("NOT_FOUND");
  if (c.state === "connected") {
    const b = (await store.read<WebsiteBinding>(bindingKey(c.bindingId!))).value;
    if (!b || b.clientId !== client.id || b.siteId !== site) throw Error("WRITE_UNCONFIRMED");
    if (b.connectionId !== c.id) return { schemaVersion: 1, state: "superseded", connectionId: c.id, configurationHash: b.configurationHash };
    return { schemaVersion: 1, state: "connected", connectionId: c.id, bindingId: b.id,
      bindingToken: bindingToken(b), configurationHash: b.configurationHash, inventoryMode: b.inventoryMode, calendarUrl: calendarUrl(b) };
  }
  const currentSite = (await store.read<Site>(siteKey(c.clientId, c.siteId))).value;
  const currentBinding = currentSite ? (await store.read<WebsiteBinding>(bindingKey(currentSite.bindingId))).value : null;
  if ((currentBinding?.revision ?? 0) !== c.bindingRevision) return { schemaVersion: 1, state: "superseded", connectionId: c.id, configurationHash: currentBinding?.configurationHash };
  return { schemaVersion: 1, state: "awaiting_owner", connectionId: c.id, configurationHash: c.configurationHash,
    approvalUrl: `${customerOrigin()}/website-booking?connection=${c.id}`, expiresAt: c.expiresAt };
}
export async function prepareConnection(store: CustomerStore, client: WebsiteClient, input: Record<string, unknown>, now = new Date()) {
  requireEnabled();
  fields(input, ["schemaVersion", "action", "requestId", "siteId", "siteName", "ownerEmail", "configurationHash", "reservationConfig", "roomRecords"]);
  if (input.schemaVersion !== 1 || input.action !== "prepare") throw Error("INVALID_INPUT");
  const siteId = permittedSite(client, input.siteId), requestId = uuid(input.requestId), ownerEmail = email(input.ownerEmail);
  const siteName = plain(input.siteName, 80)!;
  const config = validateConfiguration(input.reservationConfig, input.roomRecords, input.configurationHash, now);
  const hash = digest(JSON.stringify({ siteId, ownerEmail, siteName, ...config }));
  const key = connectionKey(requestId), old = await store.read<WebsiteConnection>(key);
  if (old.value) {
    if (old.value.clientId !== client.id || old.value.hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
    return connectionStatus(store, client, { schemaVersion: 1, action: "status", siteId, connectionId: requestId }, now);
  }
  const site = await store.read<Site>(siteKey(client.id, siteId));
  if (site.value && site.value.ownerEmail !== ownerEmail) throw Error("WEBSITE_OWNER_MISMATCH");
  const currentBinding = site.value ? (await store.read<WebsiteBinding>(bindingKey(site.value.bindingId))).value : null;
  if (site.value && !currentBinding) throw Error("BINDING_UNAVAILABLE");
  await store.limit(`website-prepare:${client.id}`, 30);
  const value: WebsiteConnection = { id: requestId, clientId: client.id, siteId, siteName, ownerEmail, hash, ...config,
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 3600000).toISOString(), state: "awaiting_owner", bindingRevision: currentBinding?.revision ?? 0 };
  try { await store.commit([{ key, before: null, after: value, ttlSeconds: 3600 }]); }
  catch (error) {
    const recovered = (await store.read<WebsiteConnection>(key)).value;
    if (!recovered) throw error;
    if (recovered.clientId !== client.id || recovered.hash !== hash) throw Error("IDEMPOTENCY_CONFLICT");
  }
  return connectionStatus(store, client, { schemaVersion: 1, action: "status", siteId, connectionId: requestId }, now);
}

export function nativeProperty(workspace: Workspace, property: Property) {
  if (property.sourceMode !== "native" || (property.setup && property.setup.mode !== "empty") ||
    workspace.calendarSources?.some(s => s.propertyId === property.id) ||
    !propertyReadiness(workspace, property).complete ||
    workspace.bookings.some(b => b.propertyId === property.id && b.entry !== "os")) throw Error("LEGACY_INTEGRATION_REQUIRED");
}

export async function ownerConnection(store: CustomerStore, account: Account, id: unknown, now = new Date()) {
  const c = (await connectionFor(store, id, now)).value;
  if (!account.emailVerifiedAt || account.email !== c.ownerEmail) throw Error("WEBSITE_OWNER_MISMATCH");
  const workspaces = [];
  for (const ref of account.workspaces) {
    const ws = (await store.read<Workspace>(`workspace:${ref.id}`)).value;
    if (!ws || !ws.members.some(m => m.accountId === account.id && m.active && m.role === "owner")) continue;
    const member = ws.members.find(m => m.accountId === account.id && m.active && m.role === "owner")!;
    const properties = ws.properties.filter(p => {
      if (!member.allProperties && !member.propertyIds.includes(p.id)) return false;
      try { nativeProperty(ws, p); return true; } catch { return false; }
    }).map(p => ({ id: p.id, name: p.name, kind: p.kind, rooms: p.rooms }));
    workspaces.push({ slug: ws.slug, name: ws.name, version: ws.version, properties });
  }
  const site = (await store.read<Site>(siteKey(c.clientId, c.siteId))).value;
  const binding = site ? (await store.read<WebsiteBinding>(bindingKey(site.bindingId))).value : null;
  if (binding && binding.ownerAccountId !== account.id) throw Error("WEBSITE_OWNER_MISMATCH");
  if (c.state === "awaiting_owner" && (binding?.revision ?? 0) !== c.bindingRevision) throw Error("CONNECTION_SUPERSEDED");
  if (c.state === "connected" && binding?.connectionId !== c.id) throw Error("CONNECTION_SUPERSEDED");
  return { authenticated: true, email: account.email, connection: {
    id: c.id, siteName: c.siteName, state: c.state, configurationHash: c.configurationHash,
    expiresAt: c.expiresAt, config: c.config, roomRecords: c.roomRecords,
    ...(binding ? { calendarUrl: calendarUrl(binding), binding: {
      slug: binding.slug, propertyId: binding.propertyId,
      version: workspaces.find(w => w.slug === binding.slug)?.version,
      roomMappings: binding.physicalMappings,
      // Whole-house-only configuration still retains physical type mappings.
      physicalMappings: binding.physicalMappings,
      lineConnected: Boolean(binding.ownerLine?.verifiedAt && binding.ownerLine.recipientId),
      linePairingId: binding.ownerLine?.pairingId,
      lineVerifiedAt: binding.ownerLine?.verifiedAt,
    } } : {}),
  }, workspaces };
}

export async function approveConnection(store: CustomerStore, account: Account, input: Record<string, unknown>, now = new Date()) {
  requireEnabled();
  fields(input, ["action", "connectionId", "requestKey", "confirmed", "mode", "slug", "propertyId", "version", "roomMappings"]);
  if (input.action !== "approve" || input.confirmed !== true || !["new", "existing"].includes(String(input.mode))) throw Error("INVALID_INPUT");
  const approvalKey = uuid(input.requestKey), slug = validSlug(input.slug);
  const saved = await connectionFor(store, input.connectionId, now), c = saved.value;
  const approvalHash = digest(JSON.stringify({ mode: input.mode, slug, propertyId: input.propertyId, version: input.version, roomMappings: input.roomMappings }));
  const accountSaved = await store.read<Account>(accountKey(account.email));
  if (!accountSaved.value || accountSaved.value.id !== account.id || !accountSaved.value.emailVerifiedAt || accountSaved.value.email !== c.ownerEmail) throw Error("WEBSITE_OWNER_MISMATCH");
  if (c.state === "connected") {
    if (c.approvedBy !== account.id || c.approvalKey !== approvalKey || c.approvalHash !== approvalHash) throw Error("IDEMPOTENCY_CONFLICT");
    const existing = (await store.read<WebsiteBinding>(bindingKey(c.bindingId!))).value;
    if (!existing || existing.connectionId !== c.id) throw Error("CONNECTION_SUPERSEDED");
    return { state: "connected", calendarUrl: calendarUrl(existing) };
  }
  try {
  const site = await store.read<Site>(siteKey(c.clientId, c.siteId));
  const oldBinding = site.value ? await store.read<WebsiteBinding>(bindingKey(site.value.bindingId)) : { raw: null, value: null };
  if (site.value && (!oldBinding.value || site.value.ownerAccountId !== account.id || site.value.ownerEmail !== account.email)) throw Error("WEBSITE_OWNER_MISMATCH");
  if ((oldBinding.value?.revision ?? 0) !== c.bindingRevision) throw Error("CONNECTION_SUPERSEDED");
  let workspace: Workspace, property: Property, workspaceRaw: string | null = null;
  const changes: Change[] = [];
  const physicalMappings: { roomTypeId: string; roomIds: string[] }[] = [];
  const activeTypes = c.config.rooms.filter(r => r.enabled);
  if (input.mode === "new") {
    if (site.value || input.propertyId || input.roomMappings || accountSaved.value.workspaces.length >= 10) throw Error("INVALID_INPUT");
    const slugRow = await store.read<string>(`slug:${slug}`);
    if (slugRow.value) throw Error("SLUG_EXISTS");
    const rooms = activeTypes.flatMap(type => {
      const roomIds = Array.from({ length: integer(type.units, 1, 50) }, () => randomUUID());
      physicalMappings.push({ roomTypeId: type.roomTypeId, roomIds });
      const name = c.roomRecords.find(r => r.id === type.roomTypeId)!.name;
      return roomIds.map((id, i) => ({ id, name: `${name.slice(0, 30)} ${i + 1}` }));
    });
    property = { id: randomUUID(), name: c.siteName, kind: c.config.sellingMode === "whole_house" ? "villa" : c.config.sellingMode,
      rooms, villaRoomIds: c.config.sellingMode === "rooms" ? [] : rooms.map(r => r.id), sourceMode: "native",
      setup: { mode: "empty", readyAt: now.toISOString(), unresolvedCount: 0, approvedByEmail: account.email } };
    workspace = { id: randomUUID(), slug, name: c.siteName, version: 1, members: [{ accountId: account.id, email: account.email,
      role: "owner", active: true, allProperties: true, propertyIds: [] }], properties: [property], bookings: [], audit: [] };
    changes.push({ key: `slug:${slug}`, before: null, after: workspace.id });
    changes.push({ key: accountKey(account.email), before: accountSaved.raw, after: { ...accountSaved.value,
      workspaces: [...accountSaved.value.workspaces, { id: workspace.id, slug, name: c.siteName, creationKey: c.id, creationHash: c.hash }] } });
  } else {
    const loaded = await loadWorkspace(store, account.id, slug);
    if (loaded.member.role !== "owner") throw Error("FORBIDDEN");
    if (loaded.workspace.version !== input.version) throw Error("VERSION_CONFLICT");
    workspace = loaded.workspace; workspaceRaw = loaded.raw;
    const p = workspace.properties.find(p => p.id === input.propertyId);
    if (!p || (!loaded.member.allProperties && !loaded.member.propertyIds.includes(p.id))) throw Error("NOT_FOUND");
    property = p; nativeProperty(workspace, property);
    if (oldBinding.value && (oldBinding.value.workspaceId !== workspace.id || oldBinding.value.propertyId !== property.id)) throw Error("WEBSITE_OWNER_MISMATCH");
    if (!Array.isArray(input.roomMappings) || input.roomMappings.length !== activeTypes.length) throw Error("INVALID_INPUT");
    const seen = new Set<string>();
    for (const item of input.roomMappings) {
      const mapping = record(item); fields(mapping, ["roomTypeId", "roomIds"]);
      const type = activeTypes.find(t => t.roomTypeId === mapping.roomTypeId);
      if (!type || physicalMappings.some(m => m.roomTypeId === type.roomTypeId) || !Array.isArray(mapping.roomIds) || mapping.roomIds.length !== Number(type.units)) throw Error("INVALID_INPUT");
      const roomIds = mapping.roomIds.map(v => {
        const roomId = uuid(v);
        if (seen.has(roomId) || !property.rooms.some(r => r.id === roomId)) throw Error("INVALID_INPUT");
        seen.add(roomId); return roomId;
      }).sort();
      physicalMappings.push({ roomTypeId: type.roomTypeId, roomIds });
    }
    if (oldBinding.value && digest(JSON.stringify([...physicalMappings].sort((a,b)=>a.roomTypeId.localeCompare(b.roomTypeId)))) !==
      digest(JSON.stringify([...oldBinding.value.physicalMappings].map(m=>({...m,roomIds:[...m.roomIds].sort()})).sort((a,b)=>a.roomTypeId.localeCompare(b.roomTypeId))))) throw Error("PHYSICAL_MAPPING_CHANGED");
    changes.push({ key: accountKey(account.email), before: accountSaved.raw, after: accountSaved.value });
  }
  const allRooms = physicalMappings.flatMap(m => m.roomIds);
  if (c.config.sellingMode !== "rooms" && (property.kind === "rooms" || allRooms.length !== property.villaRoomIds.length || property.villaRoomIds.some(r => !allRooms.includes(r)))) throw Error("INVALID_INPUT");
  if (property.kind === "villa" && c.config.sellingMode !== "whole_house") throw Error("INVALID_INPUT");
  const offers: RoomOffer[] = c.config.sellingMode === "whole_house" ? [] : physicalMappings.map(m => ({ id: m.roomTypeId,
    name: c.roomRecords.find(r => r.id === m.roomTypeId)!.name, roomIds: m.roomIds, capacity: Number(activeTypes.find(t => t.roomTypeId === m.roomTypeId)!.capacity), wholeHouse: false }));
  if (c.config.sellingMode !== "rooms") offers.push({ id: "whole-house", name: "全館包棟", roomIds: allRooms,
    capacity: activeTypes.reduce((n, r) => n + Number(r.units) * Number(r.capacity), 0), wholeHouse: true });
  const base = { ...property.pricing?.base };
  for (const mapping of physicalMappings) {
    const type = activeTypes.find(t => t.roomTypeId === mapping.roomTypeId)!;
    if (c.config.sellingMode !== "whole_house") for (const room of mapping.roomIds) base[room] = amount(type.nightly) / 100;
  }
  if (c.config.sellingMode !== "rooms") base.villa = amount(c.config.wholeHouseNightly) / 100;
  property = { ...property, pricing: { currency: "TWD", enabled: true, base, overrides: property.pricing?.overrides ?? [] } };
  const b: WebsiteBinding = { id: oldBinding.value?.id ?? randomUUID(), clientId: c.clientId, siteId: c.siteId, siteName: c.siteName,
    ownerAccountId: account.id, ownerEmail: account.email, workspaceId: workspace.id, slug, propertyId: property.id,
    configurationHash: c.configurationHash, config: c.config, roomRecords: c.roomRecords, offers, physicalMappings,
    inventoryMode: "platform_only", enabled: true, credentialGeneration: oldBinding.value?.credentialGeneration ?? randomUUID(),
    connectionId: c.id, revision: (oldBinding.value?.revision ?? 0) + 1, approvedAt: now.toISOString(),
    ...(oldBinding.value?.ownerLine ? { ownerLine: oldBinding.value.ownerLine } : {}) };
  // Verify key readiness before any mutation so failed credential setup creates no binding.
  bindingToken(b);
  const next: Workspace = { ...workspace, version: workspaceRaw ? workspace.version + 1 : workspace.version,
    properties: workspace.properties.map(p => p.id === property.id ? property : p),
    audit: [...workspace.audit, { at: now.toISOString(), actor: account.id, action: "website.binding.approved", targetId: b.id }] };
  changes.push({ key: `workspace:${workspace.id}`, before: workspaceRaw, after: next },
    { key: bindingKey(b.id), before: oldBinding.raw, after: b },
    { key: siteKey(c.clientId, c.siteId), before: site.raw, after: { bindingId: b.id, ownerAccountId: account.id, ownerEmail: account.email } },
    { key: connectionKey(c.id), before: saved.raw, after: { ...c, state: "connected", bindingId: b.id, approvedBy: account.id, approvalKey, approvalHash } });
  await store.commit(changes);
  const readback = await store.read<WebsiteConnection>(connectionKey(c.id));
  const stored = (await store.read<WebsiteBinding>(bindingKey(b.id))).value;
  if (readback.value?.bindingId !== b.id || readback.value.approvalHash !== approvalHash || stored?.connectionId !== c.id || stored.configurationHash !== c.configurationHash) throw Error("WRITE_UNCONFIRMED");
  return { state: "connected", calendarUrl: calendarUrl(b) };
  } catch (error) {
    const recovered = (await store.read<WebsiteConnection>(connectionKey(c.id))).value;
    if (!recovered || recovered.state !== "connected") throw error;
    if (recovered.approvedBy !== account.id || recovered.approvalKey !== approvalKey || recovered.approvalHash !== approvalHash) throw Error("IDEMPOTENCY_CONFLICT");
    const current = (await store.read<WebsiteBinding>(bindingKey(recovered.bindingId!))).value;
    if (!current || current.connectionId !== c.id) throw Error("CONNECTION_SUPERSEDED");
    return { state: "connected", calendarUrl: calendarUrl(current) };
  }
}
