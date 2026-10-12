import { digest } from "../customer-workspaces/auth.ts";
import { loadWorkspace } from "../customer-workspaces/service.ts";
import { holdsEnabled } from "../customer-workspaces/hold-state.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import { bindingWorkspace } from "./booking.ts";
import { bindingCoverage, bindingKey, nativeProperty, workspaceBindingsKey } from "./connections.ts";
import { enabled as websiteEnabled, fields, integer, requireEnabled, uuid } from "./config.ts";
import type { WebsiteBinding } from "./types.ts";

export async function websiteManagement(store: CustomerStore, accountId: string, slug: string) {
  const { workspace, member } = await loadWorkspace(store, accountId, slug);
  if (member.role !== "owner") throw Error("FORBIDDEN");
  const ids = (await store.read<string[]>(workspaceBindingsKey(workspace.id))).value ?? [];
  const sites = [];
  for (const id of ids) {
    const binding = (await store.read<WebsiteBinding>(bindingKey(id))).value;
    if (!binding || binding.workspaceId !== workspace.id || binding.slug !== slug || binding.ownerAccountId !== accountId ||
      (!member.allProperties && !member.propertyIds.includes(binding.propertyId))) continue;
    const property = workspace.properties.find(p => p.id === binding.propertyId);
    let ready = false;
    try {
      const current = await bindingWorkspace(store, binding);
      ready = websiteEnabled() && holdsEnabled() && current.property.pricing?.enabled === true;
    } catch {
      // A stale source, revoked owner or invalid room mapping makes the saved switch ineffective.
    }
    const connected = workspace.calendarSources?.some(s => s.propertyId === binding.propertyId && s.mode === "connected");
    sites.push({ id: binding.id, siteName: binding.siteName, propertyId: binding.propertyId, enabled: binding.enabled,
      ready, revision: binding.revision, approvedAt: binding.approvedAt, config: binding.config,
      source: connected ? { mode: "connected" as const }
        : property?.setup?.mode === "sheet" || property?.setup?.mode === "calendar"
        ? { mode: property.setup.mode, coverageFrom: property.setup.coverageFrom, coverageTo: property.setup.coverageTo }
        : { mode: "native" as const },
      roomMappings: binding.physicalMappings.map(mapping => ({ roomTypeName: binding.roomRecords.find(r => r.id === mapping.roomTypeId)?.name ?? "房型",
        roomNames: mapping.roomIds.map(id => workspace.properties.find(p => p.id === binding.propertyId)?.rooms.find(r => r.id === id)?.name ?? "需核對") })) });
  }
  return { sites };
}

export async function setWebsiteSales(store: CustomerStore, accountId: string, slug: string, input: Record<string, unknown>, now = new Date()) {
  fields(input, ["action", "bindingId", "revision", "enabled", "requestKey", "confirmedStaticSource"]);
  if (input.action !== "sales" || typeof input.enabled !== "boolean" ||
    (input.confirmedStaticSource !== undefined && typeof input.confirmedStaticSource !== "boolean")) throw Error("INVALID_INPUT");
  const id = uuid(input.bindingId), key = uuid(input.requestKey), revision = integer(input.revision, 1, Number.MAX_SAFE_INTEGER);
  const { workspace, member, raw } = await loadWorkspace(store, accountId, slug);
  const saved = await store.read<WebsiteBinding>(bindingKey(id)), binding = saved.value;
  if (member.role !== "owner") throw Error("FORBIDDEN");
  if (!binding || binding.ownerAccountId !== accountId || binding.workspaceId !== workspace.id || binding.slug !== slug ||
    (!member.allProperties && !member.propertyIds.includes(binding.propertyId))) throw Error("NOT_FOUND");
  const requestKey = `website:management:${id}:${key}`, hash = digest(JSON.stringify({ accountId, id, revision, enabled: input.enabled,
    confirmedStaticSource: input.confirmedStaticSource === true }));
  const receipt = await store.read<{ hash: string }>(requestKey);
  if (receipt.value) { if (receipt.value.hash !== hash) throw Error("IDEMPOTENCY_CONFLICT"); return websiteManagement(store, accountId, slug); }
  if (input.enabled) {
    const property = workspace.properties.find(p => p.id === binding.propertyId);
    if (!property) throw Error("BINDING_UNAVAILABLE");
    requireEnabled();
    if (!holdsEnabled()) throw Error("HOLDS_UNAVAILABLE");
    if (!property.pricing?.enabled) throw Error("PRICING_NOT_ENABLED");
    nativeProperty(workspace, property);
    bindingCoverage(property, binding.config);
    await bindingWorkspace(store, binding);
    if ((property.setup?.mode === "calendar" || property.setup?.mode === "sheet") && input.confirmedStaticSource !== true)
      throw Error("STATIC_SOURCE_CONFIRMATION_REQUIRED");
  }
  if (binding.revision !== revision) throw Error("VERSION_CONFLICT");
  const next = { ...binding, enabled: input.enabled, revision: binding.revision + 1 };
  await store.commit([
    { key: bindingKey(id), before: saved.raw, after: next },
    { key: `workspace:${workspace.id}`, before: raw, after: { ...workspace, version: workspace.version + 1,
      audit: [...workspace.audit, { at: now.toISOString(), actor: accountId, action: input.enabled ? "website.sales.enabled" : "website.sales.paused", targetId: id }] } },
    { key: requestKey, before: null, after: { hash } },
  ]);
  const readback = (await store.read<WebsiteBinding>(bindingKey(id))).value;
  if (readback?.revision !== next.revision || readback.enabled !== input.enabled) throw Error("WRITE_UNCONFIRMED");
  return websiteManagement(store, accountId, slug);
}
