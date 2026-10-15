import { authenticate, SESSION_SECONDS, sessionFor } from "../customer-workspaces/auth.ts";
import { consumeEmailLogin, requestEmailLogin } from "../customer-workspaces/passwordless.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import type { CustomerMail } from "../customer-intake/delivery.ts";
import type { WebsiteClient } from "./types.ts";
import { fields, requireEnabled } from "./config.ts";

// Only an authenticated, self-service Studio client may initiate signup.
// The browser proof stays in an HttpOnly cookie at that client's exact origin.
export async function studioAuthOperation(store: CustomerStore, client: WebsiteClient,
  input: Record<string, unknown>, send: CustomerMail) {
  requireEnabled();
  if (!client.allow_new_sites || input.origin !== client.editor_origin) throw Error("FORBIDDEN");
  if (input.action === "request") {
    fields(input, ["action", "origin", "email", "requestKey", "proof"]);
    await store.limit(`studio-signup:${client.id}`, 100);
    const result = await requestEmailLogin(store, {
      email: input.email, requestKey: input.requestKey, proof: input.proof as string,
      studio: { clientId: client.id, origin: client.editor_origin },
    }, send);
    if (result.status !== "accepted") throw Error("LOGIN_DELIVERY_UNCONFIRMED");
    return { status: "accepted" };
  }
  if (input.action === "consume") {
    fields(input, ["action", "origin", "token", "proof"]);
    const result = await consumeEmailLogin(store, input.token, input.proof, undefined, undefined, undefined, client.id);
    return { id: result.account.id, email: result.account.email, session: sessionFor(result.account), expiresIn: SESSION_SECONDS };
  }
  if (input.action === "session") {
    fields(input, ["action", "origin", "session"]);
    if (typeof input.session !== "string") throw Error("UNAUTHORIZED");
    const account = await authenticate(store, input.session);
    if (!account.emailVerifiedAt) throw Error("UNAUTHORIZED");
    return { id: account.id, email: account.email };
  }
  throw Error("INVALID_INPUT");
}
