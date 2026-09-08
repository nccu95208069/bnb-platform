import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Sandbox } from "@vercel/sandbox";
import type { OtaPlatformScan } from "./ota-types";

// The mailbox is separate from the untrusted browser and has no network access.
// It survives Function instance changes for 15 minutes; completed results are
// immediately saved on the device. This is not cross-device persistence.
export interface ScanJob { id: string; token: string; expiresAt: number }
export type JobResult = { state: "queued" | "running"; detail?: string } | { state: "done"; scan: OtaPlatformScan } | { state: "failed"; detail: string };
export async function createScanJob(): Promise<{ job: ScanJob; write: (result: JobResult) => Promise<void> }> {
  const box = await Sandbox.create({ name: `radar-job-${randomBytes(16).toString("hex")}`, persistent: false, runtime: "node24", timeout: 900_000, resources: { vcpus: 1 }, networkPolicy: "deny-all" });
  const token = randomBytes(32).toString("hex");
  const job = { id: box.name, token, expiresAt: Date.now() + 900_000 };
  await box.writeFiles([{ path: "/tmp/radar-token", content: Buffer.from(token) }]);
  const write = async (result: JobResult) => {
    await box.writeFiles([{ path: "/tmp/radar-result-next.json", content: Buffer.from(JSON.stringify(result)) }]);
    const moved = await box.runCommand({ cmd: "mv", args: ["/tmp/radar-result-next.json", "/tmp/radar-result.json"] });
    if (moved.exitCode !== 0) throw new Error("scan_result_save_failed");
  };
  await write({ state: "running" });
  return { job, write };
}
export async function readScanJob(id: string, token: string): Promise<JobResult> {
  if (!/^radar-job-[a-f0-9]{32}$/.test(id) || !/^[a-f0-9]{64}$/.test(token)) throw new Error("invalid_job");
  const box = await Sandbox.get({ name: id });
  const stored = await box.readFileToBuffer({ path: "/tmp/radar-token" });
  if (!stored || stored.length !== token.length || !timingSafeEqual(stored, Buffer.from(token))) throw new Error("invalid_job");
  const data = await box.readFileToBuffer({ path: "/tmp/radar-result.json" });
  if (!data || data.length > 1_000_000) throw new Error("invalid_result");
  return JSON.parse(data.toString("utf8")) as JobResult;
}
