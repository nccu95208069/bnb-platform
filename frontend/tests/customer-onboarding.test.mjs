import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { customerOrigin } from "../src/lib/customer-workspaces/site-url.ts";
import { submitIntake } from "../src/lib/customer-intake/service.ts";
import {
  beginOnboarding,
  provisionVerifiedApplication,
  sharedImportPermission,
  finishOnboardingImport,
  syncOnboardingProgress,
  listApplications,
  reviewApplication,
} from "../src/lib/customer-intake/onboarding.ts";
import {
  issueAccountLink,
  accountLinkUrl,
  consumeAccountLink,
  accountLinkInfo,
} from "../src/lib/customer-workspaces/account-links.ts";
import {
  previewImport,
  commitImport,
  undoImport,
} from "../src/lib/customer-workspaces/sheet-import.ts";
import {
  accountKey,
  authenticate,
  login,
  sessionFor,
} from "../src/lib/customer-workspaces/auth.ts";
import {
  createBooking,
  loadWorkspace,
  view,
} from "../src/lib/customer-workspaces/service.ts";
import {
  checkSharedSheet,
  sharedSource,
  sheetApplicantHasAccess,
} from "../src/lib/customer-workspaces/shared-sheet.ts";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const password = "Synthetic customer passphrase 88!";
test("disabled Google APIs report service setup failure, not incorrect customer sharing", async (t) => {
  const f = fixture(t);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url) === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "synthetic" });
    return Response.json(
      { error: { details: [{ reason: "SERVICE_DISABLED" }] } },
      { status: 403 },
    );
  });
  await assert.rejects(
    checkSharedSheet(f.input.sheetUrl),
    /SHEET_READER_UNAVAILABLE/,
  );
});
function fixture(t, { owner = true, readable = true } = {}) {
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET =
    "synthetic-onboarding-session-secret-only";
  delete process.env.CUSTOMER_SELF_SIGNUP_PREVIEW;
  process.env.CUSTOMER_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "reader@synthetic.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const data = new Map(),
    sent = [],
    state = { owner, readable };
  const rows = [
    ["入住", "退房", "房間", "旅客", "編號", "總額", "實收"],
    ["2026-10-10", "2026-10-12", "101", "甲", "A", "6000", "2000"],
    ["2026-10-15", "2026-10-17", "包棟", "乙", "B", "12000", "4000"],
    ["2026-10-20", "2026-10-21", "102", "丙", "C", "", ""],
    ["2026-10-22", "2026-10-23", "999", "丁", "D", "3000", "0"],
    ["2026-10-25", "2026-10-24", "101", "戊", "E", "3000", "0"],
  ];
  const store = {
    data,
    read: async (key) => ({
      raw: data.get(key) ?? null,
      value: JSON.parse(data.get(key) ?? "null"),
    }),
    limit: async () => {},
    commit: async (changes) => {
      if (changes.some((c) => (data.get(c.key) ?? null) !== c.before))
        throw new Error("VERSION_CONFLICT");
      for (const c of changes) data.set(c.key, JSON.stringify(c.after));
    },
  };
  const send = async (to, subject, text) => {
    sent.push({ to, subject, text });
    return "test-mail-" + sent.length;
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    const u = String(url);
    if (u === "https://oauth2.googleapis.com/token")
      return Response.json({ access_token: "synthetic-only" });
    if (!state.readable)
      return Response.json({ error: "denied" }, { status: 403 });
    if (u.startsWith("https://www.googleapis.com/drive/v3/files/"))
      return Response.json({
        owners: [
          {
            emailAddress: state.owner
              ? "customer@example.test"
              : "another@example.test",
          },
        ],
      });
    if (u.includes("/values/")) return Response.json({ values: rows });
    if (u.startsWith("https://sheets.googleapis.com/v4/spreadsheets/"))
      return Response.json({
        properties: { title: "Synthetic" },
        sheets: [
          {
            properties: {
              sheetId: 0,
              title: "Bookings",
              gridProperties: { rowCount: 100, columnCount: 8 },
            },
          },
        ],
      });
    throw new Error("Unexpected network destination");
  });
  const input = {
    requestKey: randomUUID(),
    intent: "join",
    propertyName: "Synthetic Inn",
    kind: "mixed",
    rooms: ["101", "102"],
    source: "sheet",
    sheetUrl:
      "https://docs.google.com/spreadsheets/d/synthetic-source-id-00000000/edit",
    sharingDeclared: true,
    contactName: "Synthetic Customer",
    email: "customer@example.test",
    consent: true,
    website: "",
  };
  return { store, sent, send, input, rows, state };
}
async function application(f) {
  const claim = await sheetApplicantHasAccess(f.input.sheetUrl, f.input.email);
  await submitIntake(f.store, f.input, async (m) =>
    f.send(m.to, m.subject, m.text),
  );
  await beginOnboarding(f.store, f.input.requestKey, claim, f.send);
  const link = await issueAccountLink(
    f.store,
    "onboarding",
    f.input.requestKey,
    f.input.email,
  );
  return accountLinkUrl(link).split("#")[1];
}
test("applicant receipt is independent, safe retries do not resend, and email-link verification creates exactly one isolated workspace", async (t) => {
  const f = fixture(t),
    token = await application(f);
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].to, "linlab.ai2024@gmail.com");
  assert.equal(f.sent[1].to, f.input.email);
  assert.match(f.sent[1].text, /account-setup#/);
  assert.equal((await f.store.read(accountKey(f.input.email))).value, null);
  await beginOnboarding(f.store, f.input.requestKey, true, f.send);
  assert.equal(f.sent.length, 2);
  assert.equal((await accountLinkInfo(f.store, token)).email, f.input.email);
  await assert.rejects(
    consumeAccountLink(f.store, token.slice(0, -1) + "Z", password, password),
    /LINK_INVALID/,
  );
  const { account } = await consumeAccountLink(
    f.store,
    token,
    password,
    password,
  );
  const created = await provisionVerifiedApplication(
    f.store,
    f.input.requestKey,
    account,
  );
  const loaded = await loadWorkspace(f.store, account.id, created.slug);
  assert.equal(loaded.workspace.bookings.length, 0);
  assert.ok(loaded.workspace.onboarding.approvedAt);
  const session = sessionFor(account);
  assert.equal((await authenticate(f.store, session)).id, account.id);
  const retry = await consumeAccountLink(f.store, token, password, password);
  assert.equal(retry.account.id, account.id);
  await provisionVerifiedApplication(
    f.store,
    f.input.requestKey,
    retry.account,
  );
  assert.equal(
    (await f.store.read(accountKey(f.input.email))).value.workspaces.length,
    1,
  );
  await assert.rejects(
    consumeAccountLink(
      f.store,
      token,
      "different valid password 99",
      "different valid password 99",
    ),
    /LINK_INVALID/,
  );
  await assert.rejects(
    login(f.store, {
      mode: "register",
      email: "unverified@example.test",
      password,
      confirmPassword: password,
    }),
    /REGISTRATION_CLOSED/,
  );
  assert.equal((await listApplications(f.store)).length, 1);
});
test("unknown ownership cannot expose shared content; operator review is required and access revocation is detected", async (t) => {
  const f = fixture(t, { owner: false }),
    token = await application(f),
    { account } = await consumeAccountLink(f.store, token, password, password);
  const created = await provisionVerifiedApplication(
      f.store,
      f.input.requestKey,
      account,
    ),
    loaded = await loadWorkspace(f.store, account.id, created.slug),
    p = loaded.workspace.properties[0].id;
  await assert.rejects(
    sharedImportPermission(f.store, account.id, created.slug, p),
    /SHEET_REVIEW_REQUIRED/,
  );
  await assert.rejects(
    reviewApplication(
      f.store,
      f.input.requestKey,
      "operator",
      "approve",
      {},
      f.send,
    ),
    /SHEET_REVIEW_REQUIRED/,
  );
  await reviewApplication(
    f.store,
    f.input.requestKey,
    "operator",
    "approve",
    { confirmIdentity: true },
    f.send,
  );
  assert.equal(
    (await sharedImportPermission(f.store, account.id, created.slug, p)).url,
    f.input.sheetUrl,
  );
  await assert.rejects(
    sharedImportPermission(f.store, "outsider", created.slug, p),
    /NOT_FOUND|FORBIDDEN/,
  );
  f.state.readable = false;
  await assert.rejects(checkSharedSheet(f.input.sheetUrl), /SHEET_NOT_SHARED/);
});
test("Google permission is rechecked at activation and before later source reads", async (t) => {
  const f = fixture(t),
    token = await application(f),
    { account } = await consumeAccountLink(f.store, token, password, password);
  f.state.owner = false;
  const created = await provisionVerifiedApplication(
      f.store,
      f.input.requestKey,
      account,
    ),
    loaded = await loadWorkspace(f.store, account.id, created.slug);
  assert.equal(loaded.workspace.onboarding.approvedAt, undefined);
});
test("five source rows produce three safe imports; missing rows block new bookings until corrected; final mail and retries stay scoped", async (t) => {
  const f = fixture(t),
    token = await application(f),
    { account } = await consumeAccountLink(f.store, token, password, password),
    { slug } = await provisionVerifiedApplication(
      f.store,
      f.input.requestKey,
      account,
    );
  const w = (await loadWorkspace(f.store, account.id, slug)).workspace,
    p = w.properties[0],
    args = [f.store, account.id, slug, p.id];
  const mapping = {
    headerRow: 1,
    columns: {
      checkIn: 0,
      checkOut: 1,
      rooms: 2,
      guestName: 3,
      externalId: 4,
      total: 5,
      received: 6,
    },
    roomMap: {
      101: [p.rooms[0].id],
      102: [p.rooms[1].id],
      包棟: p.rooms.map((r) => r.id),
    },
    granularity: "order",
    amountBasis: "order",
    receivedMeaning: "property",
    currency: "TWD",
    from: "2026-10-01",
  };
  const google = await sharedSource(...args, f.input.sheetUrl, 0);
  assert.equal(google.rows.length, 6);
  const source = (await f.store.read("sheet-source:" + google.id)).value.source;
  const preview = await previewImport(...args, source, mapping);
  assert.deepEqual(
    preview.rows.filter((r) => !r.issues.length).map((r) => r.row),
    [2, 3, 4],
  );
  await assert.rejects(commitImport(...args, preview.id, [5]), /INVALID_INPUT/);
  const batch = await commitImport(...args, preview.id, [2, 3, 4]);
  assert.deepEqual(await commitImport(...args, preview.id, [4, 3, 2]), batch);
  // A lost post-commit response must remain safe after the temporary preview expires.
  f.store.data.delete(`import-preview:${preview.id}`);
  await finishOnboardingImport(
    f.store,
    account,
    slug,
    p.id,
    preview.id,
    f.send,
  );
  let loaded = await loadWorkspace(f.store, account.id, slug);
  assert.equal(
    view(loaded.workspace, loaded.member).onboarding.complete,
    false,
  );
  assert.equal(loaded.workspace.onboarding.unresolvedCount, 2);
  assert.equal(loaded.workspace.bookings[1].roomIds.length, 2);
  assert.equal(loaded.workspace.bookings[1].total, 12000);
  assert.equal(
    loaded.workspace.bookings[1].importedFinance.propertyReceived,
    4000,
  );
  assert.deepEqual(loaded.workspace.bookings[1].payments, []);
  assert.equal(loaded.workspace.bookings[2].total, null);
  await assert.rejects(
    createBooking(...args.slice(0, 3), {}),
    /IMPORT_INCOMPLETE/,
  );
  const sent = f.sent.length;
  await finishOnboardingImport(
    f.store,
    account,
    slug,
    p.id,
    preview.id,
    f.send,
  );
  assert.equal(f.sent.length, sent);
  f.rows[4][2] = "102";
  f.rows[5][1] = "2026-10-26";
  const corrected = { ...source, rows: f.rows.map((r) => [...r]) };
  const next = await previewImport(...args, corrected, mapping);
  assert.deepEqual(
    next.rows.filter((r) => !r.issues.length).map((r) => r.row),
    [5, 6],
  );
  await commitImport(...args, next.id, [5, 6]);
  await finishOnboardingImport(f.store, account, slug, p.id, next.id, f.send);
  loaded = await loadWorkspace(f.store, account.id, slug);
  assert.equal(loaded.workspace.bookings.length, 5);
  assert.equal(view(loaded.workspace, loaded.member).onboarding.complete, true);
  assert.equal(f.sent.at(-1).subject, "旅宿服務｜日曆已建立");
  assert.equal(f.sent.at(-1).to, f.input.email);
  await finishOnboardingImport(
    f.store,
    account,
    slug,
    p.id,
    preview.id,
    f.send,
  );
  assert.equal((await listApplications(f.store))[0].journey.status, "ready");
  await undoImport(...args, next.id, loaded.workspace.version);
  await syncOnboardingProgress(f.store, account.id, slug);
  assert.equal((await listApplications(f.store))[0].journey.status, "partial");
  assert.equal((await listApplications(f.store))[0].journey.excludedCount, 2);
});
test("password recovery invalidates old sessions and all previously issued links without losing workspace membership", async (t) => {
  const f = fixture(t),
    token = await application(f),
    { account } = await consumeAccountLink(f.store, token, password, password);
  await provisionVerifiedApplication(f.store, f.input.requestKey, account);
  const oldSession = sessionFor(account),
    a = await issueAccountLink(
      f.store,
      "recovery",
      randomUUID(),
      account.email,
    ),
    b = await issueAccountLink(
      f.store,
      "recovery",
      randomUUID(),
      account.email,
    );
  const newPassword = "Changed synthetic passphrase 123!";
  const changed = await consumeAccountLink(
    f.store,
    accountLinkUrl(a).split("#")[1],
    newPassword,
    newPassword,
  );
  assert.equal(changed.account.workspaces.length, 1);
  await assert.rejects(authenticate(f.store, oldSession), /UNAUTHORIZED/);
  await assert.rejects(
    consumeAccountLink(
      f.store,
      accountLinkUrl(b).split("#")[1],
      password,
      password,
    ),
    /LINK_INVALID/,
  );
  const next = await login(f.store, {
    email: account.email,
    password: newPassword,
  });
  assert.equal(next.id, account.id);
  assert.equal((await authenticate(f.store, sessionFor(next))).id, account.id);
});
test("failed applicant email remains visible, admin resend is explicit, and preview sends nothing", async (t) => {
  const f = fixture(t);
  await submitIntake(f.store, f.input, async () => "operator-mail");
  const fail = async () => {
    throw new Error("transport failure");
  };
  assert.equal(
    (await beginOnboarding(f.store, f.input.requestKey, true, fail)).status,
    "needs_attention",
  );
  assert.equal(
    (await beginOnboarding(f.store, f.input.requestKey, true, f.send)).status,
    "needs_attention",
  );
  assert.equal(f.sent.length, 0);
  await reviewApplication(
    f.store,
    f.input.requestKey,
    "operator",
    "resend",
    {},
    f.send,
  );
  assert.equal(f.sent.length, 1);
  const other = {
    ...f.input,
    requestKey: randomUUID(),
    intent: "consultation",
    source: "other",
  };
  await submitIntake(f.store, other, async () => "suppressed");
  assert.equal(
    (await beginOnboarding(f.store, other.requestKey, false, f.send, true))
      .status,
    "preview",
  );
  assert.equal(f.sent.length, 1);
});

test("email origins use an explicit deployment switch and reject arbitrary hosts", (t) => {
  const before = process.env.CUSTOMER_DEPLOYMENT_LINKS,
    host = process.env.VERCEL_URL;
  t.after(() => {
    if (before === undefined) delete process.env.CUSTOMER_DEPLOYMENT_LINKS;
    else process.env.CUSTOMER_DEPLOYMENT_LINKS = before;
    if (host === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = host;
  });
  delete process.env.CUSTOMER_DEPLOYMENT_LINKS;
  process.env.VERCEL_URL = "ignored.invalid";
  assert.equal(customerOrigin(), "https://sweetfun-os.vercel.app");
  process.env.CUSTOMER_DEPLOYMENT_LINKS = "true";
  process.env.VERCEL_URL = "sweetfun-synthetic.vercel.app";
  assert.equal(customerOrigin(), "https://sweetfun-synthetic.vercel.app");
  for (const bad of [
    "evil.invalid",
    "sweetfun.vercel.app/extra",
    "sweetfun.vercel.app@evil.invalid",
    "",
  ]) {
    process.env.VERCEL_URL = bad;
    assert.throws(customerOrigin, /FEATURE_UNAVAILABLE/);
  }
});
