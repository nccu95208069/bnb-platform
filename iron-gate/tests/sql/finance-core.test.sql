-- Run against a disposable PostgreSQL database after 001-003 and 005-007.
-- All synthetic rows roll back. Never run this on the production database.
BEGIN;

INSERT INTO iron_gate.property_state
  (property_id, workspace_id, authority_epoch, inventory_version, state_json)
VALUES
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 1, 1,
   '{"propertyId":"00000000-0000-4000-8000-000000000101","workspaceId":"00000000-0000-4000-8000-000000000001","authorityEpoch":1,"version":1,"bookings":[]}'::jsonb),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000001', 1, 1,
   '{"propertyId":"00000000-0000-4000-8000-000000000102","workspaceId":"00000000-0000-4000-8000-000000000001","authorityEpoch":1,"version":1,"bookings":[]}'::jsonb);

INSERT INTO iron_gate.finance_connector (source_instance_id, property_id, source_system)
VALUES
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', 'os_manual'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000102', 'line_finance');

INSERT INTO iron_gate.finance_document
  (id, property_id, source_instance_id, source_system, source_record_id, kind, current_version, status)
VALUES ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000201', 'os_manual', 'synthetic-expense', 'money', 1, 'active');

INSERT INTO iron_gate.finance_revision
  (property_id, document_id, version, action, request_hash, source_version, actor_ref)
VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000301',
  1, 'create', repeat('a',64), '1', 'synthetic-actor');

INSERT INTO iron_gate.finance_event
  (id, property_id, document_id, revision_version, event_kind, amount_cents,
   cash_effect_cents, effective_on, cash_on, evidence_level, actor_ref)
VALUES ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000301', 1, 'expense_paid', 12345, -12345,
  '2026-10-28', '2026-10-28', 'operator_attested', 'synthetic-actor');
INSERT INTO iron_gate.finance_expense_attribution
  (property_id, event_id, month, amount_cents, allocation_policy)
VALUES ('00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000401', '2026-10-01', 12345, 'ig_v1_earliest_cent');
SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO iron_gate.finance_revision
  (property_id, document_id, version, action, request_hash, source_version, actor_ref)
VALUES ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000301',
  2, 'amend', repeat('c',64), '2', 'synthetic-actor');

INSERT INTO iron_gate.finance_category (property_id, kind, code, label)
VALUES ('00000000-0000-4000-8000-000000000101', 'expense', 'supplies', 'Supplies');
INSERT INTO iron_gate.finance_recurring_rule
  (id, property_id, source_instance_id, source_record_id, version, cadence,
   start_on, next_due_on, status, category_code)
VALUES ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000101',
  '00000000-0000-4000-8000-000000000201', 'synthetic-rule', 1, 'monthly',
  '2026-10-01', '2026-11-01', 'active', 'supplies');

DO $$
DECLARE rejected boolean;
BEGIN
  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_document
      (id, property_id, source_instance_id, source_system, source_record_id, kind, current_version, status)
    VALUES ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000202', 'line_finance', 'cross-property', 'money', 1, 'active');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'cross-property connector accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_document
      (id, property_id, source_instance_id, source_system, source_record_id, kind, current_version, status)
    VALUES ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201', 'line_finance', 'wrong-system', 'money', 1, 'active');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'connector source mismatch accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_event
      (id, property_id, document_id, revision_version, event_kind, amount_cents,
       cash_effect_cents, effective_on, cash_on, evidence_level, actor_ref)
    VALUES ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000301', 1, 'expense_paid', 12345, 12345,
      '2026-10-28', '2026-10-28', 'operator_attested', 'synthetic-actor');
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'wrong cash direction accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_request_receipt
      (property_id, source_instance_id, request_key, request_hash, status, response_json)
    VALUES ('00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000201', 'cross-property', repeat('b',64), 'accepted', '{}');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'cross-property receipt accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_recurring_rule
      (id, property_id, source_instance_id, source_record_id, version, cadence,
       start_on, next_due_on, status, category_code)
    VALUES ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000102',
      '00000000-0000-4000-8000-000000000202', 'cross-category', 1, 'monthly',
      '2026-10-01', '2026-11-01', 'active', 'supplies');
  EXCEPTION WHEN foreign_key_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'cross-property category accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_settlement
      (id, property_id, source_instance_id, settlement_batch_ref, gross_cents,
       refund_cents, fee_cents, net_cents, evidence_ref)
    VALUES ('00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000201', 'synthetic-batch', 10000, 1000, 200, 9000, 'synthetic-ref');
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'unbalanced settlement accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_event
      (id, property_id, document_id, revision_version, event_kind, amount_cents,
       cash_effect_cents, effective_on, cash_on, evidence_level, actor_ref, reverses_event_id)
    VALUES ('00000000-0000-4000-8000-000000000403', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000301', 1, 'reversal', 12345, 12345,
      '2026-10-29', '2026-10-29', 'operator_attested', 'synthetic-actor',
      '00000000-0000-4000-8000-000000000401');
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'wrong-period reversal accepted'; END IF;

  rejected := false;
  BEGIN
    INSERT INTO iron_gate.finance_event
      (id, property_id, document_id, revision_version, event_kind, amount_cents,
       cash_effect_cents, effective_on, cash_on, evidence_level, actor_ref)
    VALUES ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000301', 1, 'expense_paid', 50, -50,
      '2026-10-28', '2026-10-28', 'operator_attested', 'synthetic-actor');
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'unattributed expense accepted'; END IF;

  rejected := false;
  BEGIN
    SET CONSTRAINTS ALL DEFERRED;
    INSERT INTO iron_gate.finance_event
      (id, property_id, document_id, revision_version, event_kind, amount_cents,
       cash_effect_cents, effective_on, cash_on, evidence_level, actor_ref, reverses_event_id)
    VALUES ('00000000-0000-4000-8000-000000000405', '00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000301', 2, 'reversal', 12345, 12345,
      '2026-10-28', '2026-10-28', 'operator_attested', 'synthetic-actor',
      '00000000-0000-4000-8000-000000000401');
    INSERT INTO iron_gate.finance_expense_attribution
      (property_id, event_id, month, amount_cents, allocation_policy)
    VALUES ('00000000-0000-4000-8000-000000000101',
      '00000000-0000-4000-8000-000000000405', '2026-11-01', -12345, 'ig_v1_earliest_cent');
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'reversal shifted cost to another month'; END IF;

  rejected := false;
  BEGIN
    UPDATE iron_gate.finance_event SET safe_description = 'rewritten'
      WHERE id = '00000000-0000-4000-8000-000000000401';
  EXCEPTION WHEN check_violation THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'immutable event updated'; END IF;
END $$;

SET LOCAL ROLE iron_gate_runtime;
SELECT set_config('iron_gate.property_id', '00000000-0000-4000-8000-000000000101', true);
DO $$
DECLARE rejected boolean := false;
BEGIN
  IF (SELECT count(*) FROM iron_gate.finance_connector) <> 1 THEN
    RAISE EXCEPTION 'RLS connector scope failed';
  END IF;
  IF (SELECT count(*) FROM iron_gate.finance_event) <> 1 THEN
    RAISE EXCEPTION 'RLS event scope failed';
  END IF;
  IF (SELECT count(*) FROM iron_gate.finance_category) <> 1 THEN
    RAISE EXCEPTION 'RLS category scope failed';
  END IF;
  BEGIN
    INSERT INTO iron_gate.finance_connector (source_instance_id, property_id, source_system)
    VALUES ('00000000-0000-4000-8000-000000000203',
      '00000000-0000-4000-8000-000000000101', 'os_manual');
  EXCEPTION WHEN insufficient_privilege THEN rejected := true;
  END;
  IF NOT rejected THEN RAISE EXCEPTION 'finance writer enabled before W2'; END IF;
END $$;
RESET ROLE;
ROLLBACK;
