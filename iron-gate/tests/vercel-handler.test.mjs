import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createDatabasePool, createVercelFetch, databaseUrlForVercel } from "../api/index.mjs";

test("Vercel pool handles disconnected idle and checked-out clients without leaking errors", async () => {
  const logs = [];
  const originalError = console.error;
  const pool = createDatabasePool("postgres://runtime:private-password@localhost/postgres");
  try {
    console.error = (...parts) => logs.push(parts);
    const client = new EventEmitter();
    pool.emit("connect", client);
    assert.doesNotThrow(() => client.emit("error", new Error("private SQL and connection string")));
    assert.doesNotThrow(() => pool.emit("error", new Error("private SQL and connection string"), client));
    assert.deepEqual(logs, [
      ["iron_gate_database_connection_error"],
      ["iron_gate_database_idle_connection_error"],
    ]);
  } finally {
    console.error = originalError;
    await pool.end();
  }
});

test("Vercel entry refuses requests without both private settings", async () => {
  const handle = createVercelFetch({});
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code: "SERVICE_UNAVAILABLE" } });
});

test("Vercel entry refuses an unverified remote database transport", async () => {
  const handle = createVercelFetch({
    VERCEL_ENV: "preview",
    IRON_GATE_PREVIEW_ENABLED: "true",
    IRON_GATE_DATABASE_URL: "postgres://runtime@db.example/postgres?sslmode=require",
    IRON_GATE_OS_PROOF_SECRET: "x".repeat(32),
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
});

test("Production cannot read Preview credentials or initialize a pool", async () => {
  let secretReads = 0;
  const handle = createVercelFetch({
    VERCEL_ENV: "production",
    IRON_GATE_PREVIEW_ENABLED: "true",
    get IRON_GATE_DATABASE_URL() { secretReads++; return "unused"; },
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(secretReads, 0);
});

test("Production switch uses only separate Production settings", async () => {
  let previewReads = 0;
  let productionReads = 0;
  const handle = createVercelFetch({
    VERCEL_ENV: "production",
    IRON_GATE_PREVIEW_ENABLED: "true",
    IRON_GATE_PRODUCTION_ENABLED: "true",
    get IRON_GATE_DATABASE_URL() { previewReads++; return "unused"; },
    get IRON_GATE_OS_PROOF_SECRET() { previewReads++; return "unused"; },
    get IRON_GATE_LINE_PROOF_SECRET() { previewReads++; return "unused"; },
    get IRON_GATE_PRODUCTION_DATABASE_URL() {
      productionReads++;
      return "postgres://runtime@db.example/postgres?sslmode=require";
    },
    IRON_GATE_PRODUCTION_OS_PROOF_SECRET: "x".repeat(32),
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(previewReads, 0);
  assert.equal(productionReads, 1);
});

test("An unflagged deployment remains unavailable before reading credentials", async () => {
  let secretReads = 0;
  const handle = createVercelFetch({
    get IRON_GATE_DATABASE_URL() { secretReads++; return "unused"; },
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(secretReads, 0);
});

test("A flagged deployment without a confirmed Preview target remains unavailable", async () => {
  let secretReads = 0;
  const handle = createVercelFetch({
    IRON_GATE_PREVIEW_ENABLED: "true",
    get IRON_GATE_DATABASE_URL() { secretReads++; return "unused"; },
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(secretReads, 0);
});

test("Vercel remote URL pins the bundled CA without weakening hostname verification", () => {
  const raw = "postgresql://runtime:secret@pooler.example:6543/postgres?sslmode=verify-full";
  const secured = new URL(databaseUrlForVercel(raw));
  assert.equal(secured.searchParams.get("sslmode"), "verify-full");
  assert.match(secured.searchParams.get("sslrootcert"), /certs\/prod-ca-2021\.crt$/);
  assert.throws(() => databaseUrlForVercel(`${raw}&sslrootcert=/tmp/other.crt`),
    /UNSAFE_DATABASE_TRANSPORT/);
});
