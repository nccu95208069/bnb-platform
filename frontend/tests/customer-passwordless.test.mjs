import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture } from "./helpers/calendar-fixture.mjs";
import {
  accountKey,
  authenticate,
  sessionFor,
  login,
} from "../src/lib/customer-workspaces/auth.ts";
import {
  customerCredentialBinding,
  newPasswordlessCredential,
} from "../src/lib/customer-workspaces/identity.ts";
import {
  requestEmailLogin,
  consumeEmailLogin,
  newLoginProof,
} from "../src/lib/customer-workspaces/passwordless.ts";
import {
  issueAccountLink,
  consumeAccountLink,
  accountLinkUrl,
} from "../src/lib/customer-workspaces/account-links.ts";
import { createPasswordCredential } from "../src/lib/owner-password.ts";
function environment() {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET =
    "synthetic-signin-secret-at-least-thirty-two-chars";
  process.env.CUSTOMER_DEPLOYMENT_LINKS = "true";
  process.env.VERCEL_URL = "synthetic-login.vercel.app";
}
const mailToken = (text) => text.match(/\/signin#([^\s]+)/)[1];
test("email login is same-browser, scoped, short-lived and retryable without a password or duplicate mail", async (t) => {
  environment();
  const previousOrigin = process.env.CUSTOMER_DEPLOYMENT_ORIGIN;
  process.env.CUSTOMER_DEPLOYMENT_ORIGIN = "https://synthetic-pilot.vercel.app";
  t.after(() => {
    if (previousOrigin === undefined)
      delete process.env.CUSTOMER_DEPLOYMENT_ORIGIN;
    else process.env.CUSTOMER_DEPLOYMENT_ORIGIN = previousOrigin;
  });
  const { store } = fixture();
  store.data.clear();
  const proof = newLoginProof(),
    id = randomUUID(),
    hash = "a".repeat(64),
    sent = [];
  const input = {
    email: "owner@example.test",
    requestKey: id,
    proof,
    draftHash: hash,
  };
  const send = async (...args) => {
    sent.push(args);
    return "synthetic-mail";
  };
  assert.equal(
    (await requestEmailLogin(store, input, send)).status,
    "accepted",
  );
  await requestEmailLogin(store, input, send);
  assert.equal(sent.length, 1);
  assert.match(sent[0][2], /https:\/\/synthetic-pilot\.vercel\.app\/signin#/);
  assert.ok(!sent[0][2].includes("https://synthetic-login.vercel.app"));
  assert.equal((await store.read(accountKey(input.email))).value, null);
  const token = mailToken(sent[0][2]);
  await assert.rejects(
    consumeEmailLogin(store, token, newLoginProof(), hash, id),
    /LINK_INVALID/,
  );
  await assert.rejects(
    consumeEmailLogin(store, token, proof, "b".repeat(64), id),
    /LINK_INVALID/,
  );
  await assert.rejects(
    consumeEmailLogin(store, token, proof, hash, randomUUID()),
    /LINK_INVALID/,
  );
  const result = await consumeEmailLogin(store, token, proof, hash, id);
  assert.equal(result.account.credential.kind, "passwordless");
  assert.ok(result.account.emailVerifiedAt);
  assert.equal(
    (await authenticate(store, sessionFor(result.account))).id,
    result.account.id,
  );
  assert.deepEqual(
    (await consumeEmailLogin(store, token, proof, hash, id)).account,
    result.account,
  );
  await assert.rejects(
    login(store, { email: input.email, password: "anything-not-a-password" }),
    /UNAUTHORIZED/,
  );
  const stored = await store.read(`customer-login:${id}`);
  await store.commit([
    {
      key: `customer-login:${id}`,
      before: stored.raw,
      after: { ...stored.value, expiresAt: Date.now() - 1 },
    },
  ]);
  await assert.rejects(
    consumeEmailLogin(store, token, proof, hash, id),
    /LINK_INVALID/,
  );
});
test("generic email login neither creates arbitrary accounts nor leaks their existence; uncertain mail is not resent", async () => {
  environment();
  const { store } = fixture();
  store.data.clear();
  let calls = 0;
  const proof = newLoginProof(),
    send = async () => {
      calls++;
      throw Error("reply lost");
    };
  assert.equal(
    (
      await requestEmailLogin(
        store,
        { email: "absent@example.test", requestKey: randomUUID(), proof },
        send,
      )
    ).status,
    "accepted",
  );
  assert.equal(calls, 0);
  assert.equal(
    [...store.data.keys()].some((k) => k.startsWith("account:")),
    false,
  );
  const input = {
    email: "new@example.test",
    requestKey: randomUUID(),
    proof,
    draftHash: "a".repeat(64),
  };
  assert.equal(
    (await requestEmailLogin(store, input, send)).status,
    "needs_attention",
  );
  assert.equal(
    (await requestEmailLogin(store, input, send)).status,
    "needs_attention",
  );
  assert.equal(calls, 1);
  await assert.rejects(
    requestEmailLogin(store, { ...input, email: "other@example.test" }, send),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("email verification clears pre-claimed unverified passwords and rejects links issued before credential rotation", async () => {
  environment();
  const { store } = fixture();
  store.data.clear();
  const email = "preclaimed@example.test",
    account = {
      id: randomUUID(),
      email,
      credential: await createPasswordCredential("synthetic-old-password-123"),
      workspaces: [],
    };
  await store.commit([
    { key: accountKey(email), before: null, after: account },
  ]);
  const oldSession = sessionFor(account),
    proof = newLoginProof(),
    id = randomUUID();
  let token;
  await requestEmailLogin(
    store,
    { email, proof, requestKey: id },
    async (_to, _subject, text) => {
      token = mailToken(text);
      return "sent";
    },
  );
  const verified = (await consumeEmailLogin(store, token, proof)).account;
  assert.equal(verified.credential.kind, "passwordless");
  await assert.rejects(authenticate(store, oldSession), /UNAUTHORIZED/);
  await assert.rejects(
    login(store, { email, password: "synthetic-old-password-123" }),
    /UNAUTHORIZED/,
  );
  const link = await issueAccountLink(store, "recovery", randomUUID(), email);
  const reset = await consumeAccountLink(
    store,
    accountLinkUrl(link).split("#")[1],
    "new-real-owner-password-123",
    "new-real-owner-password-123",
  );
  assert.equal(reset.account.credential.kind, "password");
  assert.notEqual(
    customerCredentialBinding(reset.account.credential),
    customerCredentialBinding(verified.credential),
  );
  await assert.rejects(consumeEmailLogin(store, token, proof), /LINK_INVALID/);
});
test("existing verified passwords remain usable after a normal passwordless login", async () => {
  environment();
  const { store } = fixture();
  store.data.clear();
  const email = "verified@example.test",
    account = {
      id: randomUUID(),
      email,
      emailVerifiedAt: new Date().toISOString(),
      credential: await createPasswordCredential("verified-password-123"),
      workspaces: [],
    };
  await store.commit([
    { key: accountKey(email), before: null, after: account },
  ]);
  const proof = newLoginProof();
  let token;
  await requestEmailLogin(
    store,
    { email, requestKey: randomUUID(), proof },
    async (_to, _subject, text) => {
      token = mailToken(text);
      return "sent";
    },
  );
  assert.equal(
    (await consumeEmailLogin(store, token, proof)).account.credential.kind,
    "password",
  );
  assert.equal(
    (await login(store, { email, password: "verified-password-123" })).id,
    account.id,
  );
});
test("passwordless accounts accept collaboration invitations with their verified session, never another account or stale credentials", async () => {
  environment();
  const f = fixture();
  const { createInvitation, invitationUrl, invitationInfo, acceptInvitation } =
    await import("../src/lib/customer-workspaces/invitations.ts");
  const owner = {
    id: "calendar-owner",
    email: "owner@example.test",
    credential: newPasswordlessCredential(),
    workspaces: [],
  };
  const invitee = {
    id: randomUUID(),
    email: "invitee@example.test",
    emailVerifiedAt: new Date().toISOString(),
    credential: newPasswordlessCredential(),
    workspaces: [],
  };
  await f.store.commit([
    { key: accountKey(invitee.email), before: null, after: invitee },
  ]);
  const created = await createInvitation(f.store, owner, f.workspace.slug, {
    requestKey: randomUUID(),
    version: 1,
    email: invitee.email,
    role: "viewer",
    allProperties: true,
    propertyIds: [],
  });
  const token = invitationUrl(created.workspace.id, created.invitation).split(
    "#",
  )[1];
  assert.equal((await invitationInfo(f.store, token)).passwordless, true);
  assert.equal((await invitationInfo(f.store, token, invitee)).signedIn, true);
  await assert.rejects(
    acceptInvitation(f.store, token, null, null, {
      ...invitee,
      id: randomUUID(),
    }),
    /PASSWORD_INVALID/,
  );
  await assert.rejects(
    acceptInvitation(f.store, token, null, null, {
      ...invitee,
      credential: newPasswordlessCredential(),
    }),
    /PASSWORD_INVALID/,
  );
  await assert.rejects(
    acceptInvitation(f.store, token, "invented-password", null),
    /UNAUTHORIZED/,
  );
  const result = await acceptInvitation(f.store, token, null, null, invitee);
  assert.equal(result.account.credential.kind, "passwordless");
  assert.equal(result.slug, f.workspace.slug);
  assert.equal(
    (await acceptInvitation(f.store, token, null, null, result.account)).account
      .id,
    invitee.id,
  );
});
