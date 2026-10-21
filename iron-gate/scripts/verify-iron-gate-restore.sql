-- Run this SELECT separately on the original Iron Gate project and on the
-- isolated restored project. Compare every row_count and digest exactly.
-- It returns no booking, guest, credential, or payment data. The digest includes
-- every column, including timestamps, and detects missing or changed rows.
-- Check the schema inventory separately before claiming whole-schema parity.
SELECT 'audit_log' AS table_name, count(*) AS row_count,
  md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.audit_id), '')) AS digest
FROM iron_gate.audit_log t
UNION ALL
SELECT 'credentials', count(*),
  md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.token_hash), ''))
FROM iron_gate.credentials t
UNION ALL
SELECT 'occupied_room_nights', count(*),
  md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY
    t.property_id, t.room_id, t.night), ''))
FROM iron_gate.occupied_room_nights t
UNION ALL
SELECT 'outbox', count(*),
  md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.cursor), ''))
FROM iron_gate.outbox t
UNION ALL
SELECT 'property_state', count(*),
  md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY t.property_id), ''))
FROM iron_gate.property_state t
ORDER BY table_name;
