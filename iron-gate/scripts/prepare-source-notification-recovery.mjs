#!/usr/bin/env node
import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planSourceNotificationRecovery, sourceNotificationRecoverySql } from "../src/source-notification-recovery.mjs";

async function privateJson(path) {
  const file = await lstat(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || file.size > 1_048_576 ||
    (typeof process.getuid === "function" && file.uid !== process.getuid())) throw Error("PRIVATE_INPUT_REQUIRED");
  return JSON.parse(await readFile(path, "utf8"));
}

export async function prepareNotificationRecovery(inputPath, manifestPath, outputPath) {
  const plan = planSourceNotificationRecovery(await privateJson(inputPath), await privateJson(manifestPath));
  if (outputPath) {
    const file = await open(resolve(outputPath), "wx", 0o600);
    try { await file.writeFile(sourceNotificationRecoverySql(plan)); await file.sync(); }
    finally { await file.close(); }
  }
  return plan.summary;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [inputPath, manifestPath, outputPath, extra] = process.argv.slice(2);
  if (!inputPath || !manifestPath || extra) throw Error("USAGE_INPUT_MANIFEST_OPTIONAL_SQL_OUTPUT");
  // Omitting the output path is a pure dry run. This helper has no DB/network client.
  console.log(JSON.stringify(await prepareNotificationRecovery(inputPath, manifestPath, outputPath)));
}
