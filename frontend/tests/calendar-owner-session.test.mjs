import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOwnerSession, validOwnerCode, validOwnerSession, ownerAccessConfigured, OWNER_SESSION_SECONDS } from "../src/lib/calendar-owner-session.ts";
const code = "a".repeat(32);
const setup = () => { process.env.CALENDAR_OWNER_CODE_HASH = createHash("sha256").update(code).digest("hex"); process.env.CALENDAR_OWNER_SESSION_SECRET = "b".repeat(64); };
test("missing configuration fails closed", () => { delete process.env.CALENDAR_OWNER_CODE_HASH; assert.equal(ownerAccessConfigured(), false); assert.equal(validOwnerCode(code), false); assert.equal(validOwnerSession("owner.fake"), false); });
test("only the configured high-entropy code authenticates", () => { setup(); assert.equal(validOwnerCode(code), true); for (const bad of ["", "b".repeat(32), null, {}, code + "a"]) assert.equal(validOwnerCode(bad), false); });
test("tampered, expired and rotated owner sessions are rejected", () => { setup(); const now = Date.parse("2026-09-06T06:00:00Z"); const session = createOwnerSession(now); assert.equal(validOwnerSession(session, now), true); assert.equal(validOwnerSession(session + "x", now), false); assert.equal(validOwnerSession(session.replace("owner", "admin"), now), false); assert.equal(validOwnerSession(session, now + OWNER_SESSION_SECONDS * 1000), false); process.env.CALENDAR_OWNER_CODE_HASH = "c".repeat(64); assert.equal(validOwnerSession(session, now), false); });
