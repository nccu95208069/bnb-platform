import assert from "node:assert/strict";
import { test } from "node:test";
import { createVercelFetch } from "../api/index.mjs";

test("Vercel entry refuses requests without both private settings", async () => {
  const handle = createVercelFetch({});
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { error: { code: "SERVICE_UNAVAILABLE" } });
});

test("Vercel entry refuses an unverified remote database transport", async () => {
  const handle = createVercelFetch({
    IRON_GATE_DATABASE_URL: "postgres://runtime@db.example/postgres?sslmode=require",
    IRON_GATE_OS_PROOF_SECRET: "x".repeat(32),
  });
  const response = await handle(new Request("https://iron-gate.example/v1/properties"));
  assert.equal(response.status, 503);
});
