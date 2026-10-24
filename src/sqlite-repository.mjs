import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GateError } from "./errors.ts";
import { nightsFor } from "./service.ts";

function refreshOccupancy(db, state) {
  db.prepare("DELETE FROM occupied_room_nights WHERE property_id = ?").run(state.propertyId);
  const insert = db.prepare(
    "INSERT INTO occupied_room_nights(property_id, room_id, night, booking_id) VALUES (?, ?, ?, ?)"
  );
  for (const booking of state.bookings) {
    if (booking.status !== "held" && booking.status !== "confirmed") continue;
    for (const cell of nightsFor(booking.stays, state.roomIds))
      insert.run(state.propertyId, cell.roomId, cell.date, booking.id);
  }
}

/**
 * Durable single-host adapter for private pilots and recovery tests. All writes
 * to one property are committed as one SQLite transaction. A Postgres adapter
 * is still required before a multi-instance production deployment.
 */
export class SqlitePropertyRepository {
  #db;

  constructor(filename) {
    if (filename !== ":memory:") {
      if (typeof filename !== "string" || !filename) throw new Error("DATABASE_PATH_REQUIRED");
      filename = resolve(filename);
      mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    }
    this.#db = new DatabaseSync(filename);
    if (filename !== ":memory:") chmodSync(filename, 0o600);
    this.#db.exec("PRAGMA busy_timeout = 10000; PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    if (filename !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL;");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS properties (
        property_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        cursor INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        property_id TEXT NOT NULL REFERENCES properties(property_id),
        event_json TEXT NOT NULL CHECK(json_valid(event_json))
      );
      CREATE INDEX IF NOT EXISTS outbox_property_cursor ON outbox(property_id, cursor);
      CREATE TABLE IF NOT EXISTS occupied_room_nights (
        property_id TEXT NOT NULL REFERENCES properties(property_id),
        room_id TEXT NOT NULL,
        night TEXT NOT NULL,
        booking_id TEXT NOT NULL,
        PRIMARY KEY(property_id, room_id, night)
      );
      CREATE TABLE IF NOT EXISTS audit_log (
        audit_id TEXT PRIMARY KEY,
        property_id TEXT NOT NULL REFERENCES properties(property_id),
        audit_json TEXT NOT NULL CHECK(json_valid(audit_json))
      );
      CREATE INDEX IF NOT EXISTS audit_property ON audit_log(property_id);
    `);
  }

  async seed(state) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare("INSERT INTO properties(property_id, state_json, updated_at) VALUES (?, ?, ?)")
        .run(state.propertyId, JSON.stringify(state), new Date().toISOString());
      refreshOccupancy(this.#db, state);
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async read(propertyId) {
    const row = this.#db.prepare("SELECT state_json FROM properties WHERE property_id = ?").get(propertyId);
    return row ? JSON.parse(row.state_json) : null;
  }

  async transact(propertyId, fn) {
    // Keep the native transaction entirely synchronous. Awaiting user code
    // while holding SQLite's write lock can deadlock another connection on
    // the same event loop. All domain transitions in IronGateService are sync.
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT state_json FROM properties WHERE property_id = ?").get(propertyId);
      if (!row) throw new GateError("PROPERTY_NOT_FOUND", 404);
      const draft = JSON.parse(row.state_json);
      const pending = [];
      const pendingAudits = [];
      const result = fn(draft, { emit: (event) => pending.push(structuredClone(event)),
        audit: (record) => pendingAudits.push(structuredClone(record)) });
      if (result && typeof result.then === "function") throw new Error("ASYNC_TRANSACTION_UNSUPPORTED");
      this.#db.prepare("UPDATE properties SET state_json = ?, updated_at = ? WHERE property_id = ?")
        .run(JSON.stringify(draft), new Date().toISOString(), propertyId);
      refreshOccupancy(this.#db, draft);
      const append = this.#db.prepare(
        "INSERT INTO outbox(event_id, property_id, event_json) VALUES (?, ?, ?)"
      );
      for (const event of pending) append.run(event.eventId, propertyId, JSON.stringify(event));
      const appendAudit = this.#db.prepare(
        "INSERT INTO audit_log(audit_id, property_id, audit_json) VALUES (?, ?, ?)"
      );
      for (const record of pendingAudits)
        appendAudit.run(record.auditId, propertyId, JSON.stringify(record));
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  async events(propertyId, after, limit) {
    const rows = this.#db.prepare(
      "SELECT cursor, event_json FROM outbox WHERE property_id = ? AND cursor > ? ORDER BY cursor LIMIT ?"
    ).all(propertyId, after, limit);
    return rows.map((row) => ({ ...JSON.parse(row.event_json), cursor: Number(row.cursor) }));
  }

  auditRecords(propertyId) {
    return this.#db.prepare("SELECT audit_json FROM audit_log WHERE property_id = ? ORDER BY rowid")
      .all(propertyId).map((row) => JSON.parse(row.audit_json));
  }

  close() { this.#db.close(); }
}
