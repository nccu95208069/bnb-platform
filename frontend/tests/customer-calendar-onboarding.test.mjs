import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fixture, ics, event, range } from "./helpers/calendar-fixture.mjs";
import { accountKey, digest } from "../src/lib/customer-workspaces/auth.ts";
import { newPasswordlessCredential } from "../src/lib/customer-workspaces/identity.ts";
import {
  uploadCalendar,
  previewCalendar,
} from "../src/lib/customer-workspaces/calendar-import.ts";
import {
  startCalendarOnboarding,
  draftHash,
  draftKey,
  draftForHash,
  previewContext,
  updateCalendarDraft,
  calendarOnboardingView,
  prepareCalendarSave,
  finishCalendarOnboarding,
} from "../src/lib/customer-workspaces/calendar-onboarding.ts";
import { loadWorkspace } from "../src/lib/customer-workspaces/service.ts";
import { financeSummary } from "../src/lib/customer-workspaces/domain.ts";
async function setup(kind = "ios_calendar") {
  const { store } = fixture();
  store.data.clear();
  const input = {
    name: "Synthetic preview inn",
    kind: "rooms",
    rooms: ["101"],
    calendarKind: kind,
  };
  const started = await startCalendarOnboarding(store, input),
    hash = draftHash(started.cookie);
  const { scoped, args } = previewContext(store, hash, started.draft);
  const workspace = (
    await loadWorkspace(scoped, started.draft.actor, started.draft.slug)
  ).workspace;
  return {
    store,
    input,
    ...started,
    hash,
    scoped,
    args,
    property: workspace.properties[0],
  };
}
async function preview(f) {
  const source = await uploadCalendar(
    ...f.args,
    Buffer.from(ics([event({ title: "客人：Synthetic" })])),
    "example.ics",
    { kind: f.draft.kind, ...range },
  );
  await updateCalendarDraft(
    f.store,
    f.hash,
    await draftForHash(f.store, f.hash),
    { sourceId: source.id },
  );
  const rules = {
    calendarIds: source.calendars.map((c) => c.id),
    rooms: { [source.calendars[0].id]: [f.property.rooms[0].id] },
    dateMode: "stay",
    titleRooms: false,
    extractLabels: true,
    overrides: {},
  };
  const p = await previewCalendar(...f.args, source.id, rules);
  await updateCalendarDraft(
    f.store,
    f.hash,
    await draftForHash(f.store, f.hash),
    { previewId: p.id },
  );
  return {
    source,
    preview: p,
    command: {
      previewId: p.id,
      selected: p.rows.map((r) => r.id),
      confirmed: true,
      confirmedCoverage: true,
      mode: "migration",
    },
  };
}
async function account(f, email = "owner@example.test") {
  const a = {
    id: randomUUID(),
    email,
    emailVerifiedAt: new Date().toISOString(),
    credential: newPasswordlessCredential(),
    workspaces: [],
  };
  await f.store.commit([{ key: accountKey(email), before: null, after: a }]);
  return a;
}
test("all three calendar choices preview before signup; temporary data never creates real tenants or accounts", async () => {
  for (const kind of ["google_calendar", "ios_calendar", "android_calendar"]) {
    const f = await setup(kind),
      p = await preview(f);
    assert.equal(p.preview.rows[0].disposition, "ready");
    assert.equal(
      [...f.store.data.keys()].some((k) =>
        /^(account|workspace|slug):/.test(k),
      ),
      false,
    );
    const view = await calendarOnboardingView(f.store, f.hash);
    assert.equal(view.account, null);
    assert.equal(view.preview.id, p.preview.id);
    assert.equal(
      (await startCalendarOnboarding(f.store, f.input, f.cookie)).cookie,
      f.cookie,
    );
    const foreign = await startCalendarOnboarding(f.store, {
      ...f.input,
      name: "Other preview",
    });
    assert.notEqual(foreign.cookie, f.cookie);
    assert.equal(
      (
        await previewContext(
          f.store,
          digest(foreign.cookie),
          foreign.draft,
        ).scoped.read(`calendar-snapshot:${p.source.id}`)
      ).value,
      null,
    );
    await prepareCalendarSave(f.store, f.hash, p.command);
    assert.equal(
      [...f.store.data.keys()].some((k) => k.startsWith("workspace:")),
      false,
    );
  }
});
test("verified save atomically creates one tenant, one batch and unknown finances; exact retry survives lost write response", async () => {
  const f = await setup(),
    p = await preview(f),
    a = await account(f);
  await prepareCalendarSave(f.store, f.hash, p.command);
  const baseCommit = f.store.commit;
  let committed = false;
  f.store.commit = async (changes) => {
    await baseCommit(changes);
    if (
      !committed &&
      changes.some((c) => c.key === `workspace:${f.draft.workspaceId}`)
    ) {
      committed = true;
      throw Error("reply lost after atomic commit");
    }
  };
  await assert.rejects(
    finishCalendarOnboarding(f.store, f.hash, a, a.id),
    /reply lost/,
  );
  f.store.commit = baseCommit;
  const result = await finishCalendarOnboarding(f.store, f.hash, a, a.id);
  const w = (await loadWorkspace(f.store, a.id, result.slug)).workspace;
  assert.equal(w.bookings.length, 1);
  assert.equal(w.calendarBatches.length, 1);
  assert.equal(financeSummary(w.bookings[0]).received, null);
  assert.equal(w.bookings[0].total, null);
  assert.equal(
    (await f.store.read(accountKey(a.email))).value.workspaces.length,
    1,
  );
  assert.equal(w.members[0].accountId, a.id);
  assert.equal(
    w.members.some((m) => m.accountId === f.draft.actor),
    false,
  );
  assert.equal(
    (await calendarOnboardingView(f.store, f.hash, a)).completed,
    result.url,
  );
});
test("email/Google ownership, explicit account confirmation and preview selection cannot be changed during save", async () => {
  const f = await setup(),
    p = await preview(f),
    a = await account(f),
    b = await account(f, "other@example.test");
  await assert.rejects(
    prepareCalendarSave(f.store, f.hash, {
      ...p.command,
      selected: ["not-in-preview"],
    }),
    /INVALID_INPUT/,
  );
  await prepareCalendarSave(f.store, f.hash, p.command);
  await assert.rejects(
    prepareCalendarSave(f.store, f.hash, { ...p.command, selected: [] }),
    /CALENDAR_PREVIEW_LOCKED/,
  );
  await updateCalendarDraft(
    f.store,
    f.hash,
    await draftForHash(f.store, f.hash),
    { claimEmail: a.email, googleAccountId: a.id },
  );
  assert.equal(
    (await calendarOnboardingView(f.store, f.hash, b)).account,
    null,
  );
  assert.equal(
    (await calendarOnboardingView(f.store, f.hash, a)).account.id,
    a.id,
  );
  await assert.rejects(
    finishCalendarOnboarding(f.store, f.hash, b, b.id),
    /CALENDAR_ACCOUNT_CHANGED/,
  );
  await assert.rejects(
    finishCalendarOnboarding(f.store, f.hash, a, b.id),
    /CALENDAR_ACCOUNT_CHANGED/,
  );
  await assert.rejects(
    finishCalendarOnboarding(
      f.store,
      f.hash,
      { ...a, emailVerifiedAt: undefined },
      a.id,
    ),
    /CALENDAR_ACCOUNT_CHANGED/,
  );
  assert.equal(
    (await f.store.read(`workspace:${f.draft.workspaceId}`)).value,
    null,
  );
});
test("expired drafts, concurrent saves and changed account versions fail safely without partial ownership", async () => {
  const f = await setup(),
    p = await preview(f),
    a = await account(f);
  await prepareCalendarSave(f.store, f.hash, p.command);
  const settled = await Promise.allSettled([
    finishCalendarOnboarding(f.store, f.hash, a, a.id),
    finishCalendarOnboarding(f.store, f.hash, a, a.id),
  ]);
  assert.equal(
    settled.some((r) => r.status === "fulfilled"),
    true,
  );
  assert.equal(
    (await f.store.read(accountKey(a.email))).value.workspaces.length,
    1,
  );
  assert.equal(
    (await loadWorkspace(f.store, a.id, f.draft.slug)).workspace.bookings
      .length,
    1,
  );
  const saved = await draftForHash(f.store, f.hash);
  await f.store.commit([
    {
      key: draftKey(f.hash),
      before: saved.raw,
      after: { ...saved.value, expiresAt: Date.now() - 1 },
    },
  ]);
  await assert.rejects(
    calendarOnboardingView(f.store, f.hash, a),
    /CALENDAR_PREVIEW_REQUIRED/,
  );
});
