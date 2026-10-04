import test from "node:test";
import assert from "node:assert/strict";
import XLSX from "xlsx";
import {
  tablesFromMatrices,
  parseFile,
} from "../../src/lib/order-health/parser.ts";
import {
  analyze,
  questions,
  dateValue,
} from "../../src/lib/order-health/engine.ts";
import {
  createJob,
  answer,
  start,
  run,
  status,
  seal,
  unseal,
  reportFor,
  removeSource,
  retryConnection,
  runPending,
} from "../../src/lib/order-health/service.ts";
import type {
  CustomerStore,
  Change,
} from "../../src/lib/customer-workspaces/store.ts";
import type { Scope, Job } from "../../src/lib/order-health/types.ts";
process.env.ORDER_HEALTH_ENCRYPTION_KEY =
  "synthetic-local-test-key-never-used-in-production";
delete process.env.GEMINI_API_KEY;
const headers = [
  "訂單編號",
  "入住日期",
  "退房日期",
  "房號",
  "房數",
  "金額",
  "平台",
  "狀態",
  "預訂日期",
  "姓名",
  "電話",
];
const row = (
  id = "a",
  start = "2026-01-31",
  end = "2026-02-02",
  money = "6000",
  status = "已確認",
) => [
  id,
  start,
  end,
  "101",
  "1",
  money,
  "官網",
  status,
  "2026-01-01",
  "synthetic guest",
  "0912345678",
];
const tables = (rows: string[][]) =>
  tablesFromMatrices([{ title: "訂單", matrix: [headers, ...rows] }]);
const job = (
  rows: string[][],
  answers: Job["answers"] = { unit: "stay", money: "total", booked: "yes" },
) => ({
  id: "a".repeat(32),
  sourceHash: "sample",
  sourceTitle: "synthetic",
  tables: tables(rows),
  answers,
});
test("CSV, xlsx and xls parse without retaining guest columns", async () => {
  for (const ext of ["csv", "xlsx", "xls"] as const) {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([headers, row()]),
      "訂單",
    );
    const bytes = XLSX.write(wb, {
      type: "buffer",
      bookType: ext === "xls" ? "biff8" : ext,
    });
    const ts = await parseFile(bytes, `synthetic.${ext}`);
    assert.equal(ts.length, 1);
    assert.equal(ts[0].rows.length, 1);
    assert.equal(ts[0].rows[0].cells[9], "");
    assert.equal(ts[0].headers[9], "[個資欄位]");
    assert.ok(!JSON.stringify(ts).includes("0912345678"));
  }
});
test("cross-month stays exclude checkout and allocate total accurately", () => {
  const r = analyze(job([row()]));
  assert.equal(r.nights, 2);
  assert.equal(r.amount, 6000);
  assert.equal(r.adr, 3000);
  assert.deepEqual(
    r.monthly.map((m) => [m.month, m.amount]),
    [
      ["2026-01", 3000],
      ["2026-02", 3000],
    ],
  );
  assert.equal(r.lead.median, 30);
  assert.equal(r.occupancy, null);
});
test("cancelled and unknown states are quarantined", () => {
  const r = analyze(
    job([
      row(),
      row("b", "2026-02-03", "2026-02-04", "900", "取消"),
      row("c", "2026-02-03", "2026-02-04", "900", "待確認"),
    ]),
  );
  assert.equal(r.includedRows, 1);
  assert.equal(r.excluded.length, 2);
});
test("zero remains a roomnight and is excluded from ADR denominator", () => {
  const r = analyze(job([row(), row("b", "2026-02-03", "2026-02-04", "0")]));
  assert.equal(r.nights, 3);
  assert.equal(r.amount, 6000);
  assert.equal(r.adr, 3000);
});
test("unknown money preserves roomnights without inventing amount", () => {
  const r = analyze(job([row()], { unit: "stay", money: "skip" }));
  assert.equal(r.nights, 2);
  assert.equal(r.amount, null);
  assert.equal(r.adr, null);
  assert.equal(r.unknownAmountNights, 2);
});
test("repeated order IDs quarantine the entire group", () => {
  const r = analyze(
    job([
      row(),
      row("a", "2026-02-02", "2026-02-03"),
      row("b", "2026-02-04", "2026-02-05", "800"),
    ]),
  );
  assert.equal(r.includedRows, 1);
  assert.equal(r.excluded.length, 2);
  assert.equal(r.amount, 800);
});
test("unidentified exact duplicates are quarantined", () => {
  assert.throws(() => analyze(job([row(""), row("")])), /HEALTH_EMPTY/);
});
test("multiroom total is not multiplied twice", () => {
  const data = row();
  data[4] = "3";
  const r = analyze(job([data], { unit: "multi", money: "total" }));
  assert.equal(r.nights, 6);
  assert.equal(r.amount, 6000);
  assert.equal(r.adr, 1000);
  const n = analyze(job([data], { unit: "multi", money: "night" }));
  assert.equal(n.amount, 36000);
});
test("unsupported villa and inconsistent nights do not get guessed", () => {
  const data = row();
  data[3] = "包棟";
  assert.throws(() => analyze(job([data])), /HEALTH_EMPTY/);
  assert.throws(
    () => analyze(job([row("a", "2026-01-31", "2026-01-30")])),
    /HEALTH_EMPTY/,
  );
});
test("mixed currency disables money for whole report", () => {
  const j = job([row()]);
  j.tables = tablesFromMatrices([
    {
      title: "訂單",
      matrix: [
        [...headers, "幣別"],
        [...row(), "USD"],
      ],
    },
  ]);
  assert.equal(analyze(j).amount, null);
});
test("date ambiguity and invalid calendar dates fail closed", () => {
  assert.equal(dateValue("03/04/2026", undefined), null);
  assert.equal(dateValue("03/04/2026", "dmy"), "2026-04-03");
  assert.equal(dateValue("03/04/2026", "mdy"), "2026-03-04");
  assert.equal(dateValue("2026-02-31", undefined), null);
  assert.equal(dateValue("115/01/31", undefined), "2026-01-31");
});
test("table selection counts toward cumulative five and does not mix summary sheets", () => {
  const t = tablesFromMatrices([
    { title: "明細", matrix: [headers, row()] },
    { title: "摘要", matrix: [headers, row()] },
  ]);
  const j = {
    tables: t,
    answers: {} as Record<string, string>,
    questions: [] as Job["questions"],
  };
  j.questions = questions(j);
  assert.equal(j.questions.length, 1);
  assert.equal(j.questions[0].id, "table");
  j.answers.table = "0";
  j.questions = questions(j);
  assert.ok(j.questions.length <= 5);
  const original = JSON.stringify(j.questions);
  j.answers.unit = "stay";
  assert.equal(JSON.stringify(questions(j)), original);
  assert.equal(
    analyze({
      ...job([row()]),
      tables: t,
      answers: { table: "0", unit: "stay", money: "total" },
    }).nights,
    2,
  );
});
test("five question budget degrades lower-priority metrics without sixth question", () => {
  const t = tablesFromMatrices([
    {
      title: "A",
      matrix: [
        ["入住日期", "退房日期", "金額", "館別", "預訂日期"],
        ["03/04/2026", "04/04/2026", "100", "旅宿甲", "01/02/2026"],
      ],
    },
    { title: "B", matrix: [headers, row()] },
  ]);
  const j = {
    tables: t,
    answers: { table: "0" },
    questions: [{ id: "table", title: "table", note: "", options: [] }],
  } as Pick<Job, "tables" | "answers" | "questions">;
  j.questions = questions(j);
  assert.equal(j.questions.length, 5);
  assert.ok(!j.questions.some((q) => q.id === "money"));
  assert.ok(!j.questions.some((q) => q.id === "booked"));
});
test("tiny broken ZIP and oversized input rejected", async () => {
  await assert.rejects(
    parseFile(Buffer.from("P"), "bad.xlsx"),
    /HEALTH_FORMAT/,
  );
  await assert.rejects(
    parseFile(Buffer.alloc(3000001), "big.csv"),
    /HEALTH_SIZE/,
  );
});
class Memory implements CustomerStore {
  data = new Map<string, string>();
  async read<T>(k: string) {
    const raw = this.data.get(k) ?? null;
    return { raw, value: raw ? (JSON.parse(raw) as T) : null };
  }
  async commit(cs: Change[]) {
    for (const c of cs)
      assert.equal(this.data.get(c.key) ?? null, c.before, "CAS");
    for (const c of cs) this.data.set(c.key, JSON.stringify(c.after));
  }
  async limit() {}
}
const scope: Scope = {
  workspace: "synthetic-a",
  property: "p1",
  actor: "a1",
  name: "測試旅宿",
  canWrite: true,
};
test("persistent workflow survives refresh, idempotency and parallel workers", async () => {
  const store = new Memory(),
    input = {
      requestId: "synthetic-request-0001",
      title: "synthetic.csv",
      tables: tables([row()]),
    };
  const j = await createJob(store, scope, input);
  assert.equal((await createJob(store, scope, input)).id, j.id);
  await Promise.all([run(store, scope, j.id), run(store, scope, j.id)]);
  const current = (await status(store, scope, j.id)).job!;
  assert.equal(current.state, "confirm");
  const ready = await answer(
    store,
    scope,
    j.id,
    { unit: "stay", money: "total", booked: "yes" },
    current.version,
  );
  assert.equal(ready.state, "ready");
  const running = await start(store, scope, j.id, ready.version);
  assert.equal(running.state, "analyzing");
  await run(store, scope, j.id);
  const done = await status(store, scope);
  assert.equal(done.latest?.nights, 2);
  assert.equal(
    (await reportFor(store, scope, j.id)).snapshot,
    done.latest?.snapshot,
  );
  assert.ok([...store.data.values()].every((v) => !v.includes("6000")));
  await removeSource(store, scope, j.id);
  assert.equal((await status(store, scope)).job, null);
  assert.equal((await status(store, scope)).latest?.nights, 2);
});
test("cross-scope reads, viewer writes, unknown answers and repeated request mutation rejected", async () => {
  const store = new Memory(),
    input = {
      requestId: "synthetic-request-0002",
      title: "s",
      tables: tables([row()]),
    },
    j = await createJob(store, scope, input);
  await assert.rejects(
    status(store, { ...scope, workspace: "other" }, j.id),
    /HEALTH_EXPIRED/,
  );
  await assert.rejects(
    createJob(store, { ...scope, canWrite: false }, input),
    /FORBIDDEN/,
  );
  await assert.rejects(
    createJob(store, scope, { ...input, title: "changed" }),
    /IDEMPOTENCY_CONFLICT/,
  );
  await run(store, scope, j.id);
  const current = (await status(store, scope, j.id)).job!;
  await assert.rejects(
    answer(store, scope, j.id, { sixth: "yes" }, current.version),
    /INVALID_INPUT/,
  );
});
test("encrypted data authenticates tampering", () => {
  const encrypted = seal({ value: "private" });
  assert.deepEqual(unseal(encrypted), { value: "private" });
  assert.throws(() => unseal(encrypted.slice(0, -4) + "AAAA"));
});

test("different active orders overlapping a physical room are isolated", () => {
  const r = analyze(
    job([
      row("a", "2026-01-01", "2026-01-03"),
      row("b", "2026-01-02", "2026-01-04"),
      row("c", "2026-01-05", "2026-01-06", "2000"),
    ]),
  );
  assert.equal(r.includedRows, 1);
  assert.equal(r.excluded.length, 2);
  assert.ok(r.excluded.every((e) => e.reason.includes("重疊")));
});
test("settings revision leaves previous report immutable and chat scoped", async () => {
  const { revise, saveChat, chatHistory } =
    await import("../../src/lib/order-health/service.ts");
  const store = new Memory(),
    j = await createJob(store, scope, {
      requestId: "synthetic-revision-original",
      title: "s",
      tables: tables([row()]),
    });
  await run(store, scope, j.id);
  let current = (await status(store, scope, j.id)).job!;
  current = await answer(
    store,
    scope,
    j.id,
    { unit: "stay", money: "total", booked: "yes" },
    current.version,
  );
  await start(store, scope, j.id, current.version);
  await run(store, scope, j.id);
  const before = await reportFor(store, scope, j.id);
  await saveChat(store, scope, j.id, {
    question: "房晚？",
    answer: "2 房晚",
    facts: before.facts,
    snapshot: before.snapshot,
    createdAt: new Date().toISOString(),
    mode: "rules",
  });
  assert.equal((await chatHistory(store, scope, j.id)).length, 1);
  assert.equal(
    (await chatHistory(store, { ...scope, actor: "other" }, j.id)).length,
    0,
  );
  const revised = await revise(
    store,
    scope,
    j.id,
    "synthetic-revision-request",
  );
  assert.equal(revised.questions.length, current.questions.length);
  const changed = await answer(
    store,
    scope,
    revised.id,
    { money: "none" },
    revised.version,
  );
  await start(store, scope, changed.id, changed.version);
  await run(store, scope, changed.id);
  assert.equal((await reportFor(store, scope, changed.id)).amount, null);
  assert.equal((await reportFor(store, scope, j.id)).amount, 6000);
  assert.equal((await reportFor(store, scope, j.id)).snapshot, before.snapshot);
});
test("actual customer sessions enforce active role, workspace and property scope", async () => {
  const { access } = await import("../../src/lib/order-health/access.ts");
  const { sessionFor, digest } =
    await import("../../src/lib/customer-workspaces/auth.ts");
  process.env.CUSTOMER_WORKSPACES_ENABLED = "true";
  process.env.CUSTOMER_SESSION_SECRET =
    "synthetic-local-session-secret-over-thirty-two";
  const store = new Memory(),
    account = {
      id: "00000000-0000-4000-8000-000000000123",
      email: "scope@example.test",
      credential: {
        schema: 1,
        kind: "passwordless",
        revision: "test-revision",
      },
      workspaces: [],
    } as import("../../src/lib/customer-workspaces/types.ts").Account;
  store.data.set(`account:${digest(account.email)}`, JSON.stringify(account));
  store.data.set("slug:scope-test", JSON.stringify("w1"));
  const ws = {
    id: "w1",
    slug: "scope-test",
    members: [
      {
        accountId: account.id,
        role: "owner",
        active: true,
        allProperties: false,
        propertyIds: ["p1"],
      },
    ],
    properties: [
      { id: "p1", name: "P1" },
      { id: "p2", name: "P2" },
    ],
  };
  store.data.set("workspace:w1", JSON.stringify(ws));
  const req = { cookies: { get: () => ({ value: sessionFor(account) }) } };
  assert.equal((await access(store, req, "scope-test", "p1")).canWrite, true);
  await assert.rejects(access(store, req, "scope-test", "p2"), /FORBIDDEN/);
  await assert.rejects(access(store, req, "other-test", "p1"), /NOT_FOUND/);
  for (const role of ["housekeeper", "viewer_no_price"]) {
    ws.members[0].role = role;
    store.data.set("workspace:w1", JSON.stringify(ws));
    await assert.rejects(access(store, req, "scope-test", "p1"), /FORBIDDEN/);
  }
  ws.members[0].role = "viewer";
  store.data.set("workspace:w1", JSON.stringify(ws));
  assert.equal((await access(store, req, "scope-test", "p1")).canWrite, false);
  ws.members[0].active = false;
  store.data.set("workspace:w1", JSON.stringify(ws));
  await assert.rejects(access(store, req, "scope-test", "p1"));
  await assert.rejects(
    access(store, { cookies: { get: () => undefined } }, "scope-test", "p1"),
    /UNAUTHORIZED/,
  );
});

test("fallback chat answers requested period and rejects unsupported predictions", async () => {
  const { chat } = await import("../../src/lib/order-health/chat.ts");
  const r = analyze(job([row()]));
  const answer = await chat(r, "2026-02 有多少房晚？", "overview");
  assert.equal(answer.facts.length, 1);
  assert.equal(answer.facts[0].value, 1);
  assert.ok(answer.facts[0].refs.length);
  assert.equal(
    (await chat(r, "明年房晚會增加嗎？", "overview")).facts.length,
    0,
  );
  assert.equal(
    (await chat(r, "2026-03 有多少房晚？", "overview")).facts.length,
    0,
  );
});
test("Google reader uses read-only scope and rejects revoked sharing", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.CUSTOMER_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "synthetic@synthetic.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const { readGoogle } = await import("../../src/lib/order-health/google.ts");
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls++;
      if (url === "https://oauth2.googleapis.com/token") {
        const assertion = (init?.body as URLSearchParams).get("assertion")!;
        const claim = JSON.parse(
          Buffer.from(assertion.split(".")[1], "base64url").toString(),
        );
        assert.equal(
          claim.scope,
          "https://www.googleapis.com/auth/spreadsheets.readonly",
        );
        return Response.json({ access_token: "synthetic-token" });
      }
      assert.ok(
        url.startsWith("https://sheets.googleapis.com/v4/spreadsheets/"),
      );
      assert.equal(init?.cache, "no-store");
      if (url.includes("/values:batchGet"))
        return Response.json({ valueRanges: [{ values: [headers, row()] }] });
      return Response.json({
        properties: { title: "合成 Google Sheet" },
        sheets: [
          {
            properties: {
              title: "訂單",
              gridProperties: { rowCount: 10, columnCount: 11 },
            },
          },
        ],
      });
    };
    const result = await readGoogle(
      "https://docs.google.com/spreadsheets/d/synthetic-spreadsheet-123456789/edit",
    );
    assert.equal(result.tables[0].rows.length, 1);
    assert.equal(calls, 3);
    globalThis.fetch = async (input) => String(input).includes("oauth2.googleapis.com")
      ? Response.json({ access_token: "synthetic-token" })
      : new Response("{}", { status: 403 });
    await assert.rejects(
      readGoogle("synthetic-spreadsheet-123456789"),
      /SHEET_NOT_SHARED/,
    );
  } finally {
    globalThis.fetch = original;
    delete process.env.CUSTOMER_SHEET_READER_CREDENTIALS;
  }
});

test("permission worker waits without using read retries, then cron advances automatically", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.ORDER_HEALTH_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "worker@synthetic.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const fetchBefore = globalThis.fetch, nowBefore = Date.now;
  let now = nowBefore(), shared = false, sheetReads = 0;
  try {
    Date.now = () => now;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "synthetic-token" });
      sheetReads++;
      if (!shared) return Response.json({ error: { code: 403 } }, { status: 403 });
      if (url.includes("values:batchGet")) return Response.json({ valueRanges: [{ values: [headers, row()] }] });
      return Response.json({ spreadsheetId: "synthetic-spreadsheet-123456789", properties: { title: "Private orders" },
        sheets: [{ properties: { title: "訂單", gridProperties: { rowCount: 10, columnCount: 11 } } }] });
    };
    const store = new Memory();
    const created = await createJob(store, scope, { requestId: "permission-worker-request", title: "Google 試算表", url: "synthetic-spreadsheet-123456789" });
    assert.equal(created.state, "checking_access");
    await runPending(store, async () => true);
    let current = (await status(store, scope)).job!;
    assert.equal(current.state, "awaiting_share");
    assert.equal(current.error, null);
    assert.equal(current.connection?.checks, 1);
    assert.equal(sheetReads, 1);
    await runPending(store, async () => true);
    assert.equal(sheetReads, 1, "throttled until next check");
    for (let i = 0; i < 4; i++) { now += 10001; await runPending(store, async () => true); }
    assert.equal((await status(store, scope)).job?.state, "awaiting_share", "waiting does not consume 3 processing retries");
    shared = true; now += 10001;
    await runPending(store, async () => true);
    current = (await status(store, scope)).job!;
    assert.equal(current.state, "confirm");
    assert.equal(current.connection?.status, "connected");
    assert.equal(current.sourceTitle, "Private orders");
    assert.equal(current.summary[0].rows, 1);
    assert.deepEqual(unseal(JSON.parse(store.data.get("health:pending")!)), []);
  } finally { globalThis.fetch = fetchBefore; Date.now = nowBefore; delete process.env.ORDER_HEALTH_SHEET_READER_CREDENTIALS; }
});

test("share timeout is resumable and worker revalidates revoked actor access", async () => {
  const nowBefore = Date.now;
  try {
    let now = nowBefore(); Date.now = () => now;
    const store = new Memory();
    const created = await createJob(store, scope, { requestId: "permission-timeout-request", title: "Google 試算表", url: "synthetic-spreadsheet-123456789" });
    now += 15 * 60000 + 1;
    await runPending(store, async () => true);
    const paused = (await status(store, scope)).job!;
    assert.equal(paused.state, "blocked");
    assert.equal(paused.connection?.status, "paused");
    assert.equal(paused.error, "HEALTH_SHARE_TIMEOUT");
    const resumed = await retryConnection(store, scope, created.id);
    assert.equal(resumed.state, "checking_access");
    assert.ok(resumed.connection!.retryUntil > now);
    await runPending(store, async () => false);
    assert.equal((await status(store, scope)).job?.error, "FORBIDDEN");
    await assert.rejects(retryConnection(store, { ...scope, canWrite: false }, created.id), /FORBIDDEN/);
  } finally { Date.now = nowBefore; }
});

test("Google API configuration errors are not presented as missing Sheet sharing", async () => {
  const { generateKeyPairSync } = await import("node:crypto");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  process.env.ORDER_HEALTH_SHEET_READER_CREDENTIALS = JSON.stringify({
    client_email: "worker@synthetic.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
  });
  const original = globalThis.fetch;
  try {
    const { checkGoogleAccess } = await import("../../src/lib/order-health/google.ts");
    globalThis.fetch = async (input) => String(input).includes("oauth2.googleapis.com")
      ? Response.json({ access_token: "synthetic" })
      : Response.json({ error: { details: [{ reason: "SERVICE_DISABLED" }] } }, { status: 403 });
    await assert.rejects(checkGoogleAccess("synthetic-spreadsheet-123456789"), /SHEET_READ_FAILED/);
  } finally { globalThis.fetch = original; delete process.env.ORDER_HEALTH_SHEET_READER_CREDENTIALS; }
});

test("compatible worksheets merge only by explicit selection and retain sheet evidence", () => {
  const a = tables([row("a", "2026-01-01", "2026-01-02")])[0],
    b = {
      ...tables([row("b", "2026-02-01", "2026-02-02")])[0],
      id: "1",
      title: "二月",
    };
  const j = {
    ...job([]),
    tables: [a, b],
    answers: { table: "all", unit: "stay", money: "total" },
  };
  const r = analyze(j);
  assert.equal(r.nights, 2);
  assert.ok(r.facts[0].refs.includes("二月!2"));
  assert.ok(
    questions({ ...j, answers: {}, questions: [] })[0].options.some(
      (o) => o.value === "all",
    ),
  );
});
