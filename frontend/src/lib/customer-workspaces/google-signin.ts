import { randomBytes, randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { accountKey, digest } from "./auth.ts";
import {
  customerCredentialBinding,
  newPasswordlessCredential,
} from "./identity.ts";
import { normalizedEmail, validEmail } from "../workspace-auth/types.ts";
import { intakeEnabled, onboardingEnabled } from "../customer-intake/config.ts";
import {
  calendarGoogleConfig,
  CALENDAR_READ_SCOPES,
  exchangeCalendarCode,
  calendarGrantChange,
} from "./calendar-google.ts";
import { draftForHash, previewContext } from "./calendar-onboarding.ts";
import type { Account } from "./types.ts";
import type { CustomerStore } from "./store.ts";
const keys = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs"),
  { timeoutDuration: 8000, cooldownDuration: 30000, cacheMaxAge: 3600000 },
);
type GoogleState = {
  draftHash?: string;
  browser: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
  used: boolean;
};
export type GoogleIdentity = {
  sub: string;
  email: string;
  authoritative: boolean;
};
type GoogleLink = { accountId: string; accountKey: string };
const stateKey = (state: string) => `google-signin:${digest(state)}`;
export async function verifyGoogleIdentity(
  idToken: unknown,
  nonce: string,
  getKey: JWTVerifyGetKey = keys,
): Promise<GoogleIdentity> {
  if (typeof idToken !== "string" || idToken.length > 20000)
    throw new Error("GOOGLE_SIGNIN_FAILED");
  try {
    const { payload } = await jwtVerify(idToken, getKey, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: calendarGoogleConfig().clientId,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email", "email_verified", "nonce"],
      maxTokenAge: "10 minutes",
      clockTolerance: 15,
    });
    const email = normalizedEmail(payload.email);
    if (
      payload.nonce !== nonce ||
      typeof payload.sub !== "string" ||
      !/^[\w-]{1,255}$/.test(payload.sub) ||
      payload.email_verified !== true ||
      !validEmail(email) ||
      (payload.azp && payload.azp !== calendarGoogleConfig().clientId)
    )
      throw new Error();
    return {
      sub: payload.sub,
      email,
      authoritative:
        email.endsWith("@gmail.com") ||
        (typeof payload.hd === "string" && Boolean(payload.hd)),
    };
  } catch {
    throw new Error("GOOGLE_SIGNIN_FAILED");
  }
}
async function accountForGoogle(
  store: CustomerStore,
  identity: GoogleIdentity,
  allowCreate: boolean,
): Promise<Account | null> {
  const subjectKey = `google-subject:${digest(identity.sub)}`,
    linked = await store.read<GoogleLink>(subjectKey);
  if (linked.value) {
    const account = (await store.read<Account>(linked.value.accountKey)).value;
    if (
      !account ||
      account.id !== linked.value.accountId ||
      account.googleSubject !== identity.sub ||
      !account.emailVerifiedAt
    )
      throw new Error("GOOGLE_SIGNIN_FAILED");
    return account;
  }
  // A third-party email recorded in a Google account may no longer belong to
  // that user. Require a fresh email-link challenge before any account linking.
  if (!identity.authoritative) return null;
  const key = accountKey(identity.email),
    current = await store.read<Account>(key);
  if (!current.value && !allowCreate)
    throw new Error("GOOGLE_ACCOUNT_NOT_FOUND");
  if (
    current.value?.googleSubject &&
    current.value.googleSubject !== identity.sub
  )
    throw new Error("GOOGLE_SIGNIN_FAILED");
  const account: Account = {
    ...(current.value ?? {
      id: randomUUID(),
      email: identity.email,
      workspaces: [],
      credential: newPasswordlessCredential(),
    }),
    // Pre-claimed, unverified accounts cannot retain a password known by a
    // different party after the actual email owner completes authentication.
    ...(!current.value?.emailVerifiedAt
      ? { credential: newPasswordlessCredential() }
      : {}),
    emailVerifiedAt: current.value?.emailVerifiedAt ?? new Date().toISOString(),
    googleSubject: identity.sub,
  };
  await store.commit([
    { key, before: current.raw, after: account },
    {
      key: subjectKey,
      before: linked.raw,
      after: { accountId: account.id, accountKey: key } satisfies GoogleLink,
    },
  ]);
  const verified = (await store.read<Account>(key)).value;
  if (
    !verified ||
    verified.id !== account.id ||
    verified.googleSubject !== identity.sub
  )
    throw new Error("WRITE_UNCONFIRMED");
  return verified;
}
export async function linkVerifiedGoogleIdentity(
  store: CustomerStore,
  account: Account,
  identity: GoogleIdentity,
) {
  if (!account.emailVerifiedAt || account.email !== identity.email)
    throw new Error("CALENDAR_ACCOUNT_CHANGED");
  const subjectKey = `google-subject:${digest(identity.sub)}`,
    linked = await store.read<GoogleLink>(subjectKey),
    current = await store.read<Account>(accountKey(account.email));
  if (
    !current.value ||
    current.value.id !== account.id ||
    !current.value.emailVerifiedAt ||
    customerCredentialBinding(current.value.credential) !==
      customerCredentialBinding(account.credential) ||
    (current.value.googleSubject &&
      current.value.googleSubject !== identity.sub) ||
    (linked.value && linked.value.accountId !== account.id)
  )
    throw new Error("CALENDAR_ACCOUNT_CHANGED");
  if (linked.value && current.value.googleSubject === identity.sub)
    return current.value;
  const next = { ...current.value, googleSubject: identity.sub };
  await store.commit([
    { key: accountKey(account.email), before: current.raw, after: next },
    {
      key: subjectKey,
      before: linked.raw,
      after: { accountId: account.id, accountKey: accountKey(account.email) },
    },
  ]);
  const verified = (await store.read<Account>(accountKey(account.email))).value;
  if (
    !verified ||
    verified.id !== account.id ||
    verified.googleSubject !== identity.sub ||
    customerCredentialBinding(verified.credential) !==
      customerCredentialBinding(account.credential)
  )
    throw new Error("WRITE_UNCONFIRMED");
  return verified;
}
export async function beginGoogleSignIn(
  store: CustomerStore,
  draftHash?: string,
) {
  if (draftHash) {
    const { value } = await draftForHash(store, draftHash);
    if (value.completed || value.prepared)
      throw new Error("CALENDAR_PREVIEW_LOCKED");
  }
  const config = calendarGoogleConfig(),
    state = randomBytes(32).toString("base64url"),
    browser = randomBytes(32).toString("base64url"),
    nonce = randomBytes(32).toString("base64url"),
    verifier = randomBytes(32).toString("base64url");
  await store.commit([
    {
      key: stateKey(state),
      before: null,
      after: {
        ...(draftHash ? { draftHash } : {}),
        browser: digest(browser),
        nonce,
        verifier,
        expiresAt: Date.now() + 600000,
        used: false,
      } satisfies GoogleState,
      ttlSeconds: 600,
    },
  ]);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: ["openid", "email", ...(draftHash ? CALENDAR_READ_SCOPES : [])].join(
      " ",
    ),
    state,
    nonce,
    code_challenge: Buffer.from(digest(verifier), "hex").toString("base64url"),
    code_challenge_method: "S256",
    prompt: draftHash ? "select_account consent" : "select_account",
    ...(draftHash ? { access_type: "offline" } : {}),
  }).toString();
  return { url: url.toString(), browser };
}
export async function isGoogleSignInState(store: CustomerStore, state: string) {
  return (
    /^[\w-]{43}$/.test(state) &&
    Boolean((await store.read<GoogleState>(stateKey(state))).value)
  );
}
export async function finishGoogleSignIn(
  store: CustomerStore,
  state: string,
  browser: string,
  code: string,
  cookieDraftHash?: string,
  getKey?: JWTVerifyGetKey,
) {
  if (
    !/^[\w-]{43}$/.test(state) ||
    !/^[\w-]{43}$/.test(browser) ||
    !code ||
    code.length > 4096
  )
    throw new Error("GOOGLE_SIGNIN_FAILED");
  const key = stateKey(state),
    saved = await store.read<GoogleState>(key),
    data = saved.value;
  if (
    !data ||
    data.used ||
    data.expiresAt <= Date.now() ||
    data.browser !== digest(browser) ||
    (data.draftHash && data.draftHash !== cookieDraftHash)
  )
    throw new Error("GOOGLE_SIGNIN_FAILED");
  if (data.draftHash && (!intakeEnabled() || !onboardingEnabled()))
    throw new Error("FEATURE_UNAVAILABLE");
  const draft = data.draftHash
    ? await draftForHash(store, data.draftHash)
    : null;
  if (draft?.value.completed || draft?.value.prepared)
    throw new Error("CALENDAR_PREVIEW_LOCKED");
  await store.commit([
    { key, before: saved.raw, after: { ...data, used: true }, ttlSeconds: 600 },
  ]);
  const result = await exchangeCalendarCode({
    code,
    grant_type: "authorization_code",
    code_verifier: data.verifier,
    redirect_uri: calendarGoogleConfig().redirectUri,
  });
  const identity = await verifyGoogleIdentity(
    result.id_token,
    data.nonce,
    getKey,
  );
  if (
    draft &&
    (typeof result.access_token !== "string" ||
      typeof result.refresh_token !== "string" ||
      typeof result.expires_in !== "number" ||
      result.expires_in < 60 ||
      typeof result.scope !== "string" ||
      CALENDAR_READ_SCOPES.some(
        (s) => !(result.scope as string).split(" ").includes(s),
      ))
  )
    throw new Error("CALENDAR_CONNECT_REQUIRED");
  const account = await accountForGoogle(store, identity, Boolean(draft));
  if (draft && data.draftHash) {
    const { scoped } = previewContext(store, data.draftHash, draft.value);
    const grant = await calendarGrantChange(
      scoped,
      draft.value.actor,
      draft.value.workspaceId,
      draft.value.propertyId,
      {
        access: result.access_token as string,
        refresh: result.refresh_token as string,
        expiresAt:
          Date.now() +
          (Math.min(result.expires_in as number, 3600) - 30) * 1000,
      },
    );
    // Account identity and its calendar credentials move together. A stale OAuth
    // return cannot replace another account's grant while losing the draft CAS.
    await scoped.commitWithDraft([grant.change], draft, {
      googleIdentity: identity,
      googleAccountId: account?.id,
      claimEmail: account?.email ?? identity.email,
      sourceId: undefined,
      previewId: undefined,
      loginRequestId: undefined,
    });
  }
  if (!account && !draft) throw new Error("GOOGLE_EMAIL_CHALLENGE_REQUIRED");
  return {
    account,
    destination: draft ? "/join/calendar?calendar=connected" : "/start",
  };
}
