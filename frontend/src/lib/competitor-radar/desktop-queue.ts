import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { desktopScan, type DesktopCapture } from "./desktop-evidence";
import type { OtaScanRequest } from "./ota-types";
import type { JobResult, ScanJob } from "./scan-jobs";

interface DesktopJob { job: ScanJob; request: OtaScanRequest; createdAt: number; result: JobResult; claim?: string }
export function desktopDirectory(): string | undefined {
  const directory = process.env.RADAR_DESKTOP_QUEUE_DIR;
  return !process.env.VERCEL && directory && isAbsolute(directory) ? directory : undefined;
}
function root() { const value = desktopDirectory(); if (!value) throw new Error("desktop_not_configured"); return value; }
function path(id: string) { if (!/^desktop-[a-f0-9]{32}$/.test(id)) throw new Error("invalid_job"); return join(root(), id + ".json"); }
async function load(id: string): Promise<DesktopJob> { const data = await readFile(path(id), "utf8"); if (data.length > 1000000) throw new Error("invalid_job"); return JSON.parse(data); }
async function save(item: DesktopJob) { const file = path(item.job.id), temp = file + "." + randomBytes(8).toString("hex") + ".tmp"; await writeFile(temp, JSON.stringify(item), { mode: 0o600 }); await rename(temp, file); }
async function exclusive<T>(action: () => Promise<T>): Promise<T> {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const lock = join(root(), "queue.lock");
  // Never steal a lock from a possibly active writer.
  for (let attempt = 0; ; attempt++) {
    try { await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 }); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 99) throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { return await action(); } finally { await unlink(lock); }
}
async function all() {
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const files = (await readdir(root())).filter(f => /^desktop-[a-f0-9]{32}\.json$/.test(f));
  return Promise.all(files.map(file => load(file.slice(0, -5))));
}
const fingerprint = (request: OtaScanRequest) => createHash("sha256").update(JSON.stringify(request)).digest("hex");
export async function enqueueDesktop(request: OtaScanRequest): Promise<ScanJob> {
  if (request.platform !== "agoda") throw new Error("此平台的桌面收集尚未開放。");
  return exclusive(async () => {
    const jobs = await all();
    const active = jobs.filter(j => j.job.expiresAt > Date.now() && (j.result.state === "queued" || j.result.state === "running"));
    const existing = active.find(j => fingerprint(j.request) === fingerprint(request));
    if (existing) return existing.job;
    if (active.length >= 4) throw new Error("電腦已有待處理工作，請等待完成。");
    const job = { id: "desktop-" + randomBytes(16).toString("hex"), token: randomBytes(32).toString("hex"), expiresAt: Date.now() + 4 * 3600000 };
    await save({ job, request, createdAt: Date.now(), result: { state: "queued", detail: "等待桌面執行，請保持電腦與 Codex 開啟。" } });
    return job;
  });
}
export async function readDesktop(id: string, token: string): Promise<JobResult> {
  const item = await load(id);
  if (!/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(item.job.token))) throw new Error("invalid_job");
  if (item.job.expiresAt <= Date.now() && (item.result.state === "queued" || item.result.state === "running")) return { state: "failed", detail: "桌面工作已逾時；已保存結果仍保留。" };
  return item.result;
}
/** A claim serializes access to the one real desktop. No automatic lease takeover. */
export async function claimDesktop() {
  return exclusive(async () => {
    const jobs = await all();
    if (jobs.some(j => j.result.state === "running")) return null;
    const item = jobs.filter(j => j.result.state === "queued" && j.job.expiresAt > Date.now()).sort((a,b) => a.createdAt - b.createdAt)[0];
    if (!item) return null;
    item.claim = randomBytes(32).toString("hex");
    item.result = { state: "running", detail: "電腦正在核對房型與含稅總額。" };
    await save(item);
    return { id: item.job.id, claim: item.claim, request: item.request };
  });
}
export async function finishDesktop(id: string, claim: string, capture: DesktopCapture | { failure: string }) {
  return exclusive(async () => {
    const item = await load(id);
    if (item.result.state !== "running" || !item.claim || claim !== item.claim) throw new Error("invalid_claim");
    item.result = "failure" in capture ? { state: "failed", detail: String(capture.failure).slice(0, 500) } : { state: "done", scan: desktopScan(item.request, capture, item.createdAt) };
    delete item.claim;
    await save(item);
    return { id, state: item.result.state };
  });
}
