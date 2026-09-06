import { mkdir, readFile, writeFile } from "node:fs/promises";
import { adaptSweetfunSheet } from "../src/lib/booking-sources/sweetfun-sheet.ts";

// Input is private connector output: { values: header-and-data-rows, observedAt: ISO timestamp }.
// Never put the input under the repository or public/. This script writes only the anonymous projection.
if (!process.argv[2]) throw new Error("Provide the absolute path to a private Sheet snapshot JSON");
const input = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(input.values) || !Number.isFinite(Date.parse(input.observedAt))) throw new Error("Invalid snapshot input");
const snapshot = adaptSweetfunSheet(input.values, "sweetfun-operations-sheet-v1", input.observedAt);
const output = new URL("../.calendar-data/", import.meta.url);
await mkdir(output, { recursive: true });
await writeFile(new URL("source-snapshot.json", output), JSON.stringify(snapshot));
console.log({ source_version: snapshot.source.snapshot_version, ...snapshot.summary });
