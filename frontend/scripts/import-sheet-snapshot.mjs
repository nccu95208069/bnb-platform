import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { adaptSweetfunSheet } from "../src/lib/booking-sources/sweetfun-sheet.ts";

// Input is private connector output: { values: header-and-data-rows, observedAt: ISO timestamp }.
// Never put the input under the repository or public/. This script writes only the anonymous projection.
if (!process.argv[2]) throw new Error("Provide the absolute path to a private Sheet snapshot JSON");
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(input.values) || !Number.isFinite(Date.parse(input.observedAt))) throw new Error("Invalid snapshot input");
const output = new URL("../.calendar-data/", import.meta.url);
let previous;
try { previous = JSON.parse(await readFile(new URL("source-snapshot.json", output), "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
let acknowledgements = (previous?.issues ?? []).filter(i => i.acknowledged).map(i => i.fingerprint);
let snapshot = adaptSweetfunSheet(input.values, "sweetfun-operations-sheet-v1", input.observedAt, acknowledgements);
// Explicit owner-authorized baseline only; never use this flag in a recurring import job.
if (process.argv.includes("--acknowledge-current-issues")) {
  acknowledgements = snapshot.issues.map(i => i.fingerprint);
  snapshot = adaptSweetfunSheet(input.values, "sweetfun-operations-sheet-v1", input.observedAt, acknowledgements);
}
await mkdir(output, { recursive: true });
await writeFile(new URL("source-snapshot.tmp", output), JSON.stringify(snapshot));
await rename(new URL("source-snapshot.tmp", output), new URL("source-snapshot.json", output));
console.log({ source_version: snapshot.source.snapshot_version, ...snapshot.summary });
