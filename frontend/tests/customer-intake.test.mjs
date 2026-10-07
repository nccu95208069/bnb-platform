import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  submitIntake,
  intakeAnswers,
  intakeMessage,
} from "../src/lib/customer-intake/service.ts";
function fixture() {
  const data = new Map();
  return {
    data,
    read: async (key) => ({
      raw: data.get(key) ?? null,
      value: JSON.parse(data.get(key) ?? "null"),
    }),
    commit: async (changes) => {
      if (changes.some((c) => (data.get(c.key) ?? null) !== c.before))
        throw Error("VERSION_CONFLICT");
      for (const c of changes) data.set(c.key, JSON.stringify(c.after));
    },
    limit: async () => {},
  };
}
const input = (extra = {}) => ({
  requestKey: randomUUID(),
  intent: "consultation",
  propertyName: "Synthetic Inn",
  kind: "mixed",
  rooms: ["101", "102"],
  source: "other",
  sourceDescription: "紙本月曆",
  sheetUrl: "",
  sharingDeclared: false,
  contactName: "Synthetic Owner",
  email: "owner@example.test",
  phone: "LINE synthetic",
  note: "需要資料轉換協助",
  consent: true,
  website: "",
  ...extra,
});
test("consultation persists full context then sends only to fixed operator; same request retries do not resend or leak contact data", async () => {
  const store = fixture(),
    calls = [],
    payload = input({ to: "attacker@example.test" });
  const send = async (m) => {
    calls.push(m);
    assert.equal(
      JSON.parse([...store.data.values()][0]).notification.status,
      "sending",
    );
    return "synthetic-message-id";
  };
  const first = await submitIntake(store, payload, send);
  const repeated = await submitIntake(store, payload, send);
  assert.deepEqual(repeated, first);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, "linlab.ai2024@gmail.com");
  assert.match(calls[0].text, /紙本月曆/);
  assert.match(calls[0].text, /owner@example.test/);
  assert.match(calls[0].text, /101、102/);
  assert.equal(JSON.stringify(first).includes("owner@example.test"), false);
  assert.equal(first.notification, "accepted");
  await assert.rejects(
    submitIntake(store, { ...payload, note: "changed" }, send),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("Sheet join requires questions, a private document link and sharing declaration; never claims verified access or creates workspace", async () => {
  const store = fixture(),
    payload = input({
      intent: "join",
      source: "sheet",
      sheetUrl:
        "https://docs.google.com/spreadsheets/d/synthetic-sheet-id-00000000/edit?usp=sharing#gid=0",
      sharingDeclared: true,
    });
  const result = await submitIntake(store, payload, async () => "message");
  const saved = JSON.parse([...store.data.values()][0]);
  assert.equal(result.status, "awaiting_review");
  assert.equal(saved.sheetAccess, "not_checked");
  assert.equal(
    saved.answers.sheetUrl,
    "https://docs.google.com/spreadsheets/d/synthetic-sheet-id-00000000/edit",
  );
  assert.equal(store.data.size, 1);
  assert.ok([...store.data.keys()][0].startsWith("intake:"));
  for (const change of [
    { sharingDeclared: false },
    { source: "other" },
    { propertyName: "" },
    { kind: "" },
    { rooms: [] },
    {
      sheetUrl: "https://evil.test/spreadsheets/d/synthetic-sheet-id-00000000",
    },
  ])
    assert.throws(
      () => intakeAnswers({ ...payload, ...change }),
      /JOIN_INCOMPLETE|SHEET_LINK_INVALID/,
    );
});
test("consultation works without completed questionnaire and with incomplete pasted link", async () => {
  const payload = input({
    propertyName: "",
    kind: "",
    rooms: [],
    source: "sheet",
    sheetUrl: "docs.google…",
  });
  const answers = intakeAnswers(payload);
  assert.equal(answers.propertyName, null);
  assert.equal(answers.sheetUrl, null);
  assert.equal(answers.providedLink, "docs.google…");
  const message = intakeMessage({
    id: "example",
    createdAt: "synthetic",
    answers,
  });
  assert.match(message.text, /docs.google…/);
});
test("validation and honeypot reject before persistence or mail; recipient cannot be supplied by form", async () => {
  for (const extra of [
    { consent: false },
    { email: "x\r\nBcc:evil@test.invalid" },
    { contactName: "two\nlines" },
    { website: "spam" },
    { requestKey: "guess" },
    { rooms: ["101", "101"] },
  ]) {
    const store = fixture();
    let sends = 0;
    await assert.rejects(
      submitIntake(store, input(extra), async () => {
        sends++;
        return "no";
      }),
      /INVALID_INPUT/,
    );
    assert.equal(store.data.size, 0);
    assert.equal(sends, 0);
  }
});
test("concurrent submission sends once; failed or uncertain provider response retains request without pretending sent", async () => {
  const store = fixture(),
    payload = input();
  let sends = 0;
  const notify = async () => {
    sends++;
    throw Error("provider timeout");
  };
  const result = await Promise.allSettled([
    submitIntake(store, payload, notify),
    submitIntake(store, payload, notify),
  ]);
  assert.equal(sends, 1);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const retry = await submitIntake(store, payload, notify);
  assert.equal(retry.saved, true);
  assert.equal(retry.notification, "pending");
  assert.equal(sends, 1);
  assert.equal(
    JSON.parse([...store.data.values()][0]).notification.status,
    "needs_attention",
  );
});
test("lost reply after provider accepted cannot send another notification", async () => {
  const store = fixture(),
    commit = store.commit,
    payload = input();
  let sends = 0;
  store.commit = async (changes) => {
    await commit(changes);
    if (changes[0].after.notification.status === "accepted")
      throw Error("lost write reply");
  };
  await assert.rejects(
    submitIntake(store, payload, async () => {
      sends++;
      return "accepted-id";
    }),
    /lost write reply/,
  );
  const retry = await submitIntake(store, payload, async () => {
    sends++;
    return "duplicate";
  });
  assert.equal(retry.notification, "accepted");
  assert.equal(sends, 1);
});
