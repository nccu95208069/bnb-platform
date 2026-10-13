import { createHash, randomBytes } from "node:crypto";
import { customerOrigin } from "../customer-workspaces/site-url.ts";
import type { CustomerStore } from "../customer-workspaces/store.ts";
import { digest } from "../customer-workspaces/auth.ts";
import { configureGmailOAuth, mailStatus } from "./mail.ts";
import { mailSender } from "./gmail.ts";

export const ACCEPTANCE_GMAIL_COOKIE = "bnb_acceptance_gmail_oauth";
const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
const STATE_SECONDS = 600;
type OAuthState = {
  nonceHash: string;
  verifier: string;
  sender: string;
  redirectUri: string;
  expiresAt: number;
  used: boolean;
};

export function acceptanceGmailConfig() {
  if (process.env.CUSTOMER_ISOLATED_ACCEPTANCE !== "true" ||
      process.env.CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_ENABLED !== "true")
    throw new Error("MAIL_NOT_CONFIGURED");
  const clientId = process.env.CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CUSTOMER_ACCEPTANCE_GMAIL_OAUTH_CLIENT_SECRET;
  if (!clientId || !/^[a-zA-Z0-9-]+\.apps\.googleusercontent\.com$/.test(clientId) ||
      !clientSecret || clientSecret.length < 10 || clientSecret.length > 4096)
    throw new Error("MAIL_NOT_CONFIGURED");
  const origin = customerOrigin();
  return {
    clientId, clientSecret, sender: mailSender(), origin,
    redirectUri: `${origin}/api/acceptance-mail/google/callback`,
  };
}

export function acceptanceGmailReady() {
  try { acceptanceGmailConfig(); return true; }
  catch { return false; }
}

const stateKey = (state: string) => `acceptance-gmail-oauth:${digest(state)}`;

export async function beginAcceptanceGmail(store: CustomerStore, now = Date.now()) {
  const config = acceptanceGmailConfig();
  if ((await mailStatus()).configured) throw new Error("MAIL_ALREADY_CONFIGURED");
  await store.limit("acceptance-gmail-oauth-start", 5);
  const state = randomBytes(32).toString("base64url");
  const browser = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const record: OAuthState = {
    nonceHash: digest(browser), verifier, sender: config.sender,
    redirectUri: config.redirectUri, expiresAt: now + STATE_SECONDS * 1000, used: false,
  };
  await store.commit([{ key: stateKey(state), before: null, after: record, ttlSeconds: STATE_SECONDS }]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: `openid email ${GMAIL_SEND}`,
    state,
    access_type: "offline",
    prompt: "consent select_account",
    login_hint: config.sender,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), browser };
}

async function providerJson(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error();
    return await response.json() as Record<string, unknown>;
  } catch { throw new Error("MAIL_FAILED"); }
}

export async function finishAcceptanceGmail(
  store: CustomerStore, state: string, browser: string, code: string, now = Date.now(),
) {
  const config = acceptanceGmailConfig();
  if (!/^[\w-]{43}$/.test(state) || !/^[\w-]{43}$/.test(browser) ||
      !code || code.length > 4096)
    throw new Error("FORBIDDEN");
  const key = stateKey(state);
  const snapshot = await store.read<OAuthState>(key);
  const saved = snapshot.value;
  if (!saved || saved.used || saved.expiresAt <= now || saved.nonceHash !== digest(browser) ||
      saved.sender !== config.sender || saved.redirectUri !== config.redirectUri)
    throw new Error("FORBIDDEN");
  await store.commit([{ key, before: snapshot.raw, after: { ...saved, used: true }, ttlSeconds: STATE_SECONDS }]);
  if ((await mailStatus()).configured) throw new Error("MAIL_ALREADY_CONFIGURED");
  const token = await providerJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId, client_secret: config.clientSecret,
      code, code_verifier: saved.verifier, redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const scopes = typeof token.scope === "string" ? token.scope.split(" ") : [];
  if (typeof token.access_token !== "string" || typeof token.refresh_token !== "string" ||
      !scopes.includes(GMAIL_SEND) || !scopes.includes("email") || !scopes.includes("openid"))
    throw new Error("MAIL_FAILED");
  const identity = await providerJson("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (identity.email_verified !== true ||
      typeof identity.email !== "string" || identity.email.toLowerCase() !== config.sender)
    throw new Error("MAIL_SENDER_MISMATCH");
  const configured = await configureGmailOAuth({
    clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: token.refresh_token,
  });
  return { sender: configured.sender, messageId: configured.messageId, verifiedAt: configured.verifiedAt };
}
