import test from "node:test";
import assert from "node:assert/strict";
import { validateDatabaseTransport } from "../src/main.mjs";

test("remote booking database requires hostname-verified TLS", () => {
  assert.doesNotThrow(() => validateDatabaseTransport(
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full"));
  assert.doesNotThrow(() => validateDatabaseTransport(
    "postgresql://user@127.0.0.1:55432/iron_gate_test"));
  for (const url of [
    "postgresql://user:secret@db.example.test/iron_gate",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=require",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full&ssl=no-verify",
    "postgresql://user@127.0.0.1/iron_gate_test?host=db.example.test",
    "postgresql://user:secret@db.example.test/iron_gate?sslmode=verify-full&sslmode=disable",
    "file:///private/tmp/iron_gate_test",
  ]) assert.throws(() => validateDatabaseTransport(url), /UNSAFE_DATABASE_TRANSPORT/);
});
