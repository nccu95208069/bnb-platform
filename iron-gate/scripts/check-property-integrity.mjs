import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import { checkPropertyIntegrity } from "../src/property-integrity.mjs";
import { assertRuntimeDatabase, validateDatabaseTransport } from "../src/runtime-safety.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function inspectProperty(pool, propertyId) {
  if (typeof propertyId !== "string" || !UUID.test(propertyId)) throw Error("INVALID_PROPERTY_ID");
  await assertRuntimeDatabase(pool);
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query("SELECT set_config('iron_gate.property_id', $1, true)", [propertyId]);
    const state = await client.query(
      "SELECT state_json FROM iron_gate.property_state WHERE property_id = $1", [propertyId]);
    if (state.rows.length !== 1) throw Error("PROPERTY_NOT_FOUND");
    const occupancy = await client.query(`SELECT room_id::text, night::text, booking_id::text
      FROM iron_gate.occupied_room_nights WHERE property_id = $1`, [propertyId]);
    const report = checkPropertyIntegrity(state.rows[0].state_json, occupancy.rows);
    await client.query("COMMIT");
    return report;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { client.release(); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let pool;
  try {
    const databaseUrl = process.env.IRON_GATE_DATABASE_URL;
    validateDatabaseTransport(databaseUrl);
    pool = new Pool({ connectionString: databaseUrl, max: 1,
      connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 });
    const report = await inspectProperty(pool, process.argv[2]);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch {
    process.stderr.write("property integrity check failed\n");
    process.exitCode = 1;
  } finally { await pool?.end(); }
}
