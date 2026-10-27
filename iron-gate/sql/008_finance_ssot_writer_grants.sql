-- W2: scoped runtime writes. Connector provisioning remains administrative.
BEGIN;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_document','finance_revision','finance_event','finance_allocation',
    'finance_expense_attribution','finance_request_receipt','finance_outbox',
    'finance_source_alias','finance_payment_ownership'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_insert_scope ON iron_gate.%I FOR INSERT TO iron_gate_runtime WITH CHECK (property_id::text = current_setting(''iron_gate.property_id'', true))', t);
    EXECUTE format('GRANT INSERT ON iron_gate.%I TO iron_gate_runtime', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS finance_document_update_scope ON iron_gate.finance_document;
CREATE POLICY finance_document_update_scope ON iron_gate.finance_document
  FOR UPDATE TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true));
GRANT UPDATE (current_version, status, updated_at)
  ON iron_gate.finance_document TO iron_gate_runtime;
COMMIT;
