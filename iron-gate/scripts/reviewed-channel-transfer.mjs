import { fileURLToPath } from "node:url";
import { createFreshChannelAuthorization } from "../api/channel-worker.mjs";
import { transferWithRuntime as runWithRuntime } from "../src/channel-review-runtime.mjs";

export const transferWithRuntime = manifest => runWithRuntime(manifest,
  {createAuthorization: createFreshChannelAuthorization});

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv.length !== 2) throw Error("CHANNEL_REVIEW_TRANSFER_STDIN_REQUIRED");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 262_144) throw Error("CHANNEL_REVIEW_TRANSFER_MANIFEST_INVALID");
    }
    const result = await transferWithRuntime(JSON.parse(input));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (result.state !== "sync_verified") process.exitCode = 2;
  } catch (error) {
    const safe = /^CHANNEL_REVIEW_(TRANSFER_[A-Z_]+|BLOCKED)$/;
    process.stderr.write((safe.test(error?.message ?? "") ? error.message : "CHANNEL_REVIEW_TRANSFER_FAILED") + "\n");
    process.exitCode = 1;
  }
}
