/** Remote booking data must have hostname-verified TLS; loopback is for private tests. */
export function validateDatabaseTransport(connectionString) {
  let url;
  try { url = new URL(connectionString); }
  catch { throw Error("UNSAFE_DATABASE_TRANSPORT"); }
  if (!["postgresql:", "postgres:"].includes(url.protocol) || !url.hostname ||
    url.searchParams.has("host") || url.searchParams.has("ssl") ||
    url.searchParams.has("uselibpqcompat")) throw Error("UNSAFE_DATABASE_TRANSPORT");
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!loopback && (url.searchParams.getAll("sslmode").length !== 1 ||
    url.searchParams.get("sslmode") !== "verify-full"))
    throw Error("UNSAFE_DATABASE_TRANSPORT");
}

/** Reject a database login that could bypass the property isolation boundary. */
export async function assertRuntimeDatabase(pool) {
  const result = await pool.query(`SELECT current_user AS login,
    rolsuper, rolbypassrls,
    pg_has_role(current_user, 'iron_gate_runtime', 'MEMBER') AS runtime_member,
    to_regclass('iron_gate.property_state') IS NOT NULL AS schema_ready,
    row_security_active('iron_gate.property_state') AS property_rls,
    row_security_active('iron_gate.occupied_room_nights') AS occupancy_rls,
    row_security_active('iron_gate.outbox') AS outbox_rls,
    has_schema_privilege(current_user, 'iron_gate', 'CREATE') AS can_change_schema,
    has_table_privilege(current_user, 'iron_gate.credentials',
      'SELECT, INSERT, UPDATE, DELETE') AS can_change_credentials,
    has_table_privilege(current_user, 'iron_gate.audit_log',
      'SELECT, UPDATE, DELETE') AS can_read_or_change_audit,
    has_table_privilege(current_user, 'iron_gate.outbox',
      'UPDATE, DELETE') AS can_change_events
    FROM pg_roles WHERE rolname = current_user`);
  const identity = result.rows[0];
  if (!identity || identity.rolsuper || identity.rolbypassrls ||
    !identity.runtime_member || !identity.schema_ready || !identity.property_rls ||
    !identity.occupancy_rls || !identity.outbox_rls || identity.can_change_schema ||
    identity.can_change_credentials || identity.can_read_or_change_audit ||
    identity.can_change_events)
    throw Error("UNSAFE_DATABASE_ROLE_OR_SCHEMA");
}
