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
    actor: account.id,
    name: p.name,
    canWrite: ["owner", "admin"].includes(m.role),
  };
}
