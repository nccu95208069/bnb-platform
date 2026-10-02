import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { POST } from "../src/app/api/customer-intake/route.ts";
const req = (input, origin = "https://service.test") =>
  new NextRequest("https://service.test/api/customer-intake", {
    method: "POST",
    headers: { origin },
    body: JSON.stringify(input),
  });
test("public intake rejects CSRF and gates; accepts private pending request even when notification transport is unavailable", async (t) => {
  process.env.CUSTOMER_INTAKE_ENABLED = "true";
  process.env.KV_REST_API_URL = "https://redis.invalid";
  process.env.KV_REST_API_TOKEN = "synthetic";
  const data = new Map();
  let sends = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    if (String(url) !== "https://redis.invalid") {
      sends++;
      throw Error("mail should not be called");
    }
    const c = JSON.parse(options.body);
    let result = null;
    if (c[0] === "GET") result = data.get(c[1]) ?? null;
    if (c[0] === "EVAL") {
      if (c[1].includes("INCR")) result = 1;
      else {
        const keys = c.slice(3, 3 + c[2]),
          args = c.slice(3 + c[2]),
          step = c[1].includes("i*3") ? 3 : 2;
        result = keys.every((k, i) => (data.get(k) ?? "") === args[i * step])
          ? 1
          : 0;
        if (result) keys.forEach((k, i) => data.set(k, args[i * step + 1]));
      }
    }
    return Response.json({ result });
  });
  const input = {
    requestKey: randomUUID(),
    intent: "consultation",
    propertyName: "Synthetic",
    kind: "rooms",
    rooms: [],
    source: "unknown",
    contactName: "Synthetic",
    email: "test@example.test",
    consent: true,
  };
  assert.equal((await POST(req(input, "https://evil.test"))).status, 403);
  assert.equal(data.size, 0);
  const response = await POST(req(input));
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const value = await response.json();
  assert.equal(value.notification, "pending");
  assert.equal(JSON.stringify(value).includes("test@example.test"), false);
  assert.equal(sends, 0);
  const repeated = await POST(req(input));
  assert.deepEqual(await repeated.json(), value);
  assert.equal(sends, 0);
  process.env.CUSTOMER_INTAKE_ENABLED = "false";
  assert.equal((await POST(req(input))).status, 503);
});
