-- Finance activity is property scoped and readable only through the runtime role.
BEGIN;
DROP POLICY IF EXISTS audit_finance_read_scope ON iron_gate.audit_log;
CREATE POLICY audit_finance_read_scope ON iron_gate.audit_log
  FOR SELECT TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND audit_json->>'type' = 'finance.operation');
GRANT SELECT ON iron_gate.audit_log TO iron_gate_runtime;
COMMIT;
