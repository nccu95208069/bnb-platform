-- Manual rollback for an unused W1 installation only. Never run after backfill/cutover.
-- The guard checks every finance table and aborts before dropping anything if data exists.
BEGIN;
DO $$
DECLARE t text; n bigint;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'finance_connector','finance_document','finance_revision','finance_event',
    'finance_allocation','finance_expense_attribution','finance_request_receipt',
    'finance_outbox','finance_change_event','finance_change',
    'finance_source_link','finance_source_alias',
    'finance_payment_ownership','finance_import_issue','finance_import_catalog','finance_account',
    'finance_category','finance_recurring_rule','finance_payout_rule',
    'finance_operational_status','finance_evidence_assertion',
    'finance_settlement','finance_settlement_link'] LOOP
    IF to_regclass(format('iron_gate.%I', t)) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('SELECT count(*) FROM iron_gate.%I', t) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'FINANCE_ROLLBACK_NONEMPTY: %', t; END IF;
  END LOOP;
END $$;
DROP TABLE iron_gate.finance_settlement_link;
DROP TABLE iron_gate.finance_settlement;
DROP TABLE iron_gate.finance_evidence_assertion;
DROP TABLE iron_gate.finance_operational_status;
DROP TABLE iron_gate.finance_payout_rule;
DROP TABLE iron_gate.finance_recurring_rule;
DROP TABLE iron_gate.finance_account;
DROP TABLE iron_gate.finance_import_issue;
DROP TABLE IF EXISTS iron_gate.finance_import_catalog;
DROP TABLE iron_gate.finance_payment_ownership;
DROP TABLE iron_gate.finance_source_alias;
DROP TABLE iron_gate.finance_source_link;
DROP TABLE iron_gate.finance_outbox;
DROP TABLE IF EXISTS iron_gate.finance_change_event;
DROP TABLE IF EXISTS iron_gate.finance_change;
DROP TABLE iron_gate.finance_request_receipt;
DROP TABLE iron_gate.finance_expense_attribution;
DROP TABLE iron_gate.finance_allocation;
DROP TABLE iron_gate.finance_event;
DROP TABLE iron_gate.finance_category;
DROP TABLE iron_gate.finance_revision;
DROP TABLE iron_gate.finance_document;
DROP TABLE iron_gate.finance_connector;
DROP FUNCTION iron_gate.finance_validate_event_reference();
DROP FUNCTION iron_gate.finance_immutable_row();
DROP FUNCTION iron_gate.finance_assert_event_balances();
COMMIT;
