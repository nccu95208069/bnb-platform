import { lstatSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planSweetfunFinanceLinks } from "../src/sweetfun-finance-link.mjs";

function privateJson(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.mode & 0o077 || stat.size < 2 || stat.size > 3_000_000)
    throw Error("UNSAFE_PRIVATE_INPUT");
  return JSON.parse(readFileSync(path, "utf8"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (process.argv[2] !== "--restricted-live-link" || process.argv.length !== 10)
      throw Error("EXPLICIT_PRIVATE_EVIDENCE_REQUIRED");
    const sources = process.argv.slice(3, 7).map(privateJson);
    const shadow = privateJson(process.argv[7]);
    const manifest = privateJson(process.argv[8]);
    // The final argument is a fixed scope token, not a secret or a data path.
    if (process.argv[9] !== "sweetfun") throw Error("SWEETFUN_SCOPE_REQUIRED");
    process.stdout.write(`${JSON.stringify(planSweetfunFinanceLinks(
      sources, shadow, manifest).report)}\n`);
  } catch (error) {
    const safe = new Set(["EXPLICIT_PRIVATE_EVIDENCE_REQUIRED",
      "SWEETFUN_SCOPE_REQUIRED", "UNSAFE_PRIVATE_INPUT",
      "FINANCE_LINK_SHADOW_MISMATCH", "FINANCE_LINK_SOURCE_AUDIT_MISMATCH",
      "FINANCE_LINK_BOOKING_INVALID", "FINANCE_LINK_SHADOW_ROW_DUPLICATE",
      "FINANCE_LINK_SHADOW_ROW_MISMATCH"]);
    process.stderr.write(`Sweetfun finance link failed: ${safe.has(error?.message) ?
      error.message : "REDACTED_ERROR"}\n`);
    process.exitCode = 1;
  }
}
