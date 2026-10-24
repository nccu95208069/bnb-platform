import { authenticate, SESSION_SECONDS, sessionFor } from "../customer-workspaces/auth.ts";
import { consumeEmailLogin, requestEmailLogin } from "../customer-workspaces/passwordless.ts";
import { requestDeviceEmailLogin, inspectDeviceEmailLogin, consumeDeviceEmailLogin, consumeDeviceEmailCode, pollDeviceEmailLogin } from "../customer-workspaces/email-device-login.ts";
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
    fields(input, ["action", "origin", "email", "requestKey", "proof", "protocol"]);
    await store.limit(`studio-signup:${client.id}`, 100);
    if (input.protocol !== undefined && !["device-v2", "code-v3"].includes(input.protocol as string)) throw Error("INVALID_INPUT");
    const requestLogin = input.protocol ? requestDeviceEmailLogin : requestEmailLogin;
    const result = await requestLogin(store, {
      email: input.email, requestKey: input.requestKey, proof: input.proof as string,
      studio: { clientId: client.id, origin: client.editor_origin },
      ...(input.protocol === "code-v3" ? { codeInEmail: true } : {}),
    }, send);
    if (result.status !== "accepted") throw Error("LOGIN_DELIVERY_UNCONFIRMED");
    return result;
  }
  if (input.action === "inspect") {
    fields(input, ["action", "origin", "token", "proof"]);
    return inspectDeviceEmailLogin(store, input.token, input.proof, client.id);
  }
  if (input.action === "poll") {
    fields(input, ["action", "origin", "requestKey", "proof"]);
    const result = await pollDeviceEmailLogin(store, input.requestKey, input.proof, client.id);
    if (result.status !== "approved") return result;
    return { status: result.status, id: result.account.id, email: result.account.email, session: sessionFor(result.account), expiresIn: SESSION_SECONDS };
  }
  if (input.action === "consume-code") {
    fields(input, ["action", "origin", "requestKey", "proof", "loginCode"]);
    const result = await consumeDeviceEmailCode(store, input.requestKey, input.proof, input.loginCode, client.id);
    return { id: result.account.id, email: result.account.email, session: sessionFor(result.account), expiresIn: SESSION_SECONDS };
  }
  if (input.action === "consume") {
    fields(input, ["action", "origin", "token", "proof", "mode", "pairingCode", "loginCode"]);
    const result = typeof input.token === "string" && /^v[23]\./.test(input.token)
      ? await consumeDeviceEmailLogin(store, input.token, input.proof, input.mode, input.token.startsWith("v3.") ? input.loginCode : input.pairingCode, client.id)
      : await consumeEmailLogin(store, input.token, input.proof, undefined, undefined, undefined, client.id);
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
