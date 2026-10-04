import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Change, CustomerStore } from "../customer-workspaces/store.ts";
import type { Job, Scope, Table, Answers, Report, Field } from "./types.ts";
import { questions, analyze } from "./engine.ts";
import { recognize } from "./ai.ts";
import { checkGoogleAccess, readGoogle } from "./google.ts";
import { spreadsheetId } from "../customer-workspaces/customer-google.ts";
export const digest = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const root = (s: Scope) => `health:${digest([s.workspace, s.property])}`;
const QUEUE = "health:pending";
type Pending = { scope: Scope; id: string; expiresAt: string; version: number };
const backgroundStates = ["checking_access", "awaiting_share", "reading", "analyzing"];
function key() {
  const secret =
    process.env.ORDER_HEALTH_ENCRYPTION_KEY ||
    process.env.CUSTOMER_SESSION_SECRET ||
    process.env.CALENDAR_OWNER_SESSION_SECRET;
  if (!secret || secret.length < 32) throw Error("HEALTH_UNAVAILABLE");
  return createHash("sha256").update(`order-health:v1:${secret}`).digest();
}
export function seal(value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(), iv),
    body = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
  return [iv, cipher.getAuthTag(), body]
    .map((b) => b.toString("base64url"))
    .join(".");
}
export function unseal<T>(value: string): T {
  const [iv, tag, body] = value
    .split(".")
    .map((s) => Buffer.from(s, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", key(), iv);
  cipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([cipher.update(body), cipher.final()]).toString(),
  ) as T;
}
export function configured() {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}
async function read<T>(store: CustomerStore, k: string) {
  const v = await store.read<string>(k);
  return { raw: v.raw, value: v.value ? unseal<T>(v.value) : null };
}
const jobKey = (s: Scope, id: string) => {
  if (!/^[a-f0-9]{32}$/.test(id)) throw Error("NOT_FOUND");
  return `${root(s)}:job:${id}`;
};
async function load(store: CustomerStore, s: Scope, id: string) {
  const v = await read<Job & { sourceUrl?: string }>(store, jobKey(s, id));
  if (
    !v.value ||
    v.value.workspace !== s.workspace ||
    v.value.property !== s.property ||
    Date.parse(v.value.expiresAt) < Date.now()
  )
    throw Error("HEALTH_EXPIRED");
  return v as { raw: string; value: Job & { sourceUrl?: string } };
}
async function save(
  store: CustomerStore,
  s: Scope,
  job: Job,
  before: string | null,
) {
  await store.commit([
    {
      key: jobKey(s, job.id),
      before,
      after: seal(job),
      ttlSeconds: Math.max(
        1,
        Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1000),
      ),
    },
  ]);
}
export function publicJob(job: Job) {
  let preview = null;
  if (job.state === "ready") {
    try {
      const r = analyze(job);
      preview = {
        includedRows: r.includedRows,
        excluded: r.excluded.length,
        nights: r.nights,
        money: r.amount !== null,
      };
    } catch (e) {
      preview = {
        includedRows: 0,
        excluded: 0,
        nights: 0,
        money: false,
        error: e instanceof Error ? e.message : "HEALTH_EMPTY",
      };
    }
  }
  return {
    preview,
    id: job.id,
    state: job.state,
    version: job.version,
    createdAt: job.createdAt,
    expiresAt: job.expiresAt,
    sourceTitle: job.sourceTitle,
    mappingMode: job.mappingMode,
    sourceKind: job.sourceKind,
    connection: job.connection ?? null,
    sheetUrl: job.sourceKind === "sheet" && "sourceUrl" in job && typeof job.sourceUrl === "string"
      ? `https://docs.google.com/spreadsheets/d/${spreadsheetId(job.sourceUrl)}/edit`
      : null,
    questions: job.questions,
    answers: job.answers,
    error: job.error,
    report: job.report,
    summary: job.tables.map((t) => ({
      id: t.id,
      title: t.title,
      rows: t.rows.length,
      fields: Object.keys(t.mapping),
      samples: t.rows.slice(0, 3).map((r) => ({
        row: r.row,
        values: (
          [
            "checkIn",
            "checkOut",
            "nights",
            "roomCount",
            "amount",
            "status",
          ] as Field[]
        )
          .filter((f) => t.mapping[f] !== undefined)
          .map((f) => ({
            label: t.headers[t.mapping[f]!],
            value: r.cells[t.mapping[f]!] || "—",
          })),
      })),
    })),
  };
}
export async function createJob(
  store: CustomerStore,
  s: Scope,
  input: { requestId: string; title: string; tables?: Table[]; url?: string },
) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  if (!/^[\w-]{16,80}$/.test(input.requestId)) throw Error("INVALID_INPUT");
  const id = digest([s.actor, input.requestId]).slice(0, 32),
    k = jobKey(s, id),
    prior = await read<Job>(store, k),
    requestHash = digest(input);
  if (prior.value) {
    if (prior.value.requestHash !== requestHash)
      throw Error("IDEMPOTENCY_CONFLICT");
    return publicJob(prior.value);
  }
  await store.limit(`health-create:${s.workspace}:${s.actor}`, 12);
  const now = new Date(),
    job: Job & { sourceUrl?: string } = {
      id,
      workspace: s.workspace,
      property: s.property,
      actor: s.actor,
      propertyName: s.name,
      createdAt: now.toISOString(),
      expiresAt: new Date(+now + 86400000).toISOString(),
      version: 1,
      requestHash,
      sourceTitle: input.title.slice(0, 100),
      sourceHash: digest(input.tables ?? input.url),
      sourceKind: input.url ? "sheet" : "file",
      sourceUrl: input.url,
      state: input.url ? "checking_access" : "reading",
      tables: input.tables ?? [],
      questions: [],
      answers: {},
      mappingMode: "pending",
      selected: null,
      report: null,
      error: null,
      leaseUntil: 0,
      attempts: 0,
      ...(input.url ? { connection: {
        status: "checking" as const,
        checkedAt: null,
        nextCheckAt: 0,
        retryUntil: +now + 15 * 60000,
        checks: 0,
      } } : {}),
      usage: { input: 0, output: 0 },
    };
  const active = await read<{ id: string }>(store, `${root(s)}:active`);
  await store.commit([
    await queueChange(store, s, job),
    { key: k, before: null, after: seal(job), ttlSeconds: 86400 },
    {
      key: `${root(s)}:active`,
      before: active.raw,
      after: seal({ id }),
      ttlSeconds: 86400,
    },
  ]);
  return publicJob(job);
}
async function queueChange(store: CustomerStore, s: Scope, job: Job): Promise<Change> {
  const saved = await read<Pending[]>(store, QUEUE);
  const pending = (saved.value ?? []).filter((p) =>
    Date.parse(p.expiresAt) > Date.now() && root(p.scope) !== root(s),
  );
  if (pending.length >= 500) throw Error("HEALTH_QUEUE_FULL");
  return {
    key: QUEUE,
    before: saved.raw,
    after: seal([...pending, { scope: s, id: job.id, expiresAt: job.expiresAt, version: job.version }]),
  };
}
export async function runPending(
  store: CustomerStore,
  authorize: (scope: Scope) => Promise<boolean>,
) {
  const snapshot = await read<Pending[]>(store, QUEUE);
  const pending = snapshot.value ?? [];
  const finished = new Set<string>();
  const deadline = Date.now() + 220000;
  let processed = 0;
  // A job lease and compare-and-swap protect against overlapping cron and UI
  // requests. Stored actor permission is checked again before background work.
  for (const target of pending) {
    if (Date.now() > deadline - 65000) break;
    const key = `${root(target.scope)}:${target.id}:${target.version}`;
    if (Date.parse(target.expiresAt) <= Date.now()) { finished.add(key); continue; }
    try {
      const saved = await load(store, target.scope, target.id);
      if (!backgroundStates.includes(saved.value.state)) { finished.add(key); continue; }
      if (!(await authorize(target.scope))) {
        saved.value.state = "blocked";
        saved.value.error = "FORBIDDEN";
        saved.value.version++;
        await save(store, target.scope, saved.value, saved.raw);
        finished.add(key); continue;
      }
      await run(store, target.scope, target.id);
      // A successful permission check advances to data reading immediately.
      await run(store, target.scope, target.id);
      processed++;
      if (!backgroundStates.includes((await load(store, target.scope, target.id)).value.state))
        finished.add(key);
    } catch (error) {
      if (error instanceof Error && error.message === "HEALTH_EXPIRED") finished.add(key);
    }
  }
  if (finished.size) {
    const current = await read<Pending[]>(store, QUEUE);
    try {
      await store.commit([{ key: QUEUE, before: current.raw, after: seal(
        (current.value ?? []).filter((p) => !finished.has(`${root(p.scope)}:${p.id}:${p.version}`)),
      ) }]);
    } catch { /* A concurrent enqueue wins; finished entries can be pruned next run. */ }
  }
  return { processed };
}
export async function retryConnection(store: CustomerStore, s: Scope, id: string) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  const { value: job, raw } = await load(store, s, id);
  if (job.sourceKind !== "sheet" || !job.connection) throw Error("INVALID_INPUT");
  if (job.state === "checking_access" || job.leaseUntil > Date.now()) return publicJob(job);
  if (job.state !== "awaiting_share" && !(job.state === "blocked" &&
      ["SHEET_NOT_SHARED", "SHEET_READ_FAILED", "HEALTH_SHARE_TIMEOUT"].includes(job.error ?? "")))
    throw Error("VERSION_CONFLICT");
  job.state = "checking_access";
  job.error = null;
  job.connection = { ...job.connection, status: "checking", nextCheckAt: 0, retryUntil: Date.now() + 15 * 60000 };
  job.version++;
  await store.commit([
    { key: jobKey(s, id), before: raw, after: seal(job), ttlSeconds: Math.max(1, Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1000)) },
    await queueChange(store, s, job),
  ]);
  return publicJob(job);
}
export async function status(store: CustomerStore, s: Scope, id?: string) {
  const latest = (await read<Report>(store, `${root(s)}:latest`)).value;
  const active =
    id ?? (await read<{ id: string }>(store, `${root(s)}:active`)).value?.id;
  let job: Job | null = null;
  if (active) {
    try {
      job = (await load(store, s, active)).value;
    } catch (e) {
      if (id) throw e;
    }
  }
  return { job: job ? publicJob(job) : null, latest };
}
export async function answer(
  store: CustomerStore,
  s: Scope,
  id: string,
  answers: Answers,
  version: number,
) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  const { value: job, raw } = await load(store, s, id);
  if (
    !["confirm", "ready", "blocked"].includes(job.state) ||
    job.version !== version
  )
    throw Error("VERSION_CONFLICT");
  if (!answers || typeof answers !== "object" || Array.isArray(answers))
    throw Error("INVALID_INPUT");
  for (const [k, v] of Object.entries(answers)) {
    const q = job.questions.find((q) => q.id === k);
    if (!q || !q.options.some((o) => o.value === v))
      throw Error("INVALID_INPUT");
  }
  // Changing the table after questions were issued would invalidate their meanings. Start a new import instead.
  if (job.answers.table && answers.table && answers.table !== job.answers.table)
    throw Error("HEALTH_TABLE_LOCKED");
  job.answers = { ...job.answers, ...answers };
  job.questions = questions(job);
  if (job.questions.length > 5) throw Error("HEALTH_QUESTIONS");
  job.state = job.questions.every((q) => job.answers[q.id])
    ? "ready"
    : "confirm";
  job.version++;
  job.error = null;
  await save(store, s, job, raw);
  return publicJob(job);
}
export async function start(
  store: CustomerStore,
  s: Scope,
  id: string,
  version: number,
) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  const { value: job, raw } = await load(store, s, id);
  if (["analyzing", "complete"].includes(job.state)) return publicJob(job);
  if (job.state !== "ready" || job.version !== version)
    throw Error("VERSION_CONFLICT");
  job.state = "analyzing";
  job.leaseUntil = 0;
  job.attempts = 0;
  job.version++;
  await store.commit([
    { key: jobKey(s, id), before: raw, after: seal(job), ttlSeconds: Math.max(1, Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1000)) },
    await queueChange(store, s, job),
  ]);
  return publicJob(job);
}
export async function run(store: CustomerStore, s: Scope, id: string) {
  let entry;
  try {
    entry = await load(store, s, id);
  } catch {
    return;
  }
  const job = entry.value;
  if (
    !backgroundStates.includes(job.state) ||
    job.leaseUntil > Date.now() ||
    ((job.state === "awaiting_share" || job.state === "checking_access") &&
      (job.connection?.nextCheckAt ?? 0) > Date.now())
  )
    return;
  const active = await read<{ id: string }>(store, `${root(s)}:active`);
  if (active.value?.id !== id) return;
  job.leaseUntil = Date.now() + 90000;
  const checking = job.state === "checking_access" || job.state === "awaiting_share";
  if (!checking) job.attempts++;
  job.version++;
  try {
    await save(store, s, job, entry.raw);
  } catch {
    return;
  }
  const locked = await load(store, s, id);
  if (locked.value.version !== job.version) return;
  try {
    if (checking) {
      if (!job.connection || job.connection.retryUntil <= Date.now()) {
        if (job.connection) job.connection.status = "paused";
        throw Error("HEALTH_SHARE_TIMEOUT");
      }
      const binding = await read<{ workspace: string }>(store, `health:source:${digest(spreadsheetId(job.sourceUrl!))}`);
      if (binding.value && binding.value.workspace !== s.workspace) throw Error("HEALTH_SOURCE_BOUND");
      job.connection.checks++;
      job.connection.checkedAt = new Date().toISOString();
      const connected = await checkGoogleAccess(job.sourceUrl!);
      job.connection.status = "connected";
      job.connection.nextCheckAt = 0;
      job.sourceTitle = connected.title;
      job.state = "reading";
      job.attempts = 0;
    } else if (job.attempts > 3) throw Error("HEALTH_RETRIES");
    else if (job.state === "reading") {
      if (job.sourceKind === "sheet") {
        const bindingKey = `health:source:${digest(spreadsheetId(job.sourceUrl!))}`;
        const binding = await read<{ workspace: string }>(store, bindingKey);
        if (binding.value && binding.value.workspace !== s.workspace)
          throw Error("HEALTH_SOURCE_BOUND");
        const result = await readGoogle(job.sourceUrl!);
        if (!binding.value)
          await store.commit([
            {
              key: bindingKey,
              before: null,
              after: seal({ workspace: s.workspace }),
            },
          ]);
        job.tables = result.tables;
        job.sourceTitle = result.title;
        job.sourceHash = digest(job.tables);
      }
      if (!job.tables.length) throw Error("HEALTH_HEADERS");
      try {
        const result = await recognize(job.tables);
        job.tables = result.tables;
        job.mappingMode = result.mode;
        job.usage = result.usage;
      } catch {
        job.mappingMode = "rules";
      }
      job.questions = questions(job);
      job.state = job.questions.length ? "confirm" : "blocked";
      if (!job.questions.length) job.error = "HEALTH_HEADERS";
    } else {
      job.report = analyze(job);
      job.state = "complete";
    }
    job.error = job.state === "blocked" ? job.error : null;
  } catch (e) {
    const code = e instanceof Error ? e.message : "HEALTH_FAILED";
    if (code === "SHEET_NOT_SHARED" && job.connection) {
      job.state = "awaiting_share";
      job.connection.status = "waiting";
      job.connection.nextCheckAt = Date.now() + 10000;
      job.error = null;
    } else {
      job.state = "blocked";
      if (job.connection && job.connection.status !== "paused" && checking) job.connection.status = "error";
      job.error = code;
    }
  }
  job.leaseUntil = 0;
  job.version++;
  if (job.state === "complete" && job.report) {
    const latest = await read<Report>(store, `${root(s)}:latest`),
      active = await read<{ id: string }>(store, `${root(s)}:active`);
    const changes = [
      {
        key: jobKey(s, id),
        before: locked.raw,
        after: seal(job),
        ttlSeconds: Math.max(
          1,
          Math.ceil((Date.parse(job.expiresAt) - Date.now()) / 1000),
        ),
      },
      {
        key: `${root(s)}:report:${id}`,
        before: null,
        after: seal(job.report),
        ttlSeconds: 30 * 86400,
      },
    ];
    if (active.value?.id === id)
      changes.push({
        key: `${root(s)}:latest`,
        before: latest.raw,
        after: seal(job.report),
        ttlSeconds: 30 * 86400,
      });
    await store.commit(changes);
  } else await save(store, s, job, locked.raw);
}
export async function reportFor(store: CustomerStore, s: Scope, id: string) {
  jobKey(s, id);
  const report = (await read<Report>(store, `${root(s)}:report:${id}`)).value;
  if (!report) throw Error("HEALTH_EXPIRED");
  return report;
}
export async function removeSource(store: CustomerStore, s: Scope, id: string) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  const { raw } = await load(store, s, id);
  await store.commit([
    { key: jobKey(s, id), before: raw, after: null, ttlSeconds: 1 },
  ]);
}

// A settings revision creates a new job and leaves the completed snapshot intact.
export async function revise(
  store: CustomerStore,
  s: Scope,
  id: string,
  requestId: string,
) {
  if (!s.canWrite) throw Error("FORBIDDEN");
  const { value: previous } = await load(store, s, id);
  if (previous.state !== "complete") throw Error("VERSION_CONFLICT");
  const created = await createJob(store, s, {
    requestId,
    title: previous.sourceTitle,
    tables: previous.tables,
  });
  const current = await load(store, s, created.id);
  if (current.value.state !== "reading") return publicJob(current.value);
  current.value.questions = previous.questions;
  current.value.answers = { ...previous.answers };
  current.value.mappingMode = previous.mappingMode;
  current.value.state = "ready";
  current.value.version++;
  await save(store, s, current.value, current.raw);
  return publicJob(current.value);
}
export type ChatEntry = {
  question: string;
  answer: string;
  facts: Report["facts"];
  snapshot: string;
  createdAt: string;
  mode: string;
};
export async function chatHistory(store: CustomerStore, s: Scope, id: string) {
  await reportFor(store, s, id);
  return (
    (await read<ChatEntry[]>(store, `${root(s)}:chat:${id}:${digest(s.actor)}`))
      .value ?? []
  );
}
export async function saveChat(
  store: CustomerStore,
  s: Scope,
  id: string,
  entry: ChatEntry,
) {
  const report = await reportFor(store, s, id);
  if (entry.snapshot !== report.snapshot) throw Error("VERSION_CONFLICT");
  const k = `${root(s)}:chat:${id}:${digest(s.actor)}`,
    previous = await read<ChatEntry[]>(store, k);
  await store.commit([
    {
      key: k,
      before: previous.raw,
      after: seal([...(previous.value ?? []), entry].slice(-20)),
      ttlSeconds: Math.max(
        1,
        Math.ceil(
          (Date.parse(report.createdAt) + 30 * 86400000 - Date.now()) / 1000,
        ),
      ),
    },
  ]);
}
