import { sourceDefinition } from "../booking-sources/config.ts";
import {
  authenticate,
  CUSTOMER_COOKIE,
  enabled,
} from "../customer-workspaces/auth.ts";
import { loadWorkspace } from "../customer-workspaces/service.ts";
import { principalFor, type CookieRequest } from "../workspace-auth/session.ts";
import { PROPERTY_IDS } from "../workspace-auth/types.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { Scope } from "./types.ts";
import { ownerAccessConfigured } from "../calendar-owner-session.ts";
import { RedisWorkspaceStore } from "../workspace-auth/store.ts";
import type { Workspace } from "../customer-workspaces/types.ts";
export async function backgroundAccess(store: CustomerStore, s: Scope) {
  if (!s.canWrite) return false;
  if (s.workspace === "legacy") {
    if (!ownerAccessConfigured() || !PROPERTY_IDS.includes(s.property)) return false;
    if (s.actor === "calendar-owner") return true;
    const member = (await new RedisWorkspaceStore().read()).value.members.find((m) => m.id === s.actor);
    return Boolean(member && member.status === "active" && !member.mustResetPassword &&
      ["god", "admin"].includes(member.role) &&
      (member.allProperties || member.propertyIds.includes(s.property)));
  }
  if (!enabled()) return false;
  const w = (await store.read<Workspace>(`workspace:${s.workspace}`)).value;
  const member = w?.members.find((m) => m.accountId === s.actor && m.active);
  return Boolean(member && ["owner", "admin"].includes(member.role) &&
    w?.properties.some((p) => p.id === s.property) &&
    (member.allProperties || member.propertyIds.includes(s.property)));
}
export async function access(
  store: CustomerStore,
  request: CookieRequest,
  workspace: string,
  property: string,
): Promise<Scope> {
  if (workspace === "legacy") {
    const p = await principalFor(request);
    if (!p) throw Error("UNAUTHORIZED");
    if (
      !p.viewPrices ||
      !PROPERTY_IDS.includes(property) ||
      (!p.allProperties && !p.propertyIds.includes(property))
    )
      throw Error("FORBIDDEN");
    return {
      workspace: "legacy",
      property,
      actor: p.id,
      name: sourceDefinition(property).property.name,
      canWrite: ["owner", "god", "admin"].includes(p.role),
    };
  }
  if (!enabled()) throw Error("NOT_FOUND");
  const account = await authenticate(
      store,
      request.cookies.get(CUSTOMER_COOKIE)?.value,
    ),
    { workspace: w, member: m } = await loadWorkspace(
      store,
      account.id,
      workspace,
    ),
    p = w.properties.find(
      (p) =>
        p.id === property && (m.allProperties || m.propertyIds.includes(p.id)),
    );
  if (!p || ["viewer_no_price", "housekeeper"].includes(m.role))
    throw Error("FORBIDDEN");
  return {
    workspace: w.id,
    property: p.id,
    receptionKind: p.kind,
    actor: account.id,
    name: p.name,
    canWrite: ["owner", "admin"].includes(m.role),
  };
}
