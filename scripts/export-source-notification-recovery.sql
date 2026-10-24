-- Read-only psql template. Supply property_id and a JSON array source_versions_json
-- through private operator inputs. Store only the result JSON in a mode-0600 file.
WITH params AS (
  SELECT :'property_id'::uuid AS property_id, :'source_versions_json'::jsonb AS versions
), scoped AS (
  SELECT p.state_json AS state FROM iron_gate.property_state p, params q
  WHERE p.property_id = q.property_id AND jsonb_array_length(q.versions) BETWEEN 1 AND 50
), links AS (
  SELECT l.value FROM scoped s, params q, jsonb_array_elements(s.state->'sourceLinks') l(value)
  WHERE l.value->>'sourceVersion' IN (SELECT jsonb_array_elements_text(q.versions))
), bookings AS (
  SELECT b.value FROM scoped s, jsonb_array_elements(s.state->'bookings') b(value)
  WHERE b.value->>'id' IN (SELECT value->>'bookingId' FROM links)
), audit_rows AS (
  SELECT a.audit_id, a.audit_json FROM iron_gate.audit_log a, params q
  WHERE a.property_id = q.property_id AND a.audit_json->>'bookingId' IN (SELECT value->>'id' FROM bookings)
), receipt_rows AS (
  SELECT r.value FROM scoped s, jsonb_array_elements(s.state->'receipts') r(value)
  WHERE r.value->>'action' = 'source:write'
    AND r.value->'response'->>'bookingId' IN (SELECT value->>'id' FROM bookings)
)
SELECT jsonb_build_object(
  'schema',1,'propertyId',state->>'propertyId','workspaceId',state->>'workspaceId',
  'authorityEpoch',state->'authorityEpoch','inventoryVersion',state->'version','readOnly',state->'readOnly',
  'stateSha256',encode(sha256(convert_to(state::text,'UTF8')),'hex'),
  'auditSha256',(SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(audit_json ORDER BY audit_id),'[]'::jsonb)::text,'UTF8')),'hex') FROM audit_rows),
  'sourceGrants',state->'sourceGrants',
  'sourceLinks',(SELECT COALESCE(jsonb_agg(value ORDER BY value->>'key'),'[]'::jsonb) FROM links),
  'bookings',(SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',value->>'id','source',value->>'source','sourceKey',value->>'sourceKey',
    'createdAt',value->>'createdAt','bookedAt',value->'bookedAt','version',value->'version','status',value->>'status',
    'hasSweetfunSnapshot',value ? 'sweetfunSnapshot','hasOsSnapshot',value ? 'osSnapshot',
    'hasSourceCalendar',value ? 'sourceCalendar','lineOverridePending',COALESCE((value->>'lineOverridePending')::boolean,false)
  ) ORDER BY value->>'id'),'[]'::jsonb) FROM bookings),
  'receipts',(SELECT COALESCE(jsonb_agg(value ORDER BY value->>'key'),'[]'::jsonb) FROM receipt_rows),
  'audits',(SELECT COALESCE(jsonb_agg(audit_json ORDER BY audit_id),'[]'::jsonb) FROM audit_rows)
) || CASE WHEN state ? 'reportingPolicy' THEN jsonb_build_object('reportingPolicy',state->'reportingPolicy') ELSE '{}'::jsonb END
AS notification_recovery_input FROM scoped;
