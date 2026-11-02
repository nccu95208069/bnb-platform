-- W2: operational status and plan writes remain property-scoped and non-cash.
BEGIN;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_operational_status','finance_recurring_rule','finance_payout_rule'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS finance_insert_scope ON iron_gate.%I', t);
    EXECUTE format('CREATE POLICY finance_insert_scope ON iron_gate.%I FOR INSERT TO iron_gate_runtime WITH CHECK (property_id::text = current_setting(''iron_gate.property_id'', true) AND iron_gate.finance_write_scope_allowed(property_id))', t);
    EXECUTE format('GRANT INSERT ON iron_gate.%I TO iron_gate_runtime', t);
  END LOOP;
END $$;
DROP POLICY IF EXISTS finance_recurring_update_scope ON iron_gate.finance_recurring_rule;
CREATE POLICY finance_recurring_update_scope ON iron_gate.finance_recurring_rule
  FOR UPDATE TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
GRANT UPDATE (version,cadence,start_on,end_on,next_due_on,status,category_code)
  ON iron_gate.finance_recurring_rule TO iron_gate_runtime;
DROP POLICY IF EXISTS finance_payout_update_scope ON iron_gate.finance_payout_rule;
CREATE POLICY finance_payout_update_scope ON iron_gate.finance_payout_rule
  FOR UPDATE TO iron_gate_runtime
  USING (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id))
  WITH CHECK (property_id::text = current_setting('iron_gate.property_id', true)
    AND iron_gate.finance_write_scope_allowed(property_id));
GRANT UPDATE (version,mode,day,offset_days,status)
  ON iron_gate.finance_payout_rule TO iron_gate_runtime;
COMMIT;
