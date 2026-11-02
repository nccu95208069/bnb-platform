import { digest } from "../customer-workspaces/auth.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { WebsiteBinding } from "./types.ts";
import { id, record, uuid } from "./config.ts";

const maxSitesPerClient = 100;

export const studioSitesKey = (clientId: string) => `website:studio-sites:${id(clientId)}`;
export const studioSiteKey = (clientId: string, siteId: string) =>
  `website:site:${digest(JSON.stringify([id(clientId), id(siteId)]))}`;

export function studioSiteIds(value: unknown): string[] {
  if (value === null) return [];
  if (!Array.isArray(value) || value.length > maxSitesPerClient) throw Error("STORE_UNAVAILABLE");
  const sites = value.map(uuid);
  if (new Set(sites).size !== sites.length) throw Error("STORE_UNAVAILABLE");
  return sites;
}

// One server-owned Studio client grant covers its *approved* site index only.
// External worker credentials cannot use this grant; they retain exact sites.
export function studioEmailClientIds(): string[] {
  let selected: unknown, configured: unknown, selfServiceOrigins: unknown;
  try { selected = JSON.parse(process.env.WEBSITE_BOOKING_STUDIO_EMAIL_CLIENT_IDS || "[]"); }
  catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
  if (!Array.isArray(selected) || selected.length > 10)
    throw Error("EMAIL_DELIVERY_UNAVAILABLE");
  if (!selected.length) return [];
  try {
    configured = JSON.parse(process.env.WEBSITE_BOOKING_STUDIO_CLIENTS || "[]");
    selfServiceOrigins = JSON.parse(process.env.WEBSITE_BOOKING_STUDIO_SELF_SERVICE_ORIGINS || "[]");
  }
  catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
  if (!Array.isArray(configured) || configured.length > 50) throw Error("EMAIL_DELIVERY_UNAVAILABLE");
  if (!Array.isArray(selfServiceOrigins) || selfServiceOrigins.length > 50 ||
      new Set(selfServiceOrigins).size !== selfServiceOrigins.length || selfServiceOrigins.some(origin =>
        typeof origin !== "string" || !configured.some(value => record(value).editor_origin === origin)))
    throw Error("EMAIL_DELIVERY_UNAVAILABLE");
  try {
    const ids = selected.map(id);
    if (new Set(ids).size !== ids.length) throw Error();
    for (const clientId of ids) {
      const matches = configured.filter(value => record(value).id === clientId);
      if (matches.length !== 1) throw Error();
      const client = record(matches[0]);
      if ((client.allow_new_sites !== true && !selfServiceOrigins.includes(client.editor_origin)) || !Array.isArray(client.site_ids) ||
          typeof client.token_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(client.token_sha256)) throw Error();
      const origin = new URL(String(client.editor_origin));
      if (origin.protocol !== "https:" || origin.origin !== client.editor_origin) throw Error();
    }
    return ids;
  } catch { throw Error("EMAIL_DELIVERY_UNAVAILABLE"); }
}

export async function approvedStudioBindingIds(store: CustomerStore, clientIds: string[]) {
  const result: string[] = [];
  const startAt = process.env.WEBSITE_BOOKING_STUDIO_EMAIL_START_AT;
  const starts = startAt === undefined ? null : Date.parse(startAt);
  if (starts !== null && !Number.isFinite(starts)) throw Error("EMAIL_DELIVERY_UNAVAILABLE");
  for (const clientId of clientIds) {
    const sites = studioSiteIds((await store.read<string[]>(studioSitesKey(clientId))).value);
    for (const siteId of sites) {
      const site = (await store.read<{ bindingId: string; ownerAccountId: string }>(studioSiteKey(clientId, siteId))).value;
      if (!site) continue;
      const bindingId = uuid(site.bindingId);
      const binding = (await store.read<WebsiteBinding>(`website:binding:${bindingId}`)).value;
      if (!binding || binding.clientId !== clientId || binding.siteId !== siteId ||
          binding.ownerAccountId !== site.ownerAccountId || !binding.approvedAt ||
          !Number.isFinite(Date.parse(binding.approvedAt))) throw Error("STORE_UNAVAILABLE");
      // Initial rollout must not unexpectedly drain historical pilot outboxes.
      // Existing exact binding/site grants retain their original delivery scope.
      if (starts !== null && Date.parse(binding.approvedAt) < starts) continue;
      if (!result.includes(bindingId)) result.push(bindingId);
    }
  }
  return result;
}
