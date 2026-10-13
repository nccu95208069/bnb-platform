import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("shadow CLI emits redacted results and fixed errors for private snapshots", () => {
  const folder = mkdtempSync(join(tmpdir(), "iron-gate-shadow-"));
  const path = join(folder, "private-snapshot.json");
  try {
    const workspace = { id: crypto.randomUUID(), version: 1,
      properties: [{ id: crypto.randomUUID(), rooms: [] }],
      bookings: [{ id: crypto.randomUUID(), propertyId: null,
        guestName: "Private Guest" }] };
    workspace.bookings[0].propertyId = workspace.properties[0].id;
    workspace.bookings[0].status = "cancelled";
    workspace.bookings[0].stays = [{ checkIn: "2026-11-10", checkOut: "2026-11-11", roomIds: [] }];
    // Invalid stay keeps the source private, including parser/validation failures.
    writeFileSync(path, JSON.stringify(workspace));
    const fail = spawnSync(process.execPath,
      ["--no-warnings", "--experimental-strip-types", "src/os-shadow-cli.mjs", "report", path],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.notEqual(fail.status, 0);
    assert.equal(fail.stdout, "");
    assert.equal(fail.stderr, "SHADOW_REPORT_FAILED\n");
    writeFileSync(path, JSON.stringify({ id: workspace.id, version: 1,
      properties: workspace.properties, bookings: [] }));
    const okay = spawnSync(process.execPath,
      ["--no-warnings", "--experimental-strip-types", "src/os-shadow-cli.mjs", "report", path],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(okay.status, 0);
    assert.equal(okay.stdout.includes("Private Guest"), false);
    assert.equal(JSON.parse(okay.stdout).canCutover, false);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
