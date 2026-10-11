import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import {
  fixture,
  googleConfig,
  scopes,
  range,
} from "./helpers/calendar-fixture.mjs";
import {
  beginGoogleSignIn,
  finishGoogleSignIn,
  verifyGoogleIdentity,
  linkVerifiedGoogleIdentity,
} from "../src/lib/customer-workspaces/google-signin.ts";
import {
  startCalendarOnboarding,
  draftHash,
  draftForHash,
  previewContext,
  updateCalendarDraft,
  prepareCalendarSave,
  finishCalendarOnboarding,
} from "../src/lib/customer-workspaces/calendar-onboarding.ts";
import {
  previewCalendar,
  calendarPreviewFor,
  calendarSnapshotFor,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import {
  readGoogleCalendar,
  listGoogleCalendars,
} from "../src/lib/customer-workspaces/calendar-google.ts";
import {
  accountKey,
  authenticate,
  sessionFor,
} from "../src/lib/customer-workspaces/auth.ts";
import { newPasswordlessCredential } from "../src/lib/customer-workspaces/identity.ts";
import { createPasswordCredential } from "../src/lib/owner-password.ts";
const pair = await generateKeyPair("RS256");
const resolveKey = async () => pair.publicKey;
async function jwt(nonce, payload = {}, privateKey = pair.privateKey) {
  return new SignJWT({
    sub: "google-subject-123",
    email: "synthetic.owner@gmail.com",
    email_verified: true,
    nonce,
    ...payload,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(payload.iss ?? "https://accounts.google.com")
    .setAudience(payload.aud ?? "synthetic-calendar-client")
    .setIssuedAt(payload.iat ?? Math.floor(Date.now() / 1000))
    .setExpirationTime(payload.exp ?? "5m")
    .sign(privateKey);
}
async function setup() {
  googleConfig();
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_INTAKE_ENABLED = "true";
  process.env.CUSTOMER_ONBOARDING_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET =
    "synthetic-google-login-secret-thirty-two-chars";
  const { store } = fixture();
  store.data.clear();
  const started = await startCalendarOnboarding(store, {
    name: "Synthetic Google Inn",
    kind: "rooms",
    rooms: ["101"],
    calendarKind: "google_calendar",
  });
  return { store, ...started, hash: draftHash(started.cookie) };
}
async function oauth(t, f, payload = {}, overrides = {}, draft = true, destination) {
  const flow = await beginGoogleSignIn(f.store, draft ? f.hash : undefined, destination),
    url = new URL(flow.url),
    state = url.searchParams.get("state");
  const id_token = await jwt(url.searchParams.get("nonce"), payload);
  t.mock.method(globalThis, "fetch", async (raw, options) => {
    const u = new URL(raw);
    if (u.hostname === "oauth2.googleapis.com") {
      assert.equal(
        createHash("sha256")
          .update(new URLSearchParams(options.body).get("code_verifier"))
          .digest("base64url"),
        url.searchParams.get("code_challenge"),
      );
      return Response.json({
        id_token,
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
        scope: scopes,
        ...overrides,
      });
    }
    assert.equal(options.headers.Authorization, "Bearer synthetic-access");
    if (u.pathname.endsWith("/calendarList"))
      return Response.json({
        items: [
          { id: "room-google", summary: "Synthetic", accessRole: "owner" },
        ],
      });
    assert.match(u.pathname, /calendars\/room-google\/events$/);
    return Response.json({
      items: [
        {
          id: "event-1",
          iCalUID: "synthetic-google-uid",
          summary: "客人：Synthetic",
          start: { date: "2026-10-10" },
          end: { date: "2026-10-12" },
          updated: "2026-10-01T00:00:00Z",
        },
      ],
    });
  });
  const finish = (browser = flow.browser, hash = draft ? f.hash : undefined) =>
    finishGoogleSignIn(
      f.store,
      state,
      browser,
      "synthetic-code",
      hash,
      resolveKey,
    );
  return { flow, url, state, finish };
}
test("Google ID tokens require trusted signature, audience, issuer, nonce, recent lifetime and verified email", async () => {
  googleConfig();
  assert.deepEqual(
    await verifyGoogleIdentity(await jwt("nonce"), "nonce", resolveKey),
    {
      sub: "google-subject-123",
      email: "synthetic.owner@gmail.com",
      authoritative: true,
    },
  );
  for (const payload of [
    { aud: "different-client" },
    { iss: "https://evil.test" },
    { nonce: "wrong" },
    { email_verified: false },
    { exp: Math.floor(Date.now() / 1000) - 100 },
    { iat: Math.floor(Date.now() / 1000) - 800 },
    { azp: "different-client" },
    { sub: "" },
  ])
    await assert.rejects(
      verifyGoogleIdentity(await jwt("nonce", payload), "nonce", resolveKey),
      /GOOGLE_SIGNIN_FAILED/,
    );
  const other = await generateKeyPair("RS256");
  await assert.rejects(
    verifyGoogleIdentity(
      await jwt("nonce", {}, other.privateKey),
      "nonce",
      resolveKey,
    ),
    /GOOGLE_SIGNIN_FAILED/,
  );
  assert.equal(
    (
      await verifyGoogleIdentity(
        await jwt("nonce", { email: "owner@example.test" }),
        "nonce",
        resolveKey,
      )
    ).authoritative,
    false,
  );
});
test("Google login, readonly consent, preview and atomic save need no password; final grant remains usable and encrypted", async (t) => {
  const f = await setup(),
    flow = await oauth(t, f);
  assert.equal(flow.url.searchParams.get("scope"), `openid email ${scopes}`);
  assert.equal(flow.url.searchParams.get("access_type"), "offline");
  await assert.rejects(flow.finish("x".repeat(43)), /GOOGLE_SIGNIN_FAILED/);
  await assert.rejects(
    flow.finish(flow.flow.browser, "b".repeat(64)),
    /GOOGLE_SIGNIN_FAILED/,
  );
  const signed = await flow.finish();
  assert.equal(signed.account.credential.kind, "passwordless");
  assert.equal(
    (await authenticate(f.store, sessionFor(signed.account))).id,
    signed.account.id,
  );
  await assert.rejects(flow.finish(), /GOOGLE_SIGNIN_FAILED/);
  const d = await draftForHash(f.store, f.hash),
    { args } = previewContext(f.store, f.hash, d.value);
  const source = await readGoogleCalendar(...args, {
    kind: "google_calendar",
    ...range,
    calendarIds: ["room-google"],
  });
  await updateCalendarDraft(
    f.store,
    f.hash,
    await draftForHash(f.store, f.hash),
    { sourceId: source.id },
  );
  const ws = (await args[0].read(`workspace:${d.value.workspaceId}`)).value;
  const preview = await previewCalendar(...args, source.id, {
    calendarIds: ["room-google"],
    rooms: { "room-google": [ws.properties[0].rooms[0].id] },
    dateMode: "stay",
    titleRooms: false,
    extractLabels: true,
    overrides: {},
  });
  await updateCalendarDraft(
    f.store,
    f.hash,
    await draftForHash(f.store, f.hash),
    { previewId: preview.id },
  );
  assert.equal(
    [...f.store.data.keys()].some((k) => k.startsWith("workspace:")),
    false,
  );
  await prepareCalendarSave(f.store, f.hash, {
    previewId: preview.id,
    selected: preview.rows.map((r) => r.id),
    confirmed: true,
    confirmedCoverage: true,
    mode: "connected",
  });
  const saved = await finishCalendarOnboarding(
    f.store,
    f.hash,
    signed.account,
    signed.account.id,
  );
  const finalArgs = [
    f.store,
    signed.account.id,
    saved.slug,
    d.value.propertyId,
  ];
  assert.equal((await listGoogleCalendars(...finalArgs)).calendars.length, 1);
  assert.equal(
    (await calendarPreviewFor(...finalArgs, preview.id)).actor,
    signed.account.id,
  );
  assert.equal(
    (await calendarSnapshotFor(...finalArgs, source.id)).actor,
    signed.account.id,
  );
  assert.equal(
    (await f.store.read(`workspace:${d.value.workspaceId}`)).value
      .calendarSources[0].mode,
    "connected",
  );
  assert.equal(
    [...f.store.data.values()].join("").includes("synthetic-refresh"),
    false,
  );
  const destination = `/w/${saved.slug}/orders?property=${d.value.propertyId}`;
  const login = await oauth(t, f, {}, {}, false, destination);
  assert.equal(login.url.searchParams.get("scope"), "openid email");
  const loggedIn = await login.finish();
  assert.equal(loggedIn.account.id, signed.account.id);
  assert.equal(loggedIn.destination, destination);
  await assert.rejects(() => beginGoogleSignIn(f.store, undefined, "https://evil.test"), /INVALID_INPUT/);
});
test("Google partial consent never creates an account; third-party email cannot seize an existing account", async (t) => {
  const partial = await setup(),
    p = await oauth(t, partial, {}, { scope: "openid email" });
  await assert.rejects(p.finish(), /CALENDAR_CONNECT_REQUIRED/);
  assert.equal(
    [...partial.store.data.keys()].some((k) => k.startsWith("account:")),
    false,
  );
  const f = await setup(),
    email = "existing@example.test",
    account = {
      id: randomUUID(),
      email,
      emailVerifiedAt: new Date().toISOString(),
      credential: newPasswordlessCredential(),
      workspaces: [],
    };
  await f.store.commit([
    { key: accountKey(email), before: null, after: account },
  ]);
  const flow = await oauth(t, f, { email });
  assert.equal((await flow.finish()).account, null);
  assert.equal(
    (await f.store.read(accountKey(email))).value.googleSubject,
    undefined,
  );
  await assert.rejects(
    linkVerifiedGoogleIdentity(
      f.store,
      { ...account, email: "other@example.test" },
      { sub: "google-subject-123", email, authoritative: false },
    ),
    /CALENDAR_ACCOUNT_CHANGED/,
  );
  const linked = await linkVerifiedGoogleIdentity(f.store, account, {
    sub: "google-subject-123",
    email,
    authoritative: false,
  });
  assert.equal(linked.googleSubject, "google-subject-123");
  const again = await oauth(t, f, { email }, {}, false);
  assert.equal((await again.finish()).account.id, account.id);
});
test("authoritative Google verification revokes a pre-claimed password and refuses conflicting subjects", async (t) => {
  const f = await setup(),
    email = "synthetic.owner@gmail.com",
    account = {
      id: randomUUID(),
      email,
      credential: await createPasswordCredential("synthetic-old-password"),
      workspaces: [],
    };
  await f.store.commit([
    { key: accountKey(email), before: null, after: account },
  ]);
  const oldSession = sessionFor(account),
    flow = await oauth(t, f),
    signed = await flow.finish();
  assert.equal(signed.account.id, account.id);
  assert.equal(signed.account.credential.kind, "passwordless");
  await assert.rejects(authenticate(f.store, oldSession), /UNAUTHORIZED/);
  const conflict = await oauth(t, f, { sub: "another-subject" }, {}, false);
  await assert.rejects(conflict.finish(), /GOOGLE_SIGNIN_FAILED/);
});
test("a stale concurrent Google return cannot overwrite the winning account's calendar grant", async (t) => {
  const f = await setup(),
    a = await beginGoogleSignIn(f.store, f.hash),
    b = await beginGoogleSignIn(f.store, f.hash);
  const au = new URL(a.url),
    bu = new URL(b.url),
    at = await jwt(au.searchParams.get("nonce"), {
      sub: "account-a",
      email: "a@gmail.com",
    }),
    bt = await jwt(bu.searchParams.get("nonce"), {
      sub: "account-b",
      email: "b@gmail.com",
    });
  let resumeA, enteredA;
  const entered = new Promise((resolve) => {
    enteredA = resolve;
  });
  t.mock.method(globalThis, "fetch", async (raw, options) => {
    if (new URL(raw).hostname === "oauth2.googleapis.com") {
      const code = new URLSearchParams(options.body).get("code");
      if (code === "A") {
        enteredA();
        await new Promise((resolve) => {
          resumeA = resolve;
        });
      }
      return Response.json({
        id_token: code === "A" ? at : bt,
        access_token: `access-${code}`,
        refresh_token: `refresh-${code}`,
        expires_in: 3600,
        scope: scopes,
      });
    }
    assert.equal(options.headers.Authorization, "Bearer access-B");
    return Response.json({ items: [] });
  });
  const finishingA = finishGoogleSignIn(
    f.store,
    au.searchParams.get("state"),
    a.browser,
    "A",
    f.hash,
    resolveKey,
  );
  await entered;
  const resultB = await finishGoogleSignIn(
    f.store,
    bu.searchParams.get("state"),
    b.browser,
    "B",
    f.hash,
    resolveKey,
  );
  resumeA();
  await assert.rejects(finishingA, /VERSION_CONFLICT/);
  const draft = await draftForHash(f.store, f.hash);
  assert.equal(draft.value.googleAccountId, resultB.account.id);
  assert.equal(draft.value.googleIdentity.email, "b@gmail.com");
  assert.deepEqual(
    (
      await listGoogleCalendars(
        ...previewContext(f.store, f.hash, draft.value).args,
      )
    ).calendars,
    [],
  );
});
test("turning off public onboarding blocks a previously issued signup grant before token exchange", async (t) => {
  const f = await setup(),
    flow = await oauth(t, f);
  process.env.CUSTOMER_ONBOARDING_ENABLED = "false";
  await assert.rejects(flow.finish(), /FEATURE_UNAVAILABLE/);
  assert.equal(
    [...f.store.data.keys()].some((k) => k.startsWith("account:")),
    false,
  );
});
