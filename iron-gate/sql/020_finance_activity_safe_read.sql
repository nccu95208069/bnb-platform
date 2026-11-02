-- Expose only the finance operation projection. The runtime role must never
-- receive direct SELECT on the shared booking/security audit log.
BEGIN;
-- Keep the original runtime invariant even if this migration is reapplied
-- after a replay of the earlier finance activity migration.
REVOKE SELECT ON iron_gate.audit_log FROM iron_gate_runtime;
DROP POLICY IF EXISTS audit_finance_read_scope ON iron_gate.audit_log;
CREATE OR REPLACE FUNCTION iron_gate.finance_activity_operations(target_property uuid)
RETURNS TABLE (
  audit_id uuid, property_id uuid, created_at timestamptz,
  action text, actor_ref text, request_key text, operation_kind text,
  source_instance_id uuid
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.audit_id,a.property_id,a.created_at,
    a.audit_json->>'action',a.audit_json->>'actorRef',
    a.audit_json->>'requestKey',a.audit_json->>'operationKind',
    CASE WHEN a.audit_json->>'sourceInstanceId' ~*
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (a.audit_json->>'sourceInstanceId')::uuid ELSE NULL END
  FROM iron_gate.audit_log a
  WHERE a.property_id=target_property
    AND target_property::text=current_setting('iron_gate.property_id',true)
    AND EXISTS (SELECT 1 FROM iron_gate.finance_write_scope s
      WHERE s.property_id=target_property AND s.mode='general_only')
    AND a.audit_json->>'type'='finance.operation'
$$;
REVOKE ALL ON FUNCTION iron_gate.finance_activity_operations(uuid)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION iron_gate.finance_activity_operations(uuid)
  TO iron_gate_runtime;
COMMIT;
