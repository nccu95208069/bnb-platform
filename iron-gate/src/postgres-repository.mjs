import { GateError } from "./errors.ts";
import { nightsFor } from "./service.ts";
import { appendNativeFinance, nativeFinanceCutover } from "./finance-native.mjs";

function occupancyRows(state) {
  const rows = [];
  for (const booking of state.bookings) {
    if (booking.status !== "held" && booking.status !== "confirmed") continue;
    for (const cell of nightsFor(booking.stays, state.roomIds)) {
      rows.push({ room_id: cell.roomId, night: cell.date, booking_id: booking.id });
      if (rows.length > 200_000) throw new GateError("PROPERTY_CAPACITY_LIMIT", 409);
    }
  }
  return rows;
}

async function scope(client, propertyId) {
  await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [propertyId]);
}

/**
 * Expects a pg-compatible Pool. One property row is locked for each write;
 * state, occupancy uniqueness, and outbox commit in the same transaction.
 * The pool must connect as a dedicated login granted iron_gate_runtime.
 */
export class PostgresPropertyRepository {
  #pool;
  #financeNativeEnabled;
  constructor(pool, financeNativeEnabled = false) {
    this.#pool = pool;
    this.#financeNativeEnabled = financeNativeEnabled;
  }

  async read(propertyId) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await scope(client, propertyId);
      const result = await client.query(
        "SELECT state_json FROM iron_gate.property_state WHERE property_id = $1", [propertyId]
      );
      await client.query("COMMIT");
      return result.rows[0]?.state_json ?? null;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async seed(state) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await scope(client, state.propertyId);
      await client.query(`INSERT INTO iron_gate.property_state
        (property_id, workspace_id, authority_epoch, inventory_version, state_json)
        VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [state.propertyId, state.workspaceId, state.authorityEpoch, state.version, JSON.stringify(state)]);
      await this.#refreshOccupancy(client, state);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async transact(propertyId, fn) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await scope(client, propertyId);
        const current = await client.query(`SELECT state_json, authority_epoch, inventory_version
          FROM iron_gate.property_state WHERE property_id = $1 FOR UPDATE`, [propertyId]);
        if (!current.rows.length) throw new GateError("PROPERTY_NOT_FOUND", 404);
        const draft = structuredClone(current.rows[0].state_json);
        const pending = [];
        const pendingAudits = [];
        const pendingFinance = [];
        const result = await fn(draft, { emit: (event) => pending.push(structuredClone(event)),
          audit: (record) => pendingAudits.push(structuredClone(record)),
          financeNative: intent => pendingFinance.push(structuredClone(intent)) });
        // Native finance adds the change watermark to the same response object
        // held by the legacy request receipt. Do it before serializing the draft.
        for (const intent of pendingFinance) {
          if (await nativeFinanceCutover(client, propertyId, intent.type,
            this.#financeNativeEnabled))
            await appendNativeFinance(client, propertyId, intent, result);
        }
        const updated = await client.query(`UPDATE iron_gate.property_state SET
          state_json = $1::jsonb, authority_epoch = $2, inventory_version = $3, updated_at = now()
          WHERE property_id = $4 AND authority_epoch = $5 AND inventory_version = $6`,
          [JSON.stringify(draft), draft.authorityEpoch, draft.version, propertyId,
            current.rows[0].authority_epoch, current.rows[0].inventory_version]);
        if (updated.rowCount !== 1) throw new GateError("AUTHORITY_MOVED", 409);
        await this.#refreshOccupancy(client, draft);
        for (const event of pending) await client.query(`INSERT INTO iron_gate.outbox
          (event_id, property_id, event_json) VALUES ($1, $2, $3::jsonb)`,
          [event.eventId, propertyId, JSON.stringify(event)]);
        for (const record of pendingAudits) await client.query(`INSERT INTO iron_gate.audit_log
          (audit_id, property_id, audit_json) VALUES ($1, $2, $3::jsonb)`,
          [record.auditId, propertyId, JSON.stringify(record)]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        if ((error.code === "40001" || error.code === "40P01") && attempt < 2) continue;
        throw error;
      } finally { client.release(); }
    }
    throw new Error("TRANSACTION_RETRY_EXHAUSTED");
  }

  async #refreshOccupancy(client, state) {
    const cells = occupancyRows(state);
    await client.query("DELETE FROM iron_gate.occupied_room_nights WHERE property_id = $1", [state.propertyId]);
    if (cells.length) await client.query(`INSERT INTO iron_gate.occupied_room_nights
      (property_id, room_id, night, booking_id)
      SELECT $1::uuid, x.room_id, x.night, x.booking_id
      FROM jsonb_to_recordset($2::jsonb) AS x(room_id uuid, night date, booking_id uuid)`,
      [state.propertyId, JSON.stringify(cells)]);
  }

  async events(propertyId, after, limit) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await scope(client, propertyId);
      const result = await client.query(`SELECT cursor, event_json FROM iron_gate.outbox
        WHERE property_id = $1 AND cursor > $2 ORDER BY cursor LIMIT $3`, [propertyId, after, limit]);
      await client.query("COMMIT");
      return result.rows.map((row) => {
        const cursor = Number(row.cursor);
        if (!Number.isSafeInteger(cursor)) throw new Error("EVENT_CURSOR_OVERFLOW");
        return { ...row.event_json, cursor };
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { client.release(); }
  }
}
