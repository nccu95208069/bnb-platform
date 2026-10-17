import { statSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { analyzeOsWorkspace, compareOsPropertyCandidate } from "./os-shadow.mjs";

const MAX_INPUT_BYTES = 50 * 1024 * 1024;

function privateJson(filename) {
  const stat = statSync(filename);
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) throw Error("INVALID_FILE");
  return JSON.parse(readFileSync(filename, "utf8"));
}

/** Read private local snapshots; print only the redacted report. Never writes to either system. */
export function shadowReport(args) {
  if (args[0] === "report" && args.length === 2)
    return analyzeOsWorkspace(privateJson(args[1]));
  if (args[0] === "compare" && args.length === 6) {
    const authorityEpoch = Number(args[4]), inventoryVersion = Number(args[5]);
    if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 0 ||
      !Number.isSafeInteger(inventoryVersion) || inventoryVersion < 1)
      throw Error("INVALID_VERSION");
    return compareOsPropertyCandidate(privateJson(args[1]), args[2], privateJson(args[3]),
      { authorityEpoch, inventoryVersion });
  }
  throw Error("USAGE");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { process.stdout.write(`${JSON.stringify(shadowReport(process.argv.slice(2)))}\n`); }
  catch {
    // Parse errors can contain source snippets. Keep all failure output fixed.
    process.stderr.write("SHADOW_REPORT_FAILED\n");
    process.exitCode = 1;
  }
}
