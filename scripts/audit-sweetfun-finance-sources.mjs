import { readFileSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
export { auditSweetfunFinanceSources } from "../src/sweetfun-finance-source-audit.mjs";
import { auditSweetfunFinanceSources } from "../src/sweetfun-finance-source-audit.mjs";

function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size > 2_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] !== "--restricted-live-evidence" || process.argv.length !== 7)
      throw Error("EXPLICIT_PRIVATE_EVIDENCE_REQUIRED");
    const result = auditSweetfunFinanceSources(...process.argv.slice(3).map(privateJson));
    process.stdout.write(`${JSON.stringify(result.report)}\n`);
  } catch (error) {
    const allowed = new Set(["INVALID_LIVE_FINANCE_EVIDENCE",
      "OS_KEY_INVENTORY_INCOMPLETE", "SHEET_SOURCE_ID_MISSING_OR_DUPLICATE",
      "OS_RECEIPT_ORDER_NOT_IN_SHEET", "OS_RECEIPT_LEDGER_KEY_MISMATCH",
      "OS_RECEIPT_AUDIT_MISMATCH", "LINE_SOURCE_PROJECTION_MISMATCH",
      "LINE_SOURCE_ORDER_NOT_IN_SHEET", "SHEET_PARENT_ORDER_DRIFT",
      "LINE_CHAIN_INCOMPLETE", "FINANCE_CLAIM_REVERSE_MISMATCH"]);
    process.stderr.write(`Finance source audit failed: ${allowed.has(error?.message) ?
      error.message : "REDACTED_ERROR"}\n`);
    process.exitCode = 1;
  }
}
